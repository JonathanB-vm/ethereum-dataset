"""Work planning and cost guarding for the ingest job.

The pure decisions the daily job makes before it touches BigQuery: which blocks are final
enough to publish, how they divide into chunks, which month partitions those chunks live
in, and whether a query is cheap enough to run. Kept free of any cloud client so it can be
tested exhaustively without an account -- see `test_planning.py`.

Spec: docs/superpowers/specs/2026-09-08-ingest-pipeline.md
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# Post-merge finality is ~13 minutes (64 slots). 100 blocks is ~20 minutes, so a block
# this far behind head can never be reorged out and the pipeline needs no reorg handling.
FINALITY_LAG = 100

# The unit of work. Aligned to multiples of this, so a chunk's identity is derivable from
# any block inside it and a retry always reproduces the same range.
CHUNK_SIZE = 10_000

# BigQuery on-demand pricing, verified 2026-09-08: $6.25 per TiB scanned.
USD_PER_TIB = 6.25
BYTES_PER_TIB = 1024 ** 4

# Abort a query that would scan more than this. The hazard the guard exists for: a query
# that loses its partition filter scans the full source tables (~5.7 TB, ~$35) and, on a
# daily schedule, costs ~$1,000/month. A failed run is always cheaper than that.
DEFAULT_BYTE_CEILING = 200 * 1000 ** 3  # 200 GB


class CostCeilingExceeded(RuntimeError):
    """A dry run reported more bytes than the job is willing to pay for."""

    def __init__(self, scanned_bytes: int, ceiling: int) -> None:
        self.scanned_bytes = scanned_bytes
        self.ceiling = ceiling
        super().__init__(
            "query would scan {0:.1f} GB (${1:.2f}), ceiling is {2:.1f} GB -- "
            "this usually means the block_timestamp partition filter was lost".format(
                scanned_bytes / 1e9, usd_for_bytes(scanned_bytes), ceiling / 1e9
            )
        )


def usd_for_bytes(scanned_bytes: int) -> float:
    """Dollar cost of a BigQuery scan, ignoring the monthly free tier."""
    return scanned_bytes / BYTES_PER_TIB * USD_PER_TIB


def guard_cost(scanned_bytes: int, ceiling: int = DEFAULT_BYTE_CEILING) -> int:
    """Raise unless a dry-run estimate is within the ceiling. Returns the bytes."""
    if scanned_bytes > ceiling:
        raise CostCeilingExceeded(scanned_bytes, ceiling)
    return scanned_bytes


def target_end(head: int, lag: int = FINALITY_LAG, chunk: int = CHUNK_SIZE) -> int:
    """Last block of the newest chunk that is both complete and final.

    Returns -1 when the chain has not yet produced a full publishable chunk, so callers
    can treat "nothing to do" as an ordinary result rather than an error.
    """
    if chunk <= 0:
        raise ValueError("chunk size must be positive")
    safe = head - lag
    if safe < 0:
        return -1
    return (safe // chunk) * chunk - 1


@dataclass(frozen=True)
class Chunk:
    """A chunk-aligned, month-contained range of blocks: the unit of publication."""

    start: int
    end: int

    @property
    def blocks(self) -> int:
        return self.end - self.start + 1

    def name(self, network: str, table: str) -> str:
        """cryo's file naming, zero-padded so bucket listings sort lexically."""
        return "{0}__{1}__{2:08d}_to_{3:08d}.parquet".format(
            network, table, self.start, self.end
        )


def plan_chunks(
    last_done: int | None, end: int, chunk: int = CHUNK_SIZE
) -> list[Chunk]:
    """Chunk-aligned ranges still to publish, oldest first.

    `last_done` is the end block of the newest published chunk. Pass None only for a
    genuine cold start from block 0; a backfill that begins mid-chain passes its first
    block minus one. Ranges are always aligned to `chunk`, so a retry reproduces them
    exactly and a partially published chunk is republished whole rather than patched.
    """
    if chunk <= 0:
        raise ValueError("chunk size must be positive")
    if end < 0:
        return []
    start = 0 if last_done is None else last_done + 1
    # Align the starting point down; a partially published chunk is republished whole.
    start = (start // chunk) * chunk
    out: list[Chunk] = []
    while start + chunk - 1 <= end:
        out.append(Chunk(start, start + chunk - 1))
        start += chunk
    return out


def month_of(day: date) -> tuple[int, int]:
    return day.year, day.month


def months_covering(first: date, last: date) -> list[tuple[int, int]]:
    """Every (year, month) partition between two dates inclusive.

    The source tables are partitioned monthly on `block_timestamp`, so this is the real
    unit of scanning: a backfill exports one month per query and splits it into chunks
    locally, rather than paying for a month partition once per chunk.
    """
    if last < first:
        return []
    out: list[tuple[int, int]] = []
    y, m = first.year, first.month
    while (y, m) <= (last.year, last.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def is_behind(head: int, last_done: int, threshold: int = 30_000) -> bool:
    """Whether ingest has fallen far enough behind head to be worth alerting on.

    30,000 blocks is ~4 days, which in practice means the public dataset is lagging
    rather than that the job is broken.
    """
    return head - last_done > threshold

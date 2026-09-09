"""Tests for the ingest job's planning and cost-guarding decisions.

These are the decisions that cost money if they are wrong -- a lost partition filter is
~$35 a run -- so they are tested exhaustively and without a cloud account.
"""

from __future__ import annotations

from datetime import date

import pytest

from planning import (
    CHUNK_SIZE,
    Chunk,
    CostCeilingExceeded,
    guard_cost,
    is_behind,
    months_covering,
    plan_chunks,
    target_end,
    usd_for_bytes,
)


class TestTargetEnd:
    def test_stays_a_full_chunk_behind_head(self):
        # head 25,534,299 -> safe 25,534,199 -> last complete chunk ends 25,529,999
        assert target_end(25_534_299) == 25_529_999

    def test_never_publishes_inside_the_finality_lag(self):
        # A block exactly at the lag boundary is still not publishable, because its
        # chunk is incomplete.
        assert target_end(20_000 + 100) == 19_999

    def test_ignores_a_chunk_that_is_not_yet_complete(self):
        # 9,999 blocks past the boundary is not a chunk.
        assert target_end(20_000 + 9_999 + 100) == 19_999

    def test_returns_negative_one_before_the_first_full_chunk(self):
        assert target_end(5_000) == -1

    def test_handles_head_below_the_finality_lag(self):
        assert target_end(10) == -1

    def test_rejects_a_nonsense_chunk_size(self):
        with pytest.raises(ValueError):
            target_end(1_000_000, chunk=0)


class TestPlanChunks:
    def test_produces_aligned_ranges(self):
        plan = plan_chunks(last_done=19_999, end=49_999)
        assert plan == [Chunk(20_000, 29_999), Chunk(30_000, 39_999),
                        Chunk(40_000, 49_999)]

    def test_is_empty_when_nothing_new_is_final(self):
        # The daily job must exit quietly on a day with no complete chunk.
        assert plan_chunks(last_done=49_999, end=49_999) == []

    def test_never_emits_a_partial_trailing_chunk(self):
        # 5,000 blocks past the last boundary do not make a chunk.
        assert plan_chunks(last_done=19_999, end=34_999) == [Chunk(20_000, 29_999)]

    def test_realigns_a_misaligned_resume_point(self):
        # If the log somehow holds a mid-chunk block, the whole chunk is republished
        # rather than a partial range being invented.
        assert plan_chunks(last_done=25_004, end=39_999)[0] == Chunk(20_000, 29_999)

    def test_cold_start_from_zero(self):
        assert plan_chunks(last_done=None, end=19_999) == [
            Chunk(0, 9_999), Chunk(10_000, 19_999)
        ]

    def test_returns_empty_when_no_chunk_is_final_yet(self):
        assert plan_chunks(last_done=None, end=-1) == []

    def test_a_year_is_263_chunks(self):
        plan = plan_chunks(last_done=-1, end=2_630_000 - 1)
        assert len(plan) == 263
        assert plan[0].start == 0 and plan[-1].end == 2_629_999

    def test_chunks_are_contiguous_and_uniform(self):
        plan = plan_chunks(last_done=19_999, end=119_999)
        assert all(c.blocks == CHUNK_SIZE for c in plan)
        assert all(b.start == a.end + 1 for a, b in zip(plan, plan[1:]))


class TestChunkNaming:
    def test_uses_cryo_zero_padded_convention(self):
        assert Chunk(25_534_200, 25_534_299).name("ethereum", "transactions") == (
            "ethereum__transactions__25534200_to_25534299.parquet"
        )

    def test_pads_low_block_numbers_so_listings_sort_lexically(self):
        names = [Chunk(s, s + 9_999).name("ethereum", "blocks")
                 for s in (0, 10_000, 20_000)]
        assert names == sorted(names)
        assert names[0].startswith("ethereum__blocks__00000000_to_")


class TestCostGuard:
    def test_allows_a_partition_pruned_query(self):
        assert guard_cost(50 * 1000 ** 3) == 50 * 1000 ** 3

    def test_blocks_a_full_table_scan(self):
        # The exact failure the guard exists for: ~5.7 TB when the partition filter is
        # lost, which is ~$35 a run and ~$1,000/month on a daily schedule.
        with pytest.raises(CostCeilingExceeded) as err:
            guard_cost(5_700 * 1000 ** 3)
        assert "partition filter" in str(err.value)

    def test_allows_exactly_the_ceiling(self):
        assert guard_cost(100, ceiling=100) == 100

    def test_blocks_one_byte_over(self):
        with pytest.raises(CostCeilingExceeded):
            guard_cost(101, ceiling=100)

    def test_reports_the_dollar_cost_of_a_full_scan(self):
        # 5.7 TB at $6.25 per TiB.
        assert usd_for_bytes(5_700 * 1000 ** 3) == pytest.approx(32.4, abs=0.5)

    def test_a_free_tier_sized_scan_is_cents(self):
        assert usd_for_bytes(50 * 1000 ** 3) < 0.35


class TestMonthsCovering:
    def test_single_month(self):
        assert months_covering(date(2026, 7, 1), date(2026, 7, 31)) == [(2026, 7)]

    def test_crosses_a_year_boundary(self):
        assert months_covering(date(2025, 11, 3), date(2026, 2, 1)) == [
            (2025, 11), (2025, 12), (2026, 1), (2026, 2)
        ]

    def test_a_full_year_is_twelve_partitions(self):
        assert len(months_covering(date(2026, 1, 1), date(2026, 12, 31))) == 12

    def test_reversed_range_is_empty(self):
        assert months_covering(date(2026, 7, 1), date(2026, 6, 1)) == []


class TestLagAlerting:
    def test_quiet_when_current(self):
        assert not is_behind(head=2_000_000, last_done=1_999_000)

    def test_alerts_when_four_days_behind(self):
        assert is_behind(head=2_000_000, last_done=1_960_000)

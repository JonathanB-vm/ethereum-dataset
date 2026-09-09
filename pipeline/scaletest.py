#!/usr/bin/env python3
"""Scale test: does query cost stay flat as the table grows?

The architecture spec's latency targets are unvalidated, because every measurement so far
ran on 100 blocks that fit entirely in memory. A real backfill is the only way to settle
them properly. This gets partway there on a laptop, for free.

Method: replicate the canonical 100-block sample many times into a separate database,
shifting each copy forward in block number and time, and measure the benchmark suite at
increasing sizes.

Two things make the result meaningful rather than a toy:

1. **Realistic cardinality.** Naively replicating would repeat every address N times, which
   would flatter compression and the bloom filters badly. Instead the *hot* addresses --
   tokens, routers, exchanges, which genuinely do recur across blocks -- are kept stable,
   while the long tail of one-off addresses is perturbed per replica. Transaction and block
   hashes are always perturbed, since those never repeat in reality.

2. **A cache-independent metric.** The dataset still fits in page cache on a laptop, so
   wall-clock time here is optimistic and should not be read as a latency result. What does
   survive the caching is `read_rows`: how much data ClickHouse had to touch. If a
   block-range query reads the same number of rows whether the table holds 40 thousand or
   17 million, the primary key is doing its job and the design scales. If `read_rows` grows
   with the table, it does not, and no amount of hardware fixes it.

Usage:
    python pipeline/scaletest.py --replicas 200
    python pipeline/scaletest.py --replicas 200 --checkpoints 25 50 100 200
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BLOCKS_PER_REPLICA = 100
SECONDS_PER_BLOCK = 12
SRC = "import/parquet/v1"
HOT_ADDRESSES = 200


class ClickHouse:
    def __init__(self, url: str, database: str = "default") -> None:
        self.url = url
        self.database = database

    def run(self, sql: str, database: str | None = None, query_id: str | None = None) -> str:
        params = {"database": database or self.database, "default_format": "TSV"}
        if query_id:
            params["query_id"] = query_id
        req = urllib.request.Request(
            f"{self.url}/?{urllib.parse.urlencode(params)}",
            data=sql.encode("utf-8"),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as res:
                return res.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            # ClickHouse puts the real diagnosis in the body; without this all you get
            # is "400 Bad Request".
            body = err.read().decode("utf-8", "replace")[:600]
            raise RuntimeError(
                f"ClickHouse {err.code}: {body}\n"
                f"--- while running ---\n{sql[:400]}"
            ) from None

    def rows(self, sql: str, database: str | None = None) -> list[list[str]]:
        out = self.run(sql, database)
        return [line.split("\t") for line in out.strip().split("\n") if line]

    def one(self, sql: str, database: str | None = None) -> str:
        return self.run(sql, database).strip()


def build_schema(ch: ClickHouse, database: str) -> None:
    """Apply the production schema to a throwaway database."""
    text = Path(__file__).with_name("clickhouse") / "schema.sql"
    sql = text.read_text(encoding="utf-8")
    if "eth_scale" in sql:
        raise SystemExit("schema.sql already mentions eth_scale; refusing to rewrite")
    sql = sql.replace("eth.", f"{database}.").replace(
        "CREATE DATABASE IF NOT EXISTS eth;", f"CREATE DATABASE IF NOT EXISTS {database};"
    )
    ch.run(f"DROP DATABASE IF EXISTS {database}")
    # Strip comments *before* splitting on ";". A prose semicolon inside a comment -- and
    # the schema has one -- otherwise cuts a statement in half and the remainder is sent
    # as SQL. `clickhouse-client --multiquery` handles the file fine; this splitter is the
    # naive part, so it does the stripping itself.
    stripped = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    )
    for statement in stripped.split(";"):
        if statement.strip():
            ch.run(statement.strip())


def hot_address_array(ch: ClickHouse) -> str:
    """The most frequent addresses, kept stable across replicas.

    Real chain data reuses a small set of contracts constantly and a long tail of externally
    owned accounts barely at all. Preserving that shape is what keeps the address index and
    the bloom filters honest.
    """
    rows = ch.rows(f"""
        SELECT addr FROM (
            SELECT from_address AS addr, count() c
              FROM file('{SRC}/transactions/**/*.parquet', Parquet) GROUP BY addr
            UNION ALL
            SELECT address, count() FROM file('{SRC}/token_transfers/**/*.parquet', Parquet)
             GROUP BY address
            UNION ALL
            SELECT to_address, count() FROM file('{SRC}/token_transfers/**/*.parquet', Parquet)
             GROUP BY to_address
        ) GROUP BY addr ORDER BY sum(c) DESC LIMIT {HOT_ADDRESSES}
    """)
    return "[" + ",".join(f"'{r[0]}'" for r in rows) + "]"


def addr_expr(col: str, hot: str, nullable: bool = False) -> str:
    """Keep hot addresses identical across replicas; perturb the rest per replica."""
    kept = f"unhex(substring({col}, 3))"
    perturbed = f"toFixedString(substring(SHA256(concat({col}, toString(i))), 1, 20), 20)"
    expr = f"if(has({hot}, {col}), {kept}, {perturbed})"
    if nullable:
        return f"if({col} IS NULL, NULL, toFixedString({expr}, 20))"
    return f"toFixedString({expr}, 20)"


def load(ch: ClickHouse, db: str, lo: int, n: int, hot: str) -> None:
    """Insert `n` replicas starting at index `lo`."""
    shift_b = f"toUInt32(i * {BLOCKS_PER_REPLICA})"
    shift_t = f"toIntervalSecond(i * {BLOCKS_PER_REPLICA * SECONDS_PER_BLOCK})"
    # ClickHouse requires an alias on both sides of a CROSS JOIN.
    src = f"(SELECT number AS i FROM numbers({lo}, {n})) AS rep"

    ch.run(f"""
        INSERT INTO {db}.transactions
        SELECT
            block_number + {shift_b},
            toDateTime(block_timestamp) + {shift_t},
            SHA256(concat(block_hash, toString(i))),
            transaction_index,
            SHA256(concat(transaction_hash, toString(i))),
            nonce,
            {addr_expr('from_address', hot)},
            {addr_expr('to_address', hot, nullable=True)},
            toUInt256(value), gas, toUInt128(gas_price), input,
            toUInt128OrNull(max_fee_per_gas), toUInt128OrNull(max_priority_fee_per_gas),
            transaction_type, chain_id, access_list,
            unhex(substring(r, 3)), unhex(substring(s, 3)), v, y_parity
        FROM file('{SRC}/transactions/**/*.parquet', Parquet) AS base
        CROSS JOIN {src}
    """, database=db)

    ch.run(f"""
        INSERT INTO {db}.token_transfers
        SELECT
            block_number + {shift_b},
            toDateTime(block_timestamp) + {shift_t},
            SHA256(concat(block_hash, toString(i))),
            transaction_index,
            SHA256(concat(transaction_hash, toString(i))),
            event_index, batch_index,
            {addr_expr('address', hot)},
            event_type,
            unhex(substring(event_hash, 3)),
            event_signature,
            {addr_expr('operator_address', hot, nullable=True)},
            {addr_expr('from_address', hot)},
            {addr_expr('to_address', hot)},
            toUInt256OrNull(token_id), toUInt256(quantity), removed
        FROM file('{SRC}/token_transfers/**/*.parquet', Parquet) AS base
        CROSS JOIN {src}
    """, database=db)

    ch.run(f"""
        INSERT INTO {db}.blocks
        SELECT
            block_number + {shift_b},
            toDateTime(block_timestamp) + {shift_t},
            SHA256(concat(block_hash, toString(i))),
            transaction_count, transfer_count
        FROM file('{SRC}/blocks/**/*.parquet', Parquet) AS base
        CROSS JOIN {src}
    """, database=db)


BENCHMARKS = {
    "block range page (50 rows)": """
        SELECT block_number, transaction_index, hex(transaction_hash), toString(value)
        FROM {db}.transactions
        WHERE block_number >= {mid} AND block_number <= {mid} + 99
        ORDER BY block_number, transaction_index LIMIT 50""",
    "deep page via keyset cursor": """
        SELECT block_number, transaction_index FROM {db}.transactions
        WHERE (block_number, transaction_index) > ({mid}, 5)
          AND block_number <= {mid} + 99
        ORDER BY block_number, transaction_index LIMIT 50""",
    "transaction by hash (index table)": """
        SELECT block_number, transaction_index FROM {db}.transactions
        WHERE (block_number, transaction_index) IN (
          SELECT block_number, transaction_index FROM {db}.tx_by_hash
          WHERE transaction_hash = (SELECT transaction_hash FROM {db}.tx_by_hash LIMIT 1))""",
    "address -> transactions (index table)": """
        SELECT block_number, transaction_index FROM {db}.transactions
        WHERE (block_number, transaction_index) IN (
          SELECT block_number, transaction_index FROM {db}.tx_by_address
          WHERE address = (SELECT address FROM {db}.tx_by_address
                           GROUP BY address ORDER BY count() DESC LIMIT 1)
          ORDER BY block_number, transaction_index LIMIT 50)
        ORDER BY block_number, transaction_index LIMIT 50""",
    "address lookup, the JOIN form (rejected)": """
        SELECT f.block_number FROM {db}.tx_by_address i
        INNER JOIN {db}.transactions f
          ON f.block_number = i.block_number AND f.transaction_index = i.transaction_index
        WHERE i.address = (SELECT address FROM {db}.tx_by_address
                           GROUP BY address ORDER BY count() DESC LIMIT 1)
        ORDER BY i.block_number LIMIT 50""",
    "stats over 10k blocks (materialized)": """
        SELECT sum(tx_count), sum(transfer_count), toString(sum(eth_moved))
        FROM {db}.block_stats
        WHERE block_number >= {lo} AND block_number <= {lo} + 9999""",
    "flat join page (the records view)": """
        SELECT t.block_number, t.transaction_index, tr.event_index
        FROM {db}.transactions t
        LEFT JOIN {db}.token_transfers tr
          ON t.block_number = tr.block_number AND t.transaction_index = tr.transaction_index
        WHERE t.block_number >= {mid} AND t.block_number <= {mid} + 9
        ORDER BY t.block_number, t.transaction_index LIMIT 50
        SETTINGS join_use_nulls = 1""",
}


def benchmark(ch: ClickHouse, db: str, label: str, repeats: int = 3) -> list[dict]:
    lo = int(ch.one(f"SELECT min(block_number) FROM {db}.transactions", db))
    hi = int(ch.one(f"SELECT max(block_number) FROM {db}.transactions", db))
    mid = lo + (hi - lo) // 2
    results = []

    for name, template in BENCHMARKS.items():
        sql = template.format(db=db, lo=lo, mid=mid)
        best = None
        qid = None
        for r in range(repeats):
            qid = f"scale-{label}-{abs(hash(name))}-{r}"
            t0 = time.perf_counter()
            ch.run(sql, database=db, query_id=qid)
            elapsed = (time.perf_counter() - t0) * 1000
            best = elapsed if best is None else min(best, elapsed)
        ch.run("SYSTEM FLUSH LOGS")
        stats = ch.rows(f"""
            SELECT read_rows, read_bytes FROM system.query_log
            WHERE query_id = '{qid}' AND type = 'QueryFinish'
            ORDER BY event_time DESC LIMIT 1""")
        read_rows, read_bytes = (int(stats[0][0]), int(stats[0][1])) if stats else (0, 0)
        results.append({
            "query": name, "ms": round(best or 0, 1),
            "read_rows": read_rows, "read_mb": round(read_bytes / 1e6, 2),
        })
    return results


def sizes(ch: ClickHouse, db: str) -> dict:
    row = ch.rows(f"""
        SELECT sum(rows), sum(data_compressed_bytes),
               sum(data_uncompressed_bytes), sum(secondary_indices_compressed_bytes)
        FROM system.parts WHERE database = '{db}' AND active""")[0]
    per_table = {
        r[0]: {"rows": int(r[1]), "mb": round(int(r[2]) / 1e6, 1)}
        for r in ch.rows(f"""
            SELECT table, sum(rows), sum(data_compressed_bytes) FROM system.parts
            WHERE database = '{db}' AND active GROUP BY table ORDER BY table""")
    }
    return {
        "rows": int(row[0]), "compressed_mb": round(int(row[1]) / 1e6, 1),
        "uncompressed_mb": round(int(row[2]) / 1e6, 1),
        "skip_index_mb": round(int(row[3]) / 1e6, 2),
        "ratio": round(int(row[2]) / max(int(row[1]), 1), 2),
        "tables": per_table,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--replicas", type=int, default=200)
    ap.add_argument("--checkpoints", type=int, nargs="*", default=None)
    ap.add_argument("--batch", type=int, default=25)
    ap.add_argument("--url", default="http://localhost:8123")
    ap.add_argument("--database", default="eth_scale")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    checkpoints = sorted(set(args.checkpoints or [
        max(1, args.replicas // 8), max(1, args.replicas // 4),
        max(1, args.replicas // 2), args.replicas,
    ]))

    ch = ClickHouse(args.url)
    print(f"clickhouse {ch.one('SELECT version()')}")
    print(f"building {args.database} ...")
    build_schema(ch, args.database)
    hot = hot_address_array(ch)
    print(f"hot addresses kept stable across replicas: {hot.count(',') + 1}")

    report = {"replicas": args.replicas, "checkpoints": []}
    done = 0
    for target in checkpoints:
        while done < target:
            n = min(args.batch, target - done)
            load(ch, args.database, done, n, hot)
            done += n
            print(f"  loaded {done}/{args.replicas} replicas", end="\r", flush=True)
        ch.run(f"OPTIMIZE TABLE {args.database}.block_stats FINAL", database=args.database)
        size = sizes(ch, args.database)
        blocks = done * BLOCKS_PER_REPLICA
        print(f"\n=== {done} replicas | {blocks:,} blocks | {size['rows']:,} rows "
              f"| {size['compressed_mb']:,} MB on disk ===")
        results = benchmark(ch, args.database, str(done))
        print(f"  {'query':38} {'ms':>8} {'read_rows':>12} {'read_MB':>9}")
        for r in results:
            print(f"  {r['query']:38} {r['ms']:>8} {r['read_rows']:>12,} {r['read_mb']:>9}")
        report["checkpoints"].append({
            "replicas": done, "blocks": blocks, "size": size, "benchmarks": results,
        })

    if args.out:
        args.out.write_text(json.dumps(report, indent=2))
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

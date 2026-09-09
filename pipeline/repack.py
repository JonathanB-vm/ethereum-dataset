#!/usr/bin/env python3
"""Repack a flat BigQuery CSV export into the canonical normalized Parquet layout.

This is the `repack` step of the ingest pipeline
(docs/superpowers/specs/2026-09-08-ingest-pipeline.md), runnable with no cloud account:
it reads the flat 35-column join that BigQuery produced and writes the three normalized
tables described in the data-model spec, sorted, zstd-compressed, checksummed, with a
manifest.

In production the input is Parquet straight from `EXPORT DATA` rather than this CSV, and
`access_list` arrives as real JSON via TO_JSON_STRING. The table shapes, sort keys, row
group sizes, compression, naming, checksums and manifest are identical either way, so the
output of this script is the format contract.

Usage:
    python pipeline/repack.py analytics_25534200_25534299.csv --out data/parquet/v1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

SCHEMA_VERSION = 1

# Row group sizes from the data-model spec (DuckDB guidance is 250k-500k rows).
ROW_GROUP = {"transactions": 250_000, "token_transfers": 500_000, "blocks": 100_000}

# Sort keys from the data-model spec. Sorting is what lets a remote DuckDB query skip
# row groups by block, so it is part of the format, not an optimization.
SORT_KEY = {
    "transactions": "block_number, transaction_index",
    "token_transfers": "block_number, transaction_index, event_index, batch_index",
    "blocks": "block_number",
}

TABLES = ("transactions", "token_transfers", "blocks")


def int_str(col: str) -> str:
    """A lossless integer as a decimal string.

    The source CSV writes some integer columns with a trailing `.0` (a pandas float
    artifact), and 256-bit values exceed every fixed-width integer type DuckDB has.
    Both are handled by keeping the value as text and stripping the suffix. Never cast
    these through DOUBLE: 2^256 does not survive a float, and a wrong `value` is silent
    data corruption rather than a visible error.
    """
    return r"nullif(regexp_replace({0}, '\.0+$', ''), '')".format(col)


def small_int(col: str, typ: str) -> str:
    """A small integer that may carry the same `.0` suffix."""
    return "try_cast({0} AS {1})".format(int_str(col), typ)


def build(con: duckdb.DuckDBPyConnection, csv_path: Path) -> None:
    # all_varchar: never let the CSV sniffer choose types. Left to itself it infers
    # DOUBLE for quantity, token_id and value_lossless_tx, which silently destroys
    # precision on exactly the columns this project promises to keep lossless.
    # DuckDB does not accept bound parameters in CREATE VIEW, so the path is inlined
    # with SQL quote escaping.
    literal = csv_path.as_posix().replace("'", "''")
    con.execute(
        "CREATE OR REPLACE VIEW flat AS "
        "SELECT * FROM read_csv('{0}', header = true, all_varchar = true)".format(literal)
    )

    # transactions: one row per transaction. In the flat join every transfer row repeats
    # its transaction's columns (including `input`, which is 96.9% of the file's bytes),
    # so this is where the bulk of the saving comes from.
    con.execute("""
        CREATE OR REPLACE TABLE transactions AS
        SELECT DISTINCT ON (transaction_hash)
            {block_number}      AS block_number,
            cast(block_timestamp AS TIMESTAMP) AS block_timestamp,
            block_hash,
            {transaction_index} AS transaction_index,
            transaction_hash,
            {nonce}             AS nonce,
            from_address_tx     AS from_address,
            nullif(to_address_tx, '') AS to_address,
            {value}             AS value,
            {gas}               AS gas,
            {gas_price}         AS gas_price,
            input_tx            AS input,
            {max_fee}           AS max_fee_per_gas,
            {max_priority_fee}  AS max_priority_fee_per_gas,
            {tx_type}           AS transaction_type,
            {chain_id}          AS chain_id,
            regexp_replace(trim(access_list_tx), '\\s+', ' ', 'g') AS access_list,
            r_tx                AS r,
            s_tx                AS s,
            {v}                 AS v,
            {y_parity}          AS y_parity
        FROM flat
        ORDER BY transaction_hash, block_number, transaction_index
    """.format(
        block_number=small_int("block_number", "UINTEGER"),
        transaction_index=small_int("transaction_index", "USMALLINT"),
        nonce=small_int("nonce_tx", "UBIGINT"),
        value=int_str("value_lossless_tx"),
        gas=small_int("gas_tx", "UBIGINT"),
        gas_price=int_str("gas_price_tx"),
        max_fee=int_str("max_fee_per_gas_tx"),
        max_priority_fee=int_str("max_priority_fee_per_gas_tx"),
        tx_type=small_int("type_tx", "UTINYINT"),
        chain_id=small_int("chain_id_tx", "UBIGINT"),
        v=small_int("v_tx", "UBIGINT"),
        y_parity=small_int("y_parity_tx", "UTINYINT"),
    ))

    con.execute("""
        CREATE OR REPLACE TABLE token_transfers AS
        SELECT
            {block_number}      AS block_number,
            cast(block_timestamp AS TIMESTAMP) AS block_timestamp,
            block_hash,
            {transaction_index} AS transaction_index,
            transaction_hash,
            {event_index}       AS event_index,
            {batch_index}       AS batch_index,
            address,
            event_type,
            event_hash,
            event_signature,
            nullif(operator_address, '') AS operator_address,
            from_address,
            to_address,
            {token_id}          AS token_id,
            {quantity}          AS quantity,
            cast(removed AS BOOLEAN) AS removed
        FROM flat
        WHERE lower(is_token_transfer) = 'true'
    """.format(
        block_number=small_int("block_number", "UINTEGER"),
        transaction_index=small_int("transaction_index", "USMALLINT"),
        event_index=small_int("event_index", "UINTEGER"),
        batch_index=small_int("batch_index", "UINTEGER"),
        token_id=int_str("token_id"),
        quantity=int_str("quantity"),
    ))

    con.execute("""
        CREATE OR REPLACE TABLE blocks AS
        SELECT
            t.block_number,
            min(t.block_timestamp) AS block_timestamp,
            any_value(t.block_hash) AS block_hash,
            cast(count(*) AS USMALLINT) AS transaction_count,
            cast(coalesce(any_value(x.transfer_count), 0) AS UINTEGER) AS transfer_count
        FROM transactions t
        LEFT JOIN (
            SELECT block_number, count(*) AS transfer_count
            FROM token_transfers GROUP BY block_number
        ) x USING (block_number)
        GROUP BY t.block_number
    """)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="Repack a flat CSV export to canonical Parquet.")
    ap.add_argument("csv", type=Path, help="flat BigQuery CSV export")
    ap.add_argument("--out", type=Path, default=Path("data/parquet/v1"))
    ap.add_argument("--compression", default="zstd")
    args = ap.parse_args()

    if not args.csv.exists():
        print("no such file: {0}".format(args.csv), file=sys.stderr)
        return 1

    con = duckdb.connect()
    print("reading {0} ({1:.2f} GB) ...".format(args.csv, args.csv.stat().st_size / 1e9))
    build(con, args.csv)

    first, last = con.execute(
        "SELECT min(block_number), max(block_number) FROM blocks"
    ).fetchone()
    month = con.execute(
        "SELECT strftime(min(block_timestamp), '%Y/%m') FROM blocks"
    ).fetchone()[0]
    year, mm = month.split("/")

    files = []
    for table in TABLES:
        # cryo's naming convention: zero-padded so listings sort lexically.
        name = "ethereum__{0}__{1:08d}_to_{2:08d}.parquet".format(table, first, last)
        rel = Path(table) / "year={0}".format(year) / "month={0}".format(mm) / name
        dest = args.out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        con.execute("""
            COPY (SELECT * FROM {table} ORDER BY {sort})
            TO '{dest}'
            (FORMAT PARQUET, COMPRESSION {comp}, ROW_GROUP_SIZE {rg})
        """.format(
            table=table, sort=SORT_KEY[table], dest=dest.as_posix(),
            comp=args.compression, rg=ROW_GROUP[table],
        ))
        rows = con.execute("SELECT count(*) FROM {0}".format(table)).fetchone()[0]
        size = dest.stat().st_size
        files.append({
            "table": table,
            "path": rel.as_posix(),
            "block_start": first,
            "block_end": last,
            "rows": rows,
            "bytes": size,
            "sha256": sha256(dest),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        print("  {0:16} {1:>9,} rows  {2:8.2f} MB".format(table, rows, size / 1e6))

    # The manifest is written last, so a partially written chunk is never visible.
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": args.csv.name,
        "block_start": first,
        "block_end": last,
        "compression": args.compression,
        "files": files,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (args.out / "checksums.txt").write_text(
        "".join("{0}  {1}\n".format(f["sha256"], f["path"]) for f in files)
    )

    blocks = last - first + 1
    total = sum(f["bytes"] for f in files)
    print("\n{0} blocks -> {1:.2f} MB ({2:.4f} MB/block, {3})".format(
        blocks, total / 1e6, total / blocks / 1e6, args.compression))
    print("projected one year (2.63M blocks): {0:.0f} GB".format(
        total / blocks * 2_630_000 / 1e9))
    print("manifest: {0}".format(args.out / "manifest.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

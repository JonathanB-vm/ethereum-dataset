# Ingest pipeline: BigQuery → Parquet → ClickHouse

Date: 2026-09-08
Status: draft, pending user approval
Parent: `2026-09-08-scale-to-one-year-architecture.md`
Query draft: `sql/export_block_range.sql`

## Principles

1. **Never scan a source table without a partition filter.** The source tables are
   partitioned **by month** on `block_timestamp` (official schema page; see the industry
   comparison doc). Every query carries a `block_timestamp BETWEEN …` clause derived from
   the block range, in addition to the `block_number` range. Because the partition is
   monthly, one query touches at least one whole month of the selected columns, so
   **the backfill exports one month per query**, not one chunk per query, and the daily
   job re-reads the current month. This is the difference between under a dollar and
   tens of dollars per run.
2. **Only finalized blocks.** The job targets `head − 100`. Post-merge finality is ~13
   minutes (64 slots); 100 blocks is ~20 minutes, so reorgs never reach us and there is no
   reorg-handling code.
3. **Idempotent by chunk.** The unit of work is a 10,000-block chunk (aligned to multiples
   of 10,000, never crossing a month). A chunk is either fully published or absent.
4. **Parquet is the source of truth.** ClickHouse loads from the canonical Parquet in R2,
   never from BigQuery directly. A ClickHouse rebuild is a replay of the manifest.
5. **No pandas, no CSV in the middle.** `EXPORT DATA … FORMAT PARQUET` from BigQuery, then a
   repack step in DuckDB.

## Job steps

```
1. head        = MAX(block_number) in bigquery-public-data.…blocks      (tiny query)
2. target_end  = floor((head − 100) / 10000) × 10000 − 1                  (last complete chunk)
3. last_done   = highest chunk with status = done in ingest_log
4. for month in months covering (last_done + 1 … target_end):
     a. EXPORT DATA (transactions, token_transfers, blocks) for the month's block range
        → gs://staging/<month>/*.parquet (three statements from
        sql/export_block_range.sql; one scan of the month partition per table)
     then for each 10,000-block chunk inside that export:
     b. repack: DuckDB reads the month's shards for the chunk's range, sorts by the
        table's sort key, writes one file per table with ~250k-row groups (transactions)
        / ~500k (transfers), zstd, hex-string encoding for hashes and addresses → local tmp
     c. sha256 each file; upload to r2://eth-dataset/v1/<table>/year=/month=/blocks_a_b.parquet
     d. ClickHouse: INSERT INTO <table> SELECT … FROM s3('r2 url', 'Parquet')  (three tables;
        `input_format_parquet_import_nested = 1`, hex → FixedString via unhex(), STRING
        numerics (`quantity`, `token_id`, `value_lossless`) → UInt256, `v`/`y_parity` hex → int)
     e. verify: row counts in ClickHouse for the range == Parquet row counts
     f. ingest_log: chunk → done (row counts, sha256s, timings)
     g. delete gs://staging/<chunk>
5. rewrite manifest.json and checksums.txt from ingest_log (written last, atomically)
6. refresh column_stats (nightly only)
```

Any failure leaves the chunk in `failed`; the next run retries it. A chunk that was loaded
into ClickHouse but not logged is harmless: `ReplacingMergeTree` deduplicates the retry.

### Daily cadence and backfill

- **Daily job**: ~7,200 new blocks per day, so most days publish zero or one chunk. The job
  must exit quietly when there is nothing to do.
- **Backfill (M1)**: the same job with `last_done` reset to the start block of the year,
  running chunk after chunk. 263 chunks for a year. At roughly 2–4 minutes per chunk
  (export + repack + load), a year backfills in about a day on one worker; chunks are
  independent, so 4 workers finish in a few hours.
- **Five-year backfill (M3)**: identical, ~1,300 chunks. Block time before the merge
  (Sep 2022) was ~13–14 s, so the block count for a calendar span is lower than 12 s implies.

### Where it runs

- **Scheduler + worker**: GitHub Actions cron (free, 6-hour job limit, fine for daily) or
  Google Cloud Scheduler + Cloud Run Job (keeps the GCS traffic in-region). Backfill runs
  on the ClickHouse server itself to avoid moving 250 GB twice.
- **Language**: Python (`google-cloud-bigquery`, `duckdb`, `clickhouse-connect`, `boto3` for
  R2). The BigQuery and DuckDB tooling is most mature here.
- **Credentials**: a GCP service account with BigQuery job-user and staging-bucket write;
  an R2 API token scoped to the dataset bucket; ClickHouse user with INSERT only.

## Cost model

BigQuery on-demand pricing: $6.25 per TB scanned, first 1 TB per month free.

Source table sizes reported by a third party (unverified): transactions 4.08 TB,
token_transfers 1.60 TB, i.e. roughly 40–60 GB per recent month for the two tables we read.
Partitions are monthly, and clustering on `block_timestamp` may prune further inside a
month; the dry run reports the actual figure.

| Run | Scanned | Cost |
|---|---|---|
| Daily, partition-pruned (re-reads the current month, both tables) | ~40–100 GB | ~$0.25–0.60 (≈ $10–20 / month; zero while inside the free 1 TiB) |
| One-year backfill, one query per month | ~0.6–1.2 TB | ~$0–8 |
| Five-year backfill | ~3–6 TB | ~$20–40 |
| Any run without the `block_timestamp` filter | full tables, ~5.7 TB | ~$35 **per run** |

If the daily cost matters, run the job weekly instead: same freshness class for a
research dataset, one-seventh of the scans.

Guard: the job reads the dry-run estimate (`job_config.dry_run = True`) before every export
and aborts if `total_bytes_processed` exceeds a per-query ceiling (default 200 GB). This turns
a missing partition filter into a failed run instead of a surprise invoice.

GCS staging: pennies (short-lived). R2 class-A writes: negligible at ~3 files per chunk.

## Verification and monitoring

- Per chunk: row counts match across BigQuery result, Parquet and ClickHouse; `MAX(block_number)`
  equals the chunk end; every block in the range exists in `blocks`.
- Per run: alert (email or Slack webhook) on failure or when head − last_done exceeds
  30,000 blocks (~4 days), which usually means the public dataset is lagging.
- `ingest_log` is a small ClickHouse table (`chunk_start, chunk_end, table, rows, sha256,
  status, started_at, finished_at`) and doubles as the data source for the manifest and the
  "data current to block N" badge in the explorer.

## Parsing the STRING-typed numeric columns

The source types `v`, `y_parity`, `quantity`, `token_id` and `value_lossless` as STRING
(verified 2026-09-09). Their *formatting* is still open, and it decides how the repack step
parses them. This matters more than it looks: `try_cast('0x1' AS UBIGINT)` in DuckDB
returns NULL rather than raising, so if `v` arrives as hex and the pipeline assumes
decimal, every row silently loses its `v` and nothing fails.

`pipeline/repack.py` currently parses `v` and `y_parity` as integers, which is correct for
the CSV export in the repo (pandas had already numeric-ified them) but may not be for
Parquet straight out of `EXPORT DATA`. `sql/verify_schema.sql` query 5 settles it in one
cheap read. Until it is run, treat this as the open item most likely to cause silent data
loss on the first real export.

The 256-bit columns are unaffected: they stay decimal strings end to end and are never
cast to a fixed-width type.

## Schema drift

The public dataset is maintained by Google and can add columns or rename tables. The
export queries list columns explicitly, so an added column is ignored and a removed or
renamed column fails the run loudly. Adopting a new column is a schema version bump (`v2`
prefix in R2, new ClickHouse tables, a migration note in the data dictionary).

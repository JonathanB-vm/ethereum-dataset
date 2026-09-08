# Ingest pipeline: BigQuery → Parquet → ClickHouse

Date: 2026-09-08
Status: draft, pending user approval
Parent: `2026-09-08-scale-to-one-year-architecture.md`
Query draft: `sql/export_block_range.sql`

## Principles

1. **Never scan a source table without a partition filter.** The source tables are
   partitioned by `block_timestamp`. Every query carries a `block_timestamp BETWEEN …`
   clause derived from the block range, in addition to the `block_number` range. This is
   the difference between cents and tens of dollars per run.
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
4. for chunk in (last_done + 1 … target_end) step 10000:
     a. EXPORT DATA (transactions, token_transfers, blocks) → gs://staging/<chunk>/*.parquet
        (three statements from sql/export_block_range.sql with the chunk's range)
     b. repack: DuckDB reads the shards, sorts by the table's sort key,
        writes one file per table with 100k-row groups and zstd → local tmp
     c. sha256 each file; upload to r2://eth-dataset/v1/<table>/year=/month=/blocks_a_b.parquet
     d. ClickHouse: INSERT INTO <table> SELECT … FROM s3('r2 url', 'Parquet')  (three tables)
     e. verify: row counts in ClickHouse for the range == Parquet row counts
     f. ingest_log: chunk → done (row counts, sha256s, timings)
     g. delete gs://staging/<chunk>
5. rewrite manifest.json from ingest_log (written last, atomically)
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

| Run | Scanned | Cost |
|---|---|---|
| Daily, partition-pruned (one chunk) | ~3–5 GB | < $0.05 |
| One-year backfill, partition-pruned | ~1–2 TB | ~$0–10 |
| Five-year backfill | ~5–8 TB | ~$30–50 |
| Any run without the `block_timestamp` filter | full tables, ~4–6 TB | ~$30–40 **per run** |

Guard: the job reads the dry-run estimate (`job_config.dry_run = True`) before every export
and aborts if `total_bytes_processed` exceeds a per-chunk ceiling (default 20 GB). This turns
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

## Schema drift

The public dataset is maintained by Google and can add columns or rename tables. The
export queries list columns explicitly, so an added column is ignored and a removed or
renamed column fails the run loudly. Adopting a new column is a schema version bump (`v2`
prefix in R2, new ClickHouse tables, a migration note in the data dictionary).

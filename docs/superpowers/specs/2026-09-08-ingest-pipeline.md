# Ingest pipeline: BigQuery → Parquet → ClickHouse

Date: 2026-09-08
Status: draft, pending user approval
Parent: `2026-09-08-scale-to-one-year-architecture.md`
Query draft: `sql/export_block_range.sql`

## Principles

1. **Never scan a source table without a time filter.** The source tables are partitioned
   on `block_timestamp` and clustered on it too (both confirmed 2026-09-09 against the live
   `INFORMATION_SCHEMA`). Every query carries a `block_timestamp BETWEEN …` clause derived
   from the block range, in addition to the `block_number` range. This is the difference
   between a few gigabytes and a full-table scan.

   **A narrow time filter does prune — measured, and this corrected the spec.** Dry-run
   estimates on `transactions`, same 21 columns: one month of August 2026 is **86.51 GB**,
   one day is **3.51 GB**, a **24.6×** reduction. An earlier draft assumed a day-sized
   filter could not prune below a whole month partition and budgeted the daily job at a
   month's scan.

   The measurement cannot distinguish daily partitions from monthly partitions whose
   clustering prunes within them, and it does not need to: what the cost model depends on
   is how many bytes a filter removes, and a day-sized filter removes ~96% of a month.
   (Monthly-plus-clustering is the likelier reading — the official schema page says
   monthly, clustering on `block_timestamp` is confirmed, and the measured day is 1.26× a
   uniform 31st of the month, which is the approximate pruning clustering gives rather than
   the exact partition boundary a daily partition would.)

   The two jobs therefore want different windows:

   - **Backfill: one query per calendar month.** Reading each month exactly once costs
     0.94 TiB for a year of `transactions`, against 1.17 TiB for 365 day-sized queries —
     monthly is ~19% cheaper, because clustering prunes slightly worse than proportionally.
   - **Daily job: filter to the new blocks' time window only, never the whole month.** At
     ~3.5 GB a day instead of 86.5 GB, this is the single largest cost saving in the
     pipeline and it takes the recurring BigQuery bill to zero.

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
| Daily, new day only (`transactions`, measured) | 3.51 GB | ~107 GB/month → **$0**, inside the free 1 TiB |
| Daily, re-reading the whole month (the earlier plan) | 86.51 GB | ~2.4 TiB/month → ~$8.70 |
| One-year backfill, one query per month (`transactions`) | 1,038 GB = 0.94 TiB | **$0** after the free tier |
| One-year backfill, one query per day (`transactions`) | 1,281 GB = 1.17 TiB | ~$1.06 |
| Any run without the `block_timestamp` filter | full tables, ~5.7 TB | ~$32 **per run** |

Figures are `transactions` only, measured 2026-09-09 on August 2026 with the 21 columns
the export actually selects. `token_transfers` is the smaller table and its own dry run is
still outstanding; on the reported table sizes (1.60 TB against 4.08 TB) it should add
roughly 40%, which leaves both the daily job and the backfill inside the free tier.

**The recurring BigQuery line is therefore ~$0, not the $10–20/month first budgeted.**
Cost only appears if the time filter is lost, which is exactly what the dry-run guard
prevents.

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

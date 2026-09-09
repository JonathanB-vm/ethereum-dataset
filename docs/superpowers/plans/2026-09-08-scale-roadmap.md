# Roadmap: from one block to one year (and then five)

Date: 2026-09-08
Status: draft, pending user approval
Specs: `docs/superpowers/specs/2026-09-08-*.md`

**Goal:** serve one year of Ethereum mainnet transactions and token transfers (~2 B rows)
through the existing explorer, a public API and downloadable Parquet, at ~$70–130 / month,
with automatic daily refresh from BigQuery.

## M0 — Measure and decide (days)

- [x] Run `node scripts/measure-csv.mjs analytics_25534200_25534299.csv` on the 100-block file; update the sizing tables in the architecture spec. *(Done: 749 records and 406 transactions per block, 21.95 MB flat per block, 96.9% of bytes `input_tx` with 98.6% duplicated.)*
- [x] Produce real Parquet with `pipeline/repack.py` and measure it, replacing the last estimate in the cost model. *(Done: 0.1028 MB/block → **270 GB/year**, against the ~250 GB estimate. Row counts verified against the source: 40,642 transactions, 43,941 transfers, 100 blocks, no unexpected nulls, 37-digit quantities intact.)*
- [x] Verify column names and the partition column of the three source tables in the BigQuery console; fix `sql/export_block_range.sql`. *(Done 2026-09-09 via `sql/verify_schema.sql`. All 42 selected columns exist with the expected types — **no changes needed to the export query**. Confirmed `access_list` is REPEATED, and `value` is BIGNUMERIC, whose 76-digit ceiling cannot hold uint256's 78.)*
- [x] Confirm the partition column. *(Done 2026-09-09: `block_timestamp` on all three tables, and it is also the sole clustering column — matching the third-party field report.)*
- [ ] Confirm the partition **granularity** is monthly. The DDL route is closed — BigQuery returns an empty `ddl` for a public dataset you do not own. Settle it by measurement instead: compare the dry-run estimate of a one-day filter against a one-month filter (`verify_schema.sql` 3 vs 3c). Equal means monthly; ~31× smaller means daily and a cheaper daily job than budgeted.
- [ ] Dry-run the export query for one 10,000-block chunk and record `total_bytes_processed`.
- [ ] **Decide: signature columns (`r`, `s`, `v`, `y_parity`) kept or dropped.** Measured at **76 GB/year, 28% of the footprint** — the largest storage lever in the project. Needs the research group.
- [ ] Decide: hosting (dedicated server vs. ClickHouse Cloud vs. institutional server). Sizing input is settled by measurement: ~409 GB of ClickHouse disk for one year, ~1.6–2.1 TB for five, so ~450 GB of NVMe with merge headroom.
- [ ] Decide: API language (TypeScript recommended).
- [ ] Decide: 10,000 blocks per Parquet file (spec) vs 8,192 (era1 convention) vs 1,000 (cryo default).
- [x] Decide: hex strings (spec, matches BigQuery/AWS) vs binary (cryo) in the published Parquet. *(Resolved by measurement: hex costs 270 GB/year vs 252 GB for binary — a 6.7% premium, ~$0.27/month on R2. **Keep hex**; pandas/DuckDB convenience is worth far more than 18 GB.)*
- [ ] Create the R2 bucket (versioning on) and the GCS staging bucket; provision credentials. *(First item that needs a card.)*

## M0.5 — Groundwork that needs no account (in progress)

Everything here runs against the 2.19 GB export already on disk, with DuckDB and a local
ClickHouse in Docker standing in for BigQuery and the server. The format contract, the
schema, the API and the frontend are all exercised for real before a single bucket exists.

- [x] `pipeline/repack.py` — flat CSV → three normalized tables → sorted, zstd, checksummed Parquet + manifest.
- [x] `pipeline/clickhouse/schema.sql` — fact tables, address index tables + MVs, `block_stats`, `ingest_log`.
- [x] Load the local Parquet into a Docker ClickHouse; measure real on-disk size, compression ratio and skip-index size. *(Done: **409 GB/year** against the 380 GB projection. Found and fixed two schema bugs that only appear when the DDL is actually run — see `pipeline/clickhouse/`. Every derived structure verified against the fact tables. Latency targets remain unvalidated: 100 blocks fit in page cache.)*
- [x] `pipeline/clickhouse/load.sql` — hex→binary and decimal-string→UInt256 casts; the local stand-in for the production `s3()` load.
- [x] Ingest planning and cost guard (`pipeline/planning.py`): finality lag, chunk alignment, month partitions, dry-run byte ceiling. 28 tests. *(The BigQuery client itself still needs an account.)*
- [x] API service against local ClickHouse (`api/`): endpoints, cursor pagination, scope enforcement, caps, cache headers, rate-limit headers. 103 tests.
- [x] `/v1/records`, the flat 35-column join — reconstructs the source CSV exactly (74,889 rows), proving the normalization is lossless.
- [x] Frontend seam: `QueryProvider`, `ApiQueryProvider`, `MemoryQueryProvider`, and one contract suite over a recorded API fixture.
- [x] `pipeline/README.md` — how to run the whole stack locally, and what it does and does not prove.
- [ ] Rewire the UI: table in manual pagination/sorting/filtering mode, filters to query params, block picker, stats band from the API. Wants the API deployed to review against.
- [ ] Ingest orchestration end to end (needs BigQuery, GCS and R2 credentials).

## M1 — One year, end to end (weeks)

Pipeline
- [ ] Ingest job skeleton: head discovery, chunking, `ingest_log`, dry-run cost guard.
- [ ] Export step (three `EXPORT DATA` statements per chunk) → GCS staging.
- [ ] Repack step (DuckDB): sort, 100k-row groups, zstd, sha256; upload to R2.
- [ ] ClickHouse DDL from the data-model spec: fact tables, index tables + MVs, `block_stats`.
- [ ] Load step (`INSERT … SELECT FROM s3()`), verification, manifest writer.
- [ ] Backfill one year (parallel workers); confirm on-disk size and query latencies against the targets.
- [ ] Daily schedule + failure alert.

API
- [ ] Service with `/v1/head`, block/range pages, tx-by-hash, address pages, stats, column stats.
- [ ] Cursor pagination, limits, read-only ClickHouse user, immutable caching headers.
- [ ] Synchronous CSV export (≤ 100k rows).

Explorer
- [ ] New `DataProvider` interface; `apiProvider`; CSV provider adapted for tests.
- [ ] Table in manual pagination/sorting/filtering mode; filters → query params.
- [ ] Block picker/range, typed global search, "current to block N" badge.
- [ ] Stats band and dictionary stats from the API.
- [ ] Deploy: ClickHouse + API + explorer on one server behind Caddy + Cloudflare.

Exit criteria: a researcher can open the explorer, pick any block range in the year,
filter, sort and export a page; p95 latencies meet the architecture spec; the daily job has
run unattended for a week.

## M2 — Distribution (weeks)

- [ ] Downloads page with manifest, checksums, DuckDB/pandas snippets, schema JSON.
- [ ] Async export jobs (≤ 5 M rows, CSV/Parquet, R2 link).
- [ ] First tagged release (`2026.xx`) with citation text; Hugging Face Datasets mirror; DOI.
- [ ] `docker-compose` "researcher VM": ClickHouse + a loader that pulls chosen months from R2.
- [ ] Usage docs: data dictionary, known caveats (`removed` flag, contract-creation `to_address`), examples.
- [ ] Decide: offer a read-only SQL endpoint with CryptoHouse-style limits.

## M3 — Five years (days of compute, little new code)

- [ ] Grow the disk (3–4 TB NVMe) or move to ClickHouse Cloud.
- [ ] Backfill 10–13 M blocks with the same job; watch the per-chunk cost guard.
- [ ] Re-check address-index sizes and stats latencies at 5× scale.

## M4 — Public release

- [ ] API keys, per-key rate limits, usage dashboard.
- [ ] Status page for ingest lag; public changelog per release.
- [ ] Announce to the research community.

# Roadmap: from one block to one year (and then five)

Date: 2026-09-08
Status: draft, pending user approval
Specs: `docs/superpowers/specs/2026-09-08-*.md`

**Goal:** serve one year of Ethereum mainnet transactions and token transfers (~2 B rows)
through the existing explorer, a public API and downloadable Parquet, at ~$70–130 / month,
with automatic daily refresh from BigQuery.

## M0 — Measure and decide (days)

- [ ] Run `node scripts/measure-csv.mjs analytics_25534200_25534299.csv` on the 100-block file; update the sizing tables in the architecture spec.
- [ ] Verify column names and the partition column of the three source tables in the BigQuery console; fix `sql/export_block_range.sql`.
- [ ] Dry-run the export query for one 10,000-block chunk and record `total_bytes_processed`.
- [ ] Decide: signature columns (`r`, `s`, `v`, `y_parity`) kept or dropped.
- [ ] Decide: hosting (dedicated server vs. ClickHouse Cloud vs. institutional server).
- [ ] Decide: API language (TypeScript recommended).
- [ ] Create the R2 bucket (versioning on) and the GCS staging bucket; provision credentials.

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

## M3 — Five years (days of compute, little new code)

- [ ] Grow the disk (3–4 TB NVMe) or move to ClickHouse Cloud.
- [ ] Backfill 10–13 M blocks with the same job; watch the per-chunk cost guard.
- [ ] Re-check address-index sizes and stats latencies at 5× scale.

## M4 — Public release

- [ ] API keys, per-key rate limits, usage dashboard.
- [ ] Status page for ingest lag; public changelog per release.
- [ ] Announce to the research community.

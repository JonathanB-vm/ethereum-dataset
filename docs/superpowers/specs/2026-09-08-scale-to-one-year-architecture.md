# Scaling the explorer to one year of blocks — architecture

Date: 2026-09-08
Status: draft, pending user approval
Companion specs: `2026-09-08-data-model.md`, `2026-09-08-ingest-pipeline.md`,
`2026-09-08-api-and-frontend.md`. Roadmap: `docs/superpowers/plans/2026-09-08-scale-roadmap.md`.

## Problem

The explorer today is a browser-only SPA that loads the whole dataset up front
(`public/data/rows.csv.gz`, 100 blocks, 74,889 records, with calldata fetched per row from
256 gzipped shards) and sorts, filters, aggregates and exports entirely in the client. The
research group wants:

1. **Next milestone:** one year of mainnet blocks (~2.63 M blocks at 12 s per block).
2. **Later:** the last five years (~10–13 M blocks), everything the source dataset carries.
3. A product researchers can use and pass around: browse, query, download, and eventually an API.

The client-side model stops working at roughly 50,000 rows. One year is ~2 billion rows.
Nothing in the current data path survives the jump, while the UI layer largely does.

## Sizing (measured, then extrapolated)

Measured on the 100-block export in the repo (`analytics_25534200_25534299.csv`, blocks
25,534,200–25,534,299, 2026-07-14) with `node scripts/measure-csv.mjs <file>`. The earlier
draft of this table extrapolated from a single block; those figures are kept in the last
column so the correction is visible.

| Per block | Measured (100 blocks) | Earlier 1-block draft |
|---|---|---|
| Records in the current flat join | 749 (439 transfers + 309 plain transactions) | 600 (504 + 96) |
| Unique transactions | 406 | 256 |
| Flat CSV size | 21.95 MB (96.9% of bytes are `input_tx`, 98.6% of those are duplicates of the same tx) | 6.5 MB (78% / 94%) |
| Deduped, gzip (`rows.csv.gz` + `calldata/*.json.gz`) | 0.161 MB | 0.15 MB |
| Normalized, Parquet + zstd | **0.1028 MB (measured)** | ~0.10 MB (estimate) |

The gzip row is measured on the artifacts the prep script already produces (12.05 MB of
rows plus 4.01 MB of deduped calldata per 100 blocks). It is an **upper bound** on the
normalized size: `rows.csv.gz` is still the flat join, so transaction columns are repeated
on every transfer row. Event mix over the 100 blocks: 43,595 ERC-20, 292 ERC-721,
54 ERC-1155. 12,220 of 40,642 transactions (30%) carry calldata; 2,175 rows carry a numpy
`array(...)` repr in `access_list_tx`, confirming that column is unparseable as exported.

| Extrapolated | One year (2.63 M blocks) | Five years (10–13 M blocks) |
|---|---|---|
| Transactions | ~1.07 B rows | ~4.1–5.3 B rows |
| Token transfers | ~1.16 B rows | ~4.4–5.7 B rows |
| Flat CSV, uncompressed | ~58 TB | ~220–285 TB |
| Normalized Parquet + zstd | **270 GB (measured)** | ~1.0–1.4 TB |
| ClickHouse on disk (incl. indexes, MVs) | **409 GB (measured)** | ~1.6–2.1 TB |

The five-year row is an over-estimate: it applies today's 406 transactions per block to
blocks going back to 2021, when per-block activity was materially lower. Treat it as a
ceiling for disk sizing, not a forecast.

### Where the bytes actually go

Produced by running `pipeline/repack.py` on the 100-block export and reading the Parquet
column statistics — no cloud account involved. Per-year figures scale the 100-block
measurement by 26,300.

| Column | GB / year | Share |
|---|---|---|
| `transactions.input` (calldata) | 75.6 | 28% |
| `transactions.r` + `.s` (signatures) | 76.0 | 28% |
| `transaction_hash` (both tables) | 47.2 | 18% |
| addresses (`from`/`to`/`token`, both tables) | 47.6 | 18% |
| everything else | ~23 | 8% |
| **total** | **270** | |

Two of those five lines are optional, which turns the storage figure into a choice:

| Option | GB / year | Note |
|---|---|---|
| A. hex strings, keep signatures | **270** | as specified today |
| B. binary hashes/addresses, keep signatures | 252 | −6.7%, costs researcher convenience |
| C. hex strings, drop `r`/`s`/`v`/`y_parity` | **194** | −28%, needs the research group's sign-off |
| D. binary + drop signatures | 182 | −33% |

The two open decisions in the roadmap are therefore worth very different amounts. Hex
versus binary is a 6.7% question and the spec's answer (hex, for pandas compatibility)
stands cheaply. Signatures are a 28% question — by far the largest storage lever left, and
the one that decides between a 1 TB and a 2 TB disk at five-year scale.

### ClickHouse on disk (measured on a local server)

The full schema was created on a ClickHouse 26.8 container and loaded from the Parquet
above — no cloud account, no hosting decision required first.

| Table | On disk | Rows | Compression |
|---|---|---|---|
| `transactions` | 8.83 MiB | 40,642 | 4.76× |
| `token_transfers` | 1.86 MiB | 43,941 | 5.81× |
| `tx_by_hash` | 1.44 MiB | 40,642 | 1.02× |
| `transfers_by_address` | 1.27 MiB | 131,877 | 3.06× |
| `tx_by_address` | 1.04 MiB | 81,257 | 2.01× |
| `block_stats` | 235 KiB | 100 | — |
| **total (incl. skip indexes and marks)** | **14.84 MiB / 100 blocks** | | |

That is **409 GB per year**, against the 380 GB projected from the Parquet size — the
derived structures cost slightly more than assumed. The three address/hash index tables are
25% of the total, and `tx_by_hash` is the priciest per row (37 bytes) because a 32-byte
hash does not compress. Skip indexes are cheap: 153 KiB across both fact tables.

A one-year server therefore needs ~450 GB of NVMe with headroom for merges, and five years
~2 TB. Both sit comfortably inside the hardware already priced below.

**What this does not prove.** 100 blocks fit entirely in page cache, so the latency targets
in this spec remain unvalidated — they need a real backfill. What is validated is the
schema, the load path, the storage ratio and the correctness of every derived structure.

**What the re-measurement changed.** The flat CSV is 3.4× larger per block than the
single-block draft assumed, but the *compressed* figure — the one that sets the storage
bill — landed at 270 GB against the draft's ~250 GB, because nearly all the extra bytes are
duplicated calldata that dedupes away. Storage cost and server sizing stand. Row counts do
not: transactions come in at 1.6× the draft, which raises the cost of the per-row
structures (address index tables, bloom filters) and, in particular, the signature columns
— `r` and `s` measure **76 GB / year**, against ~43 GB in the first draft and ~68 GB in the
row-count correction. At 28% of the footprint that makes the keep-or-drop decision on
signatures the largest storage lever in the project.

Two conclusions drive the design: normalization alone is a 4× saving even after
compression, and a year fits on one NVMe disk. This is mid-sized data: too big for a
browser or vanilla Postgres, comfortably small for one columnar database server.

## Goals and non-goals

Goals:
- Serve interactive browsing (page of 50 rows, filters, sort) in well under one second.
- Serve lookups by block, block range, time range, transaction hash and address.
- Publish the dataset as downloadable, citable, versioned Parquet.
- Refresh automatically and cheaply from BigQuery.
- Keep total monthly cost in the low hundreds of dollars or less.

Non-goals (this phase):
- Real-time (sub-minute) freshness. Daily is fine; hourly is possible.
- Arbitrary SQL from the public. Heavy analysis runs on the researcher's machine over Parquet.
- Decoding contract calls / event ABIs beyond what the source dataset carries.

## Architecture

```
BigQuery public dataset (Google runs this compute)
        │  daily job: EXPORT DATA … PARQUET for finalized block ranges
        ▼
GCS staging bucket (raw export shards, short retention)
        │  repack: sort by block, fixed row groups, checksum, manifest
        ▼
R2 bucket  ── canonical Parquet, partitioned by month/table ── downloads, DuckDB-over-HTTP
        │  ClickHouse INSERT … SELECT FROM s3()
        ▼
ClickHouse (one server) ── sorted tables, skip indexes, address index tables, stats MVs
        │
API (cursor pagination, caps, immutable caching) ──▶ CDN ──▶ React explorer (existing UI)
```

**Two storage layers, with a clear source of truth.**

- **Cold / canonical: Parquet in object storage.** This is the dataset. Partitioned by
  month and table, sorted by block, fixed row-group size, with a manifest (block range, row
  count, bytes, sha256 per file) and a schema version. Everything else can be rebuilt
  from it. Cloudflare R2 is preferred over GCS/S3 because egress is free: a researcher
  pulling 250 GB costs $0 on R2 and ~$30 on GCS.
- **Hot / derived: ClickHouse.** Columnar, compresses internally, handles billions of rows
  on one machine, and the ClickHouse docs contain a worked "Ethereum blockchain data"
  example that follows exactly this BigQuery → Parquet → ClickHouse path. Because it is
  derived, it needs no backups: a rebuild is a re-load from R2.

**Rejected alternatives.**
- Postgres / TimescaleDB: 2 B rows with address indexes is painful and slow to load.
- BigQuery as the live backend: seconds per query, billed per scan, unusable behind a UI.
- DuckDB as the server: excellent for one user over Parquet, not a multi-user server.
- Keeping the flat 35-column join as the storage format: 10× the bytes, unparseable
  `access_list_tx` (numpy repr with embedded newlines), duplicated `input_tx`.

## Who provides the compute

| Usage mode | Compute runs on | Who pays |
|---|---|---|
| Browsing in the explorer (pages, filters, stats) | Our ClickHouse server | Us (the server line below) |
| Public API | Our server, behind rate limits and row caps | Us |
| Download Parquet, analyze in DuckDB / pandas | Researcher's machine | Us: storage only (egress free on R2) |
| DuckDB querying Parquet remotely over HTTP | Researcher's machine | Us: bandwidth only |
| Daily ingest from BigQuery | Google | Us: per TB scanned |
| "VM for researchers" | Either a docker-compose they run (they pay) or a hosted notebook (we pay) | Depends |

Rule: we provide compute for interactive browsing only, with hard limits (row cap,
query timeout, rate limit). Heavy research runs on the researcher's hardware over Parquet.
One server then serves dozens of researchers because the heavy work never touches it.

## Hosting and cost

Recommended for M1 (one year): one dedicated server + R2 + Cloudflare CDN.

Prices verified 2026-09-08 (details and sources in the industry comparison doc).

| Component | One year | Five years |
|---|---|---|
| Dedicated server (Hetzner AX52: Ryzen 7 7700, 64 GB, 2×1 TB NVMe ≈ €64 / month; AX102: 128 GB, 2×1.92 TB NVMe, quoted €122–259 / month, verify) or an institutional server | ~$70–130 / month | ~$150–280 / month, needs ≥ 3 TB NVMe |
| R2 storage ($0.015 / GB-month, egress $0) | ~270 GB → ~$4 | ~1 TB → ~$15 |
| Cloudflare CDN (free tier) | $0 | $0 |
| BigQuery ingest (monthly partitions; the daily job re-reads the current month) | ~$10–20 / month, or ~$2 if run weekly | same |
| **Total** | **~$85–155 / month** | **~$170–315 / month** |

Alternative with less operations: ClickHouse Cloud. The Basic tier (~$186 / month 24×7,
fixed 8 GB RAM / 2 vCPU) is **capped at 1 TB of storage and cannot scale**, so it fits one
year only just and five years not at all; the Scale tier starts around $499 / month plus
$25.30 / TB-month storage and $0.1152 / GB internet egress (exports out of ClickHouse Cloud
are billed). An institutional server with NVMe drops the compute line to zero.

One-time BigQuery backfill: ~0.6–1.2 TB scanned for one year (~$0–8 after the free
1 TiB / month), ~3–6 TB for five years (~$20–40). The only budget hazard is a query without
a partition filter: a full scan of the two source tables is ~5.7 TB, ~$35 per run, i.e.
~$1,000 / month for a daily job. The ingest spec makes the partition filter mandatory and
adds a dry-run byte ceiling.

## Performance targets

Measured at the API, one year of data, single server, p95:

| Query | Target | Mechanism |
|---|---|---|
| Block / block range / time range page | < 100 ms | primary sort key |
| Page of 50 rows with sort + filters within a block range | < 200 ms | sort key + skip indexes |
| Transaction by hash | < 50 ms | hash lookup table |
| Address → transactions / transfers page | < 200 ms | address index tables |
| Stats for a block range or day range | < 100 ms | materialized aggregates |
| Ad-hoc aggregation over a full year | 10–60 s | acceptable for API-key users only, capped |
| Synchronous CSV export | ≤ 100k rows, streaming | server-side |
| Asynchronous export | ≤ 5 M rows, link to R2 | job queue |

Download times are bandwidth-bound: one month of transfers (~10 GB) is ~15 min at
100 Mbps; a full year (~250 GB) is ~5.5 h at 100 Mbps or ~35 min at 1 Gbps. A remote
DuckDB query over R2 that touches one contract for one month reads 50–500 MB.

## Techniques used, by effect

Shrink the data: normalize (store `input` once per tx); store addresses and hashes as
bytes, not hex strings; per-column codecs (Delta+ZSTD on block numbers and timestamps,
LowCardinality on enums); drop `value_tx` (duplicate of `value_lossless_tx`); confirm with
researchers whether the ECDSA signature columns (~68 GB / year, incompressible) are needed.

Speed up lookups: sort key = access pattern `(block_number, transaction_index, …)`; bloom
filters on hashes and addresses, minmax on timestamps; small address index tables fed by
materialized views; block-level stats materialized at ingest; keyset (cursor) pagination,
never OFFSET; `Cache-Control: immutable` on any response whose block range is finalized.

Cheapen the pipeline: partition-pruned BigQuery queries; ingest only blocks ≥ 100 behind
head (finality, so no reorg handling); idempotent chunk loads with an ingest log; ClickHouse
loads straight from the bucket.

Serve researchers: Parquet by month and table, sorted, row groups aligned to block ranges;
manifest + checksums + schema version; zero-egress hosting; a Hugging Face Datasets mirror
for a DOI and free public hosting.

## Industry precedent

A survey of how BigQuery, ClickHouse's own Ethereum example, CryptoHouse, Dune,
Blockscout, Etherscan, Otterscan, AWS Public Blockchain Data, cryo, Sourcify and the
Ethereum Foundation's era1 archives handle the same problems, and a line-by-line
comparison with these specs, is in `2026-09-08-industry-practice-comparison.md`. The
short version: the architecture matches what the field converged on (columnar store,
`ReplacingMergeTree`, keyset pagination, Parquet in a bucket, address-keyed side
structures), and this design is ahead of practice on checksums, immutable caching and
lossless 256-bit values.

## Risks and open questions

- ~~**Estimates rest on one block.**~~ Resolved: re-measured on the 100-block export (see
  Sizing). Compressed storage held within 7%; row counts rose ~1.6× for transactions. The
  sample is still 20 minutes of one day, so it carries no seasonal or pre-merge variation.
- **Source dataset column names** in `sql/export_block_range.sql` were written from memory;
  verify against the BigQuery schema tab before the first run.
- ~~**Source freshness.**~~ Largely resolved: measured 2026-09-09, the dataset's head block
  was 25,939,422 at 11:09 UTC, roughly two hours behind wall clock — far fresher than the
  daily cadence needs. The ingest job must still tolerate "nothing new" runs, and one
  reading is not an SLA, so the lag alert stays.
- **Coverage confirmed.** The dataset runs from block 0 to head, so the five-year milestone
  needs no additional source. Block rate measured over the 405,222 blocks between the
  sample and head: **12.04 s/block, ~2.62 M blocks/year**, against the 2.63 M this spec
  assumed — a 0.4% difference, so every extrapolation here stands.
- **Single server.** ClickHouse is rebuildable from R2, so the failure mode is downtime, not
  data loss. Enable R2 object versioning to protect the canonical layer.
- **Signature columns**: keep or drop (decision needed from the research group).
- **Language split**: TypeScript API (shares types with the React app) vs. Python (matches
  the BigQuery/DuckDB tooling of the ingest job). Recommendation in the API spec.

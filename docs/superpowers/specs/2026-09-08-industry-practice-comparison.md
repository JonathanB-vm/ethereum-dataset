# Industry practice survey and comparison with the scale-up specs

Date: 2026-09-08
Status: research note; feeds corrections into the 2026-09-08 specs
Scope: how established projects store, publish and serve bulk Ethereum data, compared
line by line with `2026-09-08-scale-to-one-year-architecture.md`, `…-data-model.md`,
`…-ingest-pipeline.md` and `…-api-and-frontend.md`.

Method: web research on 2026-09-08. Several primary sites (clickhouse.com, hetzner.com,
duckdb.org, docs.goldsky.com, blockchair.com, huggingface.co, zenodo.org, arxiv.org) were
unreachable from the research environment; where that happened, facts were taken from the
projects' GitHub sources or from search-engine snippets and are marked *(snippet)*.
Anything marked *(unverified)* should be checked before it is relied on.

## 1. Who was surveyed

| Project | What it is | Why it matters here |
|---|---|---|
| Google BigQuery `blockchain_analytics_ethereum_mainnet_us` | Our source dataset | Its partitioning and column types set our ingest cost and schema |
| Google's original `crypto_ethereum` pipeline (ethereum-etl + Airflow) | How Google built the public dataset | Reference for idempotent, verified batch loads |
| ClickHouse official Ethereum example + BigQuery migration guide | Same data, same target engine | Reference DDL and measured load times |
| CryptoHouse (ClickHouse + Goldsky, crypto.clickhouse.com) | Free public SQL over Ethereum/Base/Solana | A live ClickHouse deployment serving the public |
| AWS Public Blockchain Data (`s3://aws-public-blockchain`) | Daily Parquet dumps, open data registry | Closest precedent for "Parquet in a bucket" |
| Paradigm `cryo` | The de-facto tool for extracting chain data to Parquet | Sets researcher expectations for file naming, types |
| Sourcify Parquet export | Append-only Parquet export with a lessons-learned v1 → v2 | Manifest and checksum practice |
| Ethereum Foundation era1 / e2store, EIP-4444 | Protocol-level standard for historical block archives | Chunking and integrity conventions |
| Blockchair dumps, XBlock-ETH, Zenodo record 3906690 | Daily TSV dumps; the main academic Ethereum dataset | What researchers already download and cite |
| Hugging Face Datasets, Zenodo | Hosting with DOIs | Distribution and citation |
| ClickHouse community discussion #72182, Postgres-based indexers | Practitioners hitting the same wall | Engine choice and reorg handling |

## 2. Findings by topic

### 2.1 The source: BigQuery dataset facts that change our plan

- **Partitioning is MONTHLY on `block_timestamp`** for every table (official schema page).
  A third-party field report adds that clustering is only on `block_timestamp`, so the
  monthly partition is the main pruning lever. Reported table sizes: transactions 4.08 TB,
  token_transfers 1.60 TB, logs 3.70 TB, traces 13 TB *(snippet, third party)*.
- **Column names and types** (from a BigQuery metadata dump of the dataset): `transactions`
  has `transaction_type` (not `type`), `value BIGNUMERIC` plus `value_lossless STRING`,
  `access_list RECORD{address, storage_keys}`, and `r, s, v, y_parity` all `STRING`.
  `token_transfers.quantity` and `token_id` are `STRING`. `blocks` has `transaction_count`
  and a `withdrawals RECORD`. Whether `access_list` is REPEATED is not in the dump *(unverified)*.
- Google also ships **`transactions_by_from_address` and `transactions_by_to_address`**,
  full copies of `transactions` organised by address, and recommends "clustered
  materialized views" on address fields for address-filtered queries.
- Storage of the public dataset is free; only query bytes are billed. Update latency for
  this dataset is not documented anywhere reachable *(unverified)*. The older community
  `crypto_ethereum` dataset is ~4 minutes behind the chain.

### 2.2 How Google built its pipeline (cloud.google.com blog)

- Two phases, export then load, orchestrated by Cloud Composer (Airflow). Export writes
  daily files to GCS; load runs `load → enrich → verify` tasks.
- "All operations in the workflow are atomic and idempotent." They **reload partitions
  instead of appending**, because a retried append would duplicate rows; BigQuery
  partition replacement (`table$20180623`) is the mechanism.
- They avoided streaming because of consistency and reorgs, and planned a lambda layout:
  the last day eventually consistent, all earlier days strongly consistent.
- Block ranges are derived from dates (`get_block_range_for_date`), so tasks are stateless.

### 2.3 ClickHouse: official example, migration guide, docs, community

- **Official Ethereum example DDL** (github.com/ClickHouse/examples): hashes and addresses
  as plain `String`; `value Decimal(38,0)`; `block_number UInt32 CODEC(Delta(4), ZSTD(1))`;
  `block_timestamp DateTime CODEC(Delta(4), ZSTD(1))`; `ENGINE = MergeTree ORDER BY
  (block_timestamp, block_number)`; no `PARTITION BY`, no skip indexes. No token_transfers
  table in the example.
- **Official BigQuery → ClickHouse guide**: `EXPORT DATA OPTIONS (format='PARQUET')` to GCS,
  then `INSERT … SELECT FROM s3()`; measured on the 4 TB public Ethereum dataset: export
  8 min, import 54 min. Tips: wrap nullable columns in `ifNull()`, set
  `input_format_parquet_import_nested = 1` for STRUCT columns.
- **CryptoHouse** (public, free): `ReplacingMergeTree`, `ORDER BY (block_timestamp,
  block_slot, signature)` on Solana tables (the Ethereum DDL is not published); hashes as
  `String`; amounts as `Decimal(76, 38)`; materialized views give approximate aggregates
  and `FINAL` gives exact ones. Claimed >20× compression versus CSV *(snippet)*. Public
  users get quotas; heavier use goes to a dedicated instance.
- **Docs guidance**: bloom_filter default false-positive rate 0.025, `GRANULARITY` default 1,
  only `equals`/`in` predicates; skip indexes work best when the column correlates with
  the primary key and must be tested on real data. **Projections are not supported
  together with lightweight deletes or `FINAL`**, MergeTree only, and double the write
  cost; materialized views are the tool for separate target tables. Partition keys should
  have under 100–1,000 distinct values; monthly is the usual choice and "partitioning is a
  data management technique, not a query optimization tool". `UInt256` is native and
  holds the full 2^256 range. `FixedString(N)` is only efficient for strictly fixed-length
  values (the docs' own example is SHA-256 as `FixedString(32)`).
- **Community (#72182)**: a Postgres indexer at millions of rows hit 30 s queries;
  ClickHouse maintainers recommended `ReplacingMergeTree`, warned that lightweight deletes
  do not fit reorg handling, and suggested an immutable "main" range plus a small mutable
  tail (latest hour/day) that queries union.

### 2.4 Publishing bulk files: what the field actually does

| Project | Format | Chunking | Compression | Integrity / manifest | Encoding |
|---|---|---|---|---|---|
| AWS Public Blockchain | Parquet, Hive `date=YYYY-MM-DD/` | one day | Snappy | none | hex strings; `value` as **double (lossy)** |
| cryo | Parquet (CSV/JSON optional) | **1,000 blocks per file** (default, `--align`), names `ethereum__transactions__00000000_to_00000999.parquet` | lz4 default | Parquet stats on | **binary** columns by default; u256 as binary + string + f64 columns |
| era1 (EF standard) | e2store, snappy-framed RLP | **8,192 blocks per file** | snappy | `checksums.txt` (sha256) + accumulator roots; `geth download-era` verifies | binary |
| Sourcify export | Parquet | 1 M rows per file, append-only | (n/a) | v1 had a `manifest.json` **without checksums** and regenerated every file; v2 dropped the manifest, relies on bucket ETag/MD5 | hex strings |
| Blockchair | TSV.gz, one file per table per day | one day | gzip | none | hex strings |
| XBlock-ETH (academic) | ZIP of CSV | 1 M blocks per file, later 250 k | zip | none | hex strings |
| Zenodo 3906690 | CSV | 1 M blocks per file, 10 files, 27.4 GB | none | Zenodo DOI | hex strings |
| BigQuery (source) | columnar, query only | month partitions | (managed) | (managed) | hex strings; lossless value as STRING |

Observations: nobody in the survey defaults to zstd (lz4, snappy, gzip); only the EF
standard ships checksums; only cryo stores binary; the two largest public Parquet sets
(AWS, cryo) disagree on how to store 256-bit values, and AWS chose a lossy double.

### 2.5 Hosting with DOIs

- **Hugging Face Datasets**: public storage is "best-effort" with no fixed quota (PRO up to
  10 TB); hard max 500 GB per file, recommended under 50 GB; under 100 k files per repo and
  10 k per folder. Parquet repos get the full-dataset viewer (sort/filter on the first
  5 GB), `hf://datasets/...` paths readable directly from DuckDB, a `/parquet` listing
  API, and **DataCite DOIs, one per version**; after a DOI is minted the repo can no longer
  be deleted or renamed without support.
- **Zenodo**: 50 GB and 100 files per record, one-time increase to 200 GB on request,
  per-version DOIs *(snippet)*. Fits a subset, not the whole dataset.
- **FAIR**: the DOI alone is not enough; DataCite requires Identifier, Creator, Title,
  Publisher, PublicationYear, ResourceType, and a landing page with license and version.

### 2.6 Parquet layout guidance (DuckDB docs, Dremio series)

- DuckDB writes 122,880-row row groups by default; guidance is 250 k–500 k rows per row
  group for analytics tables, at least as many row groups per file as query threads, and
  sorting on the filter columns so min/max statistics prune.
- Remote reads use HTTP range requests and only pull the row groups and columns a query
  needs, but many small row groups or many columns cause request storms
  (duckdb-httpfs issue #172). Fewer, larger row groups are better for remote use.

### 2.7 Prices verified on 2026-09-08

| Item | Verified figure |
|---|---|
| BigQuery on-demand | $6.25 per TiB scanned, first 1 TiB per month free |
| Cloudflare R2 | $0.015 per GB-month, egress $0, Class A $4.50 / M ops, Class B $0.36 / M ops |
| ClickHouse Cloud Basic | ~$0.22 per unit-hour ≈ $186 / month 24×7; **capped at 1 TB storage**, fixed 8 GB RAM / 2 vCPU, single zone; storage $25.30 / TB-month; internet egress from $0.1152 / GB |
| ClickHouse Cloud Scale | from ~$499 / month |
| Hetzner AX42 | ~€46.52 / month, 64 GB, 2×512 GB NVMe *(snippet)* |
| Hetzner AX52 | ~€64 / month, Ryzen 7 7700, 64 GB, 2×1 TB NVMe *(snippet)* |
| Hetzner AX102 | Ryzen 9 7950X3D, 128 GB, 2×1.92 TB NVMe; quoted between €122 and €259 / month across sources after a June-2026 price adjustment *(unverified; hetzner.com unreachable)* |

## 3. Comparison with our specs

Legend: ✅ matches practice · 🔧 spec changed as a result · ⚠️ deliberate deviation, justified · ❓ still open

### Ingest pipeline

| Topic | Industry practice | Our spec | Verdict |
|---|---|---|---|
| Orchestration | Google: Airflow export → GCS → load → verify | Cron job: export → GCS staging → repack → R2 → ClickHouse → verify | ✅ same shape, simpler tooling |
| Idempotency | Google reloads partitions rather than appending | Chunk-level `ingest_log` + `ReplacingMergeTree` dedupe | ✅ |
| Reorgs | Google: no streaming, last day eventually consistent; ClickHouse community: immutable main + mutable tail | Ingest only `head − 100` (finalized); no mutable tail at all | ✅ stricter and simpler; costs ~20 min of freshness |
| Partition filter | Dataset is **monthly** partitioned; clustering on `block_timestamp` | Spec assumed daily partitions | 🔧 A 10,000-block chunk query touches a whole month partition. Backfill must export **one month per query** and split into chunks in the repack step; the daily job re-reads the current month (tens of GB, well under $1 per run). Cost table updated. |
| Cost guard | none documented | `dry_run` byte ceiling per query | ✅ beyond practice |
| Export mechanics | Official guide: `EXPORT DATA … PARQUET` → `s3()` | Same | ✅ |
| Nested columns | Guide: `input_format_parquet_import_nested = 1` | Not mentioned | 🔧 added to load step for `access_list` |
| Column names | `transaction_type`, `value_lossless STRING`, `v`/`y_parity STRING`, `quantity`/`token_id STRING` | Draft SQL guessed these | 🔧 confirmed; ClickHouse DDL now casts `v`, `y_parity`, `quantity`, `token_id` explicitly |

### Data model

| Topic | Industry practice | Our spec | Verdict |
|---|---|---|---|
| Engine | CryptoHouse and community: `ReplacingMergeTree` | `ReplacingMergeTree` | ✅ |
| Sort key | Official example `(block_timestamp, block_number)`; CryptoHouse `(block_timestamp, slot, signature)` | `(block_number, transaction_index, …)` | ⚠️ We key on block number because the explorer navigates by block and every fact table shares the key; timestamps are monotonic with block number, so time-range queries prune equally well via the minmax index. |
| Hash/address type | Everyone stores hex `String`; cryo alone stores binary | `FixedString(32)` / `FixedString(20)` | ⚠️ kept: halves the bytes on the widest columns and the docs endorse `FixedString` for fixed-length hashes. Cost: hex conversion at the API edge. Fallback to `String` is a one-line change if operational friction appears. |
| 256-bit values | ClickHouse example `Decimal(38,0)` (cannot hold the top of the range); AWS `double` (lossy); cryo binary+string+f64; BigQuery STRING | `UInt256` in ClickHouse, **decimal strings** in Parquet | 🔧 corrected. The draft said `DECIMAL(76,0)`, which is wrong twice over: DuckDB caps `DECIMAL` at 38 digits, and `2^256 − 1` needs 78, so no Parquet-writable decimal holds the range. Decimal strings match BigQuery's own `value_lossless STRING` and cost under 3% of the footprint. Still lossless, which the app already guarantees end to end. |
| Partitioning | Docs: monthly, under ~1,000 partitions; example has none | `toYYYYMM(block_timestamp)` | ✅ |
| Address lookups | Google publishes full per-address table copies; docs warn projections do not work with `FINAL`/lightweight deletes | Small MV-fed index tables `(address, block, tx_index)` | ✅ same idea as Google's copies at ~5% of the storage, and compatible with `ReplacingMergeTree` |
| Skip indexes | Docs: bloom filters need testing, default fpr 0.025 | bloom_filter(0.01) on hashes/addresses | ✅ with the doc caveat: measure index size on real data (M1 exit criterion) |
| Codecs | Example: `Delta(4), ZSTD(1)` on block number/timestamp | `Delta, ZSTD` | ✅ |
| Aggregates | CryptoHouse: MVs approximate, `FINAL` exact | `block_stats` AggregatingMergeTree | ✅ |

### Published Parquet dataset

| Topic | Industry practice | Our spec | Verdict |
|---|---|---|---|
| File chunking | cryo 1,000 blocks; era1 8,192; XBlock 1 M; AWS one day | 10,000 blocks, never crossing a month | ⚠️ Larger than cryo/era1 to keep ~1 GB files (good for remote row-group reads and few objects); aligned like cryo's `--align`. If researchers come with cryo tooling, 8,192-block chunks would be a drop-in familiar size; decision left open. |
| Naming | cryo `ethereum__transactions__00000000_to_00000999.parquet` | `blocks_25500000_25509999.parquet` under `year=/month=/` | 🔧 adopt zero-padded 8-digit block numbers so listings sort lexically, like cryo |
| Compression | lz4 / snappy / gzip; none use zstd | zstd | ⚠️ kept: better ratio, wide reader support (pyarrow, DuckDB, ClickHouse); egress is free so decompression speed matters more than size on our side, and zstd decompresses faster than gzip |
| Row groups | DuckDB guidance 250 k–500 k rows | 100 k rows | 🔧 raised to ~250 k rows (transactions) and ~500 k (transfers) to cut remote request counts |
| Integrity | Only era1 ships `checksums.txt`; Sourcify dropped a manifest that lacked checksums | manifest with sha256 per file, written last | ✅ ahead of practice; also publish a plain `checksums.txt` for `sha256sum -c` |
| Immutability | Sourcify v1 regenerated every file on each export and abandoned that | files immutable once listed; corrections as new releases | ✅ |
| Encoding | AWS/BigQuery hex strings; cryo binary | binary in Parquet | 🔧 revisit: researchers' pandas workflows expect hex strings; ship hex strings in the **published** Parquet (binary stays internal to ClickHouse). Costs ~2× on hash columns after compression is far less. |
| Lossy values | AWS stores `value` as double | never | ✅ |
| Hosting | AWS S3 open data, HF, Zenodo | R2 + HF mirror + Zenodo subset | ✅ HF limits fit: keep files under 50 GB, under 10 k per folder |
| Citation | XBlock-ETH has a paper + DOI; Zenodo per-version DOIs | HF DOI per release | ✅ add DataCite metadata and a CITATION.cff |

### Serving (API and explorer)

Facts first (see section 2.8 below for the survey), then the comparison table.

### 2.8 Serving: explorers, APIs, and the address-lookup problem

- **Etherscan**: page/offset pagination with a hard 10,000-record window
  (`"Result window is too large, PageNo x Offset size must be less than or equal to
  10000"`); clients work around it by walking `startblock` forward, i.e. they rebuild
  keyset pagination on top of the offset API. Free tier cut to 1,000 records per request in
  July 2026 *(snippet)*. Rate limits: 5 calls/s and 100k/day free, up to 30/s on paid tiers
  *(snippet)*. No backend details are published.
- **Blockscout** (PostgreSQL, open source): Ethereum mainnet instance is **21 TB** of
  Postgres. Issue history is a catalogue of the pain we are avoiding: indexing that slows
  as the DB grows (#7300), address pages taking "tens of seconds or even minutes" (#8730),
  planner steering needed for the address→transactions query (PR #523), count queries too
  expensive (#251). Its API v2 uses **keyset pagination, 50 per page, with an echoed
  `next_page_params` object** such as `{"block_number": 27736955, "index": 4}`, and its docs
  tell developers to append those fields "rather than paging through with an offset".
  Anonymous default 300 req/min per IP; keyed 10 req/s; CSV export 50/hour.
- **Dune**: moved Postgres → Spark → Trino ("DuneSQL", with native UINT256). Storage is
  Parquet + Delta Lake with **no secondary indexes**, tables ordered by `block_time`, and
  the docs quantify the address/hash problem: a hash lookup over ~1.6 B tx rows takes
  ~6 min without a block filter and **13 s with `block_number`**, because min/max
  statistics on hash columns are useless. API pagination is limit/offset with a
  server-issued `next_offset`; the newer Sim API uses an opaque base64 cursor; the official
  client caps batches at 32,000 rows.
- **Otterscan / Erigon**: serves search straight from the node using Erigon's per-address
  bitmap indexes (`CallFromIndex` / `CallToIndex`); page size capped at 25, pagination by
  block number, no counts, no sorting. Zero extra storage, minimal features.
- **CryptoHouse public profile** (verified in `setup.sql`): `max_execution_time = 60`,
  `max_result_rows = 1000`, `max_memory_usage = 20 GB`, quota 60 queries/hour; address
  style queries are pushed into materialized views. Goldsky's ClickHouse sink defaults to
  `ReplacingMergeTree` in append-only mode.
- **The Graph substreams-sink-files**: Parquet by default, **files bucketed by 10,000
  blocks**, zstd/snappy selectable, to S3/GCS.
- **Cursor pagination standards**: JSON:API cursor profile (`page[size]`, `page[after]`,
  opaque cursor, must report `maxSize`), Stripe (`starting_after`, `limit` ≤ 100,
  `has_more`), Slack (opaque base64 cursor, `next_cursor`, limits ≤ 200).
- The three production answers to "transactions by address": Erigon's per-address bitmap
  index, Blockscout's B-tree indexes plus planner steering, and ClickHouse deployments'
  time-ordered base table plus address-keyed materialized views. Google's BigQuery dataset
  does the same with its `transactions_by_from_address` / `_by_to_address` copies.

| Topic | Industry practice | Our spec | Verdict |
|---|---|---|---|
| Pagination | Blockscout v2, JSON:API, Stripe, Slack, Dune Sim: opaque or keyset cursors; Etherscan's offset window is the anti-pattern everyone works around | Opaque base64 cursor of the sort key, no OFFSET | ✅ |
| Page size | Blockscout 50, Otterscan 25, Stripe ≤100, Slack ≤200 | default 50, max 1,000 anonymous / 10,000 keyed | ✅ generous but bounded; matches CryptoHouse's 1,000-row cap and Etherscan's paid 10,000 |
| Query timeout | CryptoHouse 60 s | 30 s | ✅ stricter |
| Rate limit | Blockscout 300/min anonymous, Etherscan 5/s free | 60/min anonymous, 600/min keyed | 🔧 raise anonymous to 300/min to match Blockscout; keep 30 s and the row cap as the real protection |
| Rate-limit headers | Blockscout: `x-ratelimit-limit`, `x-ratelimit-remaining` | not specified | 🔧 add the two headers |
| Counts | Blockscout: count queries too expensive (#251) | `total` returned only when cheap | ✅ |
| Address lookups | Every production system adds an address-keyed structure | MV-fed address index tables | ✅ |
| Unbounded queries | Dune: 6 min without a block filter | 400 unless scope is a block range, address or hash | ✅ |
| Immutable caching | not documented by any surveyed API | `Cache-Control: immutable` on finalized ranges | ✅ beyond practice |
| Export | Blockscout CSV export 50/hour | sync ≤100k rows, async ≤5 M rows via R2 link | ✅ add an hourly cap per key on async jobs (e.g. 10/hour) |
| Public SQL access | CryptoHouse offers raw SQL with a hard profile | not offered | ❓ a read-only ClickHouse user with CryptoHouse's profile limits would give researchers SQL at almost no cost; worth an M2 decision |

## 4. Changes applied to the specs from this survey

1. Ingest: export **per month partition**, split into chunks locally; cost table reworked for monthly partitions; `input_format_parquet_import_nested` in the load step; explicit casts for the string-typed source columns.
2. Data model: Parquet file names use 8-digit zero-padded block numbers; row groups 250 k / 500 k; published Parquet carries hex strings while ClickHouse keeps binary; `checksums.txt` next to the manifest.
3. Architecture: price table updated with verified figures and the ClickHouse Cloud Basic 1 TB cap (Basic cannot hold five years; Scale tier from ~$499).
4. API: anonymous rate limit raised to 300/min with `x-ratelimit-*` headers; hourly cap on async exports.
5. Open decisions added to the roadmap: 10,000 vs 8,192 blocks per file; hex vs binary in published files; public read-only SQL endpoint.

## 5. Sources

- Google schema/overview/example pages (mirrored copies in github.com/gvillarroel/gcp-radar; originals at docs.cloud.google.com/blockchain-analytics/docs/{schema,overview,example-ethereum})
- BigQuery metadata dump: github.com/rsyi/whale-bigquery-public-data (blockchain_analytics_ethereum_mainnet_us.*.md)
- Third-party field report on partitioning and sizes: github.com/cloudonshore/thewalletshift/blob/main/docs/GCP-EXPLORATION.md
- Google blog "Ethereum in BigQuery: how we built this dataset": cloud.google.com/blog/products/data-analytics/ethereum-bigquery-how-we-built-dataset
- ClickHouse examples: github.com/ClickHouse/examples/tree/main/ethereum ; migration guide source: github.com/ClickHouse/ClickHouse/blob/master/docs/get-started/migrate/bigquery/loading-data.mdx
- ClickHouse docs sources: mergetree.mdx (skip indexes), best-practices/{using_data_skipping_indices, choosing_a_primary_key, partitioning_keys, select_data_type}, data-modeling/projections, data-types/{int-uint, fixedstring}
- ClickHouse discussion #72182: github.com/ClickHouse/ClickHouse/discussions/72182
- CryptoHouse: github.com/ClickHouse/CryptoHouse (setup.sql, queries.json); clickhouse.com/blog/announcing-cryptohouse-free-blockchain-analytics (snippet)
- AWS Public Blockchain Data: registry.opendata.aws/aws-public-blockchain ; github.com/aws-samples/digital-assets-examples/blob/main/analytics/consumer/schema/eth.md
- cryo: github.com/paradigmxyz/cryo (README, crates/freeze/src/types/chunks)
- Sourcify export docs: github.com/sourcifyeth/docs ; export.sourcify.dev
- e2store/era1: github.com/eth-clients/e2store-format-specs ; geth.ethereum.org/docs/fundamentals/downloadera ; EIP-4444
- Blockchair: github.com/Blockchair/Blockchair.Support (API docs); blockchair.com/dumps (snippet)
- XBlock-ETH: github.com/tczpl/XBlock-ETH ; DOI 10.1109/OJCS.2020.2990458 ; Zenodo record 3906690 (snippet)
- Hugging Face hub docs: huggingface.co/docs/hub/{storage-limits, doi, datasets-duckdb} (via github.com/huggingface/hub-docs)
- DuckDB Parquet tips (duckdb.org/docs/current/data/parquet/tips, via search); duckdb-httpfs issue #172
- Serving survey: Etherscan error string in github.com/thesandboxgame/sandbox-smart-contracts (etherscan.ts) and github.com/rotki/rotki; Blockscout docs repo (rest.mdx, requests-and-limits.mdx, rate-limits.mdx, database-storage-requirements.mdx) and issues #7300, #8730, #251, PR #523; Dune docsV2 query-engine.md and dune-client base.py; Otterscan book ots-api.md and Erigon otterscan_api.go / flags.go; CryptoHouse setup.sql (public profile); streamingfast/substreams-sink-files; JSON:API cursor-pagination profile
- Prices: cloud.google.com/bigquery/pricing ; R2 and ClickHouse Cloud 2026 price roundups (egresscost.com, dev.to/beton, improvado.io); ClickHouse Cloud usage limits doc; Hetzner figures from whtop.com and serverlist.dev (snippets)

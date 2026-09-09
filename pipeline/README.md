# Pipeline and API: running the whole stack locally

Everything here runs on one machine with **no cloud account and no credit card**. The
2.19 GB BigQuery export already in the repo root stands in for the daily BigQuery job, a
local directory stands in for the R2 bucket, and a Docker ClickHouse stands in for the
server. What that leaves unproven is listed at the bottom.

Design docs: [`docs/superpowers/specs/2026-09-08-*.md`](../docs/superpowers/specs/) and the
[roadmap](../docs/superpowers/plans/2026-09-08-scale-roadmap.md).

## Prerequisites

```bash
python -m pip install duckdb pytest      # repack + planning tests
npm install                              # api + explorer
# Docker, for ClickHouse
```

## 1. Repack the export into canonical Parquet

Turns the flat 35-column join into the three normalized tables, sorted, zstd-compressed,
checksummed, with a manifest written last.

```bash
python pipeline/repack.py analytics_25534200_25534299.csv --out data/parquet/v1
```

```
  transactions        40,642 rows      8.83 MB
  token_transfers     43,941 rows      1.44 MB
  blocks                 100 rows      0.01 MB

100 blocks -> 10.28 MB (0.1028 MB/block, zstd)
projected one year (2.63M blocks): 270 GB
```

In production the input is Parquet straight from `EXPORT DATA` rather than this CSV, and
`access_list` arrives as real JSON. The table shapes, sort keys, row-group sizes,
compression, file naming, checksums and manifest are identical either way, so this output
is the format contract.

## 2. Bring up ClickHouse and load it

```bash
docker run -d --name eth-ch -p 8123:8123 -p 9000:9000 \
  -e CLICKHOUSE_SKIP_USER_SETUP=1 \
  -v "$PWD/data:/var/lib/clickhouse/user_files/import" \
  clickhouse/clickhouse-server:latest

docker exec -i eth-ch clickhouse-client --multiquery < pipeline/clickhouse/schema.sql
docker exec -i eth-ch clickhouse-client --multiquery < pipeline/clickhouse/load.sql
docker exec eth-ch clickhouse-client --query "OPTIMIZE TABLE eth.block_stats FINAL"
```

Notes that cost time to rediscover:

- The mount must **not** be `:ro`. The image's entrypoint chowns `user_files` and refuses
  to start against a read-only mount.
- `CLICKHOUSE_SKIP_USER_SETUP=1` leaves `default` without a password. Without it the image
  generates a random one and the HTTP interface rejects every request.
- `file()` only reads under `user_files`, which is why the mount lands there. Production
  uses `s3()` against R2 instead; the casts are the same.

Check it:

```bash
docker exec eth-ch clickhouse-client --query "
  SELECT table, formatReadableSize(sum(data_compressed_bytes)) AS size, sum(rows) AS rows
  FROM system.parts WHERE database='eth' AND active GROUP BY table ORDER BY size DESC"
```

## 3. Run the API

```bash
npm run api            # http://localhost:3001
```

```bash
curl 'http://localhost:3001/v1/head'
curl 'http://localhost:3001/v1/stats?block_from=25534200&block_to=25534299'
curl 'http://localhost:3001/v1/records?block_from=25534200&block_to=25534200&limit=5'
curl 'http://localhost:3001/v1/addresses/0xdac17f958d2ee523a2206206994597c13d831ec7/transfers?limit=5'
curl -i 'http://localhost:3001/v1/transactions'   # 400: every query must be bounded
```

Configuration is environment-only: `CLICKHOUSE_URL`, `CLICKHOUSE_DB`, `CLICKHOUSE_USER`,
`CLICKHOUSE_PASSWORD`, `PORT`, `DATASET_RELEASE`.

## 4. Tests

```bash
npm test                              # 407 tests, including the API and provider contract
npm run test:api                      # API only
cd pipeline && python -m pytest       # 28 planning and cost-guard tests
```

The API integration tests need ClickHouse from step 2. Without it they report as
**skipped**, never as passed — an earlier version of them passed vacuously against a live
server and hid a real bug, so they now resolve availability at module load and run in the
`node` environment (jsdom cannot reach a local port).

## 5. Scale test

The sample is 100 blocks, which fits in memory, so nothing measured on it says anything
about behaviour at a billion rows. `scaletest.py` closes part of that gap for free by
replicating the sample into a separate database and measuring at increasing sizes.

```bash
python pipeline/scaletest.py --replicas 200 --checkpoints 25 50 100 200 --out data/scaletest.json
```

Two design points make the result meaningful rather than a toy:

- **Cardinality is preserved.** Naive replication would repeat every address N times and
  flatter both compression and the bloom filters. The *hot* addresses — tokens, routers,
  exchanges, which genuinely recur — stay stable, while the long tail is perturbed per
  replica, and transaction and block hashes are always perturbed.
- **The metric is `read_rows`, not wall time.** The data still fits in page cache on a
  laptop, so timings here are optimistic and are not latency results. What survives the
  caching is how much data ClickHouse had to touch: if a block-range query reads the same
  number of rows whether the table holds 40 thousand or 17 million, the primary key is
  doing its job. If it grows with the table, no hardware fixes that.

This is what caught the API's worst bug. The hash and address endpoints joined the fact
table to the index table, and ClickHouse builds a join's hash table from the right-hand
side — so a single lookup read 110–120% of the transactions table, growing with the table,
exactly where the index was supposed to help. The benchmark suite still runs the rejected
JOIN form alongside the fixed one so the gap stays visible.

## What this proves

- The normalized model is **lossless**: `/v1/records` reconstructs the source CSV exactly —
  74,889 rows for the sample's 100 blocks, 43,941 transfer rows and 30,948 plain, matching
  the source file number for number.
- **Storage**: 0.1028 MB/block of Parquet (270 GB/year) and 14.84 MiB/100 blocks on the
  ClickHouse disk (409 GB/year), both measured rather than estimated.
- **Precision**: 256-bit values survive as decimal strings from BigQuery through Parquet
  and ClickHouse to JSON. A 37-digit quantity round-trips intact.
- **Correctness of the derived structures**: address index rows for the `to` role equal
  transactions minus contract creations; `operator` rows equal the ERC-1155 count; every
  `block_stats` counter matches the fact tables.
- **Pagination**: keyset paging walks all 74,889 rows exactly once with no gaps or repeats.

## What this does NOT prove

- **Latency.** 100 blocks fit in page cache. Every performance target in the architecture
  spec is unvalidated until a real backfill exists.
- **Ingest cost.** The BigQuery scan figures are still estimates; a dry run settles them.
  The dry run itself is free, and the BigQuery sandbox needs no credit card.
- **Anything requiring a bucket**: `EXPORT DATA` to GCS, the R2 upload, `s3()` loads,
  object versioning, the daily schedule.
- **Scale behaviour**: bloom filter selectivity, merge pressure and address-index size at a
  billion rows all need real volume, and the docs flag them as M1 exit criteria.

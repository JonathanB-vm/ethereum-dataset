-- Draft: export a block range from BigQuery straight to Parquet in a bucket.
-- Two normalized tables (no pandas join, no CSV in between). Run in the BigQuery
-- console or with `bq query --use_legacy_sql=false < sql/export_block_range.sql`.
--
-- Before first use:
--   1. Verify column names against the table schema (the console's "Schema" tab):
--      transactions.transaction_type vs. type, access_list, value_lossless, etc.
--   2. The tables are partitioned MONTHLY on block_timestamp (official schema page).
--      Filtering on it is what avoids a full-table scan (~$35 per run). Because the
--      partition is a month, run one export per calendar month for backfills and
--      split into 10,000-block chunks afterwards (see the ingest spec).
--   3. Replace the bucket name.
--
-- Cost check: the console shows "This query will process N GB" before you run it.
-- Column names below were confirmed against a metadata dump of the dataset
-- (transaction_type, value_lossless STRING, access_list RECORD{address, storage_keys},
-- r/s/v/y_parity STRING, token_transfers.quantity/token_id STRING).

DECLARE first_block INT64 DEFAULT 25534200;
DECLARE last_block  INT64 DEFAULT 25534299;

-- Approximate the time window of the block range so the partition filter prunes.
-- 12 s per block, plus a one-day margin on each side.
DECLARE approx_start TIMESTAMP DEFAULT (
  SELECT MIN(block_timestamp)
  FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.blocks`
  WHERE block_number = first_block
);
DECLARE ts_from TIMESTAMP DEFAULT TIMESTAMP_SUB(approx_start, INTERVAL 1 DAY);
DECLARE ts_to   TIMESTAMP DEFAULT TIMESTAMP_ADD(
  approx_start, INTERVAL CAST((last_block - first_block) * 12 AS INT64) + 86400 SECOND);

-- 1. transactions (one row per transaction, input data stored once)
EXPORT DATA OPTIONS (
  uri = 'gs://YOUR-BUCKET/parquet/transactions/blocks_25534200_25534299/*.parquet',
  format = 'PARQUET',
  compression = 'ZSTD',
  overwrite = true
) AS
SELECT
  block_hash, block_number, block_timestamp,
  transaction_hash, transaction_index, nonce,
  from_address, to_address,
  value_lossless,                       -- STRING, full 256-bit precision
  gas, gas_price, input,
  max_fee_per_gas, max_priority_fee_per_gas,
  transaction_type, chain_id,
  TO_JSON_STRING(access_list) AS access_list,   -- JSON, not a numpy repr
  r, s, v, y_parity
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.transactions`
WHERE block_timestamp BETWEEN ts_from AND ts_to      -- partition pruning
  AND block_number BETWEEN first_block AND last_block
ORDER BY block_number, transaction_index;

-- 2. token_transfers (one row per transfer event; join to transactions on
--    transaction_hash at query time)
EXPORT DATA OPTIONS (
  uri = 'gs://YOUR-BUCKET/parquet/token_transfers/blocks_25534200_25534299/*.parquet',
  format = 'PARQUET',
  compression = 'ZSTD',
  overwrite = true
) AS
SELECT
  block_hash, block_number, block_timestamp,
  transaction_hash, transaction_index,
  event_index, batch_index,
  address, event_type, event_hash, event_signature,
  operator_address, from_address, to_address,
  token_id, quantity, removed
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.token_transfers`
WHERE block_timestamp BETWEEN ts_from AND ts_to
  AND block_number BETWEEN first_block AND last_block
ORDER BY block_number, transaction_index, event_index, batch_index;

-- 3. blocks (small; drives the `blocks` table, head discovery and the manifest)
EXPORT DATA OPTIONS (
  uri = 'gs://YOUR-BUCKET/parquet/blocks/blocks_25534200_25534299/*.parquet',
  format = 'PARQUET',
  compression = 'ZSTD',
  overwrite = true
) AS
SELECT
  block_number, block_timestamp, block_hash,
  transaction_count
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.blocks`
WHERE block_timestamp BETWEEN ts_from AND ts_to
  AND block_number BETWEEN first_block AND last_block
ORDER BY block_number;

-- Head discovery (run separately, tiny scan): the ingest job targets head − 100.
-- SELECT MAX(block_number) AS head
-- FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.blocks`
-- WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY);

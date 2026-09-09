-- M0 verification: run these in the BigQuery console before the first real export.
--
-- All three are free. Queries 1 and 2 read INFORMATION_SCHEMA, which is metadata and is
-- not billed as scanned bytes. Query 3 is checked with the console's dry-run estimate
-- rather than actually run. None of this needs a billing account -- the BigQuery sandbox
-- is enough.
--
-- Goal: settle the two open M0 items, which are the last unknowns in the ingest cost.
--   1. Do the column names in sql/export_block_range.sql match the live schema?
--   2. How many bytes does one month-partitioned export actually scan?

-- ---------------------------------------------------------------------------
-- 1. Column names and types for the three tables we read.
--    Compare against sql/export_block_range.sql. The names below were taken from a
--    third-party metadata dump, not the live schema, so this is the check that matters.
--    Expect: transactions.transaction_type (NOT `type`), value_lossless STRING,
--    r/s/v/y_parity STRING, token_transfers.quantity and token_id STRING.
-- ---------------------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN ('transactions', 'token_transfers', 'blocks')
ORDER BY table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- 2. Confirm the partition column and that partitioning is MONTHLY.
--    The whole cost model rests on this: a query without a block_timestamp filter
--    scans the full tables (~5.7 TB, ~$32 a run).
--    Expect: is_partitioning_column = 'YES' on block_timestamp.
-- ---------------------------------------------------------------------------
SELECT table_name, column_name, is_partitioning_column, clustering_ordinal_position
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN ('transactions', 'token_transfers', 'blocks')
  AND (is_partitioning_column = 'YES' OR clustering_ordinal_position IS NOT NULL)
ORDER BY table_name;

-- ---------------------------------------------------------------------------
-- 3. The cost probe. DO NOT RUN THIS -- paste it and read the estimate.
--
--    The console shows "This query will process N GB" in the top right before you run
--    anything. That estimate is what the ingest job's dry-run guard reads, and it is
--    the number to write into the ingest spec's cost table.
--
--    Two things to check:
--      a. With the block_timestamp filter below, expect tens of GB (one month partition).
--      b. Delete the block_timestamp line and watch the estimate jump to terabytes.
--         That difference is the entire reason the cost guard exists.
--
--    Adjust the month to one the dataset actually covers.
-- ---------------------------------------------------------------------------
SELECT
  block_number, transaction_hash, transaction_index, from_address, to_address,
  value_lossless, gas, gas_price, input, transaction_type
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.transactions`
WHERE block_timestamp >= TIMESTAMP('2026-07-01')
  AND block_timestamp <  TIMESTAMP('2026-08-01')      -- delete this line to see the hazard
  AND block_number BETWEEN 25530000 AND 25539999;

-- ---------------------------------------------------------------------------
-- 4. Head discovery, as the daily job does it. Tiny scan; safe to run.
-- ---------------------------------------------------------------------------
SELECT MAX(block_number) AS head, MAX(block_timestamp) AS head_time
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.blocks`
WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY);

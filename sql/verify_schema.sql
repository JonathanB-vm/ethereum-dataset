-- M0 verification for the BigQuery console.
--
-- >>> PASTE ONE QUERY AT A TIME. Do not paste this whole file. <<<
--
-- Pasting them together makes it a multi-statement script, and BigQuery then (a) runs
-- every statement, including query 3, which is meant to be read rather than run, and
-- (b) stops showing the upfront "this query will process N GB" estimate, which is the
-- single number query 3 exists to produce.
--
-- Workflow: open BigQuery -> Create query, paste query 1 (comments and all), Run, read the
-- result. Then select-all, paste the next one over it. Five passes.
--
-- All of this is free. Queries 1 and 2 read INFORMATION_SCHEMA, which is metadata and is
-- not billed as scanned bytes. Query 3 is never run. Queries 4 and 5 read a couple of days
-- of one table. None of it needs a billing account -- the sandbox is enough.
--
-- Status:
--   1. Column names        DONE 2026-09-09 -- all 42 exist, export query needs no changes.
--   2. Partitioning        confirm block_timestamp is the partition column.
--   3. Scan cost           OPEN -- the last unknown in the ingest cost model.
--   4. Coverage / head     tells you which months exist, for query 3's dates.
--   5. STRING number format OPEN -- decides how the repack step parses v and y_parity,
--                          and gets it wrong silently if assumed.

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

-- ---------------------------------------------------------------------------
-- 5. What do the STRING-typed numeric columns actually look like?
--
--    v, y_parity, quantity, token_id and value_lossless are all STRING in the source.
--    How they are *formatted* decides how the pipeline parses them, and getting it wrong
--    fails silently: try_cast('0x1' AS UBIGINT) is NULL, not an error, so `v` would
--    quietly become empty for every row.
--
--    Expect either hex ('0x1', '0x1b') or decimal ('1', '27'). Cheap: one small block
--    range, five columns.
-- ---------------------------------------------------------------------------
SELECT v, y_parity, value_lossless
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.transactions`
WHERE block_timestamp >= TIMESTAMP('2026-07-14')
  AND block_timestamp <  TIMESTAMP('2026-07-16')
  AND block_number BETWEEN 25534200 AND 25534210
LIMIT 20;

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
--   2. Partition column    DONE 2026-09-09 -- block_timestamp, and clustered on it too.
--   2b. Partition GRANULARITY  OPEN -- the cost model assumes MONTHLY; confirm it.
--   3. Scan cost           OPEN -- the last unknown in the ingest cost model.
--   4. Coverage / head     DONE 2026-09-09 -- genesis to head, head ~2h behind live.
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
-- 2. Confirm which column the tables are partitioned on.
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
-- 2b. Partition GRANULARITY.
--
--     Query 2 proves block_timestamp is the partitioning column, but not whether
--     partitions are daily, monthly or yearly -- and the cost model's "export one month
--     per query" rests on monthly.
--
--     The obvious route, reading the table DDL, does NOT work here: BigQuery returns an
--     empty `ddl` for a public dataset you do not own (confirmed 2026-09-09).
--     INFORMATION_SCHEMA.PARTITIONS is worth a try and may be restricted the same way.
--
--     The reliable route is to measure the pruning instead of reading about it, which is
--     what queries 3 and 3c do together. That is better evidence anyway: what the cost
--     model needs is not the declared granularity but how many bytes a filter actually
--     prunes away.
-- ---------------------------------------------------------------------------
-- Optional, may return "permission denied" on a public dataset. If it works, the shape of
-- partition_id is the answer: '202608' = MONTH, '20260814' = DAY, '2026' = YEAR.
SELECT table_name, partition_id, total_rows
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.INFORMATION_SCHEMA.PARTITIONS`
WHERE table_name = 'transactions'
ORDER BY partition_id DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
-- 3. The cost probe. DO NOT RUN -- paste it and read the estimate.
--
--    The console shows "This query will process N GB" at the top right before you run
--    anything. That number is the last unknown in the ingest cost model.
--
--    This selects the SAME columns the real export does, which matters: BigQuery bills by
--    column, so a probe with fewer columns understates the cost. `input` alone is most of
--    the bytes.
--
--    August 2026 is a complete month inside the dataset's coverage. The block range is a
--    10,000-block chunk sitting inside it -- the real unit of work.
--
--    Check two things:
--      a. As written, expect tens of GB: one month partition, these columns.
--      b. Delete the two block_timestamp lines and watch it jump to terabytes. That gap
--         is the ~$32-per-run hazard the cost guard exists to prevent.
-- ---------------------------------------------------------------------------
SELECT
  block_hash, block_number, block_timestamp,
  transaction_hash, transaction_index, nonce,
  from_address, to_address,
  value_lossless,
  gas, gas_price, input,
  max_fee_per_gas, max_priority_fee_per_gas,
  transaction_type, chain_id,
  TO_JSON_STRING(access_list) AS access_list,
  r, s, v, y_parity
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.transactions`
WHERE block_timestamp >= TIMESTAMP('2026-08-01')     -- delete these two lines
  AND block_timestamp <  TIMESTAMP('2026-09-01')     -- to see the hazard
  AND block_number BETWEEN 25700000 AND 25709999;

-- ---------------------------------------------------------------------------
-- 3b. The same probe for token_transfers. DO NOT RUN -- read the estimate.
--     The daily job reads both tables, so the run cost is 3 + 3b.
-- ---------------------------------------------------------------------------
SELECT
  block_hash, block_number, block_timestamp,
  transaction_hash, transaction_index,
  event_index, batch_index,
  address, event_type, event_hash, event_signature,
  operator_address, from_address, to_address,
  token_id, quantity, removed
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.token_transfers`
WHERE block_timestamp >= TIMESTAMP('2026-08-01')
  AND block_timestamp <  TIMESTAMP('2026-09-01')
  AND block_number BETWEEN 25700000 AND 25709999;

-- ---------------------------------------------------------------------------
-- 3c. Partition granularity, measured. DO NOT RUN -- read the estimate.
--
--     Identical to query 3 except the window is ONE DAY instead of one month. Compare the
--     two estimates:
--
--       same bytes as query 3        -> partitions are MONTHLY. A day-sized filter cannot
--                                       prune below one month, which is exactly the
--                                       assumption the ingest spec is built on.
--       roughly 1/31 of query 3      -> partitions are DAILY, and the daily job gets much
--                                       cheaper than budgeted. Good news; update the spec.
--
--     This measures the behaviour the cost model depends on, rather than the declared
--     granularity, so it is the stronger evidence even where the DDL is readable.
-- ---------------------------------------------------------------------------
SELECT
  block_hash, block_number, block_timestamp,
  transaction_hash, transaction_index, nonce,
  from_address, to_address,
  value_lossless,
  gas, gas_price, input,
  max_fee_per_gas, max_priority_fee_per_gas,
  transaction_type, chain_id,
  TO_JSON_STRING(access_list) AS access_list,
  r, s, v, y_parity
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.transactions`
WHERE block_timestamp >= TIMESTAMP('2026-08-14')
  AND block_timestamp <  TIMESTAMP('2026-08-15');

-- ---------------------------------------------------------------------------
-- 4. Head discovery, as the daily job does it. Tiny scan; safe to run.
-- ---------------------------------------------------------------------------
SELECT MAX(block_number) AS head, MAX(block_timestamp) AS head_time
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.blocks`
WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY);

-- ---------------------------------------------------------------------------
-- 5. What do the STRING-typed numeric columns actually look like? Run this.
--
--    v, y_parity, quantity, token_id and value_lossless are all STRING in the source.
--    How they are *formatted* decides how the pipeline parses them, and getting it wrong
--    fails silently: try_cast('0x1' AS UBIGINT) is NULL, not an error, so `v` would
--    quietly become empty for every row.
--
--    Expect either hex ('0x1', '0x1b') or decimal ('1', '27'). value_lossless is expected
--    to be a plain decimal string; quantity and token_id live on token_transfers and are
--    already known to be decimal from the CSV export.
--
--    NOTE: filter on time only. An earlier version of this query also carried a
--    block_number range taken from a linear blocks-per-day extrapolation, and the two
--    windows did not overlap -- it returned no rows at all. Block numbers derived from a
--    rate estimate drift by days over a month; never AND them with a date window unless
--    the numbers came from the data itself. Scans one day (~3.5 GB), inside the free tier.
-- ---------------------------------------------------------------------------
SELECT v, y_parity, value_lossless, transaction_type
FROM `bigquery-public-data.blockchain_analytics_ethereum_mainnet_us.transactions`
WHERE block_timestamp >= TIMESTAMP('2026-08-14')
  AND block_timestamp <  TIMESTAMP('2026-08-15')
LIMIT 20;

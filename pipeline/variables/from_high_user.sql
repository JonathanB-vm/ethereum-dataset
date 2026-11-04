-- from_high_user: 1 if the transaction's sender initiated more than 10 transactions in the
-- 7,200 blocks before this transaction's block (blocks [B - 7200, B - 1]), else 0.
-- Transactions earlier in block B itself are not counted.
-- Registry entry: registry/variables.json. Reference implementation (must agree):
-- scripts/variablesPrep.mjs.
--
-- Bound parameters: {block_from:UInt32}, {block_to:UInt32}, {version:UInt32}.
--
-- The window reads back 7,200 blocks before block_from, so computing one range never
-- depends on another range having been computed first. Where those blocks are not loaded
-- the window is simply shorter -- the truncation the registry description warns about.
--
-- Counts are aggregated to one row per (sender, block) before the window function, so the
-- frame is a RANGE over block numbers: "7200 PRECEDING AND 1 PRECEDING" is exactly
-- [B - 7200, B - 1] regardless of how many blocks in between the sender was idle.
INSERT INTO eth.tx_variable_values (variable_id, block_number, transaction_index, value, version, computed_at)
WITH
    per_block AS
    (
        SELECT from_address, block_number, count() AS sent
        FROM eth.transactions
        WHERE block_number >= greatest({block_from:UInt32}, 7200) - 7200
          AND block_number <= {block_to:UInt32}
        GROUP BY from_address, block_number
    ),
    windowed AS
    (
        SELECT
            from_address,
            block_number,
            sum(sent) OVER (
                PARTITION BY from_address
                ORDER BY block_number
                RANGE BETWEEN 7200 PRECEDING AND 1 PRECEDING
            ) AS prior_sent
        FROM per_block
    )
SELECT
    'from_high_user'                              AS variable_id,
    t.block_number                                AS block_number,
    t.transaction_index                           AS transaction_index,
    toFloat64(ifNull(w.prior_sent, 0) > 10)       AS value,
    {version:UInt32}                              AS version,
    now()                                         AS computed_at
FROM eth.transactions AS t
LEFT JOIN windowed AS w
    ON t.from_address = w.from_address AND t.block_number = w.block_number
WHERE t.block_number >= {block_from:UInt32} AND t.block_number <= {block_to:UInt32}
SETTINGS join_use_nulls = 1

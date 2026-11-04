-- simple_transaction: 1 if the transaction carries exactly one token transfer, else 0.
-- Registry entry: registry/variables.json. Reference implementation (must agree):
-- scripts/variablesPrep.mjs.
--
-- Bound parameters: {block_from:UInt32}, {block_to:UInt32}. Run through
-- pipeline/variables/compute.ts, which also supplies {version:UInt32}.
--
-- The right-hand side of the join is a grouped subquery over the same bounded range, so
-- the hash table ClickHouse builds from it is one range's worth of transfer counts, never
-- the whole token_transfers table (see the note in api/queries.ts buildAddressPage).
INSERT INTO eth.tx_variable_values (variable_id, block_number, transaction_index, value, version, computed_at)
SELECT
    'simple_transaction'                          AS variable_id,
    t.block_number                                AS block_number,
    t.transaction_index                           AS transaction_index,
    toFloat64(ifNull(c.transfers, 0) = 1)         AS value,
    {version:UInt32}                              AS version,
    now()                                         AS computed_at
FROM eth.transactions AS t
LEFT JOIN
(
    SELECT block_number, transaction_index, count() AS transfers
    FROM eth.token_transfers
    WHERE block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}
    GROUP BY block_number, transaction_index
) AS c
    ON t.block_number = c.block_number AND t.transaction_index = c.transaction_index
WHERE t.block_number >= {block_from:UInt32} AND t.block_number <= {block_to:UInt32}
SETTINGS join_use_nulls = 1

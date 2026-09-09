-- Load canonical Parquet into ClickHouse.
--
-- This is the local stand-in for the production load step, which is identical except
-- that `file(...)` becomes `s3('https://<r2-host>/...', 'Parquet')`. The casts are the
-- interesting part and are the same either way:
--
--   * the published Parquet stores hashes and addresses as 0x-prefixed hex strings for
--     researchers, while ClickHouse stores them as FixedString binary -- unhex(substr(x,3))
--   * 256-bit values travel as decimal strings, because no Parquet-writable fixed-width
--     type holds 78 digits -- toUInt256 on the way in
--
--   docker exec -i eth-ch clickhouse-client --multiquery < pipeline/clickhouse/load.sql

INSERT INTO eth.transactions
SELECT
    block_number,
    toDateTime(block_timestamp)                                     AS block_timestamp,
    unhex(substring(block_hash, 3))                                 AS block_hash,
    transaction_index,
    unhex(substring(transaction_hash, 3))                           AS transaction_hash,
    nonce,
    unhex(substring(from_address, 3))                               AS from_address,
    if(isNull(to_address), NULL,
       toFixedString(unhex(substring(to_address, 3)), 20))          AS to_address,
    toUInt256(value)                                                AS value,
    gas,
    toUInt128(gas_price)                                            AS gas_price,
    input,
    toUInt128OrNull(max_fee_per_gas)                                AS max_fee_per_gas,
    toUInt128OrNull(max_priority_fee_per_gas)                       AS max_priority_fee_per_gas,
    transaction_type,
    chain_id,
    access_list,
    unhex(substring(r, 3))                                          AS r,
    unhex(substring(s, 3))                                          AS s,
    v,
    y_parity
FROM file('import/parquet/v1/transactions/**/*.parquet', Parquet);

INSERT INTO eth.token_transfers
SELECT
    block_number,
    toDateTime(block_timestamp)                                     AS block_timestamp,
    unhex(substring(block_hash, 3))                                 AS block_hash,
    transaction_index,
    unhex(substring(transaction_hash, 3))                           AS transaction_hash,
    event_index,
    batch_index,
    unhex(substring(address, 3))                                    AS address,
    event_type,
    unhex(substring(event_hash, 3))                                 AS event_hash,
    event_signature,
    if(isNull(operator_address), NULL,
       toFixedString(unhex(substring(operator_address, 3)), 20))    AS operator_address,
    unhex(substring(from_address, 3))                               AS from_address,
    unhex(substring(to_address, 3))                                 AS to_address,
    toUInt256OrNull(token_id)                                       AS token_id,
    toUInt256(quantity)                                             AS quantity,
    removed
FROM file('import/parquet/v1/token_transfers/**/*.parquet', Parquet);

INSERT INTO eth.blocks
SELECT
    block_number,
    toDateTime(block_timestamp)                                     AS block_timestamp,
    unhex(substring(block_hash, 3))                                 AS block_hash,
    transaction_count,
    transfer_count
FROM file('import/parquet/v1/blocks/**/*.parquet', Parquet);

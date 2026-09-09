-- ClickHouse schema for the scaled dataset.
-- Source of truth: docs/superpowers/specs/2026-09-08-data-model.md
--
-- Runnable locally with no cloud account:
--   docker run -d --name eth-ch -p 8123:8123 -p 9000:9000 \
--     -v "$PWD/data:/var/lib/clickhouse-import:ro" clickhouse/clickhouse-server:latest
--   docker exec -i eth-ch clickhouse-client --multiquery < pipeline/clickhouse/schema.sql
--
-- Every fact table is ReplacingMergeTree so a retried chunk load can never double-count;
-- the ingest log is the primary guard and the engine is defense in depth.
-- Partitioning is monthly, matching the Parquet layout one-to-one, so "reload July" is
-- one DROP PARTITION plus one INSERT.

CREATE DATABASE IF NOT EXISTS eth;

-- ---------------------------------------------------------------------------
-- Fact tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eth.transactions
(
    block_number              UInt32            CODEC(Delta, ZSTD),
    block_timestamp           DateTime          CODEC(Delta, ZSTD),
    block_hash                FixedString(32),
    transaction_index         UInt16,
    transaction_hash          FixedString(32),
    nonce                     UInt64,
    from_address              FixedString(20),
    to_address                Nullable(FixedString(20)),
    value                     UInt256,
    gas                       UInt64,
    gas_price                 UInt128,
    input                     String            CODEC(ZSTD(3)),
    max_fee_per_gas           Nullable(UInt128),
    max_priority_fee_per_gas  Nullable(UInt128),
    transaction_type          UInt8,
    chain_id                  Nullable(UInt64),
    access_list               String            CODEC(ZSTD(3)),
    r                         FixedString(32),
    s                         FixedString(32),
    v                         UInt64,
    y_parity                  Nullable(UInt8),
    INDEX idx_hash transaction_hash TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_from from_address     TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_to   to_address       TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_number, transaction_index);

CREATE TABLE IF NOT EXISTS eth.token_transfers
(
    block_number       UInt32   CODEC(Delta, ZSTD),
    block_timestamp    DateTime CODEC(Delta, ZSTD),
    block_hash         FixedString(32),
    transaction_index  UInt16,
    transaction_hash   FixedString(32),
    event_index        UInt32,
    batch_index        UInt32,
    address            FixedString(20),          -- token contract
    event_type         LowCardinality(String),
    event_hash         FixedString(32),
    event_signature    LowCardinality(String),
    operator_address   Nullable(FixedString(20)),
    from_address       FixedString(20),
    to_address         FixedString(20),
    token_id           Nullable(UInt256),
    quantity           UInt256,
    removed            Bool,
    INDEX idx_hash  transaction_hash TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_token address          TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_from  from_address     TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_to    to_address       TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_number, transaction_index, event_index, batch_index);

CREATE TABLE IF NOT EXISTS eth.blocks
(
    block_number      UInt32   CODEC(Delta, ZSTD),
    block_timestamp   DateTime CODEC(Delta, ZSTD),
    block_hash        FixedString(32),
    transaction_count UInt16,
    transfer_count    UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY block_number;

-- ---------------------------------------------------------------------------
-- Address index tables
--
-- Bloom filters only skip granules, and the docs note they work best when the column
-- correlates with the primary key -- addresses do not. A small table sorted by address
-- answers "address = X" with a primary-key read instead, at ~30 bytes per row rather
-- than a full projection copy. Projections were rejected because they are unsupported
-- together with FINAL and lightweight deletes, both of which ReplacingMergeTree needs.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eth.tx_by_address
(
    address           FixedString(20),
    block_number      UInt32,
    transaction_index UInt16,
    role              Enum8('from' = 1, 'to' = 2)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(block_number, 1000000)
ORDER BY (address, block_number, transaction_index, role);

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.tx_by_address_mv TO eth.tx_by_address AS
SELECT from_address AS address, block_number, transaction_index, 'from' AS role
FROM eth.transactions
UNION ALL
SELECT to_address AS address, block_number, transaction_index, 'to' AS role
FROM eth.transactions
WHERE to_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS eth.transfers_by_address
(
    address           FixedString(20),
    block_number      UInt32,
    transaction_index UInt16,
    event_index       UInt32,
    batch_index       UInt32,
    role              Enum8('from' = 1, 'to' = 2, 'token' = 3, 'operator' = 4)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(block_number, 1000000)
ORDER BY (address, block_number, transaction_index, event_index, batch_index, role);

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.transfers_by_address_mv
TO eth.transfers_by_address AS
SELECT from_address AS address, block_number, transaction_index, event_index, batch_index,
       'from' AS role
FROM eth.token_transfers
UNION ALL
SELECT to_address, block_number, transaction_index, event_index, batch_index, 'to'
FROM eth.token_transfers
UNION ALL
SELECT address, block_number, transaction_index, event_index, batch_index, 'token'
FROM eth.token_transfers
UNION ALL
SELECT operator_address, block_number, transaction_index, event_index, batch_index,
       'operator'
FROM eth.token_transfers
WHERE operator_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS eth.tx_by_hash
(
    transaction_hash  FixedString(32),
    block_number      UInt32,
    transaction_index UInt16
)
ENGINE = ReplacingMergeTree
ORDER BY transaction_hash;

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.tx_by_hash_mv TO eth.tx_by_hash AS
SELECT transaction_hash, block_number, transaction_index FROM eth.transactions;

-- ---------------------------------------------------------------------------
-- Materialized aggregates (the explorer's stats band)
--
-- A year is only 2.63 M rows here, so any block-range or day-range stat answers in
-- milliseconds and never touches the fact tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eth.block_stats
(
    block_number      UInt32,
    block_timestamp   DateTime,
    tx_count          UInt32,
    transfer_count    UInt32,
    erc20_count       UInt32,
    erc721_count      UInt32,
    erc1155_count     UInt32,
    eth_moved         UInt256,
    gas_price_min     UInt128,
    gas_price_max     UInt128,
    addresses_state   AggregateFunction(uniq, FixedString(20))
)
ENGINE = AggregatingMergeTree
ORDER BY block_number;

-- ---------------------------------------------------------------------------
-- Ingest log: the idempotency guard, the manifest source, and the explorer's
-- "data current to block N" badge.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eth.ingest_log
(
    chunk_start  UInt32,
    chunk_end    UInt32,
    table_name   LowCardinality(String),
    rows         UInt64,
    sha256       String,
    status       Enum8('pending' = 0, 'done' = 1, 'failed' = 2),
    started_at   DateTime,
    finished_at  Nullable(DateTime),
    error        String DEFAULT ''
)
ENGINE = ReplacingMergeTree(started_at)
ORDER BY (chunk_start, table_name);

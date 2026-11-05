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

-- One materialized view per role, not one view with a UNION ALL.
--
-- A materialized view is an insert trigger on a single source table, and with a UNION ALL
-- body only the first branch ever fires -- verified here: loading 40,642 transactions
-- through the UNION ALL version produced 40,642 rows, all role='from', and none for 'to'.
-- Nothing errors; address lookups just silently return no results for the missing roles.
CREATE MATERIALIZED VIEW IF NOT EXISTS eth.tx_by_address_from_mv TO eth.tx_by_address AS
SELECT from_address AS address, block_number, transaction_index, 'from' AS role
FROM eth.transactions;

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.tx_by_address_to_mv TO eth.tx_by_address AS
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

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.transfers_by_address_from_mv
TO eth.transfers_by_address AS
SELECT from_address AS address, block_number, transaction_index, event_index, batch_index,
       'from' AS role
FROM eth.token_transfers;

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.transfers_by_address_to_mv
TO eth.transfers_by_address AS
SELECT to_address AS address, block_number, transaction_index, event_index, batch_index,
       'to' AS role
FROM eth.token_transfers;

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.transfers_by_address_token_mv
TO eth.transfers_by_address AS
SELECT address, block_number, transaction_index, event_index, batch_index,
       'token' AS role
FROM eth.token_transfers;

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.transfers_by_address_operator_mv
TO eth.transfers_by_address AS
SELECT operator_address AS address, block_number, transaction_index, event_index,
       batch_index, 'operator' AS role
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

-- Every non-key column must be an aggregate type. The data-model spec declared these as
-- plain UInt32/UInt256/UInt128, which ClickHouse rejects outright: on a background merge
-- rows sharing the sorting key collapse and plain columns keep an arbitrary value, so a
-- retried chunk load would silently corrupt the stats band. SimpleAggregateFunction keeps
-- the columns readable as plain values while making the merge correct, and lets both
-- feeding views write partial rows for the same block.
CREATE TABLE IF NOT EXISTS eth.block_stats
(
    block_number      UInt32,
    block_timestamp   SimpleAggregateFunction(any, DateTime),
    tx_count          SimpleAggregateFunction(sum, UInt64),
    transfer_count    SimpleAggregateFunction(sum, UInt64),
    erc20_count       SimpleAggregateFunction(sum, UInt64),
    erc721_count      SimpleAggregateFunction(sum, UInt64),
    erc1155_count     SimpleAggregateFunction(sum, UInt64),
    eth_moved         SimpleAggregateFunction(sum, UInt256),
    gas_price_min     SimpleAggregateFunction(min, UInt128),
    gas_price_max     SimpleAggregateFunction(max, UInt128),
    addresses_state   AggregateFunction(uniq, FixedString(20))
)
ENGINE = AggregatingMergeTree
ORDER BY block_number;

-- Two feeding views. Each emits a partial row per block; the engine merges them, so
-- `tx_count` comes from one and `transfer_count` from the other without either
-- overwriting the block's other half. Unique addresses are a uniq state so the two
-- sources can be combined without double-counting an address that appears in both.
CREATE MATERIALIZED VIEW IF NOT EXISTS eth.block_stats_tx_mv TO eth.block_stats AS
SELECT
    block_number,
    any(block_timestamp)          AS block_timestamp,
    count()                       AS tx_count,
    toUInt64(0)                   AS transfer_count,
    toUInt64(0)                   AS erc20_count,
    toUInt64(0)                   AS erc721_count,
    toUInt64(0)                   AS erc1155_count,
    sum(value)                    AS eth_moved,
    min(gas_price)                AS gas_price_min,
    max(gas_price)                AS gas_price_max,
    uniqState(from_address)       AS addresses_state
FROM eth.transactions
GROUP BY block_number;

CREATE MATERIALIZED VIEW IF NOT EXISTS eth.block_stats_transfer_mv TO eth.block_stats AS
SELECT
    block_number,
    any(block_timestamp)                                  AS block_timestamp,
    toUInt64(0)                                           AS tx_count,
    count()                                               AS transfer_count,
    countIf(event_type = 'ERC-20')                        AS erc20_count,
    countIf(event_type = 'ERC-721')                       AS erc721_count,
    countIf(event_type = 'ERC-1155')                      AS erc1155_count,
    toUInt256(0)                                          AS eth_moved,
    -- Identity elements, not zeros: a 0 here would win every min() and permanently
    -- zero out the block's real minimum gas price.
    toUInt128('340282366920938463463374607431768211455')  AS gas_price_min,
    toUInt128(0)                                          AS gas_price_max,
    uniqState(from_address)                               AS addresses_state
FROM eth.token_transfers
GROUP BY block_number;

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

-- ---------------------------------------------------------------------------
-- Research variables: researcher-defined derived columns.
--
-- A variable is a formula over the fact tables whose result is one new column. Its
-- definition lives in the catalog; its results live in one long table shared by every
-- variable, so adding a variable is a catalog row plus an INSERT and never an ALTER TABLE.
--
-- The catalog is seeded from registry/variables.json by pipeline/variables/compute.ts,
-- which then runs each formula (pipeline/variables/<id>.sql) over a block range. Creators
-- are ids into registry/users.json -- a demo user list, so there is no users table yet.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eth.variables
(
    id               String,
    label            String,
    description      String DEFAULT '',
    tags             Array(LowCardinality(String)),
    created_by       LowCardinality(String),
    created_at       Date,
    grain            LowCardinality(String),
    value_type       LowCardinality(String),
    formula_summary  String,
    formula_sql      String,
    version          UInt32
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id;

-- One row per (variable, transaction). `value` is Float64 so the same table holds flags
-- today and counts or ratios later. ReplacingMergeTree keyed on the full identity means
-- recomputing a range replaces its rows rather than double-counting them -- the same
-- guarantee the fact tables give a retried chunk load. `version` records which formula
-- version produced the row, so a stale computation is detectable after a formula change.
--
-- Sorted by variable first: a page of the explorer asks for a handful of variables over a
-- narrow block range, which is then one contiguous primary-key read per variable.
CREATE TABLE IF NOT EXISTS eth.tx_variable_values
(
    variable_id        LowCardinality(String),
    block_number       UInt32,
    transaction_index  UInt16,
    value              Float64,
    version            UInt32,
    computed_at        DateTime
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY intDiv(block_number, 1000000)
ORDER BY (variable_id, block_number, transaction_index);

-- Provenance for catalog entries that came through a researcher request. Added with
-- ADD COLUMN IF NOT EXISTS so an install created before these existed migrates in place.
ALTER TABLE eth.variables ADD COLUMN IF NOT EXISTS request_id  String DEFAULT '';
ALTER TABLE eth.variables ADD COLUMN IF NOT EXISTS approved_by LowCardinality(String) DEFAULT '';
ALTER TABLE eth.variables ADD COLUMN IF NOT EXISTS approved_at Nullable(DateTime);
ALTER TABLE eth.variables ADD COLUMN IF NOT EXISTS status      LowCardinality(String) DEFAULT 'active';

-- ---------------------------------------------------------------------------
-- App data: users and researcher variable requests.
--
-- Low-volume, update-in-place records kept here so the stack needs no second database
-- yet. Every table is ReplacingMergeTree(updated_at): an update is a new row version and
-- reads use FINAL. All access goes through api/store.ts, so moving these to Postgres when
-- the site gets a real backend is one new store implementation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eth.users
(
    id           String,
    google_sub   String DEFAULT '',
    email        String DEFAULT '',
    name         String,
    picture_url  String DEFAULT '',
    role         LowCardinality(String) DEFAULT 'researcher',   -- researcher | admin
    created_at   DateTime,
    updated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- A researcher's proposal for a new variable. Nothing runs at full scale until an admin
-- approves; `estimate` holds the measured sample-run cost as JSON (see api/estimate.ts).
CREATE TABLE IF NOT EXISTS eth.variable_requests
(
    id            String,
    variable_id   String,
    label         String,
    description   String DEFAULT '',
    tags          Array(LowCardinality(String)),
    value_type    LowCardinality(String),                 -- flag | number
    grain         LowCardinality(String),                 -- transaction
    query_sql     String,
    requested_by  String,
    status        LowCardinality(String),                 -- pending | rejected | running | completed | failed
    estimate      String DEFAULT '',
    review_note   String DEFAULT '',
    reviewed_by   String DEFAULT '',
    reviewed_at   Nullable(DateTime),
    error         String DEFAULT '',
    created_at    DateTime,
    updated_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- One row per computation of a variable over a block range: the audit trail of what ran,
-- for whom, at what cost. Written by approvals and by pipeline/variables/compute.ts.
CREATE TABLE IF NOT EXISTS eth.variable_runs
(
    id            String,
    variable_id   String,
    version       UInt32,
    request_id    String DEFAULT '',
    block_from    UInt32,
    block_to      UInt32,
    rows_written  UInt64 DEFAULT 0,
    read_rows     UInt64 DEFAULT 0,
    read_bytes    UInt64 DEFAULT 0,
    elapsed_ms    UInt64 DEFAULT 0,
    status        LowCardinality(String),                 -- running | completed | failed
    error         String DEFAULT '',
    started_at    DateTime,
    finished_at   Nullable(DateTime),
    updated_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (variable_id, started_at, id);

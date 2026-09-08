# Data model: normalized schema, Parquet layout, ClickHouse tables

Date: 2026-09-08
Status: draft, pending user approval
Parent: `2026-09-08-scale-to-one-year-architecture.md`

## From the 35-column flat CSV to three tables

The current CSV is a pandas left join of `transactions` onto `token_transfers` with a `_tx`
suffix and a derived `is_token_transfer`. Every transfer row repeats its transaction's
`input`, signature and fee fields. The new model stores each fact once:

| Table | One row per | Primary sort key |
|---|---|---|
| `blocks` | block | `block_number` |
| `transactions` | transaction | `(block_number, transaction_index)` |
| `token_transfers` | transfer event (a batch transfer yields one row per `batch_index`) | `(block_number, transaction_index, event_index, batch_index)` |

The "All Records" view of the explorer (the flat 35-column join) becomes a query-time join,
served by the API for bounded block ranges. Nothing is lost: every source column survives.

### Column mapping

| CSV column | New home | Type change | Note |
|---|---|---|---|
| `block_hash`, `block_number`, `block_timestamp` | all three tables | hash → 32 bytes, timestamp → DateTime | denormalized on purpose: they are the sort/partition keys |
| `transaction_hash`, `transaction_index` | `transactions`, `token_transfers` | hash → 32 bytes | join key |
| `event_index`, `batch_index`, `address`, `event_type`, `event_hash`, `event_signature`, `operator_address`, `from_address`, `to_address`, `token_id`, `quantity`, `removed` | `token_transfers` | addresses → 20 bytes, `event_type` → enum, `token_id`/`quantity` → UInt256 | `address` is the token contract |
| `nonce_tx`, `from_address_tx`, `to_address_tx`, `gas_tx`, `gas_price_tx`, `input_tx`, `max_fee_per_gas_tx`, `max_priority_fee_per_gas_tx`, `type_tx`, `chain_id_tx`, `r_tx`, `s_tx`, `v_tx`, `y_parity_tx` | `transactions`, without the `_tx` suffix | addresses/hashes → bytes, fees → UInt128 | `to_address` is null on contract creation |
| `value_lossless_tx` | `transactions.value` | UInt256 | full 256-bit precision |
| `value_tx` | dropped | | `value_lossless_tx` with a `.0` suffix; pure duplicate |
| `access_list_tx` | `transactions.access_list` | JSON string | the CSV holds a numpy `array([...])` repr with embedded newlines, unparseable; export as `TO_JSON_STRING(access_list)` |
| `is_token_transfer` | dropped | | implied by the table |

Open decision: `r`, `s`, `v`, `y_parity` are ~64 random bytes per transaction that do not
compress (~43 GB / year). Keep if the researchers need signature analysis; otherwise drop
them from the canonical Parquet and note it in the data dictionary.

### Types

- Addresses: 20-byte binary. Hashes: 32-byte binary. Rendered as `0x…` hex only at the API edge.
- 256-bit integers (`value`, `quantity`, `token_id`): `UInt256` in ClickHouse, `DECIMAL(76,0)`
  or a 32-byte fixed binary in Parquet (see below). Never a float.
- Fee fields (`gas_price`, `max_fee_per_gas`, `max_priority_fee_per_gas`): `UInt128`.
- `block_timestamp`: seconds since epoch, UTC.
- `event_type`: enum `ERC-20 | ERC-721 | ERC-1155` (extend if the source adds values).

## Canonical Parquet layout (the dataset)

```
r2://eth-dataset/v1/
  manifest.json
  schema/transactions.json, token_transfers.json, blocks.json
  transactions/year=2026/month=07/blocks_25500000_25509999.parquet
  token_transfers/year=2026/month=07/blocks_25500000_25509999.parquet
  blocks/year=2026/month=07/blocks_25500000_25509999.parquet
```

- **File = 10,000 blocks** (~33 hours), roughly 1 GB for transactions, 0.4 GB for transfers.
  A file never straddles a month boundary; the last file of a month is shorter.
- **Sorted by the table's sort key**, row groups of ~100,000 rows, zstd compression, Parquet
  column statistics on. Sorting is what lets DuckDB over HTTP skip row groups by block.
- **256-bit values** are written as Parquet `DECIMAL(76,0)` (fixed 32-byte binary). DuckDB
  and pyarrow read it as a decimal; document a one-line cast for pandas users.
- **Manifest** (`manifest.json`): schema version, dataset release tag, head block, and per
  file: table, path, block range, row count, bytes, sha256, created-at. The manifest is
  written last, so a partially uploaded chunk is never visible.
- **Releases**: a dated tag (`2026.09`) is a frozen manifest. Files are immutable once
  listed; corrections ship as a new release, never as an overwrite. R2 object versioning on.
- Optional mirrors: Hugging Face Datasets (free public hosting, DOI); Zenodo for a yearly
  release under its 50 GB-per-record limit (a subset, e.g. the `blocks` table plus one month).

## ClickHouse schema (derived layer)

Engine `ReplacingMergeTree` on every fact table: a re-inserted chunk deduplicates on merge,
so a retried load can never double-count. The ingest log (see the ingest spec) is the
primary guard; the engine is defense in depth.

```sql
CREATE TABLE transactions
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
    access_list               String            CODEC(ZSTD(3)),   -- JSON
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

CREATE TABLE token_transfers
(
    block_number       UInt32   CODEC(Delta, ZSTD),
    block_timestamp    DateTime CODEC(Delta, ZSTD),
    block_hash         FixedString(32),
    transaction_index  UInt16,
    transaction_hash   FixedString(32),
    event_index        UInt32,
    batch_index        UInt32,
    address            FixedString(20),                    -- token contract
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

CREATE TABLE blocks
(
    block_number     UInt32   CODEC(Delta, ZSTD),
    block_timestamp  DateTime CODEC(Delta, ZSTD),
    block_hash       FixedString(32),
    transaction_count UInt16,
    transfer_count    UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY block_number;
```

Partitioning by month gives 12 partitions a year, 60 for five years, and matches the
Parquet layout one-to-one, so "reload July" is one `DROP PARTITION` plus one `INSERT`.

### Address index tables (the address lookup problem)

Bloom filters answer "address = X" in 0.5–5 s over a year because they only skip granules.
A small secondary table sorted by address answers it in milliseconds and costs ~30 bytes
per row instead of a full projection copy:

```sql
CREATE TABLE tx_by_address
(
    address           FixedString(20),
    block_number      UInt32,
    transaction_index UInt16,
    role              Enum8('from' = 1, 'to' = 2)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(block_number, 1000000)
ORDER BY (address, block_number, transaction_index, role);

CREATE MATERIALIZED VIEW tx_by_address_mv TO tx_by_address AS
SELECT from_address AS address, block_number, transaction_index, 'from' AS role FROM transactions
UNION ALL
SELECT to_address, block_number, transaction_index, 'to' FROM transactions WHERE to_address IS NOT NULL;
```

The same pattern yields `transfers_by_address` (roles `from`, `to`, `token`, `operator`)
and `tx_by_hash` (`transaction_hash → block_number, transaction_index`). A lookup is two
primary-key reads: index table, then the fact table by `(block_number, transaction_index)`.

### Materialized aggregates (the stats band)

```sql
CREATE TABLE block_stats
(
    block_number      UInt32,
    block_timestamp   DateTime,
    tx_count          UInt32,
    transfer_count    UInt32,
    erc20_count       UInt32,
    erc721_count      UInt32,
    erc1155_count     UInt32,
    eth_moved         UInt256,      -- sum of transactions.value
    gas_price_min     UInt128,
    gas_price_max     UInt128,
    addresses_state   AggregateFunction(uniq, FixedString(20))
)
ENGINE = AggregatingMergeTree
ORDER BY block_number;
```

Fed by materialized views on both fact tables. A year is 2.63 M rows here, so any
block-range or day-range stat (`sum`, `min`, `max`, `uniqMerge`) answers in milliseconds.
The explorer's stats band and the dictionary's per-column stats (fill rate, distinct
counts, min/max) read from this table or from a nightly `column_stats` refresh, never from
the fact tables.

## Data dictionary

`src/data/dictionary.ts` stays the single source of truth for field descriptions. It gains
a `table` field (`blocks | transactions | token_transfers`) replacing `source`, and entries
for the dropped columns move to a "removed in v1" note. The same dictionary is exported as
`schema/*.json` next to the Parquet files so the downloadable dataset is self-describing.

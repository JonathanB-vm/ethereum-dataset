# Ethereum Dataset Explorer

A single-page explorer for 100 blocks of Ethereum mainnet activity — blocks
**25,534,200–25,534,299**, spanning 19m 48s on 2026-07-14 (23:35:11–23:54:59 UTC) —
browsable in a sortable, filterable data table with live dataset statistics, a full data
dictionary, and CSV export.

## Dataset provenance

The data comes from Google BigQuery's public
`blockchain_analytics_ethereum_mainnet_us` dataset, joining two tables:

- **`token_transfers`** — ERC-20 / ERC-721 transfer events
- **`transactions`** — the enclosing mainnet transactions

A third BigQuery export, `tokens.csv` (223,930 token contracts, gitignored), supplies each
token contract's `decimals` — the scale factor every ERC-20 quantity is stored against,
since Ethereum has no fractional integers. `npm run data:tokens` distills it to
`public/data/tokens.json`, keeping only the contracts this dataset references.

**Coverage is partial and the gap is not random.** Of the 955 token contracts in the
dataset, 64 have usable decimals, covering 20,352 of 43,941 transfer rows (46.3%). USDC is
absent from the token export and is alone 25% of all transfers. Rows whose decimals are
unknown show a dash rather than a guessed divisor — a wrong scale is off by orders of
magnitude, which is worse than no answer.

The source export (`analytics_25534200_25534299.csv`, 2.19 GB, gitignored) covers 100
blocks: 74,889 rows — 43,941 token-transfer rows and 30,948 transaction rows — across 35
documented columns. 96.9% of the export's bytes are a single column, `input_tx` (contract
calldata), which is duplicated across every row of a transaction. A prep script
(`npm run data:prep`) strips that column out of the row stream, dedupes it per
transaction, and ships it separately — see **Data pipeline** below. The browser therefore
loads 34 columns per row plus `input_tx` on demand.

Large numeric fields (wei values, gas prices, token quantities) are kept as **lossless
decimal strings** end to end — the app parses and compares them with `BigInt`, never
`Number`, so 256-bit values survive intact from BigQuery to the exported CSV.

## Quickstart

```bash
npm install
npm run dev       # Vite dev server
npm test          # Vitest unit suites
npm run build     # type-check + production bundle
npm run preview   # serve the production build
```

## What's in the app

- **Stats band** — six tiles computed live from the loaded records: record split
  (tx vs. transfers), token standards, total ETH moved, gas-price range, unique
  addresses, and blocks (count + range).
- **Three views** — curated *Token Transfers* and *Transactions* tabs (unit-converted
  columns: ETH, Gwei, plus a sortable, range-filterable **Block** column), plus an
  *All Records* tab showing all 34 loaded columns as raw stored values.
  *Token Transfers* gains a **Normalized Quantity** column (`quantity ÷ 10^decimals`, shown
  with the token symbol) beside the raw stored `Quantity` — an 80 USDT transfer reads as
  `80 USDT` rather than `80,000,000`. It sorts correctly across tokens of different scales
  and filters on bounds typed in token units.
- **Table** — per-column sorting (BigInt-aware for numeric strings), per-column filters
  (text / range / multi-select) with removable filter chips, debounced global search
  (⌘K / Ctrl-K) that stays responsive at 74,889 rows, pagination, and per-row detail
  expansion with raw + human-readable values.
- **Input Data on demand** — expanding a row fetches that transaction's calldata
  (`input_tx`) lazily through `CalldataProvider`, showing `Loading…` then the value; a
  plain value-transfer transaction resolves to `0x` without a network round-trip, since
  only transactions with real calldata are shipped as artifacts.
- **Data dictionary** — a slide-over panel describing all 36 documented fields (source
  table, type, description) with live per-column stats: fill rate, distinct count,
  min/max. `input_tx` shows "Fetched on demand" instead of a fill-rate bar, since its
  value isn't held in memory. Every column header's ⓘ opens the same panel scoped to
  that field.
- **CSV export** — the current view (filtered + sorted, all pages) as CSV: either the
  visible columns or all 34 loaded columns, with lossless numeric strings. Exports are
  value-lossless but format-normalized: numeric `.0` suffixes from the source CSV aren't
  reproduced, and line endings may differ from the original file.
- **Dual theme** — dark (default) and light, persisted across reloads.

## Data pipeline

The 2.19 GB source export never ships to the browser directly. A prep script turns it
into the artifacts the app actually loads (see the **Architecture** diagram below for
where each artifact fits):

```bash
npm run data:prep <source.csv>   # regenerates public/data/
npm run data:tokens   # rebuild public/data/tokens.json from tokens.csv
```

The script streams the source row by row — it is never held in memory — and:

- projects each row down to the 34 columns the browser loads, leaving `input_tx` out;
- collapses whitespace in `access_list_tx`, a cosmetic normalization of a Python/numpy
  repr that BigQuery exports with literal newlines and indentation;
- accumulates `input_tx` values into a `Map`, keyed by transaction hash, skipping plain
  `0x` value-transfers (28,422 of the source's 40,642 transactions carry no calldata);
  deduplicated this is only ~30 MB, versus 2.12 GB duplicated across every row;
- writes that map out sharded by the transaction hash's first hex byte
  (`calldata/<xx>.json.gz`, 256 shards) so the browser can derive a shard's filename from
  a hash it already has, with no index file to fetch first;
- writes `dataset.json`, a manifest of row/column counts, the block range, and the time
  span — emitted for provenance and external tooling. The app does not read this file; it
  derives the same figures from the loaded rows at runtime (see `computeStats` below).

Fetching calldata relies on `DecompressionStream`, which requires Chrome 80+, Firefox
113+, or Safari 16.4+.

## Architecture

```
analytics_*.csv (2.19 GB, gitignored)
        │  npm run data:prep
        ▼
public/data/rows.csv.gz          ← 74,889 rows × 34 columns
public/data/calldata/<xx>.json.gz ← input_tx, per transaction
        │
src/data/csvProvider.ts     ← fetch + gunzip + PapaParse + interning
src/data/calldataProvider.ts ← lazy per-row calldata
        │        implements
src/data/provider.ts   (DataProvider)  ← the data-layer seam
        │
src/data/transform.ts / dictionary.ts  ← BigInt conversions, 36-field column dictionary
        │
src/App.tsx                            ← load state, tabs, theme, panels
├── src/features/stats/                ← stats band (computeStats)
├── src/features/table/                ← TanStack table: columns, filters, chips, detail
├── src/features/dictionary/           ← dictionary slide-over + per-column stats
└── src/features/export/               ← CSV builder + download
```

**Data refresh:** the UI depends only on the `DataProvider` interface
(`src/data/provider.ts`). A future scheduled job (e.g. a BigQuery cron export followed by
`npm run data:prep`) replaces `public/data/*` — or swaps in a provider that queries an
API directly — without touching any component. Everything downstream (stats, tab counts,
block badge, dictionary stats) is derived from the loaded records at runtime, never
hard-coded.

## Roadmap: one year of blocks

The next milestone replaces the single-block CSV with one year of mainnet data (~2 B rows)
served through an API and downloadable Parquet. The design lives in
`docs/superpowers/specs/2026-09-08-*.md` (architecture, data model, ingest pipeline,
API + explorer changes) and `docs/superpowers/plans/2026-09-08-scale-roadmap.md`.
A survey of industry practice (BigQuery, ClickHouse, Dune, Blockscout, Etherscan, cryo,
AWS Public Blockchain Data, era1) compared line by line with those specs is in
`docs/superpowers/specs/2026-09-08-industry-practice-comparison.md`.
Supporting files: `sql/export_block_range.sql` (draft BigQuery → Parquet export) and
`scripts/measure-csv.mjs` (streaming sizing of any export CSV).

**Costs, sizing and the open decisions are summarised in
[`docs/superpowers/plans/2026-09-09-decision-brief.md`](docs/superpowers/plans/2026-09-09-decision-brief.md)**,
written to be forwarded to the research group as-is.

A working slice of that design already runs locally, with no cloud account:
`pipeline/repack.py` turns the export into canonical Parquet, `pipeline/clickhouse/`
holds the schema and load, and `api/` serves the paged read API over it. See
[`pipeline/README.md`](pipeline/README.md) to run the whole stack, and for what it does
and does not prove.

## Testing

`npm test` runs 274 unit tests across 31 Vitest suites covering the dictionary, CSV
parsing and row validation, gzip decoding, the dataset-prep helpers, the calldata
provider, BigInt transforms, dataset/column stats, filter functions, debounced search,
pagination ranges, column definitions, and CSV export.

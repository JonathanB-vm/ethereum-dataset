# Ethereum Dataset Explorer

A single-page explorer for a snapshot of Ethereum mainnet activity: token transfers and
transactions at block **25,534,300**, browsable in a sortable, filterable data table
with live dataset statistics, a full data dictionary, and CSV export.

## Dataset provenance

The data comes from Google BigQuery's public
`blockchain_analytics_ethereum_mainnet_us` dataset, joining two tables:

- **`token_transfers`** — ERC-20 / ERC-721 transfer events
- **`transactions`** — the enclosing mainnet transactions

The export (`public/data/analytics_25534300.csv`) is a 600-row snapshot centered on block
25,534,300: 504 token-transfer rows and 96 transaction rows across 35 columns. Large
numeric fields (wei values, gas prices, token quantities) are kept as **lossless decimal
strings** end to end — the app parses and compares them with `BigInt`, never `Number`, so
256-bit values survive intact from BigQuery to the exported CSV.

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
  addresses, and the block number/timestamp.
- **Three views** — curated *Token Transfers* and *Transactions* tabs (unit-converted
  columns: ETH, Gwei), plus an *All Records* tab showing all 35 columns as raw stored
  values.
- **Table** — per-column sorting (BigInt-aware for numeric strings), per-column filters
  (text / range / multi-select) with removable filter chips, global search (⌘K / Ctrl-K),
  pagination, and per-row detail expansion with raw + human-readable values.
- **Data dictionary** — a slide-over panel describing all 35 fields (source table, type,
  description) with live per-column stats: fill rate, distinct count, min/max. Every
  column header's ⓘ opens the same panel scoped to that field.
- **CSV export** — the current view (filtered + sorted, all pages) as CSV: either the
  visible columns or all 35, with lossless numeric strings. Exports are value-lossless
  but format-normalized: numeric `.0` suffixes from the source CSV aren't reproduced, and
  line endings may differ from the original file.
- **Dual theme** — dark (default) and light, persisted across reloads.

## Architecture

```
public/data/analytics_25534300.csv     ← BigQuery export (the current data source)
        │
src/data/csvProvider.ts                ← fetch + PapaParse + row validation
        │        implements
src/data/provider.ts   (DataProvider)  ← the data-layer seam
        │
src/data/transform.ts / dictionary.ts  ← BigInt conversions, 35-field column dictionary
        │
src/App.tsx                            ← load state, tabs, theme, panels
├── src/features/stats/                ← stats band (computeStats)
├── src/features/table/                ← TanStack table: columns, filters, chips, detail
├── src/features/dictionary/           ← dictionary slide-over + per-column stats
└── src/features/export/               ← CSV builder + download
```

**Data refresh:** the UI depends only on the `DataProvider` interface
(`src/data/provider.ts`). A future scheduled job (e.g. a BigQuery cron export) replaces
`public/data/*.csv` — or swaps in a provider that queries an API directly — without
touching any component. Everything downstream (stats, tab counts, block badge, dictionary
stats) is derived from the loaded records at runtime, never hard-coded.

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

## Testing

`npm test` runs unit tests across 11 Vitest suites covering the dictionary, CSV parsing
and row validation, BigInt transforms, dataset/column stats, filter functions, pagination
ranges, column definitions, and CSV export.

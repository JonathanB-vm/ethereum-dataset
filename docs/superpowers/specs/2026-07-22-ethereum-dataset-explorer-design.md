# Ethereum Dataset Explorer — Design Spec

**Date:** 2026-07-22
**Status:** Approved by user

## Purpose

A professional, design-forward web UI for a blockchain research group to browse an
Ethereum dataset exported from Google BigQuery
(`blockchain_analytics_ethereum_mainnet_us`, tables `token_transfers` + `transactions`,
merged into one CSV). Researchers must be able to **sort**, **filter**, and **export
filtered/sorted CSV**, and get **documentation about every column** (sourced from the
project PDF). Visual quality is a top priority — the tool previews dense data, so
detail matters.

In the near future, cron jobs will fetch fresh data from BigQuery and update the
dataset. The architecture must make that swap cheap.

## Current data

- File: `analytics_25534300.csv` (project root), ~6.5 MB
- **600 logical records**, 35 columns, all from block **25534300** (2026-07-14 23:55:11 UTC)
- Records span multiple physical lines (large quoted `input_tx` hex payloads); must be
  parsed with a real CSV parser (PapaParse), never line-split
- Row types by `is_token_transfer`:
  - `False` → **96 plain transactions** (token_transfer columns empty)
  - `True` → **504 token transfers**: 503 ERC-20, 1 ERC-721 (some transaction columns empty)
- Numeric precision: `value_lossless_tx` and `quantity` exceed 2^53 — treat as
  strings/BigInt in logic, never `parseFloat` for computation (display-rounding is fine)

## Architecture

**React 18 + Vite + TypeScript SPA.** No backend for now.

```
src/
  data/          # data layer — the only part that changes when BigQuery cron arrives
    provider.ts  # DataProvider interface: loadRecords(): Promise<EthRecord[]>
    csvProvider.ts # PapaParse the static CSV asset
    types.ts     # EthRecord type (35 fields), enums
    transform.ts # wei→ETH, gwei, timestamp, BigInt-safe parsing
    dictionary.ts# column metadata from the PDF (name, description, source table)
  features/
    stats/       # stats band cards
    table/       # TanStack Table setup, columns per tab, filters, pagination
    export/      # CSV generation from current view state
    dictionary/  # column info side panel + full dictionary view
  components/    # shared UI primitives (badges, copy button, theme toggle…)
  theme/         # design tokens, light/dark
```

- **Table engine: TanStack Table (headless)** — full sorting/filtering/column model,
  zero imposed markup, so the design is entirely ours. (AG Grid rejected: fights custom
  design. Hand-rolled rejected: re-solves solved problems.)
- **CSV parsing: PapaParse** on a static asset fetch.
- **DataProvider interface** isolates the data source; the future BigQuery-fed API
  implements the same interface with no UI changes.

## Layout & features

1. **Header** — dataset title, block badge (`#25534300`), global search, theme toggle.
2. **Stats band** — cards: total records; transactions vs transfers split; ERC-20/721
   breakdown; total ETH moved; gas price range; unique addresses. Small inline visuals
   where meaningful (follow `dataviz` skill).
3. **Tabs** — `Token Transfers (504)` · `Transactions (96)` · `All Records (600)`.
   Each tab shows only its relevant columns; All = raw 35-column view.
4. **Table**
   - Sticky header; pagination 25/50/100 (default 50)
   - Monospace truncated hashes/addresses (`0x0058…6fc5`) with copy-on-click
   - Human-readable rendering: Wei→ETH, gas in Gwei, formatted timestamps; raw value
     on hover/expand
   - Row expand → full detail of every field of that record
   - Sorting on every column (numeric-aware, BigInt-safe for value columns)
5. **Filtering**
   - Per-column: text match (addresses/hashes), numeric range (value, gas, gas price),
     dropdown (event_type, type_tx, removed)
   - Global search across all fields
   - Active filters rendered as removable chips above the table
6. **CSV export** — downloads exactly the current view: active tab + filters + sort
   order. Option: visible columns only, or all 35 columns. Client-side generation.
7. **Data dictionary** — ⓘ icon on every column header opens a side panel: PDF
   description, source table (`token_transfers` / `transactions` / both), plus live
   stats (fill rate, distinct values, min/max where numeric). A full dictionary view
   lists all 35 fields.

## Design system

- **Both light & dark themes**, toggle in header, **dark default**
- Technical-professional aesthetic: Dune/Etherscan energy but cleaner
- Monospace (JetBrains Mono) for all on-chain data; sans for UI chrome
- Restrained single accent color; high data density with careful alignment
- Implementation must follow the **frontend-design** skill and **dataviz** skill
  (for stat cards/inline visuals); both themes styled deliberately, not auto-inverted

## Error handling

- CSV fetch/parse failure → clear full-page error state with retry
- Malformed rows counted and surfaced in a dismissible notice (never silently dropped)
- Empty filter results → designed empty state with "clear filters" action

## Testing

**Vitest** unit tests for the data layer:
- CSV parsing (multiline records, empty fields → null)
- Transforms (wei→ETH, gwei, BigInt-safe compare, timestamp)
- Filter predicates (text, range, enum) and sort comparators
- Export generation (respects filters/sort/column visibility, round-trips values losslessly)

UI verified manually against both themes.

## Out of scope (this phase)

- BigQuery cron sync + API (future phase; DataProvider is the seam)
- Charts dashboard beyond the stats band
- Multi-block navigation (data is a single block today; UI must not hard-code the
  assumption — block badge derives from data)
- Authentication, deployment pipeline

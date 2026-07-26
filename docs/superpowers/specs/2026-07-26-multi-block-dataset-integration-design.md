# Multi-Block Dataset Integration — Design

**Date:** 2026-07-26
**Status:** Approved, ready for implementation planning
**Supersedes:** the single-block (600-row) data source described in
`2026-07-22-ethereum-dataset-explorer-design.md`

## Problem

The app currently loads `public/data/analytics_25534300.csv` — 600 rows from a single
block — with `fetch` → PapaParse → an in-memory `EthRecord[]`. A new export,
`analytics_25534200_25534299.csv`, covers 100 blocks and is **2.19 GB**. It cannot be
loaded the way the current file is, and the app's single-block assumptions are now
factually wrong on screen.

## Source data profile

Measured by a full streaming parse of the source file, not sampled.

| property | value |
|---|---|
| Logical CSV rows | 74,889 |
| Columns | 35 — **identical** to the current file, same names, same order |
| Blocks | 100, contiguous: 25,534,200 – 25,534,299 |
| Rows per block | 56 min / 1,992 max / 748.9 avg |
| Row split | 43,941 token transfers, 30,948 transaction rows |
| Token standards | ERC-20 43,595 · ERC-721 292 · ERC-1155 54 |
| Time span | 2026-07-14 23:35:11 → 23:54:59 UTC (19m 48s) |
| Distinct transactions | 40,642 |

### Where the 2.19 GB actually is

| column group | bytes | share |
|---|---|---|
| `input_tx` | 2.12 GB | **96.9%** |
| `access_list_tx` | 23 MB | 1.1% |
| all 33 other columns | 46 MB | 2.0% |

`input_tx` reaches 224,464 characters in a single value, and — critically — is
**repeated on every row of the same transaction**. One transaction in this export spans
702 rows, each carrying a full copy of its calldata. Deduplicated by
`transaction_hash`, the unique calldata totals **29.8 MB across 40,642 transactions**,
of which only **12,220** hold anything beyond `0x`. That is a 71× reduction.

The size problem is therefore one column, not 100× the rows. 74,889 rows × 34 columns
is **70.5 MB raw / 12.3 MB gzipped** — well within the existing architecture.

### Two data-shape changes from the 600-row file

1. **`access_list_tx` now carries real data** on 2,175 rows, as a Python/numpy repr
   containing **literal newlines**:

   ```
   "[{'address': '0x…', 'storage_keys': array(['0x0000…0018',
          '0x0000…0019'], dtype=object)}]"
   ```

   PapaParse handles the quoted newlines correctly, but rendered raw the cell and the
   row-detail panel look broken. In the old file this column was `[]` on every row.

2. **Numeric columns arrive with `.0` suffixes** more often (`chain_id_tx` as `1.0`,
   `event_index` as `5.0`). The existing `int()` helper in `csvProvider.ts` already
   handles this via `parseInt`; the new fixture locks the behavior in.

## Decisions

| # | Decision | Rejected alternatives |
|---|---|---|
| 1 | `input_tx` is **lazy-loaded per row** from a deduplicated side store | Drop it entirely; truncate to a preview; move to a query backend |
| 2 | Artifacts are **pre-built and committed, gzipped** | Commit uncompressed (~100 MB repo); generate at build time (no build without the 2.2 GB source) |
| 3 | Block gets a **column in the curated tabs, and the singular framing is corrected** | Column only (leaves header lying); add a full Blocks overview tab |
| 4 | The 600-row dataset is **replaced** | Keep both with a switcher; keep as a test-only fixture |

## Architecture

### 1. Offline prep script

`scripts/prepare-dataset.mjs`, run manually: `npm run data:prep <source.csv>`.
Stream-parses the source once (PapaParse in Node stream mode, bounded memory) and
writes three artifacts into `public/data/`:

| artifact | contents | approx size |
|---|---|---|
| `rows.csv.gz` | 74,889 rows × 34 columns (all but `input_tx`) | 12.3 MB |
| `calldata/<00–ff>.json.gz` | 256 shards keyed by the first hex byte of `transaction_hash`; each an object `{ txHash: "0x…" }` | ~48 KB each, ~12 MB total |
| `dataset.json` | row count, block min/max, time span, shard-scheme version | <1 KB |

`dataset.json` is **not a runtime dependency** — the app derives every one of those
values from the loaded records, as it does today. It exists so the artifacts are
self-describing and so a prep run can be verified against the source without reparsing
2.19 GB.

Sharding by tx-hash prefix needs no index and no manifest lookup — the client derives
the shard name from the hash. Only the 12,220 transactions with real calldata are
written; the other 28,422 are reconstructed client-side as `0x` on a shard miss, so a
**miss is a normal outcome, not an error**.

The script also **collapses whitespace runs to single spaces in `access_list_tx`**.
This is cosmetic normalization of a non-standard Python repr — no tokens are lost. It
is documented in the column's dictionary description and in the README. Parsing the
repr into real JSON was considered and rejected as a guessy transform on an unspecified
format.

The 2.19 GB source is **gitignored**. It is an input to the script, never a committed
artifact.

### 2. The `input_tx` split

`EthRecord` **drops `input_tx`**. Keeping it as a permanently-`null` field would be a
lie that every consumer silently inherits.

A data dictionary should still document all 35 fields of the dataset, so `ColumnMeta`
gains one property:

```ts
availability: 'loaded' | 'on-demand'
```

- `COLUMNS` stays **35 entries** — dictionary completeness; the existing
  `dictionary.test.ts` assertion on 35 still holds.
- A derived `LOADED_COLUMNS` (the 34 with `availability: 'loaded'`) drives everything
  that operates on in-memory rows:
  - the All Records tab — `columns.tsx:242`
  - `ALL_FIELDS` for global search — `filters.ts:62`
  - the export field list — `ExportButton.tsx:58`, whose label becomes "All 34 columns"
- `ColumnMeta['field']` widens to `keyof EthRecord | 'input_tx'`. `LOADED_COLUMNS` is
  typed as a narrowed `LoadedColumnMeta[]` whose `field` is `keyof EthRecord`, so the
  table/search/export call sites that index into a record keep full type safety and do
  not need a cast.

Two consumers deliberately keep all 35 and handle the on-demand field specially:

- **Dictionary panel** — renders `input_tx`'s description normally, but replaces its
  live stats with *"Fetched on demand — not loaded in the browser"*. `columnStats.ts`
  cannot compute a fill rate for data it does not hold, and reporting 0% would be worse
  than saying so.
- **Row detail / fullscreen** — `input_tx` stays in the "Signature & Advanced" group
  (`rowDetailFields.ts:43`), rendered as an async field.

### 3. Loading

`csvProvider.ts` default URL becomes `/data/rows.csv.gz`.

**Gzip sniffing.** If a host serves `.gz` with `Content-Encoding: gzip`, the browser has
already decompressed the body and piping it through `DecompressionStream` would fail.
The provider therefore checks for the gzip magic bytes `0x1f 0x8b` and only decompresses
when they are present — correct on either kind of host.

`parseCsv(text)` is **unchanged**. It is already tested and simply receives a larger
string.

**String interning during parse.** A per-load `Map<string, string>` collapses repeated
values in the low-cardinality columns to a single allocation each:
`block_hash` (100 distinct across 74,889 rows), `event_signature` (3 across 43,941),
`block_timestamp`, `event_type`, `event_hash`, `access_list_tx`.

### 4. Calldata provider

`src/data/calldataProvider.ts` — a second seam beside `DataProvider`:

```ts
export interface CalldataProvider {
  /** Resolves to the tx's calldata, or '0x' when it carried none. */
  get(txHash: string): Promise<string>
}
```

- Shard name is `txHash.slice(2, 4)`.
- Caches `Map<shard, Promise<Record<string, string>>>`, so each shard is fetched at most
  once and a second row in the same shard resolves without a network round trip.
- A **key miss returns `'0x'`** — the normal case for 28,422 of 40,642 transactions.
- A **network or decompress failure rejects**, so row detail can offer a retry rather
  than display a fabricated `0x`.

### 5. Block as a real dimension

`block_number` joins `transferColumns` and `transactionColumns` immediately after
`block_timestamp`. Its dictionary `kind` is already `number`, so `filterFnForKind` gives
it a range filter with no new filter code — "blocks 25534250–25534260" works for free.

`computeStats` replaces `blockNumber` / `blockTimestamp` with `blockCount`, `blockMin`,
`blockMax`, `timeStart`, `timeEnd`, computed in the pass it already makes. Then:

- **Header badge** → `100 blocks · 25,534,200–25,534,299`. It reports the *distinct*
  block count, so a future export with gaps stays honest rather than implying a
  contiguous run.
- **Stats tile 6** → block range plus the time span it covers.
- **Export filename** → `analytics_25534200_25534299_transfers.csv`.
- `latestBlock()` in `App.tsx:26` is **deleted**. Header and ExportButton read the range
  off `stats`, removing a redundant full-array scan.

### 6. Performance

**Unconditional — debounce global search.** Each keystroke currently substring-matches
74,889 rows × 34 fields: ~2.5M string operations per character. `App` keeps the input's
own value in immediate state so typing stays responsive, and feeds the table a
200 ms-trailing `globalFilter`.

**Unconditional — real load progress.** The fetch body reader plus `Content-Length`
gives a true percentage for the 12 MB download, the dominant phase. The parse phase
shows an indeterminate "Parsing 74,889 rows…". `LoadingState` gains an optional
progress prop.

**Contingent, only if measurement shows it.** Memoize `toBigInt` behind a
`Map<string, bigint>` if sorting `quantity` across 43,941 transfer rows stutters.
Measure before building it.

**Watch, no change expected.** `getFacetedUniqueValues` computes lazily per column on
access, and the enum columns (`event_type`, `type_tx`, `removed`, `is_token_transfer`)
are tiny. Revisit only if opening a filter popover stutters.

## Testing

A new committed fixture, ~20 rows across 3 blocks, carries the real file's quirks so
they cannot regress: a multi-line quoted `access_list_tx`, and `event_index` as `5.0`.

**New suites**
- prep-script pure helpers: shard key, row projection, whitespace collapse
- gzip magic-byte sniffing (both host behaviors)
- `calldataProvider`: hit, miss → `0x`, shard cache reuse, error propagation
- `block_number` present in both curated tabs, sortable and range-filterable
- block-range aggregation in `computeStats`
- export filename generation from a block range

**Updated suites**
- `dictionary.test.ts` — still 35 entries; every entry has a valid `availability`;
  exactly one is `'on-demand'`
- `columns.test.ts` — All Records tab returns 34, equal to `LOADED_COLUMNS`
- `RowDetail.test.ts` — unchanged, still set-equal to all 35

## Accepted risks

1. **`DecompressionStream` requires Safari 16.4+ / Firefox 113+** (Chrome 80+). Older
   browsers get a clear error, not a silent failure. Accepted; the fallback if it ever
   matters is shipping uncompressed artifacts.
2. **Peak load memory is roughly 300–500 MB** — a 70 MB decompressed string plus ~75k
   objects, before interning helps. Comfortable on desktop; a low-end phone may fail.
   Accepted. This is the hard ceiling of the static client-side decision: **100 blocks
   sits near it, and ~1,000 blocks would force a query backend** (Parquet + DuckDB-WASM,
   or an API behind the existing `DataProvider` seam).

## Out of scope

- A Blocks overview tab with per-block aggregates (considered, deferred)
- A dataset switcher between the 600-row and 100-block exports
- Parsing `access_list_tx` into structured JSON
- Row virtualization — the table is paginated, so DOM size is unaffected by row count

## Cleanup

- Delete both committed copies of `analytics_25534300.csv` (repo root and
  `public/data/`)
- Gitignore `analytics_*.csv` at the repo root
- Rewrite the README's provenance, dataset, and architecture sections, including the
  `input_tx` on-demand caveat and the `access_list_tx` normalization

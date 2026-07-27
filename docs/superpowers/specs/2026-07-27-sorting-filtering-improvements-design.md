# Sorting & Filtering Improvements — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation planning
**Builds on:** `2026-07-26-multi-block-dataset-integration-design.md`

## Problem

The 100-block dataset (74,889 rows, blocks 25,534,200–25,534,299) landed with the
single-block app's sorting and filtering unchanged. Five concrete gaps, each verified
against the code:

| # | Gap | Evidence |
|---|---|---|
| 1 | **Time cannot be filtered at all.** `block_timestamp` is the only `timestamp` field and the leftmost column on both curated tabs. You can sort by time; you can never bound it. | `columns.tsx:81-82` returns `undefined` for `kind: 'timestamp'` |
| 2 | **Multi-column sort works and is invisible.** Nothing overrides TanStack's `enableMultiSort` / `isMultiSortEvent`, so shift-click already stacks sorts — with no priority indicator and no hint the modifier exists. | `SortableHeader.tsx:26-28` renders only `▲`/`▼`/`↕` |
| 3 | **First-click sort direction is wrong for magnitude columns.** Ascending-first means clicking "Value ETH" surfaces zero-value transactions and "Quantity" surfaces dust. | no `sortDescFirst` anywhere in `src/` |
| 4 | **An unparseable filter bound is silently ignored** — correct behavior, indistinguishable from a broken filter. | `filters.ts:34-36` |
| 5 | **`block_number` is entered as free text** despite having a known, contiguous 100-value range. | `FilterControls.tsx:133-177` |

Three adjacent problem areas — shareable URL state, analytical filtering (match modes,
address facets, field-scoped search), and the two unmeasured performance items — were
considered and deliberately deferred. See **Out of scope**.

## Key observation

`block_number` and `block_timestamp` are **1:1** in this dataset: 100 blocks, each with
exactly one timestamp, roughly 12s apart. A time filter and a block filter are the same
constraint in different units. Building them as two independent controls would let two
on-screen controls express the same thing and appear to disagree.

They are therefore **one control**.

## Decisions

| # | Decision | Rejected alternatives |
|---|---|---|
| 1 | Block and time share **one dual-handle range control**, writing to `block_number`'s existing `'range'` filter | Two independent filters; a time-only filter with the block filter left as text boxes |
| 2 | Multi-sort is exposed as an **ordered chip row plus header priority badges**, with shift-click retained as the fast path | Header badges only (undiscoverable); a drag-to-reorder sort-manager popover (more surface, moves sorting away from the column) |
| 3 | Descending-first is an **explicit seven-field list**, not derived from `kind` | Derive from `kind: number \| bignum` — wrong for positions, counters and identifiers |
| 4 | Invalid bounds are **reported and excluded from the filter value**; `rangeFilter` itself is unchanged | Make `rangeFilter` reject rows on an unparseable bound (blanks the table mid-typing) |

---

## 1. The block & time range control

A single component, `BlockTimeRangeFilter`, opened from **either** the Time or the Block
header funnel. It writes to `block_number`'s existing `'range'` filter — no new filter
function, no change to `RangeFilterValue`, and `FilterChips` / clear-all keep working
untouched.

### The axis

`computeStats.ts:33` already builds `const blocks = new Set<number>()`. Widening it to a
`Map<number, string>` of block → timestamp yields the axis in the pass the function
already makes:

- `blockCount` becomes `map.size` — unchanged in meaning
- `blockMin` / `blockMax` — unchanged
- `DatasetStats` gains `blockAxis: { block: number; time: string }[]`, sorted ascending

The axis is derived from the **full** record set, never `tabRecords`, so handle labels do
not shift when the tab changes.

### Composition

Three parts in one popover, all bound to the same state:

1. **Two native `<input type="range">` handles**, indexed over the sorted distinct-block
   array — **not** over the raw numeric span. A future export with gaps turns them into
   adjacent steps rather than dead zones a handle can land in. Native inputs give keyboard
   and screen-reader support without reimplementing it.
2. **The existing Min/Max text boxes, retained.** Exact block entry still works, and they
   are the fallback if the slider is ever awkward.
3. **Live labels under each handle** — block number above, its `HH:MM:SS UTC` below, read
   from `blockAxis`. This is what makes the control satisfy "filter by time": you drag
   until the clock reads what you want.

The popover also shows the resulting row count via
`table.getFilteredRowModel().rows.length`. `HeaderContext` already carries `table`. The
footer reports the same number, but at the far end of a 50-row page.

### The timestamp column

`filterFnForKind` continues to return `undefined` for `'timestamp'` — that column genuinely
has no filter of its own. Instead `header()` special-cases `kind === 'timestamp'` and
renders this control targeting `block_number`. The Time funnel's active dot reads
`block_number`'s filter state, so **both funnels light up together**: they are one filter
and the UI does not pretend otherwise.

**Accepted consequence:** filtering from the Time column produces a chip reading
`Block: 25,534,212 – 25,534,287`, not a time range. That is correct — it *is* a block
filter, and a chip claiming otherwise would be the lie. The popover is headed "Block &
time range" so the mapping is never a surprise.

---

## 2. Multi-column sort

### Chips

`SortChips` renders as its own row **directly above** the existing `FilterChips` row,
reusing that component's CSS classes. The existing row gains a `Filters:` label for
symmetry. The two rows collapse independently when empty, as `FilterChips` does today.

```
Sort:     1. Value ETH ▼ ✕    2. Block ▲ ✕    Clear
Filters:  Standard: ERC-20 ✕    Block: 25,534,212 – 25,534,287 ✕    Clear all
```

Each chip is two controls: the **body toggles that column's direction**, the **`✕` drops
it** from the stack.

**Priority cannot be reordered** — you drop and re-add. This is the cost of choosing chips
over the drag-reorder manager, recorded here rather than discovered later.

### Header badges

The ordinal appears in `SortableHeader` **only when two or more sorts are active**; a lone
`¹` is noise when there is nothing to be first of. The arrow glyphs are already
`aria-hidden`, so the ordinal must reach assistive tech through the button's accessible
name: `"Value ETH, sorted descending, sort priority 1"`.

### The hint

When **exactly one** sort is active, the sort row shows a muted
`Shift-click another header to add`. At zero sorts there is nothing to add to; at two the
user has already learned it. The hint appears in the single state where it teaches
something, then leaves.

### Explicit options

`enableMultiSort: true` and `isMultiSortEvent: (e) => e.shiftKey` are currently inherited
silently in `DataTable.tsx:110-129`. The entire UI above depends on them, so they are
written down rather than left to a library default that could change. Stack depth is
uncapped — the chip row wraps, and a limit would be a guess.

**Accepted limitation:** shift-click has no touch equivalent, so on a tablet a user can
hold one sort but cannot stack them. The sort-manager popover was the option that solved
this; chips do not.

---

## 3. Sort direction defaults

A `DESC_FIRST_FIELDS` set in `columns.tsx`, beside the existing `DISPLAY_LABEL_OVERRIDES`
— same file, same pattern, and a UI concern kept out of the data dictionary.

**Descending-first (7):**
`quantity` · `value_tx` · `value_lossless_tx` · `gas_tx` · `gas_price_tx` ·
`max_fee_per_gas_tx` · `max_priority_fee_per_gas_tx`

**Deliberately excluded:** `block_number`, `transaction_index`, `event_index`,
`batch_index`, `nonce_tx`, `chain_id_tx` are positions and counters — ascending is the
natural first read. `token_id` is `bignum` but an identifier, not a magnitude; "highest
token ID" is not a question anyone asks.

This is why the list is explicit rather than derived from `kind`: `kind: 'number' |
'bignum'` covers all of the above, and deriving from it would be wrong for six of them.

---

## 4. Invalid-bound feedback

`rangeFilter` (`filters.ts:29-43`) is **unchanged**. Treating an unparseable bound as
not-yet-set is correct — it keeps a half-typed value from blanking the table. The problem
is that it is silent. Three changes, all in `RangePanel`:

1. **Validate against the filter that will actually run.** `toBigInt` for plain `range`
   columns, `decimalToWei(v, 18)` for ETH, `decimalToWei(v, 9)` for Gwei. `rangeUnit?:
   string` becomes `rangeUnit?: { label: string; decimals: number }`, so the unit label and
   the validation decimals stay one source of truth instead of decimals being inferred from
   a display string.
2. **Exclude an invalid bound from the filter value**, so the chip cannot render
   `≥ abc`. The inline message carries the explanation instead.
3. **Report it:** `aria-invalid`, `aria-describedby`, a red border, and a message beneath
   the input.

**Validation rides the existing 250 ms debounce** (`FilterControls.tsx:139-148`) rather
than running per keystroke — otherwise typing `0.` into an ETH field flashes an error
mid-decimal.

**`min > max` gets its own message** — *"Min is greater than Max"*. It parses fine and
returns zero rows, which reads as missing data. Reachable only through text entry; the
slider handles clamp.

---

## Structural note: reaching the axis

`transferColumns` / `transactionColumns` / `allColumns` are module-level constants built at
import time, so `header()` closes over static arguments and **cannot** receive `blockAxis`
as a prop.

It arrives through TanStack's `meta` escape hatch: `useReactTable({ meta: { blockAxis } })`,
read as `table.options.meta.blockAxis` from `HeaderContext`. This requires a `TableMeta`
declaration merge — the **same idiom this codebase already uses twice**, for `SortingFns`
(`columns.tsx:24-28`) and `FilterFns` (`filters.ts:102-112`). The column arrays are not
restructured.

Data flow: `computeStats` → `App` → `DataTable` prop → `useReactTable({ meta })` →
`HeaderContext` → `BlockTimeRangeFilter`.

---

## Testing

**New suites**
- `blockAxis` derivation — ascending, one entry per distinct block,
  `blockCount === blockAxis.length`
- `BlockTimeRangeFilter` — a handle sets `block_number`'s filter; each handle's label shows
  that block's timestamp; the Time funnel opens the same control and its active dot follows
  `block_number`
- Gapped axis — index → block mapping over non-contiguous blocks, no dead zones
- `SortChips` — renders in priority order; body toggles direction; `✕` removes one and
  preserves the order of the rest; `Clear` resets all; hint visible at exactly one sort
- `SortableHeader` — badge absent at one sort, present at two; priority in the accessible
  name
- Descending-first — `quantity` first-click descends, `block_number` first-click ascends
- `RangePanel` validation — garbage bound produces a message **and** is excluded from the
  filter value **and** is absent from the chip; `min > max` produces its message; ETH and
  Gwei bounds validate at 18 and 9 decimals respectively

**Fixture**

The gapped-block case gets its own **inline** fixture, not an edit to
`src/data/__fixtures__/multiblock.csv` — other suites depend on that file, and index-to-block
mapping over a non-contiguous axis is the one place this design could silently produce dead
zones.

**Must keep passing unchanged:** `dictionary.test.ts` (still 35 entries, `COLUMNS`
untouched), `columns.test.ts` (All Records still 34), `FilterChips` tests.

## Risks

1. **Two overlapping native `<input type="range">` elements is a fiddly CSS pattern**
   (pointer-events juggling on the upper track). Mitigated by keeping the Min/Max text
   boxes fully functional — the slider is an enhancement, never the only path to a bound.
2. **`meta` is untyped by default.** The declaration merge is what keeps
   `table.options.meta.blockAxis` type-safe; without it this is an `any` in the hot path of
   a new component.

## Out of scope

- URL / shareable filter state, saved views
- Match modes (equals / starts-with / not-contains), address facet lists, field-scoped
  global search (`from:0xabc`)
- Performance: the global search's ~2.5M per-pass string allocations (`filters.ts:68-77`)
  and the `bignum` sort's repeated `toBigInt` parsing stay **unmeasured and unchanged**
- Filters continue to reset on tab switch (`DataTable.tsx:97-104`)
- Sort priority reordering; multi-sort on touch

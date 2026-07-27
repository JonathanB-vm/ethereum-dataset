# Sorting & Filtering Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 100-block dataset a time/block range control, discoverable multi-column sorting, sensible first-click sort directions, and real feedback on invalid filter bounds.

**Architecture:** `computeStats` gains a `blockAxis` (block → timestamp, derived in the pass it already makes), which reaches the header cells through TanStack's `meta` escape hatch. A shared `FilterPopover` shell is extracted from `FilterControls` so a new `BlockTimeFilterControl` can reuse the funnel/popover/Escape behavior instead of duplicating it. Multi-sort is surfaced through a `SortChips` row mirroring the existing `FilterChips`, plus priority ordinals in the header's accessible name.

**Tech Stack:** React 19, TypeScript ~6.0, Vite 8, Vitest 4 (jsdom, `globals: true`), @tanstack/react-table 8, @testing-library/react 16, oxlint

**Spec:** `docs/superpowers/specs/2026-07-27-sorting-filtering-improvements-design.md`

## Global Constraints

- **Never use `Number`/`parseFloat` to compare dataset numeric values.** They are BigQuery numeric strings up to 256-bit; use `toBigInt` / `decimalToWei` / `compareNumericStrings` from `src/data/transform.ts`. `Number.parseInt` on a **block number** is fine — block numbers are small integers.
- **`rangeFilter` in `src/features/table/filters.ts:29-43` must not change behavior.** Treating an unparseable bound as not-yet-set is deliberate. Feedback is added in the panel, never by making the filter reject rows.
- **`COLUMNS` stays 35 entries; `LOADED_COLUMNS` stays 34.** `dictionary.test.ts` and `columns.test.ts` assert this and must keep passing untouched.
- **`blockAxis` is derived from the full record set, never `tabRecords`** — handle labels must not shift when the tab changes.
- **The block axis is indexed by position in the sorted distinct-block array, never by raw numeric span.** A future export with gaps must produce adjacent steps, not dead zones.
- Timestamps are stored as `"2026-07-14 23:35:11+00:00"` (space-separated, not ISO `T`). Characters 11–19 are `HH:MM:SS`.
- Every test file using jest-dom matchers must start with `import '@testing-library/jest-dom'` — there is no global setup file.
- Commands: `npm run test` (vitest run), `npm run lint` (oxlint), `npm run build` (tsc -b && vite build).
- Run a single test file with `npx vitest run <path>` and a single test with `npx vitest run <path> -t "<name>"`.

---

### Task 1: `blockAxis` in `computeStats`

**Files:**
- Modify: `src/data/types.ts` (append the `BlockAxisEntry` interface)
- Modify: `src/features/stats/computeStats.ts:4-20` (`DatasetStats`), `:33` (`blocks` Set → Map), `:71` (population), `:99-113` (return)
- Test: `src/features/stats/computeStats.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface BlockAxisEntry { block: number; time: string }` exported from `src/data/types.ts`
  - `DatasetStats.blockAxis: BlockAxisEntry[]` — ascending by `block`, one entry per distinct block

- [ ] **Step 1: Write the failing tests**

Append to `src/features/stats/computeStats.test.ts`, inside the existing `describe('computeStats', ...)` block. The file already defines `BASE` and `mk` at module scope — reuse them.

```ts
  it('builds an ascending block axis with one entry per distinct block', () => {
    const s = computeStats([
      mk({ block_number: 25534202, block_timestamp: '2026-07-14 23:35:35+00:00' }),
      mk({ block_number: 25534200, block_timestamp: '2026-07-14 23:35:11+00:00' }),
      mk({ block_number: 25534202, block_timestamp: '2026-07-14 23:35:35+00:00' }),
    ])
    expect(s.blockAxis).toEqual([
      { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
      { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
    ])
  })

  it('keeps blockCount and blockAxis length in agreement', () => {
    const s = computeStats([
      mk({ block_number: 25534200 }),
      mk({ block_number: 25534250 }),
      mk({ block_number: 25534250 }),
    ])
    expect(s.blockCount).toBe(2)
    expect(s.blockAxis).toHaveLength(s.blockCount)
  })

  it('backfills a block whose first-seen row had an empty timestamp', () => {
    const s = computeStats([
      mk({ block_number: 25534200, block_timestamp: '' }),
      mk({ block_number: 25534200, block_timestamp: '2026-07-14 23:35:11+00:00' }),
    ])
    expect(s.blockAxis).toEqual([{ block: 25534200, time: '2026-07-14 23:35:11+00:00' }])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/stats/computeStats.test.ts`
Expected: FAIL — three failures, each because `s.blockAxis` is `undefined`.

- [ ] **Step 3: Add the `BlockAxisEntry` type**

Append to `src/data/types.ts`:

```ts
/**
 * One block on the dataset's block axis, paired with the timestamp it was mined at.
 * Blocks and timestamps are 1:1 in this export, which is why a single range control can
 * express a bound in either unit — see the sorting/filtering design doc.
 */
export interface BlockAxisEntry {
  /** e.g. 25534200 */
  block: number
  /** Raw `block_timestamp`, e.g. "2026-07-14 23:35:11+00:00". `''` if no row carried one. */
  time: string
}
```

- [ ] **Step 4: Widen the `blocks` Set to a Map and expose the axis**

In `src/features/stats/computeStats.ts`:

Change the import on line 1 to also bring in the new type:

```ts
import type { BlockAxisEntry, EthRecord } from '../../data/types'
```

In the `DatasetStats` interface, after the `blockCount` field (line 15), add:

```ts
  /** Every distinct block with its timestamp, ascending. Drives the block/time range control. */
  blockAxis: BlockAxisEntry[]
```

Replace line 33:

```ts
  const blocks = new Set<number>()
```

with:

```ts
  // Map, not Set: `blocks.size` still gives blockCount, and the values give the block→time
  // axis the range control needs — both out of the single pass this function already makes.
  const blocks = new Map<number, string>()
```

Replace line 71:

```ts
    blocks.add(r.block_number)
```

with:

```ts
    // Same coalesce rule as the tx aggregates above: a block first seen on a row with an
    // empty timestamp gets backfilled by a later row that has one, rather than locking in ''.
    const seenTime = blocks.get(r.block_number)
    if (seenTime === undefined || (seenTime === '' && r.block_timestamp !== '')) {
      blocks.set(r.block_number, r.block_timestamp)
    }
```

Immediately before the `return {` on line 99, add:

```ts
  const blockAxis: BlockAxisEntry[] = Array.from(blocks, ([block, time]) => ({ block, time })).sort(
    (a, b) => a.block - b.block,
  )
```

In the returned object, change `blockCount: blocks.size,` to keep working (it does — `Map.size`) and add `blockAxis,` directly after it:

```ts
    blockCount: blocks.size,
    blockAxis,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/stats/computeStats.test.ts`
Expected: PASS — all tests in the file, including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add src/data/types.ts src/features/stats/computeStats.ts src/features/stats/computeStats.test.ts
git commit -m "feat: derive a block-to-timestamp axis in computeStats"
```

---

### Task 2: `axisIndexForBlock` and the `BlockTimeRangeFilter` panel

**Files:**
- Create: `src/features/table/blockAxis.ts`
- Create: `src/features/table/blockAxis.test.ts`
- Create: `src/features/table/BlockTimeRangeFilter.tsx`
- Create: `src/features/table/BlockTimeRangeFilter.test.tsx`
- Modify: `src/features/table/table.css` (append styles)

**Interfaces:**
- Consumes: `BlockAxisEntry` from `src/data/types.ts` (Task 1); `RangeFilterValue` from `src/features/table/filters.ts`.
- Produces:
  - `axisIndexForBlock(axis: BlockAxisEntry[], raw: string): number | null` from `./blockAxis`
  - `blockTimeLabel(time: string | undefined): string` from `./blockAxis`
  - `BlockTimeRangeFilter` from `./BlockTimeRangeFilter`, props:
    `{ axis: BlockAxisEntry[]; value: RangeFilterValue | undefined; onChange: (next: RangeFilterValue | undefined) => void; matchCount: number }`

This component is **presentational** — it never touches a TanStack `Column` or `Table`. Task 4 does the wiring. That is what makes it testable without a table instance.

- [ ] **Step 1: Write the failing helper tests**

Create `src/features/table/blockAxis.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { axisIndexForBlock, blockTimeLabel } from './blockAxis'
import type { BlockAxisEntry } from '../../data/types'

// Deliberately gapped: 200, 205, 206, 300. Index 1 is block 205, NOT block 201.
const GAPPED: BlockAxisEntry[] = [
  { block: 200, time: '2026-07-14 23:35:11+00:00' },
  { block: 205, time: '2026-07-14 23:36:11+00:00' },
  { block: 206, time: '2026-07-14 23:36:23+00:00' },
  { block: 300, time: '2026-07-14 23:55:59+00:00' },
]

describe('axisIndexForBlock', () => {
  it('returns the index of an exact block match', () => {
    expect(axisIndexForBlock(GAPPED, '206')).toBe(2)
  })

  it('indexes by position in the axis, not by numeric distance from the first block', () => {
    // Block 201 does not exist. Position 1 in the axis is block 205.
    expect(axisIndexForBlock(GAPPED, '205')).toBe(1)
    expect(axisIndexForBlock(GAPPED, '300')).toBe(3)
  })

  it('snaps a block that is not on the axis to the nearest one', () => {
    expect(axisIndexForBlock(GAPPED, '204')).toBe(1) // nearer 205 than 200
    expect(axisIndexForBlock(GAPPED, '250')).toBe(2) // nearer 206 than 300
  })

  it('clamps out-of-range values to the ends', () => {
    expect(axisIndexForBlock(GAPPED, '1')).toBe(0)
    expect(axisIndexForBlock(GAPPED, '999999')).toBe(3)
  })

  it('returns null for unparseable input or an empty axis', () => {
    expect(axisIndexForBlock(GAPPED, 'abc')).toBeNull()
    expect(axisIndexForBlock(GAPPED, '')).toBeNull()
    expect(axisIndexForBlock([], '200')).toBeNull()
  })
})

describe('blockTimeLabel', () => {
  it('extracts HH:MM:SS and marks it UTC', () => {
    expect(blockTimeLabel('2026-07-14 23:35:11+00:00')).toBe('23:35:11 UTC')
  })

  it('renders a dash when there is no timestamp', () => {
    expect(blockTimeLabel(undefined)).toBe('—')
    expect(blockTimeLabel('')).toBe('—')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/blockAxis.test.ts`
Expected: FAIL — "Failed to resolve import ./blockAxis".

- [ ] **Step 3: Implement the helpers**

Create `src/features/table/blockAxis.ts`:

```ts
import type { BlockAxisEntry } from '../../data/types'

/**
 * Position of `raw` on the block axis, snapping to the nearest block when it isn't one of
 * the axis's own values.
 *
 * Positional, not arithmetic: index 1 is "the second distinct block in the dataset", which
 * for a gapped export is not `blockMin + 1`. Indexing by raw numeric span would let a
 * slider handle land in a gap where no rows exist.
 *
 * `Number.parseInt` is safe here — block numbers are small integers, unlike the 256-bit
 * numeric strings elsewhere in this codebase that require `toBigInt`.
 */
export function axisIndexForBlock(axis: BlockAxisEntry[], raw: string): number | null {
  if (axis.length === 0) return null
  const n = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(n)) return null

  let best = 0
  let bestDistance = Math.abs(axis[0].block - n)
  for (let i = 1; i < axis.length; i++) {
    const distance = Math.abs(axis[i].block - n)
    // Strict `<` so a tie keeps the lower index — deterministic, and it matches the
    // left-to-right reading of the axis.
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/** "2026-07-14 23:35:11+00:00" → "23:35:11 UTC". The date is constant across this dataset, so the handle labels show only the clock. */
export function blockTimeLabel(time: string | undefined): string {
  if (!time) return '—'
  return `${time.slice(11, 19)} UTC`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/blockAxis.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing component tests**

Create `src/features/table/BlockTimeRangeFilter.test.tsx`:

```tsx
import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BlockTimeRangeFilter } from './BlockTimeRangeFilter'
import type { BlockAxisEntry } from '../../data/types'

const AXIS: BlockAxisEntry[] = [
  { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
  { block: 25534201, time: '2026-07-14 23:35:23+00:00' },
  { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
  { block: 25534203, time: '2026-07-14 23:35:47+00:00' },
]

function setup(value?: { min?: string; max?: string }) {
  const onChange = vi.fn()
  render(<BlockTimeRangeFilter axis={AXIS} value={value} onChange={onChange} matchCount={1234} />)
  return { onChange }
}

describe('BlockTimeRangeFilter', () => {
  it('labels each handle with its block number and that block\'s clock time', () => {
    setup({ min: '25534201', max: '25534203' })
    expect(screen.getByTestId('block-range-min-block')).toHaveTextContent('25,534,201')
    expect(screen.getByTestId('block-range-min-time')).toHaveTextContent('23:35:23 UTC')
    expect(screen.getByTestId('block-range-max-block')).toHaveTextContent('25,534,203')
    expect(screen.getByTestId('block-range-max-time')).toHaveTextContent('23:35:47 UTC')
  })

  it('shows the resulting match count', () => {
    setup()
    expect(screen.getByTestId('block-range-count')).toHaveTextContent('1,234')
  })

  it('emits the block number at the slider index it was moved to', async () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ min: '25534202', max: '25534203' }))
  })

  it('emits undefined when both handles sit at the axis ends, so no dead chip appears', async () => {
    const { onChange } = setup({ min: '25534202' })
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '0' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined))
  })

  it('will not let the start handle pass the end handle', async () => {
    const { onChange } = setup({ min: '25534200', max: '25534201' })
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '3' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ min: '25534201', max: '25534201' }))
  })

  it('updates the time label when a block is typed into the Min box', async () => {
    setup()
    fireEvent.change(screen.getByLabelText('Min block'), { target: { value: '25534202' } })
    await waitFor(() =>
      expect(screen.getByTestId('block-range-min-time')).toHaveTextContent('23:35:35 UTC'),
    )
  })

  it('renders a message instead of a broken slider when no blocks are loaded', () => {
    render(<BlockTimeRangeFilter axis={[]} value={undefined} onChange={vi.fn()} matchCount={0} />)
    expect(screen.getByText('No blocks loaded')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/BlockTimeRangeFilter.test.tsx`
Expected: FAIL — "Failed to resolve import ./BlockTimeRangeFilter".

- [ ] **Step 7: Implement the component**

Create `src/features/table/BlockTimeRangeFilter.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { BlockAxisEntry } from '../../data/types'
import { formatCount } from '../../data/transform'
import { axisIndexForBlock, blockTimeLabel } from './blockAxis'
import type { RangeFilterValue } from './filters'

/** Matches FilterControls.tsx's DEBOUNCE_MS — one filter pass per burst of dragging or typing. */
const DEBOUNCE_MS = 250

interface BlockTimeRangeFilterProps {
  axis: BlockAxisEntry[]
  value: RangeFilterValue | undefined
  onChange: (next: RangeFilterValue | undefined) => void
  /** Rows currently passing every active filter — the footer says the same thing, 50 rows away. */
  matchCount: number
}

/**
 * The one control for both "which blocks" and "which time window". They are the same
 * constraint in this dataset (100 blocks, one timestamp each, ~12s apart), so this writes a
 * plain `block_number` range and labels every handle in both units.
 *
 * State is the two block numbers *as strings*, not as axis indices. That is what lets the
 * text boxes accept a partially-typed number without the slider snapping it mid-keystroke:
 * the sliders read their position back out through `axisIndexForBlock` and write a whole
 * block number in, so there is exactly one source of truth.
 */
export function BlockTimeRangeFilter({ axis, value, onChange, matchCount }: BlockTimeRangeFilterProps) {
  const firstBlock = axis.length > 0 ? String(axis[0].block) : ''
  const lastBlock = axis.length > 0 ? String(axis[axis.length - 1].block) : ''

  const [min, setMin] = useState(() => value?.min ?? firstBlock)
  const [max, setMax] = useState(() => value?.max ?? lastBlock)

  useEffect(() => {
    const t = window.setTimeout(() => {
      // Both handles at the ends means "no constraint" — emitting a full-span range instead
      // would light the funnel and add a chip for a filter that excludes nothing.
      if (min === firstBlock && max === lastBlock) {
        onChange(undefined)
        return
      }
      const next: RangeFilterValue = {}
      if (min.trim() !== '') next.min = min.trim()
      if (max.trim() !== '') next.max = max.trim()
      onChange(next.min == null && next.max == null ? undefined : next)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // `onChange` is deliberately absent: a parent that passes an inline arrow would otherwise
    // restart the debounce on every render. Same pattern as FilterControls.tsx's panels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, firstBlock, lastBlock])

  if (axis.length === 0) {
    return <p className="filter-popover__empty">No blocks loaded</p>
  }

  const lastIndex = axis.length - 1
  const minIndex = axisIndexForBlock(axis, min) ?? 0
  const maxIndex = axisIndexForBlock(axis, max) ?? lastIndex

  return (
    <div className="block-range">
      <p className="block-range__title">Block &amp; time range</p>

      <div className="block-range__sliders">
        <input
          type="range"
          className="block-range__slider block-range__slider--min"
          aria-label="Range start"
          min={0}
          max={lastIndex}
          step={1}
          value={minIndex}
          onChange={(e) => setMin(String(axis[Math.min(Number(e.target.value), maxIndex)].block))}
        />
        <input
          type="range"
          className="block-range__slider block-range__slider--max"
          aria-label="Range end"
          min={0}
          max={lastIndex}
          step={1}
          value={maxIndex}
          onChange={(e) => setMax(String(axis[Math.max(Number(e.target.value), minIndex)].block))}
        />
      </div>

      <div className="block-range__readout">
        <span className="block-range__endpoint">
          <span className="block-range__block" data-testid="block-range-min-block">
            {formatCount(axis[minIndex].block)}
          </span>
          <span className="block-range__time" data-testid="block-range-min-time">
            {blockTimeLabel(axis[minIndex].time)}
          </span>
        </span>
        <span className="block-range__endpoint block-range__endpoint--right">
          <span className="block-range__block" data-testid="block-range-max-block">
            {formatCount(axis[maxIndex].block)}
          </span>
          <span className="block-range__time" data-testid="block-range-max-time">
            {blockTimeLabel(axis[maxIndex].time)}
          </span>
        </span>
      </div>

      <div className="filter-popover__range">
        <label className="filter-popover__field">
          <span className="filter-popover__label">Min block</span>
          <input
            type="text"
            inputMode="numeric"
            className="filter-popover__input filter-popover__input--mono"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label className="filter-popover__field">
          <span className="filter-popover__label">Max block</span>
          <input
            type="text"
            inputMode="numeric"
            className="filter-popover__input filter-popover__input--mono"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
      </div>

      <p className="block-range__count" data-testid="block-range-count">
        {formatCount(matchCount)} rows
      </p>
    </div>
  )
}
```

Note on the `<label>` wrappers: the Min/Max text inputs are wrapped in a `<label>` whose
text is "Min block"/"Max block", which is what makes `screen.getByLabelText('Min block')`
resolve in the tests.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/BlockTimeRangeFilter.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 9: Add the styles**

Append to `src/features/table/table.css`:

```css
/* ---------- block & time range control (BlockTimeRangeFilter) ---------- */

.block-range {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 17rem;
}

.block-range__title {
  margin: 0;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  opacity: 0.65;
}

/* The two sliders are stacked so their thumbs share one track. The container reserves the
   height; each input is transparent-tracked and absolutely positioned over the same line. */
.block-range__sliders {
  position: relative;
  height: 1.5rem;
}

.block-range__slider {
  position: absolute;
  inset-inline: 0;
  top: 0.35rem;
  width: 100%;
  margin: 0;
  background: transparent;
  /* Only the thumbs should be grabbable, or the upper input would swallow every click
     meant for the lower one. Re-enabled on the thumb pseudo-elements below. */
  pointer-events: none;
  -webkit-appearance: none;
  appearance: none;
}

.block-range__slider::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.block-range__slider::-moz-range-track {
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.block-range__slider::-webkit-slider-thumb {
  pointer-events: auto;
  -webkit-appearance: none;
  appearance: none;
  width: 0.85rem;
  height: 0.85rem;
  margin-top: -0.35rem;
  border-radius: 50%;
  border: 2px solid var(--bg, #fff);
  background: var(--accent, #4c8dff);
  cursor: pointer;
}

.block-range__slider::-moz-range-thumb {
  pointer-events: auto;
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 50%;
  border: 2px solid var(--bg, #fff);
  background: var(--accent, #4c8dff);
  cursor: pointer;
}

.block-range__slider:focus-visible {
  outline: none;
}

.block-range__slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #4c8dff) 40%, transparent);
}

.block-range__slider:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #4c8dff) 40%, transparent);
}

.block-range__readout {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.block-range__endpoint {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.block-range__endpoint--right {
  text-align: right;
}

.block-range__block {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.block-range__time {
  font-size: 0.7rem;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.block-range__count {
  margin: 0;
  font-size: 0.7rem;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 10: Lint and commit**

```bash
npm run lint
git add src/features/table/blockAxis.ts src/features/table/blockAxis.test.ts src/features/table/BlockTimeRangeFilter.tsx src/features/table/BlockTimeRangeFilter.test.tsx src/features/table/table.css
git commit -m "feat: block/time dual-handle range panel"
```

---

### Task 3: Extract the `FilterPopover` shell

**Files:**
- Create: `src/features/table/FilterPopover.tsx`
- Create: `src/features/table/FilterPopover.test.tsx`
- Modify: `src/features/table/FilterControls.tsx:1-104` (use the shell; the three panels stay put)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FilterPopover` from `./FilterPopover`, props
  `{ label: string; isActive: boolean; children: ReactNode }`. Renders the funnel trigger,
  the active dot, and a `role="dialog"` popover with outside-click and Escape handling.

This is a **pure refactor plus new tests**. `FilterControls`'s rendered output and behavior
must not change. It exists so Task 4's control can reuse one implementation of the
funnel/Escape/outside-click behavior rather than growing a second copy.

- [ ] **Step 1: Write the failing tests**

Create `src/features/table/FilterPopover.test.tsx`:

```tsx
import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FilterPopover } from './FilterPopover'

describe('FilterPopover', () => {
  it('is closed until the funnel is clicked', () => {
    render(<FilterPopover label="Block" isActive={false}><p>panel body</p></FilterPopover>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    expect(screen.getByRole('dialog', { name: 'Filter Block' })).toBeInTheDocument()
    expect(screen.getByText('panel body')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    render(<FilterPopover label="Block" isActive={false}><p>panel body</p></FilterPopover>)
    const trigger = screen.getByRole('button', { name: 'Filter Block' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on an outside pointer press without stealing focus back', () => {
    render(
      <div>
        <FilterPopover label="Block" isActive={false}><p>panel body</p></FilterPopover>
        <button type="button">elsewhere</button>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter Block' })).not.toHaveFocus()
  })

  it('marks the trigger active when a filter is set', () => {
    const { rerender } = render(<FilterPopover label="Block" isActive={false}><p>x</p></FilterPopover>)
    expect(screen.getByRole('button', { name: 'Filter Block' })).not.toHaveClass(
      'filter-control__trigger--active',
    )
    rerender(<FilterPopover label="Block" isActive><p>x</p></FilterPopover>)
    expect(screen.getByRole('button', { name: 'Filter Block' })).toHaveClass(
      'filter-control__trigger--active',
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/FilterPopover.test.tsx`
Expected: FAIL — "Failed to resolve import ./FilterPopover".

- [ ] **Step 3: Create the shell**

Create `src/features/table/FilterPopover.tsx`, moving the trigger/popover/effect/icon
verbatim out of `FilterControls.tsx` (including its comments — they explain the focus
policy and the `stopPropagation`):

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'

interface FilterPopoverProps {
  /** Column label, used for both the trigger's and the dialog's accessible name. */
  label: string
  /** Drives the accent state and the dot — computed by the caller, since what counts as "set" differs per panel. */
  isActive: boolean
  children: ReactNode
}

/**
 * The funnel trigger and the popover it opens: open/close state, outside-click and Escape
 * dismissal, and the accessible names. Everything about *what* is being filtered lives in
 * the panel passed as `children`.
 *
 * Extracted from FilterControls so the block/time range control can reuse one
 * implementation of this behavior instead of maintaining a second copy of the Escape and
 * outside-click handling.
 */
export function FilterPopover({ label, isActive, children }: FilterPopoverProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      // Outside click doesn't return focus to the trigger: the user just deliberately
      // moved focus/attention somewhere else on the page (another header, a table cell,
      // …), so forcing it back here would fight that action instead of respecting it.
      // Escape, below, is a keyboard-only close with nowhere else for focus to logically
      // go, which is exactly the case focus-return exists for.
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="filter-control" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-control__trigger${isActive ? ' filter-control__trigger--active' : ''}`}
        aria-label={`Filter ${label}`}
        aria-expanded={open}
        onClick={(e) => {
          // The sort toggle lives in a sibling button, not a parent — this stopPropagation
          // is only to keep a click from immediately re-triggering the outside-click
          // listener registered above once `open` flips true.
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <FunnelIcon />
        {isActive && <span className="filter-control__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div
          className="filter-popover"
          role="dialog"
          aria-label={`Filter ${label}`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
      <path
        d="M2 3h12l-4.5 5.4V13l-3 1.3V8.4L2 3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
```

- [ ] **Step 4: Rewrite `FilterControls` on top of the shell**

In `src/features/table/FilterControls.tsx`, replace the import block on lines 1-5 with:

```tsx
import { useEffect, useState } from 'react'
import type { Column } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import type { ColumnMeta } from '../../data/dictionary'
import { FilterPopover } from './FilterPopover'
import { enumDisplayValue, type RangeFilterValue } from './filters'
```

Replace the whole `FilterControls` function body (lines 34-104 of the original) with:

```tsx
export function FilterControls({ column, kind, label, rangeUnit }: FilterControlsProps) {
  const isActive = isFilterActive(kind, column.getFilterValue())
  return (
    <FilterPopover label={label} isActive={isActive}>
      {kind === 'number' || kind === 'bignum' ? (
        <RangePanel column={column} unit={rangeUnit} />
      ) : kind === 'enum' || kind === 'boolean' ? (
        <EnumPanel column={column} />
      ) : (
        <TextPanel column={column} />
      )}
    </FilterPopover>
  )
}
```

Delete the now-unused `FunnelIcon` function at the bottom of `FilterControls.tsx` (it moved
to `FilterPopover.tsx`). Keep `DEBOUNCE_MS`, `isFilterActive`, `FilterControlsProps`,
`TextPanel`, `RangePanel`, and `EnumPanel` exactly as they are.

Keep the doc comment above `FilterControls`, trimmed to match what it now does:

```tsx
/**
 * Per-column filter panel. Which panel renders is driven entirely by the column's
 * dictionary `kind` (see columns.tsx `filterFnForKind`) — the same axis that chose the
 * registered TanStack filterFn, so the control offered always matches the comparison
 * actually run. The funnel, popover and dismissal behavior live in FilterPopover.
 */
```

- [ ] **Step 5: Run the full suite to verify nothing regressed**

Run: `npm run test`
Expected: PASS — every pre-existing test, plus the 4 new `FilterPopover` tests. This is the
check that the refactor was behavior-preserving.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/features/table/FilterPopover.tsx src/features/table/FilterPopover.test.tsx src/features/table/FilterControls.tsx
git commit -m "refactor: extract FilterPopover shell from FilterControls"
```

---

### Task 4: Wire the block/time control into both headers

**Files:**
- Create: `src/features/table/__fixtures__/tableHarness.tsx`
- Create: `src/features/table/BlockTimeFilterControl.tsx`
- Create: `src/features/table/DataTable.blockRange.test.tsx`
- Modify: `src/features/table/columns.tsx:1-19` (imports), `:97-110` (`header`)
- Modify: `src/features/table/DataTable.tsx:31-44` (props), `:110-129` (`useReactTable`)
- Modify: `src/App.tsx:258-264` (pass the axis)

**Interfaces:**
- Consumes: `BlockAxisEntry` and `DatasetStats.blockAxis` (Task 1); `BlockTimeRangeFilter` (Task 2); `FilterPopover` (Task 3).
- Produces:
  - `BlockTimeFilterControl` from `./BlockTimeFilterControl`, props `{ table: Table<EthRecord>; label: string }`
  - A `TableMeta` declaration merge adding `blockAxis: BlockAxisEntry[]`
  - `DataTable` gains a required prop `blockAxis: BlockAxisEntry[]`
  - `src/features/table/__fixtures__/tableHarness.tsx` exporting `BASE`, `mk`,
    `TEST_RECORDS`, `TEST_AXIS`, `renderTransfersTable()` and `sortHeader(name)` —
    **Tasks 6 and 7 import all of these; do not re-declare them there.**

- [ ] **Step 1: Create the shared test harness**

Three test files across Tasks 4, 6 and 7 drive the real `DataTable` over the same records.
The 34-field `EthRecord` literal lives here once, so a 35th dataset field is a one-file edit.

Create `src/features/table/__fixtures__/tableHarness.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import { vi } from 'vitest'
import { DataTable } from '../DataTable'
import type { BlockAxisEntry, EthRecord } from '../../../data/types'

/** All 34 loaded fields, so a test can override just the ones it cares about via `mk`. */
export const BASE: EthRecord = {
  block_hash: '0xb', block_number: 25534200, block_timestamp: '2026-07-14 23:35:11+00:00',
  transaction_hash: '0xt1', transaction_index: 0, event_index: 0, batch_index: null,
  address: '0xtoken', event_type: 'ERC-20', event_hash: null, event_signature: null,
  operator_address: null, from_address: '0xf', to_address: '0xt', token_id: null,
  quantity: '1', removed: false, nonce_tx: null, from_address_tx: null, to_address_tx: null,
  value_tx: null, value_lossless_tx: null, gas_tx: null, gas_price_tx: null,
  max_fee_per_gas_tx: null, max_priority_fee_per_gas_tx: null, type_tx: null,
  chain_id_tx: null, access_list_tx: null, r_tx: null, s_tx: null, v_tx: null,
  y_parity_tx: null, is_token_transfer: true,
}

export const mk = (p: Partial<EthRecord>): EthRecord => ({ ...BASE, ...p })

/** Three transfer rows across three consecutive blocks, with distinct quantities so a sort is observable. */
export const TEST_RECORDS: EthRecord[] = [
  mk({ block_number: 25534200, block_timestamp: '2026-07-14 23:35:11+00:00', transaction_hash: '0xa', quantity: '1' }),
  mk({ block_number: 25534201, block_timestamp: '2026-07-14 23:35:23+00:00', transaction_hash: '0xb', quantity: '3' }),
  mk({ block_number: 25534202, block_timestamp: '2026-07-14 23:35:35+00:00', transaction_hash: '0xc', quantity: '2' }),
]

export const TEST_AXIS: BlockAxisEntry[] = [
  { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
  { block: 25534201, time: '2026-07-14 23:35:23+00:00' },
  { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
]

export function renderTransfersTable() {
  render(
    <DataTable
      records={TEST_RECORDS}
      tab="transfers"
      blockAxis={TEST_AXIS}
      globalFilter=""
      onGlobalFilterChange={vi.fn()}
    />,
  )
}

/**
 * The sort *toggle* button in a header. Scoped to `<thead>` on purpose: a header cell holds
 * three buttons (ⓘ, sort, funnel), and once Task 7 puts the direction into the sort button's
 * accessible name it reads "Quantity, sorted descending" — which a page-wide query would
 * find alongside the sort *chip* of the same column. Scoping is what keeps this unambiguous.
 */
export function sortHeader(name: string) {
  const thead = document.querySelector('thead')
  if (!thead) throw new Error('no thead rendered')
  return within(thead).getByRole('button', { name: new RegExp(`^${name}(,|$)`) })
}
```

- [ ] **Step 2: Write the failing integration tests**

Create `src/features/table/DataTable.blockRange.test.tsx`:

```tsx
import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderTransfersTable } from './__fixtures__/tableHarness'

const renderTable = renderTransfersTable

describe('DataTable — block & time range', () => {
  it('gives the Time column a filter funnel, which it never had before', () => {
    renderTable()
    expect(screen.getByRole('button', { name: 'Filter Time' })).toBeInTheDocument()
  })

  it('opens the same "Block & time range" panel from either funnel', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Time' }))
    expect(screen.getByText('Block & time range')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    expect(screen.getByText('Block & time range')).toBeInTheDocument()
  })

  it('filters rows when the range is narrowed, and lights both funnels at once', async () => {
    renderTable()
    expect(screen.getByText('Showing 1–3 of 3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filter Time' }))
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2' } })

    await waitFor(() => expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Filter Time' })).toHaveClass(
      'filter-control__trigger--active',
    )
    expect(screen.getByRole('button', { name: 'Filter Block' })).toHaveClass(
      'filter-control__trigger--active',
    )
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/DataTable.blockRange.test.tsx`
Expected: FAIL — TypeScript rejects the unknown `blockAxis` prop, and "Filter Time" has no
matching element.

- [ ] **Step 4: Create the wired control**

Create `src/features/table/BlockTimeFilterControl.tsx`:

```tsx
import type { RowData, Table } from '@tanstack/react-table'
import type { BlockAxisEntry, EthRecord } from '../../data/types'
import { BlockTimeRangeFilter } from './BlockTimeRangeFilter'
import { FilterPopover } from './FilterPopover'
import type { RangeFilterValue } from './filters'

// TanStack's TableMeta is an empty interface consumers augment by declaration merging —
// the same pattern this codebase already uses for SortingFns (columns.tsx) and FilterFns
// (filters.ts). It is how the block axis reaches a header cell: the column arrays are
// module-level constants built at import time, so `header()` closes over static arguments
// and cannot take a runtime prop.
declare module '@tanstack/table-core' {
  // `TData` is unused here but must be declared: the merge only applies if the interface
  // signature matches TanStack's own. If oxlint flags it, add an
  // `// oxlint-disable-next-line` above with the rule name it reports — do not change the
  // signature.
  interface TableMeta<TData extends RowData> {
    blockAxis: BlockAxisEntry[]
  }
}

interface BlockTimeFilterControlProps {
  table: Table<EthRecord>
  /** The label of the header this funnel sits in — "Block" or "Time". */
  label: string
}

/**
 * The funnel rendered in BOTH the Block and the Time header. Whichever one you open, the
 * panel writes `block_number`'s ordinary `'range'` filter — block and timestamp are 1:1 in
 * this dataset, so they are one constraint, and the active dot reads the same state in both
 * places rather than pretending they are independent filters.
 */
export function BlockTimeFilterControl({ table, label }: BlockTimeFilterControlProps) {
  const column = table.getColumn('block_number')
  if (!column) return null

  const value = column.getFilterValue() as RangeFilterValue | undefined
  const isActive = !!(value && (value.min?.trim() || value.max?.trim()))

  return (
    <FilterPopover label={label} isActive={isActive}>
      <BlockTimeRangeFilter
        axis={table.options.meta?.blockAxis ?? []}
        value={value}
        onChange={(next) => column.setFilterValue(next)}
        matchCount={table.getFilteredRowModel().rows.length}
      />
    </FilterPopover>
  )
}
```

- [ ] **Step 5: Special-case the two columns in `header()`**

In `src/features/table/columns.tsx`, change the first import line — `HeaderContext` replaces
`Column`, whose only use in this file was the header render function's parameter annotation
that this step is about to delete. Leaving it imported is an unused-import lint failure:

```tsx
import { createColumnHelper, type ColumnDef, type HeaderContext, type SortingFn } from '@tanstack/react-table'
```

Add to the import block (after the `FilterControls` import on line 7):

```tsx
import { BlockTimeFilterControl } from './BlockTimeFilterControl'
```

Replace the `header` function (lines 97-110) with:

```tsx
/** Block and time are one constraint in this dataset, so both headers render the same control — see BlockTimeFilterControl. */
const BLOCK_AXIS_FIELDS = new Set<DictionaryField>(['block_number', 'block_timestamp'])

function header(tab: TabId, field: DictionaryField, rangeUnit?: string) {
  const displayLabel = columnDisplayLabel(field, tab)
  const meta = getColumnMeta(field)
  const filterFn = meta ? filterFnForKind(meta.kind) : undefined
  const isBlockAxis = BLOCK_AXIS_FIELDS.has(field)
  return ({ column, table }: HeaderContext<EthRecord, unknown>) => (
    <div className="col-header-cell">
      <DictionaryInfoTrigger field={field} label={displayLabel} />
      <SortableHeader label={displayLabel} column={column} />
      {isBlockAxis ? (
        <BlockTimeFilterControl table={table} label={displayLabel} />
      ) : (
        meta &&
        filterFn && (
          <FilterControls column={column} kind={meta.kind} label={displayLabel} rangeUnit={rangeUnit} />
        )
      )}
    </div>
  )
}
```

The `filterFnForKind` `'timestamp' → undefined` case on lines 81-82 stays exactly as it is:
the timestamp column still has no filter *of its own*, and its comment should be updated to
say so:

```tsx
// Which registered TanStack filterFn (see filters.ts) a column kind gets, if any.
// `timestamp` columns get none of their own — `block_timestamp` is 1:1 with `block_number`,
// so its header renders BlockTimeFilterControl (see `header` below), which writes
// `block_number`'s range filter instead.
```

- [ ] **Step 6: Thread the axis through `DataTable`**

In `src/features/table/DataTable.tsx`, add to the imports:

```tsx
import type { BlockAxisEntry, EthRecord } from '../../data/types'
```

(replacing the existing `import type { EthRecord } from '../../data/types'`).

Add to `DataTableProps` (after `tab`):

```tsx
  /** Every distinct block with its timestamp, from the FULL dataset — not this tab's slice,
   *  or the range control's handle labels would shift on every tab switch. */
  blockAxis: BlockAxisEntry[]
```

Add `blockAxis` to the destructured parameters:

```tsx
export function DataTable({ records, tab, blockAxis, onTableReady, globalFilter, onGlobalFilterChange }: DataTableProps) {
```

Add one option to the `useReactTable` call, after `globalFilterFn: tableGlobalFilterFn,`:

```tsx
    meta: { blockAxis },
```

- [ ] **Step 7: Pass it from `App`**

In `src/App.tsx`, add the prop to the `<DataTable>` element (around line 258):

```tsx
              <DataTable
                records={tabRecords}
                tab={activeTab}
                blockAxis={stats?.blockAxis ?? []}
                onTableReady={handleTableReady}
                globalFilter={debouncedFilter}
                onGlobalFilterChange={setGlobalFilter}
              />
```

`stats` is computed from `state.result.records` — the full dataset — which is what the
constraint requires.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/DataTable.blockRange.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 9: Run the full suite and a type-check**

Run: `npm run test && npm run build`
Expected: PASS, and a clean `tsc -b`. The build is what proves the `TableMeta` declaration
merge actually typed `table.options.meta.blockAxis` rather than leaving it `any`.

- [ ] **Step 10: Lint and commit**

```bash
npm run lint
git add src/features/table/__fixtures__/tableHarness.tsx src/features/table/BlockTimeFilterControl.tsx src/features/table/DataTable.blockRange.test.tsx src/features/table/columns.tsx src/features/table/DataTable.tsx src/App.tsx
git commit -m "feat: filter by block or time from either header"
```

---

### Task 5: Descending-first on magnitude columns

**Files:**
- Modify: `src/features/table/columns.tsx` (add `DESC_FIRST_FIELDS`; add `sortDescFirst` to the accessors)
- Test: `src/features/table/columns.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Column defs for the seven magnitude fields carry
  `sortDescFirst: true`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/table/columns.test.ts`:

```ts
/** `sortDescFirst` lives directly on the ColumnDef, so it can be read off without a table instance. */
function descFirst(defs: ReturnType<typeof getColumnsForTab>, field: string): boolean | undefined {
  const def = defs.find((d) => 'accessorKey' in d && d.accessorKey === field)
  if (!def) throw new Error(`no column def for ${field}`)
  return def.sortDescFirst
}

describe('first-click sort direction', () => {
  it('descends first on magnitude columns, so the interesting rows land on page 1', () => {
    expect(descFirst(getColumnsForTab('transfers'), 'quantity')).toBe(true)
    expect(descFirst(getColumnsForTab('transactions'), 'value_lossless_tx')).toBe(true)
    expect(descFirst(getColumnsForTab('transactions'), 'gas_price_tx')).toBe(true)
    expect(descFirst(getColumnsForTab('transactions'), 'gas_tx')).toBe(true)
  })

  it('ascends first on positions, counters and identifiers', () => {
    expect(descFirst(getColumnsForTab('transfers'), 'block_number')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transfers'), 'event_index')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transfers'), 'token_id')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transactions'), 'nonce_tx')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transactions'), 'transaction_index')).toBeFalsy()
  })

  it('applies the same rule on the All Records tab', () => {
    const all = getColumnsForTab('all')
    expect(descFirst(all, 'max_fee_per_gas_tx')).toBe(true)
    expect(descFirst(all, 'max_priority_fee_per_gas_tx')).toBe(true)
    expect(descFirst(all, 'value_tx')).toBe(true)
    expect(descFirst(all, 'chain_id_tx')).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/columns.test.ts`
Expected: FAIL — every `toBe(true)` assertion receives `undefined`.

- [ ] **Step 3: Add the field set and a small accessor helper**

In `src/features/table/columns.tsx`, add immediately after the `DISPLAY_LABEL_OVERRIDES`
block (after line 53):

```tsx
// Columns where "biggest" is the interesting end, so the first header click should descend.
// Deliberately an explicit list rather than derived from `kind`: `kind: 'number' | 'bignum'`
// also covers block_number, transaction_index, event_index, batch_index, nonce_tx and
// chain_id_tx — positions and counters, where ascending is the natural first read — and
// token_id, which is a bignum but an identifier, not a magnitude.
const DESC_FIRST_FIELDS = new Set<DictionaryField>([
  'quantity',
  'value_tx',
  'value_lossless_tx',
  'gas_tx',
  'gas_price_tx',
  'max_fee_per_gas_tx',
  'max_priority_fee_per_gas_tx',
])

function descFirst(field: DictionaryField): boolean {
  return DESC_FIRST_FIELDS.has(field)
}
```

- [ ] **Step 4: Apply it to the accessors**

In `transferColumns`, add `sortDescFirst: descFirst('quantity'),` to the `quantity` accessor
(after its `sortingFn: 'bignum',` line).

In `transactionColumns`, add the matching line to three accessors:
- `value_lossless_tx` → `sortDescFirst: descFirst('value_lossless_tx'),`
- `gas_price_tx` → `sortDescFirst: descFirst('gas_price_tx'),`
- `gas_tx` → `sortDescFirst: descFirst('gas_tx'),`

In `allColumns`, add to the accessor options object (after the `sortingFn` line):

```tsx
    sortDescFirst: descFirst(meta.field),
```

The helper is used even where the answer is a constant so there is exactly one list to
edit — a literal `true` at a call site would become a second source of truth.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/columns.test.ts`
Expected: PASS — the 3 new tests plus all pre-existing ones (including the 34-column and
curated-order assertions).

- [ ] **Step 6: Commit**

```bash
git add src/features/table/columns.tsx src/features/table/columns.test.ts
git commit -m "feat: descending-first sort on magnitude columns"
```

---

### Task 6: `SortChips`

**Files:**
- Create: `src/features/table/SortChips.tsx`
- Create: `src/features/table/SortChips.test.tsx`
- Modify: `src/features/table/FilterChips.tsx:55-56` (add the `Filters:` label)
- Modify: `src/features/table/DataTable.tsx:184` (render `SortChips`)
- Modify: `src/features/table/table.css` (append styles)

**Interfaces:**
- Consumes: `columnDisplayLabel` from `./columns`; `TabId` from `./Tabs`;
  `renderTransfersTable` and `sortHeader` from `./__fixtures__/tableHarness` (Task 4).
- Produces: `SortChips` from `./SortChips`, props `{ table: Table<EthRecord>; tab: TabId }`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/table/SortChips.test.tsx`. It renders the real `DataTable` so the
chips are driven by genuine TanStack sorting state rather than a stub. The records, the
axis, `renderTransfersTable` and `sortHeader` all come from the shared harness Task 4
created — **do not re-declare them here.**

```tsx
import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderTransfersTable, sortHeader } from './__fixtures__/tableHarness'

const renderTable = renderTransfersTable

describe('SortChips', () => {
  it('shows nothing until something is sorted', () => {
    renderTable()
    expect(screen.queryByTestId('sort-chips')).not.toBeInTheDocument()
  })

  it('shows an un-numbered chip and the shift-click hint for a single sort', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    const chips = screen.getByTestId('sort-chips')
    expect(chips).toHaveTextContent('Quantity')
    expect(chips).not.toHaveTextContent('1.')
    expect(screen.getByText('Shift-click another header to add')).toBeInTheDocument()
  })

  it('numbers the chips and drops the hint once a second sort is stacked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    const chips = screen.getByTestId('sort-chips')
    expect(chips).toHaveTextContent('1.')
    expect(chips).toHaveTextContent('2.')
    expect(screen.queryByText('Shift-click another header to add')).not.toBeInTheDocument()
  })

  it('reverses that column when the chip body is clicked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity')) // quantity is descending-first (Task 5)
    expect(screen.getByTestId('sort-chip-quantity')).toHaveTextContent('▼')
    // Matched on the chip's "Activate to reverse." tail: once Task 7 lands, the *header*
    // button is also named "Quantity, sorted descending", and a prefix match would find both.
    fireEvent.click(screen.getByRole('button', { name: /^Quantity,.*Activate to reverse/ }))
    expect(screen.getByTestId('sort-chip-quantity')).toHaveTextContent('▲')
  })

  it('removes only its own column and preserves the order of the rest', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Quantity sort' }))
    expect(screen.queryByTestId('sort-chip-quantity')).not.toBeInTheDocument()
    expect(screen.getByTestId('sort-chip-block_number')).toBeInTheDocument()
  })

  it('clears every sort at once', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Clear all sorts' }))
    expect(screen.queryByTestId('sort-chips')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/SortChips.test.tsx`
Expected: FAIL — `sort-chips` is never in the document.

- [ ] **Step 3: Implement `SortChips`**

Create `src/features/table/SortChips.tsx`:

```tsx
import type { Table } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import { columnDisplayLabel } from './columns'
import type { TabId } from './Tabs'

interface SortChipsProps {
  table: Table<EthRecord>
  /** Chip labels are tab-scoped, exactly as in FilterChips — the same field can render under
   *  a unit-specific header on the transactions tab but its raw dictionary label on 'all'. */
  tab: TabId
}

/**
 * The active sort stack, as an ordered row of chips above the filter chips.
 *
 * Shift-click on a header is what *builds* the stack (TanStack's `isMultiSortEvent`); this
 * row is what makes that discoverable — without it a stacked sort is invisible, and the
 * modifier is unguessable. Each chip's body reverses its column; its ✕ drops it.
 *
 * Priority cannot be reordered here: you drop a chip and re-add it by shift-clicking the
 * header again. That is the accepted cost of chips over a drag-reorder panel.
 */
export function SortChips({ table, tab }: SortChipsProps) {
  const { sorting } = table.getState()
  if (sorting.length === 0) return null

  const numbered = sorting.length > 1

  return (
    <div className="chips-row sort-chips" data-testid="sort-chips">
      <span className="chips-row__label">Sort:</span>
      {sorting.map((sort, i) => {
        const label = columnDisplayLabel(sort.id as keyof EthRecord, tab)
        const direction = sort.desc ? 'descending' : 'ascending'
        return (
          <span key={sort.id} className="filter-chip" data-testid={`sort-chip-${sort.id}`}>
            <button
              type="button"
              className="sort-chip__body"
              // The arrow glyph is aria-hidden, so direction and priority have to reach
              // assistive tech through the accessible name instead.
              aria-label={`${label}, sorted ${direction}${numbered ? `, sort priority ${i + 1}` : ''}. Activate to reverse.`}
              onClick={() => table.getColumn(sort.id)?.toggleSorting(!sort.desc, true)}
            >
              {numbered && <span className="sort-chip__ordinal">{i + 1}.</span>}
              {label}
              <span aria-hidden="true">{sort.desc ? '▼' : '▲'}</span>
            </button>
            <button
              type="button"
              className="filter-chip__remove"
              aria-label={`Remove ${label} sort`}
              onClick={() => table.getColumn(sort.id)?.clearSorting()}
            >
              ×
            </button>
          </span>
        )
      })}
      {sorting.length === 1 && (
        // Shown in exactly the one state where it teaches something: at zero sorts there is
        // nothing to add to, and at two the user has already found the modifier.
        <span className="chips-row__hint">Shift-click another header to add</span>
      )}
      {sorting.length >= 2 && (
        <button
          type="button"
          className="filter-chips__clear"
          aria-label="Clear all sorts"
          onClick={() => table.resetSorting()}
        >
          Clear
        </button>
      )}
    </div>
  )
}
```

`toggleSorting(desc, isMulti)` is called with `isMulti: true` so reversing one column does
not collapse the rest of the stack.

- [ ] **Step 4: Label the filter row and render both rows**

In `src/features/table/FilterChips.tsx`, replace the opening of the returned JSX (line 56):

```tsx
    <div className="filter-chips">
```

with:

```tsx
    <div className="chips-row filter-chips">
      <span className="chips-row__label">Filters:</span>
```

In `src/features/table/DataTable.tsx`, add the import:

```tsx
import { SortChips } from './SortChips'
```

and render it directly above `FilterChips` (line 184):

```tsx
      <SortChips table={table} tab={tab} />
      <FilterChips table={table} tab={tab} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/SortChips.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 6: Add the styles**

Append to `src/features/table/table.css`:

```css
/* ---------- chip rows (SortChips + FilterChips share this) ---------- */

.chips-row__label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  opacity: 0.55;
  align-self: center;
}

.chips-row__hint {
  font-size: 0.72rem;
  opacity: 0.5;
  align-self: center;
}

.sort-chips {
  /* Mirrors .filter-chips' own layout; see that rule above. */
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem 0;
}

.sort-chip__body {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.sort-chip__ordinal {
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}
```

- [ ] **Step 7: Run the full suite, lint, and commit**

Run: `npm run test && npm run lint`
Expected: PASS — including the pre-existing `FilterChips` behavior, which the added label
must not have broken.

```bash
git add src/features/table/SortChips.tsx src/features/table/SortChips.test.tsx src/features/table/FilterChips.tsx src/features/table/DataTable.tsx src/features/table/table.css
git commit -m "feat: sort chips row with priority, reverse and remove"
```

---

### Task 7: Header priority badges and explicit multi-sort options

**Files:**
- Modify: `src/features/table/SortableHeader.tsx` (whole file)
- Modify: `src/features/table/columns.tsx` (pass `sortCount` from `header`)
- Modify: `src/features/table/DataTable.tsx:110-129` (make the options explicit)
- Create: `src/features/table/SortableHeader.test.tsx`

**Interfaces:**
- Consumes: `renderTransfersTable` and `sortHeader` from `./__fixtures__/tableHarness` (Task 4).
- Produces: `SortableHeader` props widen to
  `{ label: string; column: Column<EthRecord, unknown>; sortCount: number }`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/table/SortableHeader.test.tsx`, reusing the shared harness Task 4
created so the badge is driven by real sorting state. **Do not re-declare the records, the
axis, `renderTransfersTable` or `sortHeader` here — import them.**

```tsx
import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderTransfersTable, sortHeader } from './__fixtures__/tableHarness'

const renderTable = renderTransfersTable

describe('SortableHeader', () => {
  it('announces direction but no priority while a single column is sorted', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    expect(screen.getByRole('button', { name: 'Quantity, sorted descending' })).toBeInTheDocument()
  })

  it('announces the priority once two columns are stacked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    expect(
      screen.getByRole('button', { name: 'Quantity, sorted descending, sort priority 1' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Block, sorted ascending, sort priority 2' }),
    ).toBeInTheDocument()
  })

  it('renders a visible ordinal beside the arrow only when stacked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    expect(screen.queryByTestId('sort-ordinal-quantity')).not.toBeInTheDocument()
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    expect(screen.getByTestId('sort-ordinal-quantity')).toHaveTextContent('1')
  })

  it('leaves an unsorted header named by its plain label', () => {
    renderTable()
    expect(screen.getByRole('button', { name: 'Quantity' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/SortableHeader.test.tsx`
Expected: FAIL — the accessible names are the bare labels, with no direction or priority.

- [ ] **Step 3: Rewrite `SortableHeader`**

Replace the whole of `src/features/table/SortableHeader.tsx`:

```tsx
import type { Column } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'

interface SortableHeaderProps {
  label: string
  column: Column<EthRecord, unknown>
  /** How many columns are sorted in total — the ordinal is noise unless there are at least two. */
  sortCount: number
}

/**
 * Shared header renderer for every column: label + a sort indicator (accent when this
 * column is part of the active sort). The ⓘ description affordance this used to reserve
 * empty space for is now a real sibling button (`DictionaryInfoTrigger`, rendered by
 * `columns.tsx`'s `header()` inside the shared `.col-header-cell` flex row) rather than
 * living inside this element — nesting an interactive button inside this sort `<button>`
 * would be invalid HTML.
 *
 * The arrow and ordinal glyphs are aria-hidden, so direction and sort priority reach
 * assistive tech through the button's accessible name instead.
 */
export function SortableHeader({ label, column, sortCount }: SortableHeaderProps) {
  const sorted = column.getIsSorted()
  const showOrdinal = sorted !== false && sortCount > 1
  const ordinal = column.getSortIndex() + 1

  const accessibleName = !sorted
    ? label
    : `${label}, sorted ${sorted === 'asc' ? 'ascending' : 'descending'}${
        showOrdinal ? `, sort priority ${ordinal}` : ''
      }`

  return (
    <button
      type="button"
      className={`col-header${sorted ? ' col-header--active' : ''}`}
      aria-label={accessibleName}
      onClick={column.getToggleSortingHandler()}
    >
      <span className="col-header__label">{label}</span>
      <span className="col-header__sort" aria-hidden="true">
        {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
      </span>
      {showOrdinal && (
        <span className="col-header__ordinal" aria-hidden="true" data-testid={`sort-ordinal-${column.id}`}>
          {ordinal}
        </span>
      )}
    </button>
  )
}
```

- [ ] **Step 4: Pass `sortCount` from `header()`**

In `src/features/table/columns.tsx`, inside the render function returned by `header`,
change the `SortableHeader` element to:

```tsx
      <SortableHeader label={displayLabel} column={column} sortCount={table.getState().sorting.length} />
```

`table` is already in scope from Task 4's `HeaderContext` destructuring.

- [ ] **Step 5: Make the multi-sort options explicit**

In `src/features/table/DataTable.tsx`, add two options to `useReactTable`, directly after
`globalFilterFn: tableGlobalFilterFn,`:

```tsx
    // Written down rather than inherited: SortChips and the header ordinals exist entirely
    // to surface shift-click multi-sort, so the behavior they describe must not be able to
    // change out from under them via a library default.
    enableMultiSort: true,
    isMultiSortEvent: (e) => (e as { shiftKey?: boolean }).shiftKey === true,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/SortableHeader.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 7: Add the ordinal style**

Append to `src/features/table/table.css`:

```css
.col-header__ordinal {
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  vertical-align: super;
  opacity: 0.75;
}
```

- [ ] **Step 8: Run the full suite, lint, and commit**

Run: `npm run test && npm run lint`
Expected: PASS — every suite, including Task 6's `SortChips` tests, which depend on the same
sorting behavior.

```bash
git add src/features/table/SortableHeader.tsx src/features/table/SortableHeader.test.tsx src/features/table/columns.tsx src/features/table/DataTable.tsx src/features/table/table.css
git commit -m "feat: sort priority badges and explicit multi-sort options"
```

---

### Task 8: Invalid-bound feedback in `RangePanel`

**Files:**
- Modify: `src/features/table/FilterControls.tsx` (`FilterControlsProps.rangeUnit`, `RangePanel`)
- Modify: `src/features/table/columns.tsx` (`header`'s `rangeUnit` parameter type and the two call sites)
- Create: `src/features/table/RangePanel.test.tsx`

**Interfaces:**
- Consumes: `toBigInt`, `decimalToWei` from `src/data/transform.ts`; `FilterPopover` (Task 3).
- Produces: `RangeUnit` exported from `./FilterControls` —
  `{ label: string; decimals: number }`. `FilterControlsProps.rangeUnit` and `header`'s
  third parameter both take it.

`rangeFilter` in `filters.ts` is **not touched** — see Global Constraints.

- [ ] **Step 1: Write the failing tests**

Create `src/features/table/RangePanel.test.tsx`. It drives `FilterControls` with a hand-made
column stub, which is all `RangePanel` reads.

```tsx
import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Column } from '@tanstack/react-table'
import { FilterControls, type RangeUnit } from './FilterControls'
import type { EthRecord } from '../../data/types'

/** RangePanel only ever calls getFilterValue/setFilterValue on its column. */
function stubColumn() {
  let value: unknown = undefined
  const setFilterValue = vi.fn((next: unknown) => {
    value = next
  })
  const column = {
    getFilterValue: () => value,
    setFilterValue,
  } as unknown as Column<EthRecord, unknown>
  return { column, setFilterValue }
}

function openPanel(unit?: RangeUnit) {
  const { column, setFilterValue } = stubColumn()
  render(<FilterControls column={column} kind="bignum" label="Gas Price" rangeUnit={unit} />)
  fireEvent.click(screen.getByRole('button', { name: 'Filter Gas Price' }))
  return { setFilterValue }
}

describe('RangePanel validation', () => {
  it('reports an unparseable bound and keeps it out of the filter value', async () => {
    const { setFilterValue } = openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByText('Not a number')).toBeInTheDocument())
    expect(setFilterValue).toHaveBeenLastCalledWith(undefined)
  })

  it('marks the offending input invalid for assistive tech', async () => {
    openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByLabelText('Min')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByLabelText('Max')).not.toHaveAttribute('aria-invalid')
  })

  it('accepts a valid bound and applies it', async () => {
    const { setFilterValue } = openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '25' } })
    await waitFor(() => expect(setFilterValue).toHaveBeenLastCalledWith({ min: '25' }))
    expect(screen.queryByText('Not a number')).not.toBeInTheDocument()
  })

  it('validates a Gwei bound at 9 decimals, so a decimal is legal there', async () => {
    const { setFilterValue } = openPanel({ label: 'Gwei', decimals: 9 })
    fireEvent.change(screen.getByLabelText('Min (Gwei)'), { target: { value: '12.5' } })
    await waitFor(() => expect(setFilterValue).toHaveBeenLastCalledWith({ min: '12.5' }))
    expect(screen.queryByText('Not a number')).not.toBeInTheDocument()
  })

  it('calls out a reversed range rather than silently emptying the table', async () => {
    openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Max'), { target: { value: '10' } })
    await waitFor(() => expect(screen.getByText('Min is greater than Max')).toBeInTheDocument())
  })

  it('clears the message once the input becomes valid again', async () => {
    openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByText('Not a number')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '5' } })
    await waitFor(() => expect(screen.queryByText('Not a number')).not.toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/table/RangePanel.test.tsx`
Expected: FAIL — `RangeUnit` is not exported, and no message elements exist.

- [ ] **Step 3: Change the `rangeUnit` shape**

In `src/features/table/FilterControls.tsx`, add the type above `FilterControlsProps` and
change the prop:

```tsx
/**
 * A column whose cells are displayed in a converted unit. `decimals` is the exponent that
 * converts a typed bound back to the stored wei value — the same number `decimalRangeFilterFn`
 * uses in filters.ts, kept here so the label and the validation can never disagree about
 * which unit a bound is in.
 */
export interface RangeUnit {
  /** Shown in the input labels, e.g. "ETH". */
  label: string
  /** 18 for ETH, 9 for Gwei. */
  decimals: number
}

interface FilterControlsProps {
  column: Column<EthRecord, unknown>
  kind: ColumnMeta['kind']
  label: string
  /** Only set for the two columns whose filterFn is 'rangeEth'/'rangeGwei' (columns.tsx). */
  rangeUnit?: RangeUnit
}
```

- [ ] **Step 4: Add validation to `RangePanel`**

Add these imports to the top of `FilterControls.tsx`:

```tsx
import { useEffect, useId, useState } from 'react'
import { decimalToWei, toBigInt } from '../../data/transform'
```

(merge with the existing `react` import rather than adding a second one).

Add above `RangePanel`:

```tsx
/**
 * A typed bound as a comparable integer, using exactly the conversion the registered
 * filterFn will use: raw integer parsing for `'range'` columns, decimal-to-wei for the
 * `'rangeEth'`/`'rangeGwei'` ones. Null means "this text is not a number".
 */
function boundToComparable(raw: string, decimals: number | null): bigint | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (decimals == null) return toBigInt(trimmed)
  const wei = decimalToWei(trimmed, decimals)
  return wei == null ? null : BigInt(wei)
}
```

Replace `RangePanel` entirely:

```tsx
/** `unit`, when set, labels the inputs so a typed bound's unit is never a guess, and supplies the decimals its validation uses — see RangeUnit. */
function RangePanel({ column, unit }: { column: Column<EthRecord, unknown>; unit?: RangeUnit }) {
  const initial = (column.getFilterValue() as RangeFilterValue | undefined) ?? {}
  const [min, setMin] = useState(initial.min ?? '')
  const [max, setMax] = useState(initial.max ?? '')
  const [minError, setMinError] = useState<string | null>(null)
  const [maxError, setMaxError] = useState<string | null>(null)
  const errorIdBase = useId()
  const unitSuffix = unit ? ` (${unit.label})` : ''
  const decimals = unit?.decimals ?? null

  useEffect(() => {
    const t = window.setTimeout(() => {
      // Validation rides this debounce rather than running per keystroke: a bound is
      // half-typed for most of its life, and flagging "0." as an error mid-decimal would
      // punish normal typing.
      const minValue = min.trim() === '' ? null : boundToComparable(min, decimals)
      const maxValue = max.trim() === '' ? null : boundToComparable(max, decimals)
      const minInvalid = min.trim() !== '' && minValue == null
      const maxInvalid = max.trim() !== '' && maxValue == null

      const next: RangeFilterValue = {}
      // An unparseable bound is left OUT of the filter value, so a chip can never read
      // `≥ abc`. `rangeFilter` would have ignored it anyway — the difference is that the
      // message below now says why nothing happened.
      if (!minInvalid && min.trim() !== '') next.min = min.trim()
      if (!maxInvalid && max.trim() !== '') next.max = max.trim()

      const reversed = minValue != null && maxValue != null && minValue > maxValue
      setMinError(minInvalid ? 'Not a number' : reversed ? 'Min is greater than Max' : null)
      setMaxError(maxInvalid ? 'Not a number' : null)

      column.setFilterValue(next.min == null && next.max == null ? undefined : next)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, decimals])

  const minErrorId = `${errorIdBase}-min`
  const maxErrorId = `${errorIdBase}-max`

  return (
    <div className="filter-popover__range">
      <label className="filter-popover__field">
        <span className="filter-popover__label">Min{unitSuffix}</span>
        <input
          type="text"
          inputMode={unit ? 'decimal' : 'numeric'}
          className={`filter-popover__input filter-popover__input--mono${
            minError ? ' filter-popover__input--invalid' : ''
          }`}
          value={min}
          onChange={(e) => setMin(e.target.value)}
          placeholder="0"
          aria-invalid={minError ? true : undefined}
          aria-describedby={minError ? minErrorId : undefined}
          autoFocus
        />
        {minError && (
          <span id={minErrorId} className="filter-popover__error">
            {minError}
          </span>
        )}
      </label>
      <label className="filter-popover__field">
        <span className="filter-popover__label">Max{unitSuffix}</span>
        <input
          type="text"
          inputMode={unit ? 'decimal' : 'numeric'}
          className={`filter-popover__input filter-popover__input--mono${
            maxError ? ' filter-popover__input--invalid' : ''
          }`}
          value={max}
          onChange={(e) => setMax(e.target.value)}
          placeholder="max"
          aria-invalid={maxError ? true : undefined}
          aria-describedby={maxError ? maxErrorId : undefined}
        />
        {maxError && (
          <span id={maxErrorId} className="filter-popover__error">
            {maxError}
          </span>
        )}
      </label>
    </div>
  )
}
```

- [ ] **Step 5: Update the two `header()` call sites**

In `src/features/table/columns.tsx`, change `header`'s signature and its doc comment's
`rangeUnit` sentence:

```tsx
function header(tab: TabId, field: DictionaryField, rangeUnit?: RangeUnit) {
```

and add `RangeUnit` to the `FilterControls` import:

```tsx
import { FilterControls, type RangeUnit } from './FilterControls'
```

Change the two transactions-tab call sites:

```tsx
    header: header('transactions', 'value_lossless_tx', { label: 'ETH', decimals: 18 }),
```

```tsx
    header: header('transactions', 'gas_price_tx', { label: 'Gwei', decimals: 9 }),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/features/table/RangePanel.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 7: Add the error styles**

Append to `src/features/table/table.css`:

```css
.filter-popover__input--invalid {
  border-color: var(--danger, #e5534b);
}

.filter-popover__error {
  margin-top: 0.2rem;
  font-size: 0.68rem;
  color: var(--danger, #e5534b);
}
```

- [ ] **Step 8: Full verification and commit**

Run: `npm run test && npm run lint && npm run build`
Expected: all three PASS. `npm run build` runs `tsc -b`, which is what catches any call site
still passing the old `rangeUnit?: string`.

```bash
git add src/features/table/FilterControls.tsx src/features/table/RangePanel.test.tsx src/features/table/columns.tsx src/features/table/table.css
git commit -m "feat: report invalid and reversed filter bounds"
```

---

## Manual verification

Automated tests do not cover appearance or pointer interaction. After Task 8, run
`npm run dev` and confirm:

1. The Time header has a funnel; opening it shows "Block & time range" with both handles at
   the dataset ends and both clock labels populated.
2. Dragging either handle moves it, cannot cross the other, and updates the block number,
   the clock label, and the row count together.
3. Both handles back at the ends clears the chip and un-lights both funnels.
4. Sorting by Value ETH on the transactions tab puts the **largest** value on page 1.
5. Shift-clicking a second header produces two numbered sort chips and removes the hint;
   clicking a chip body reverses that column only.
6. Typing `abc` into a Min box shows "Not a number" in red and adds no chip.
7. Keyboard: Tab reaches both slider handles; arrow keys move them one block at a time.

---

## Notes for the implementer

- **`getByRole('button', { name: ... })` is load-bearing in the header tests.** Each header
  cell holds three buttons — the ⓘ dictionary trigger, the sort toggle, and the funnel. The
  regex anchoring in `sortHeader()` (`^Quantity(,|$)`) is what distinguishes the sort button
  from `Filter Quantity` and the ⓘ trigger.
- **Never make a test wait on a real 250 ms timer with `vi.useFakeTimers()` plus RTL's
  auto-advance disabled.** The tests above use `waitFor`, whose 1000 ms default comfortably
  clears the debounce.
- **Do not "fix" `rangeFilter`** to reject rows on a bad bound. Task 8's whole design is that
  the filter stays permissive and the panel explains itself.

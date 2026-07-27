import { useEffect, useState } from 'react'
import type { Column } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import type { ColumnMeta } from '../../data/dictionary'
import { FilterPopover } from './FilterPopover'
import { enumDisplayValue, type RangeFilterValue } from './filters'

interface FilterControlsProps {
  column: Column<EthRecord, unknown>
  kind: ColumnMeta['kind']
  label: string
  /** Only set for the two columns whose filterFn is 'rangeEth'/'rangeGwei' (columns.tsx) — labels the Min/Max inputs with the unit a typed bound is actually compared in. */
  rangeUnit?: string
}

const DEBOUNCE_MS = 250

function isFilterActive(kind: ColumnMeta['kind'], value: unknown): boolean {
  if (kind === 'number' || kind === 'bignum') {
    const range = value as RangeFilterValue | undefined
    return !!(range && (range.min?.trim() || range.max?.trim()))
  }
  if (kind === 'enum' || kind === 'boolean') {
    return Array.isArray(value) && value.length > 0
  }
  return typeof value === 'string' && value !== ''
}

/**
 * Per-column filter panel. Which panel renders is driven entirely by the column's
 * dictionary `kind` (see columns.tsx `filterFnForKind`) — the same axis that chose the
 * registered TanStack filterFn, so the control offered always matches the comparison
 * actually run. The funnel, popover and dismissal behavior live in FilterPopover.
 */
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

function TextPanel({ column }: { column: Column<EthRecord, unknown> }) {
  const [text, setText] = useState(() => (column.getFilterValue() as string | undefined) ?? '')

  useEffect(() => {
    const t = window.setTimeout(() => {
      column.setFilterValue(text === '' ? undefined : text)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  return (
    <label className="filter-popover__field">
      <span className="filter-popover__label">Contains</span>
      <input
        type="text"
        className="filter-popover__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. 0xabc…"
        autoFocus
      />
    </label>
  )
}

/** `unit`, when set ('ETH'/'Gwei'), labels the inputs so a typed bound's unit is never a guess — see FilterControlsProps.rangeUnit. */
function RangePanel({ column, unit }: { column: Column<EthRecord, unknown>; unit?: string }) {
  const initial = (column.getFilterValue() as RangeFilterValue | undefined) ?? {}
  const [min, setMin] = useState(initial.min ?? '')
  const [max, setMax] = useState(initial.max ?? '')
  const unitSuffix = unit ? ` (${unit})` : ''

  useEffect(() => {
    const t = window.setTimeout(() => {
      const next: RangeFilterValue = {}
      if (min.trim() !== '') next.min = min.trim()
      if (max.trim() !== '') next.max = max.trim()
      column.setFilterValue(next.min == null && next.max == null ? undefined : next)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max])

  return (
    <div className="filter-popover__range">
      <label className="filter-popover__field">
        <span className="filter-popover__label">Min{unitSuffix}</span>
        <input
          type="text"
          inputMode={unit ? 'decimal' : 'numeric'}
          className="filter-popover__input filter-popover__input--mono"
          value={min}
          onChange={(e) => setMin(e.target.value)}
          placeholder="0"
          autoFocus
        />
      </label>
      <label className="filter-popover__field">
        <span className="filter-popover__label">Max{unitSuffix}</span>
        <input
          type="text"
          inputMode={unit ? 'decimal' : 'numeric'}
          className="filter-popover__input filter-popover__input--mono"
          value={max}
          onChange={(e) => setMax(e.target.value)}
          placeholder="max"
        />
      </label>
    </div>
  )
}

function EnumPanel({ column }: { column: Column<EthRecord, unknown> }) {
  // Faceted unique values (built off the pre-filtered-by-this-column row model, via
  // `getFacetedUniqueValues` wired in DataTable.tsx) is exactly "distinct observed values
  // with counts" — no manual scan of `records` needed here.
  const facets = column.getFacetedUniqueValues()
  const selected = (column.getFilterValue() as string[] | undefined) ?? []

  const options = Array.from(facets.entries())
    .filter(([value]) => value != null && value !== '')
    .map(([value, count]) => ({
      display: enumDisplayValue(value as string | number | boolean),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))

  function toggle(display: string) {
    const next = selected.includes(display) ? selected.filter((v) => v !== display) : [...selected, display]
    column.setFilterValue(next.length === 0 ? undefined : next)
  }

  if (options.length === 0) {
    return <p className="filter-popover__empty">No values to filter on</p>
  }

  return (
    <ul className="filter-popover__list">
      {options.map((opt) => (
        <li key={opt.display}>
          <label className="filter-popover__checkbox">
            <input type="checkbox" checked={selected.includes(opt.display)} onChange={() => toggle(opt.display)} />
            <span className="filter-popover__checkbox-label">{opt.display}</span>
            <span className="filter-popover__checkbox-count">{opt.count.toLocaleString('en-US')}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

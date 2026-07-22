import type { Table } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import { columnDisplayLabel } from './columns'
import type { RangeFilterValue } from './filters'

interface FilterChipsProps {
  table: Table<EthRecord>
}

/** Human-readable summary of an active column filter's value — shape tells us which kind it came from (array = enum, object = range, string = text). */
function formatFilterValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value.join(', ')
  }
  if (typeof value === 'string') {
    return value === '' ? null : `contains "${value}"`
  }
  if (value && typeof value === 'object') {
    const range = value as RangeFilterValue
    const min = range.min?.trim()
    const max = range.max?.trim()
    if (!min && !max) return null
    if (min && max) return `${min} – ${max}`
    if (min) return `≥ ${min}`
    return `≤ ${max}`
  }
  return null
}

/**
 * Reads directly off the live `table` instance (rendered inside DataTable.tsx, which owns
 * `columnFilters` state — see the comment there — so this re-renders on every filter
 * change without needing its own copy of that state).
 */
export function FilterChips({ table }: FilterChipsProps) {
  const { columnFilters, globalFilter } = table.getState()

  const columnChips = columnFilters
    .map((f) => ({
      id: f.id,
      label: columnDisplayLabel(f.id as keyof EthRecord),
      text: formatFilterValue(f.value),
    }))
    .filter((chip): chip is { id: string; label: string; text: string } => chip.text != null)

  const hasGlobal = typeof globalFilter === 'string' && globalFilter.trim() !== ''
  const totalChips = columnChips.length + (hasGlobal ? 1 : 0)

  if (totalChips === 0) return null

  return (
    <div className="filter-chips">
      {hasGlobal && (
        <span className="filter-chip">
          Search: &ldquo;{globalFilter}&rdquo;
          <button
            type="button"
            className="filter-chip__remove"
            aria-label="Clear search"
            onClick={() => table.setGlobalFilter('')}
          >
            ×
          </button>
        </span>
      )}
      {columnChips.map((chip) => (
        <span key={chip.id} className="filter-chip">
          {chip.label}: {chip.text}
          <button
            type="button"
            className="filter-chip__remove"
            aria-label={`Clear ${chip.label} filter`}
            onClick={() => table.getColumn(chip.id)?.setFilterValue(undefined)}
          >
            ×
          </button>
        </span>
      ))}
      {totalChips >= 2 && (
        <button
          type="button"
          className="filter-chips__clear"
          onClick={() => {
            table.resetColumnFilters()
            table.setGlobalFilter('')
          }}
        >
          Clear all
        </button>
      )}
    </div>
  )
}

import type { Table } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import { formatCount } from '../../data/transform'
import { columnDisplayLabel } from './columns'
import type { RangeFilterValue } from './filters'
import type { TabId } from './Tabs'

interface FilterChipsProps {
  table: Table<EthRecord>
  /** Chip labels are tab-scoped (see columnDisplayLabel): the same field can render under
   *  a unit-specific header on the transactions tab but its raw dictionary label on 'all'. */
  tab: TabId
}

/** True for a bound that is a plain (optionally negative) base-10 integer — the only shape
 *  `formatCount` (a `number` in, `toLocaleString` out) can round-trip safely. ETH/Gwei
 *  decimal bounds ("0.5") and 256-bit numeric strings past `Number.MAX_SAFE_INTEGER` must
 *  both fall through unformatted rather than risk `formatCount` mangling them. */
function isSafeIntegerBound(value: string): boolean {
  return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))
}

/** Thousands-separates a bound for chip display when it's safe to (see isSafeIntegerBound
 *  above); every other bound — decimals, not-yet-valid text, oversized integers — renders
 *  exactly as typed. */
function formatBound(value: string): string {
  return isSafeIntegerBound(value) ? formatCount(Number(value)) : value
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
    const minRaw = range.min?.trim()
    const maxRaw = range.max?.trim()
    if (!minRaw && !maxRaw) return null
    const min = minRaw ? formatBound(minRaw) : undefined
    const max = maxRaw ? formatBound(maxRaw) : undefined
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
export function FilterChips({ table, tab }: FilterChipsProps) {
  const { columnFilters, globalFilter } = table.getState()

  const columnChips = columnFilters
    .map((f) => ({
      id: f.id,
      label: columnDisplayLabel(f.id as keyof EthRecord, tab),
      text: formatFilterValue(f.value),
    }))
    .filter((chip): chip is { id: string; label: string; text: string } => chip.text != null)

  const hasGlobal = typeof globalFilter === 'string' && globalFilter.trim() !== ''
  const totalChips = columnChips.length + (hasGlobal ? 1 : 0)

  if (totalChips === 0) return null

  return (
    <div className="chips-row filter-chips">
      <span className="chips-row__label">Filters:</span>
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

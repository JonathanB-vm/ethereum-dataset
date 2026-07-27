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

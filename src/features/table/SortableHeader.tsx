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

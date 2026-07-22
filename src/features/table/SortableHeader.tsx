import type { Column } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'

interface SortableHeaderProps {
  label: string
  column: Column<EthRecord, unknown>
}

/**
 * Shared header renderer for every column: label + a sort indicator (accent when this
 * column is the active sort). The ⓘ description affordance this used to reserve empty
 * space for is now a real sibling button (`DictionaryInfoTrigger`, rendered by
 * `columns.tsx`'s `header()` inside the shared `.col-header-cell` flex row) rather than
 * living inside this element — nesting an interactive button inside this sort `<button>`
 * would be invalid HTML.
 */
export function SortableHeader({ label, column }: SortableHeaderProps) {
  const sorted = column.getIsSorted()
  return (
    <button
      type="button"
      className={`col-header${sorted ? ' col-header--active' : ''}`}
      onClick={column.getToggleSortingHandler()}
    >
      <span className="col-header__label">{label}</span>
      <span className="col-header__sort" aria-hidden="true">
        {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
      </span>
    </button>
  )
}

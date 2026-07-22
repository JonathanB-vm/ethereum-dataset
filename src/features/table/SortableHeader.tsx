import type { Column } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'

interface SortableHeaderProps {
  label: string
  column: Column<EthRecord, unknown>
}

/**
 * Shared header renderer for every column: label + a sort indicator (accent when this
 * column is the active sort) + a reserved slot for the ⓘ description affordance Task 10
 * wires up. Reserving the slot now means Task 10 doesn't reflow every header.
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
      <span className="col-header__info-slot" />
    </button>
  )
}

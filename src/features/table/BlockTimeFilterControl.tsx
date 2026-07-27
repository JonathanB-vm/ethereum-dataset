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

// Stable empty-array fallback: a fresh `[]` literal in the render below would give
// BlockTimeRangeFilter's debounce effect (which has `axis` in its dependency array) a new
// identity on every render whenever `table.options.meta?.blockAxis` is missing, tearing
// down and re-registering the debounce timer before it ever settles.
const EMPTY_AXIS: BlockAxisEntry[] = []

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
    // `align="start"` because Block and Time are the leftmost columns on every tab: the
    // default right-anchored panel would grow off the table's left edge and be clipped.
    // `wide` because this panel needs more room than the 220px the other filters use.
    <FilterPopover label={label} isActive={isActive} align="start" wide>
      <BlockTimeRangeFilter
        axis={table.options.meta?.blockAxis ?? EMPTY_AXIS}
        value={value}
        onChange={(next) => column.setFilterValue(next)}
        matchCount={table.getFilteredRowModel().rows.length}
      />
    </FilterPopover>
  )
}

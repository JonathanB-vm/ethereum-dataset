import { useEffect, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
  type Table,
} from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import { customSortingFns, getColumnsForTab } from './columns'
import { customFilterFns, tableGlobalFilterFn } from './filters'
import { FilterChips } from './FilterChips'
import { pageRange } from './pageRange'
import type { TabId } from './Tabs'
import './table.css'

interface DataTableProps {
  records: EthRecord[]
  tab: TabId
  /** Lets a parent (Task 9: export + filter chips) reach the live TanStack instance. */
  onTableReady?: (table: Table<EthRecord>) => void
  /** Controlled from App.tsx, whose Header slot owns the global-search input. */
  globalFilter: string
  onGlobalFilterChange: (value: string) => void
}

const PAGE_SIZE_OPTIONS = [25, 50, 100]
const DEFAULT_PAGE_SIZE = 50

const fmt = (n: number): string => n.toLocaleString('en-US')

export function DataTable({ records, tab, onTableReady, globalFilter, onGlobalFilterChange }: DataTableProps) {
  // `getColumnsForTab` returns one of three module-level constant arrays, so its identity
  // is already stable per tab — no useMemo needed to avoid rebuilding the column set.
  const columns = getColumnsForTab(tab)

  const [sortingState, setSortingState] = useState<SortingState>([])
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })
  const [columnFiltersState, setColumnFiltersState] = useState<ColumnFiltersState>([])

  // Tab switch = a different column set, so sort/filter state from the old tab wouldn't
  // even apply cleanly (a sort — or a per-column filter — on "Quantity" makes no sense on
  // the transactions tab). Resetting sort/pagination/column-filters here — rather than
  // keeping a per-tab cache of each — is a deliberate simplification for this task; page
  // always resets to 1 on switch too. Global search (`globalFilter`) is *not* reset: it's
  // a whole-record search independent of which columns the active tab happens to show, so
  // it's owned by App.tsx and stays put across tab switches.
  //
  // The reset itself happens during render (React's documented "adjusting state when a
  // prop changes" pattern — https://react.dev/learn/you-might-not-need-an-effect), not in
  // a useEffect: an effect only fires *after* this render commits, so `useReactTable`
  // below would run once with the *new* columns but the *old* tab's sorting/filter state
  // (e.g. a `value_lossless_tx` sort or filter while transferColumns — which has no such
  // field — is active), which TanStack logs as a "column does not exist" console error.
  //
  // Calling setState here schedules the reset for the *next* render, but this render's
  // `sortingState`/`paginationState`/`columnFiltersState` locals are still stale — so
  // `sorting`/`pagination`/`columnFilters` below are derived inline as well, guaranteeing
  // the very same render that first sees the new `tab` also feeds useReactTable state
  // that's valid for the new `columns`.
  const [prevTab, setPrevTab] = useState(tab)
  const tabChanged = tab !== prevTab
  if (tabChanged) {
    setPrevTab(tab)
    setSortingState([])
    setPaginationState((p) => ({ pageIndex: 0, pageSize: p.pageSize }))
    setColumnFiltersState([])
  }
  const sorting = tabChanged ? [] : sortingState
  const pagination = tabChanged ? { pageIndex: 0, pageSize: paginationState.pageSize } : paginationState
  const columnFilters = tabChanged ? [] : columnFiltersState

  const table = useReactTable({
    data: records,
    columns,
    state: { sorting, pagination, columnFilters, globalFilter },
    onSortingChange: setSortingState,
    onPaginationChange: setPaginationState,
    onColumnFiltersChange: setColumnFiltersState,
    onGlobalFilterChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    sortingFns: customSortingFns,
    filterFns: customFilterFns,
    globalFilterFn: tableGlobalFilterFn,
  })

  // The table instance is a stable ref across re-renders (TanStack creates it once and
  // mutates its options in place) — this fires on mount and again if the instance itself
  // or the callback identity ever changes, which is what "whenever the instance changes" means here.
  useEffect(() => {
    onTableReady?.(table)
  }, [table, onTableReady])

  const rows = table.getRowModel().rows
  const totalRows = table.getFilteredRowModel().rows.length
  const { pageIndex, pageSize } = table.getState().pagination
  const { from: rangeStart, to: rangeEnd } = pageRange(pageIndex, pageSize, totalRows)
  const pageCount = Math.max(1, table.getPageCount())

  return (
    <div id="table-panel" role="tabpanel" aria-labelledby={`table-tab-${tab}`}>
      <FilterChips table={table} />
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((h) => {
                  const sorted = h.column.getIsSorted()
                  const ariaSort = sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                  return (
                    <th key={h.id} aria-sort={h.column.getCanSort() ? (ariaSort ?? 'none') : undefined}>
                      {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="data-table__empty" colSpan={columns.length}>
                  No records match this view.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <span className="table-footer__status">
          {totalRows === 0 ? 'No records' : `Showing ${fmt(rangeStart)}–${fmt(rangeEnd)} of ${fmt(totalRows)}`}
        </span>
        <div className="table-footer__pager">
          <label className="table-footer__size">
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => table.setPageSize(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="table-footer__page-btn"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="table-footer__page-pos">
            Page {pageIndex + 1} of {fmt(pageCount)}
          </span>
          <button
            type="button"
            className="table-footer__page-btn"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  )
}

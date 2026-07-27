import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type ExpandedState,
  type PaginationState,
  type SortingState,
  type Table,
} from '@tanstack/react-table'
import { EmptyState } from '../../components/States'
import { formatCount as fmt } from '../../data/transform'
import type { BlockAxisEntry, EthRecord } from '../../data/types'
import type { TokenRegistry } from '../../data/tokenRegistry'
import { customSortingFns, getColumnsForTab } from './columns'
import { customFilterFns, tableGlobalFilterFn } from './filters'
import { FilterChips } from './FilterChips'
import { SortChips } from './SortChips'
import { exitDuration } from '../../theme/motion'
import { ExpandIcon } from './FullscreenToggle'
import { pageRange } from './pageRange'
import { RowDetail } from './RowDetail'
import { RowFullscreen } from './RowFullscreen'
import type { TabId } from './Tabs'
import './table.css'

interface DataTableProps {
  records: EthRecord[]
  tab: TabId
  /** Every distinct block with its timestamp, from the FULL dataset — not this tab's slice,
   *  or the range control's handle labels would shift on every tab switch. */
  blockAxis: BlockAxisEntry[]
  /** Lets a parent (Task 9: export + filter chips) reach the live TanStack instance. */
  onTableReady?: (table: Table<EthRecord>) => void
  /** Controlled from App.tsx, whose Header slot owns the global-search input. */
  globalFilter: string
  onGlobalFilterChange: (value: string) => void
  /** Token decimals lookup, for the derived Normalized Quantity column. Empty is valid. */
  tokens: TokenRegistry
}

const PAGE_SIZE_OPTIONS = [25, 50, 100]
const DEFAULT_PAGE_SIZE = 50

export function DataTable({ records, tab, blockAxis, onTableReady, globalFilter, onGlobalFilterChange, tokens }: DataTableProps) {
  // The transfers tab now builds its column array per call (it closes over `tokens` for the
  // derived Normalized Quantity column), so this can no longer rely on the old module-level
  // constant identity — without the memo, every render would hand useReactTable a new
  // column array and reset its internal column state.
  const columns = useMemo(() => getColumnsForTab(tab, tokens), [tab, tokens])

  const [sortingState, setSortingState] = useState<SortingState>([])
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })
  const [columnFiltersState, setColumnFiltersState] = useState<ColumnFiltersState>([])
  // Which single row (if any) has its detail panel open, keyed by TanStack row id. A plain
  // `Record<string, boolean>` (TanStack's `ExpandedState` shape) rather than a bare string
  // so it plugs directly into `useReactTable`'s `state.expanded`/`onExpandedChange` — but
  // `toggleRowExpanded` below always *replaces* it wholesale (never merges), which is what
  // gives "only one row expanded at a time, replaced on toggle" instead of TanStack's
  // default multi-row-expansion merge behavior.
  const [expandedState, setExpandedState] = useState<ExpandedState>({})
  // Which record (if any) is open in the fullscreen preview (RowFullscreen). Owned here,
  // not in App: nothing outside the table participates. The trigger ref captures the
  // per-row button that opened it so close (✕ or Esc) can restore focus there — same
  // pattern as DictionaryPanelProvider.
  const [fullscreenRow, setFullscreenRow] = useState<EthRecord | null>(null)
  const fullscreenTriggerRef = useRef<HTMLElement | null>(null)
  // Exit-animation phase: the overlay stays mounted (with `--closing`) for exitDuration()
  // before fullscreenRow clears — instant unmount would cut the fade off at frame one.
  // The ref (not state) guards re-entry: Esc and ✕ can both fire before a re-render lands.
  const [fullscreenClosing, setFullscreenClosing] = useState(false)
  const fullscreenClosingRef = useRef(false)
  const fullscreenCloseTimerRef = useRef<number | undefined>(undefined)

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
    setExpandedState({})
    setFullscreenRow(null)
  }
  const sorting = tabChanged ? [] : sortingState
  const pagination = tabChanged ? { pageIndex: 0, pageSize: paginationState.pageSize } : paginationState
  const columnFilters = tabChanged ? [] : columnFiltersState
  const expanded = tabChanged ? {} : expandedState

  const table = useReactTable({
    data: records,
    columns,
    state: { sorting, pagination, columnFilters, globalFilter, expanded },
    onSortingChange: setSortingState,
    onPaginationChange: setPaginationState,
    onColumnFiltersChange: setColumnFiltersState,
    onGlobalFilterChange,
    onExpandedChange: setExpandedState,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    sortingFns: customSortingFns,
    filterFns: customFilterFns,
    globalFilterFn: tableGlobalFilterFn,
    // Written down rather than inherited: SortChips and the header ordinals exist entirely
    // to surface shift-click multi-sort, so the behavior they describe must not be able to
    // change out from under them via a library default.
    enableMultiSort: true,
    isMultiSortEvent: (e) => (e as { shiftKey?: boolean }).shiftKey === true,
    meta: { blockAxis },
  })

  // Toggling calls `setExpandedState` directly (not `row.getToggleExpandedHandler()`,
  // which merges into the existing object) — replacing wholesale is what enforces
  // single-row expansion: clicking a second row's chevron closes the first.
  function toggleRowExpanded(rowId: string) {
    setExpandedState((prev) => {
      const isOpen = typeof prev === 'object' && !!prev[rowId]
      return isOpen ? {} : { [rowId]: true }
    })
  }

  function openRowFullscreen(record: EthRecord, trigger: HTMLElement) {
    // Opening (possibly a different row) mid-exit-animation wins over the pending unmount.
    window.clearTimeout(fullscreenCloseTimerRef.current)
    fullscreenClosingRef.current = false
    setFullscreenClosing(false)
    fullscreenTriggerRef.current = trigger
    setFullscreenRow(record)
  }
  // useCallback so RowFullscreen's effect (Esc listener, scroll lock, focus trap) doesn't
  // tear down and re-register on every DataTable re-render while the preview is open.
  const closeRowFullscreen = useCallback(() => {
    if (fullscreenClosingRef.current) return
    fullscreenClosingRef.current = true
    setFullscreenClosing(true)
    fullscreenCloseTimerRef.current = window.setTimeout(() => {
      fullscreenClosingRef.current = false
      setFullscreenClosing(false)
      setFullscreenRow(null)
      fullscreenTriggerRef.current?.focus()
      fullscreenTriggerRef.current = null
    }, exitDuration())
  }, [])
  // The pending unmount timer must not fire into an unmounted DataTable.
  useEffect(() => () => window.clearTimeout(fullscreenCloseTimerRef.current), [])

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
  // Drives EmptyState's copy/action: "Clear filters" only makes sense — and only appears —
  // when a filter is the reason the view is empty.
  const hasActiveFilters = columnFilters.length > 0 || globalFilter.trim() !== ''

  return (
    <div id="table-panel" className="table-panel" role="tabpanel" aria-labelledby={`table-tab-${tab}`}>
      <SortChips table={table} tab={tab} />
      <FilterChips table={table} tab={tab} />
      <div className="table-scroll">
        <table className={`data-table${tab === 'all' ? ' data-table--dense' : ''}`}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {/* Chevron column: rendered directly here (not a TanStack ColumnDef) so it
                    never appears in `table.getVisibleLeafColumns()` — ExportButton's CSV
                    column list and FilterChips stay exactly the loaded dictionary fields
                    (34, plus the derived `normalized_quantity` column on the transfers tab). */}
                <th className="row-expander-header" aria-hidden="true" />
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
              <EmptyState
                colSpan={columns.length + 1}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={() => {
                  table.resetColumnFilters()
                  table.setGlobalFilter('')
                }}
              />
            ) : (
              rows.map((row, i) => {
                const isExpanded = row.getIsExpanded()
                return (
                  <Fragment key={row.id}>
                    {/* Zebra class from the *visual* page position (map index, not
                        row.index, which is the unsorted/unfiltered data position) —
                        expanded detail rows are extra <tr>s that would break :nth-child
                        counting, so CSS can't do this alone. */}
                    <tr className={i % 2 === 1 ? 'data-row--even' : undefined}>
                      <td className="row-expander-cell">
                        {/* Wrapper span (inline-flex) rather than making the <td> itself a
                            flex container — a display:flex td stops behaving as a table
                            cell. Holds the expand chevron + fullscreen preview button. */}
                        <span className="row-actions">
                          <button
                            type="button"
                            className={`row-expander${isExpanded ? ' row-expander--open' : ''}`}
                            onClick={() => toggleRowExpanded(row.id)}
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? 'Collapse row details' : 'Expand row details'}
                          >
                            <ChevronIcon />
                          </button>
                          <button
                            type="button"
                            className="row-preview"
                            onClick={(e) => openRowFullscreen(row.original, e.currentTarget)}
                            aria-label="View row details full screen"
                            title="View row details full screen"
                          >
                            <ExpandIcon />
                          </button>
                        </span>
                      </td>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                    {isExpanded && (
                      <tr className="row-detail-row">
                        <td colSpan={columns.length + 1}>
                          <RowDetail record={row.original} tokens={tokens} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <span className="table-footer__status">
          {/* A bare count ("0 records"), not a message -- EmptyState's own copy ("No records
              match your filters" / "No records in this view") already owns the "why is this
              empty" explanation directly above; the footer's job stays the same in every
              state: report a count. */}
          {totalRows === 0 ? '0 records' : `Showing ${fmt(rangeStart)}–${fmt(rangeEnd)} of ${fmt(totalRows)}`}
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

      {fullscreenRow && (
        <RowFullscreen
          record={fullscreenRow}
          onClose={closeRowFullscreen}
          closing={fullscreenClosing}
          tokens={tokens}
        />
      )}
    </div>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
      <path d="M5.5 3.5l5 4.5-5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

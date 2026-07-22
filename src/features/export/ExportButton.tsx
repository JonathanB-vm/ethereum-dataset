import { useEffect, useRef, useState } from 'react'
import type { Table } from '@tanstack/react-table'
import { COLUMNS } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import type { TabId } from '../table/Tabs'
import { buildCsv, downloadCsv } from './exportCsv'
import './export.css'

interface ExportButtonProps {
  table: Table<EthRecord>
  tab: TabId
  /** Derived by the caller (App.tsx) from the loaded dataset — never hard-coded here. */
  blockNumber: number
}

export function ExportButton({ table, tab, blockNumber }: ExportButtonProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      // Outside click doesn't return focus to the trigger — same reasoning as
      // FilterControls: the user deliberately moved focus elsewhere, so pulling it back
      // here would fight that. Escape, below, is keyboard-only with nowhere else for
      // focus to logically land, so it does restore it.
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleExport(allColumns: boolean) {
    setOpen(false)

    // TanStack's row-model pipeline is core → filtered → sorted → paginated, each stage
    // built from the previous one. `getSortedRowModel()` is the filtered-then-sorted
    // result, i.e. exactly "the current view" — one stage *before* pagination slices it
    // down to a single page. Reading `getPaginationRowModel()` here would silently export
    // only the visible page; `getPrePaginationRowModel()` is the model pagination itself
    // consumes and would return the same rows (sorting is always enabled in this table),
    // but `getSortedRowModel()` is what the brief calls out by name and is the more
    // obviously-correct choice to a future reader who doesn't already know that equivalence.
    const rows = table.getSortedRowModel().rows
    const records = rows.map((r) => r.original)
    const fields = allColumns
      ? COLUMNS.map((c) => c.field)
      : (table.getVisibleLeafColumns().map((c) => c.id) as (keyof EthRecord)[])

    const csv = buildCsv(records, fields)
    const filename = `eth-block${blockNumber}-${tab}-${records.length}rows.csv`
    downloadCsv(csv, filename)
  }

  return (
    <div className="export-button" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="export-button__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <DownloadIcon />
        Export CSV
      </button>
      {open && (
        <div className="export-button__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="export-button__item"
            onClick={() => handleExport(false)}
          >
            Visible columns
          </button>
          <button
            type="button"
            role="menuitem"
            className="export-button__item"
            onClick={() => handleExport(true)}
          >
            All 35 columns
          </button>
        </div>
      )}
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path
        d="M8 2v7.5m0 0L5 6.5m3 3l3-3M2.5 12v1.2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

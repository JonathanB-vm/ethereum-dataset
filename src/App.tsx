import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Table } from '@tanstack/react-table'
import { Header } from './components/Header'
import { csvProvider } from './data/csvProvider'
import type { LoadResult } from './data/provider'
import type { EthRecord } from './data/types'
import { formatTimestamp } from './data/transform'
import { StatsBand } from './features/stats/StatsBand'
import { computeStats } from './features/stats/computeStats'
import { DataTable } from './features/table/DataTable'
import { Tabs, type TabId } from './features/table/Tabs'
import { ExportButton } from './features/export/ExportButton'
import { GlobalSearchInput } from './components/GlobalSearchInput'

interface LoadState {
  status: 'loading' | 'error' | 'ready'
  result?: LoadResult
  error?: string
}

/** Highest block_number in the dataset — the export may not be block-sorted. */
function latestBlock(records: EthRecord[]): EthRecord | null {
  let latest: EthRecord | null = null
  for (const r of records) {
    if (latest == null || r.block_number > latest.block_number) latest = r
  }
  return latest
}

function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [activeTab, setActiveTab] = useState<TabId>('transfers')
  // ExportButton (rendered next to Tabs, below) reaches the live table through this.
  // This is `useState`, not a plain ref: DataTable's `onTableReady` fires from inside a
  // `useEffect`, *after* DataTable's own first commit — a ref would silently hold `null`
  // through App's initial render (and every render until something else happens to
  // re-render App), so ExportButton would render as if no table existed until an
  // unrelated state change (tab switch, etc.) papered over it. `setState` here schedules
  // the extra render that actually reflects the table becoming available. The instance
  // itself is a stable reference once created (TanStack mutates it in place, per
  // DataTable.tsx's own comment), so this settles after exactly one extra render, not a loop.
  const [table, setTable] = useState<Table<EthRecord> | null>(null)
  const handleTableReady = useCallback((t: Table<EthRecord>) => {
    setTable(t)
  }, [])
  // Global search input lives in the Header's slot (a sibling of DataTable), so its state
  // has to live here rather than inside DataTable — DataTable receives it back down as a
  // controlled prop.
  const [globalFilter, setGlobalFilter] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    csvProvider()
      .load()
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', result })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ⌘K / Ctrl-K focuses the global search input from anywhere on the page.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const latest = useMemo(
    () => (state.result ? latestBlock(state.result.records) : null),
    [state.result],
  )

  const stats = useMemo(
    () => (state.result ? computeStats(state.result.records) : null),
    [state.result],
  )

  // Tab counts are always derived from the loaded records, never hard-coded.
  const tabCounts = useMemo<Record<TabId, number>>(() => {
    const records = state.result?.records ?? []
    const transfers = records.reduce((n, r) => n + (r.is_token_transfer ? 1 : 0), 0)
    return { transfers, transactions: records.length - transfers, all: records.length }
  }, [state.result])

  // Tabs filter records before they ever reach DataTable — it only ever sees its own slice.
  const tabRecords = useMemo(() => {
    const records = state.result?.records ?? []
    switch (activeTab) {
      case 'transfers':
        return records.filter((r) => r.is_token_transfer)
      case 'transactions':
        return records.filter((r) => !r.is_token_transfer)
      case 'all':
        return records
    }
  }, [state.result, activeTab])

  return (
    <div className="app-shell">
      <Header
        blockNumber={latest?.block_number ?? null}
        blockTime={latest ? formatTimestamp(latest.block_timestamp) : null}
      >
        {state.status === 'ready' && (
          <GlobalSearchInput ref={searchInputRef} value={globalFilter} onChange={setGlobalFilter} />
        )}
      </Header>
      {state.status === 'ready' && stats && <StatsBand stats={stats} />}
      <main className="app-main">
        {state.status === 'loading' && <p className="app-state">Loading dataset…</p>}
        {state.status === 'error' && (
          <p className="app-state app-state--error">Failed to load dataset: {state.error}</p>
        )}
        {state.status === 'ready' && state.result && (
          <div className="table-card">
            <div className="table-toolbar">
              <Tabs active={activeTab} onChange={setActiveTab} counts={tabCounts} />
              {table && latest && (
                <ExportButton table={table} tab={activeTab} blockNumber={latest.block_number} />
              )}
            </div>
            <DataTable
              records={tabRecords}
              tab={activeTab}
              onTableReady={handleTableReady}
              globalFilter={globalFilter}
              onGlobalFilterChange={setGlobalFilter}
            />
          </div>
        )}
      </main>
    </div>
  )
}

export default App

import { useEffect, useMemo, useRef, useState } from 'react'
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
  // Task 9 (export + filter chips) reaches the live table through this — DataTable
  // reports its instance up via onTableReady, this is where it lands.
  const tableRef = useRef<Table<EthRecord> | null>(null)

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
      />
      {state.status === 'ready' && stats && <StatsBand stats={stats} />}
      <main className="app-main">
        {state.status === 'loading' && <p className="app-state">Loading dataset…</p>}
        {state.status === 'error' && (
          <p className="app-state app-state--error">Failed to load dataset: {state.error}</p>
        )}
        {state.status === 'ready' && state.result && (
          <div className="table-card">
            <Tabs active={activeTab} onChange={setActiveTab} counts={tabCounts} />
            <DataTable
              records={tabRecords}
              tab={activeTab}
              onTableReady={(table) => {
                tableRef.current = table
              }}
            />
          </div>
        )}
      </main>
    </div>
  )
}

export default App

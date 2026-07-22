import { useEffect, useMemo, useState } from 'react'
import { Header } from './components/Header'
import { csvProvider } from './data/csvProvider'
import type { LoadResult } from './data/provider'
import type { EthRecord } from './data/types'
import { formatTimestamp } from './data/transform'
import { StatsBand } from './features/stats/StatsBand'
import { computeStats } from './features/stats/computeStats'

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
          <p className="app-state">
            Loaded {state.result.records.length.toLocaleString('en-US')} rows
            {state.result.malformedCount > 0
              ? ` (${state.result.malformedCount.toLocaleString('en-US')} skipped)`
              : ''}
            .
          </p>
        )}
      </main>
    </div>
  )
}

export default App

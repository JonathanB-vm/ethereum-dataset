import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Table } from '@tanstack/react-table'
import { Header } from './components/Header'
import { ErrorState, LoadingState, MalformedNotice } from './components/States'
import { csvProvider } from './data/csvProvider'
import type { LoadResult } from './data/provider'
import type { BlockAxisEntry, EthRecord } from './data/types'
import { formatTimestamp } from './data/transform'
import { StatsBand } from './features/stats/StatsBand'
import { computeStats } from './features/stats/computeStats'
import { DataTable } from './features/table/DataTable'
import { FullscreenToggle } from './features/table/FullscreenToggle'
import { Tabs, type TabId } from './features/table/Tabs'
import { ExportButton } from './features/export/ExportButton'
import { GlobalSearchInput } from './components/GlobalSearchInput'
import { DictionaryButton, DictionaryPanelProvider } from './features/dictionary/DictionaryPanel'
import { exitDuration } from './theme/motion'
import { useDebouncedValue } from './hooks/useDebouncedValue'

interface LoadState {
  status: 'loading' | 'error' | 'ready'
  result?: LoadResult
  error?: string
}

// Stable fallback for when `stats` is null (still loading): `stats.blockAxis` from a
// `useMemo` is already a stable reference, but a literal `[]` at the JSX call site below
// would mint a brand-new array identity on every render. BlockTimeRangeFilter's debounce
// effect has `axis` in its dependency array, so a fresh identity every render tears the
// effect down and re-registers it constantly and the debounce never settles.
const EMPTY_BLOCK_AXIS: BlockAxisEntry[] = []

function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Bumping this re-runs the load effect below — Retry's whole job. Kept separate from
  // `state` itself so a retry doesn't need to duplicate the effect's fetch/catch logic.
  const [retryToken, setRetryToken] = useState(0)
  // Download progress for the current load attempt — reset to null at the start of each
  // attempt (including a retry) in the effect below, since a superseded load's progress
  // shouldn't linger onscreen once a new one starts.
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  // Reset per load (see the effect below) so a *new* load that's still malformed re-shows
  // the notice even if the user dismissed it for a previous load.
  const [malformedNoticeDismissed, setMalformedNoticeDismissed] = useState(false)
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
  // The input stays on `globalFilter` (instant feedback while typing); the *table* consumes
  // `debouncedFilter`, so a burst of keystrokes costs one filter pass, not one per character.
  const debouncedFilter = useDebouncedValue(globalFilter, 200)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Task 13: table fullscreen mode. State lives here (not in DataTable/FullscreenToggle)
  // because it toggles a class on `.table-card`, which wraps both the toolbar (where the
  // toggle button sits) and DataTable — a sibling relationship, not parent/child.
  //
  // Three phases (not a boolean) because the exit animates: 'closing' keeps the card
  // position:fixed (with the `--fs-closing` animation class) for exitDuration() before
  // 'off' drops it back into page layout — an instant class removal would snap it inline
  // with no transition frame to play.
  const [fsPhase, setFsPhase] = useState<'off' | 'on' | 'closing'>('off')
  const fullscreenToggleRef = useRef<HTMLButtonElement>(null)
  const fsCloseTimerRef = useRef<number | undefined>(undefined)

  const exitFullscreen = useCallback(() => {
    if (fsPhase !== 'on') return
    setFsPhase('closing')
    fsCloseTimerRef.current = window.setTimeout(() => {
      setFsPhase('off')
      // Matches every other overlay in this app (filter popovers, export menu, dictionary
      // panel): a keyboard-only close has nowhere else for focus to logically land, so it
      // returns to the control that opened it.
      fullscreenToggleRef.current?.focus()
    }, exitDuration())
  }, [fsPhase])

  useEffect(() => () => window.clearTimeout(fsCloseTimerRef.current), [])

  function handleFullscreenToggleClick() {
    if (fsPhase === 'on') exitFullscreen()
    else if (fsPhase === 'off') setFsPhase('on')
    // 'closing': ignore — the exit already in flight lands in a moment.
  }

  // Esc exits fullscreen — but only when nothing "on top" of it already owns Esc. Filter
  // popovers (FilterControls.tsx), the export menu (ExportButton.tsx), and the dictionary
  // panel (DictionaryPanel.tsx) each register their own `document`-level Escape listener
  // while open, and none of them call stopPropagation/preventDefault (nor could they
  // meaningfully coordinate with a sibling listener if they did — these are independent
  // `document.addEventListener('keydown', …)` calls, not a bubble chain). So on a single
  // Escape press with e.g. a filter popover open, *both* that popover's listener and this
  // one would otherwise fire — closing the popover *and* exiting fullscreen at once, which
  // isn't what "Esc exits" should mean while something is still open on top. Checking for
  // any currently-open dialog/menu (all three render with `role="dialog"` or `role="menu"`)
  // right when this handler runs — synchronously inside the same keydown dispatch, before
  // React has flushed their `setOpen(false)` — reads whether one is still in the DOM and,
  // if so, defers: that Escape press closes the popover only, and a second press (nothing
  // left open) is what exits fullscreen.
  // Scroll lock spans 'on' AND 'closing' — releasing it at closing-start would let the
  // page reflow (scrollbar reappears) behind the exit animation's final frames.
  useEffect(() => {
    if (fsPhase === 'off') return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [fsPhase])

  // Esc, by contrast, only listens while fully 'on' — during 'closing' there's nothing
  // left for it to do (exitFullscreen guards re-entry anyway).
  useEffect(() => {
    if (fsPhase !== 'on') return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      exitFullscreen()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fsPhase, exitFullscreen])

  useEffect(() => {
    let cancelled = false
    // Re-running this effect (retryToken bump) starts from `loading` again — a retry after
    // an error should show LoadingState, not leave the error (or a stale ready result) on
    // screen while the new fetch is in flight.
    setState({ status: 'loading' })
    setMalformedNoticeDismissed(false)
    setProgress(null)
    csvProvider('/data/rows.csv.gz', (loaded, total) => {
      if (!cancelled) setProgress({ loaded, total })
    })
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
  }, [retryToken])

  const handleRetry = useCallback(() => setRetryToken((t) => t + 1), [])

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
    // Wraps the whole shell (not just <main>) since the "Data dictionary" button lives in
    // Header's actions slot while every column ⓘ trigger lives deep inside DataTable — both
    // need the same context. `records` is the full loaded dataset (not `tabRecords`), so a
    // field's live stats don't change depending on which tab happened to be open when its
    // ⓘ was clicked.
    <DictionaryPanelProvider records={state.result?.records ?? []}>
      <div className="app-shell">
        <Header
          blockCount={stats?.blockCount ?? 0}
          blockMin={stats?.blockMin ?? null}
          blockMax={stats?.blockMax ?? null}
          timeRange={
            stats?.timeStart != null && stats.timeEnd != null
              ? `${formatTimestamp(stats.timeStart)} – ${formatTimestamp(stats.timeEnd)}`
              : null
          }
        >
          {state.status === 'ready' && (
            <>
              <GlobalSearchInput ref={searchInputRef} value={globalFilter} onChange={setGlobalFilter} />
              <DictionaryButton />
            </>
          )}
        </Header>
        {state.status === 'ready' &&
          state.result &&
          state.result.malformedCount > 0 &&
          !malformedNoticeDismissed && (
            <MalformedNotice
              count={state.result.malformedCount}
              onDismiss={() => setMalformedNoticeDismissed(true)}
            />
          )}
        {state.status === 'ready' && stats && <StatsBand stats={stats} />}
        <main className="app-main">
          {state.status === 'loading' && (
            <LoadingState loaded={progress?.loaded} total={progress?.total} />
          )}
          {state.status === 'error' && <ErrorState message={state.error} onRetry={handleRetry} />}
          {state.status === 'ready' && state.result && (
            <div
              className={`table-card${fsPhase !== 'off' ? ' table-card--fullscreen' : ''}${
                fsPhase === 'closing' ? ' table-card--fs-closing' : ''
              }`}
            >
              <div className="table-toolbar">
                <Tabs active={activeTab} onChange={setActiveTab} counts={tabCounts} />
                {table && (
                  <ExportButton
                    table={table}
                    tab={activeTab}
                    blockMin={stats?.blockMin ?? null}
                    blockMax={stats?.blockMax ?? null}
                  />
                )}
                {/* `!== 'off'` (not just 'on') so the collapse icon holds through the
                    closing phase instead of flicking back one animation early. */}
                <FullscreenToggle
                  ref={fullscreenToggleRef}
                  isFullscreen={fsPhase !== 'off'}
                  onToggle={handleFullscreenToggleClick}
                />
              </div>
              <DataTable
                records={tabRecords}
                tab={activeTab}
                blockAxis={stats?.blockAxis ?? EMPTY_BLOCK_AXIS}
                onTableReady={handleTableReady}
                globalFilter={debouncedFilter}
                onGlobalFilterChange={setGlobalFilter}
              />
            </div>
          )}
        </main>
      </div>
    </DictionaryPanelProvider>
  )
}

export default App

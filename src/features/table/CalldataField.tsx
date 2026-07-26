import { useEffect, useState } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { calldataProvider, type CalldataProvider } from '../../data/calldataProvider'
import { truncateMiddle } from '../../data/transform'

const defaultProvider = calldataProvider()

interface CalldataFieldProps {
  txHash: string
  label: string
  /**
   * Injectable so tests don't have to stub `fetch`. `provider` is a dependency of the
   * fetch effect below, so callers must keep it referentially stable across renders (the
   * module-level default already is) — passing a new object literal on every render would
   * retrigger the fetch every render instead of only on tx-hash change.
   */
  provider?: CalldataProvider
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; value: string }
  | { status: 'error'; message: string }

/**
 * The one row-detail field whose value isn't in memory. `input_tx` is fetched per
 * transaction from a sharded side store (see `calldataProvider.ts`) the moment a row is
 * expanded, and rendered with the same truncate + copy affordance as every other long
 * blob in this panel.
 */
export function CalldataField({ txHash, label, provider = defaultProvider }: CalldataFieldProps) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    provider
      .get(txHash)
      .then((value) => {
        // A row expanded, collapsed, and re-expanded on a different tx must not paint the
        // first row's calldata when the slower request finally lands.
        if (!cancelled) setState({ status: 'ready', value })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [txHash, provider, attempt])

  return (
    <div className="row-detail__field">
      <span className="row-detail__field-label">{label}</span>
      {state.status === 'loading' && (
        <span className="row-detail__field-value row-detail__field-value--empty">Loading…</span>
      )}
      {state.status === 'ready' && (
        <span className="row-detail__field-value">
          <span className="row-detail__field-raw" title={state.value}>
            {truncateMiddle(state.value)}
          </span>
          <CopyButton value={state.value} />
        </span>
      )}
      {state.status === 'error' && (
        <span className="row-detail__field-value">
          <span className="row-detail__field-error">Couldn&rsquo;t load</span>
          <button
            type="button"
            className="row-detail__field-retry"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  )
}

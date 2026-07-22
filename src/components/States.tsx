import './states.css'

const STAT_TILE_COUNT = 6
const SKELETON_ROW_COUNT = 10
const SKELETON_COL_COUNT = 8

/**
 * Deterministic pseudo-random width so skeleton bars read as organic column content rather
 * than a uniform grid — no `Math.random()`, so a given tile/cell renders the same width on
 * every render (and in tests/screenshots) instead of jittering.
 */
function skeletonWidth(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 999) * 10000
  const frac = x - Math.floor(x)
  return Math.round(min + frac * (max - min))
}

/**
 * Centered skeleton for the initial dataset fetch: shimmering stat-tile placeholders +
 * table header/row placeholders, sized to the real StatsBand/DataTable layout so swapping
 * to the ready state doesn't jump the page (brief: "match real layout to avoid shift").
 * Deliberately not spinner-only — a bare spinner tells the user *that* something is
 * loading but not *what's about to appear*; this shape previews it.
 */
export function LoadingState() {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-label="Loading dataset">
      <section className="loading-state__stats" aria-hidden="true">
        {Array.from({ length: STAT_TILE_COUNT }).map((_, i) => (
          <div className="loading-state__tile" key={i}>
            <span className="skeleton" style={{ width: 60, height: 9 }} />
            <span className="skeleton" style={{ width: skeletonWidth(i, 70, 108), height: 20 }} />
            <span className="skeleton" style={{ width: skeletonWidth(i + 11, 40, 84), height: 9 }} />
          </div>
        ))}
      </section>

      <div className="loading-state__table">
        <div className="loading-state__toolbar">
          <span className="skeleton skeleton--pill" style={{ width: 88 }} />
          <span className="skeleton skeleton--pill" style={{ width: 104 }} />
          <span className="skeleton skeleton--pill" style={{ width: 76 }} />
          <span className="skeleton loading-state__toolbar-btn" style={{ width: 108, height: 28 }} />
        </div>
        <div className="loading-state__grid">
          <div className="loading-state__row loading-state__row--head">
            {Array.from({ length: SKELETON_COL_COUNT }).map((_, c) => (
              <span key={c} className="skeleton" style={{ width: skeletonWidth(c, 42, 74), height: 9 }} />
            ))}
          </div>
          {Array.from({ length: SKELETON_ROW_COUNT }).map((_, r) => (
            <div className="loading-state__row" key={r}>
              {Array.from({ length: SKELETON_COL_COUNT }).map((_, c) => (
                <span
                  key={c}
                  className="skeleton"
                  style={{ width: skeletonWidth(r * SKELETON_COL_COUNT + c, 36, 128), height: 11 }}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="loading-state__footer">
          <span className="skeleton" style={{ width: 150, height: 9 }} />
        </div>
      </div>
    </div>
  )
}

interface ErrorStateProps {
  message?: string
  onRetry: () => void
}

/** Full dataset load failure — replaces the whole main content area. */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <span className="error-state__icon" aria-hidden="true">
        <AlertIcon />
      </span>
      <h2 className="error-state__title">Couldn&rsquo;t load the dataset</h2>
      {message && <p className="error-state__detail">{message}</p>}
      <button type="button" className="error-state__retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

interface EmptyStateProps {
  /** Whether a column filter or the global search is currently narrowing the view — decides
   *  whether "Clear filters" is offered at all: if nothing is filtering the view, clearing
   *  filters can't fix it, so the button would be a dead end. */
  hasActiveFilters: boolean
  onClearFilters: () => void
  colSpan: number
}

/** Rendered as the table body's only row when the active tab/filters yield zero records. */
export function EmptyState({ hasActiveFilters, onClearFilters, colSpan }: EmptyStateProps) {
  return (
    <tr>
      <td className="empty-state" colSpan={colSpan}>
        <span className="empty-state__icon" aria-hidden="true">
          <NoResultsIcon />
        </span>
        <p className="empty-state__title">
          {hasActiveFilters ? 'No records match your filters' : 'No records in this view'}
        </p>
        {hasActiveFilters && (
          <button type="button" className="empty-state__clear" onClick={onClearFilters}>
            Clear filters
          </button>
        )}
      </td>
    </tr>
  )
}

interface MalformedNoticeProps {
  count: number
  onDismiss: () => void
}

/** Dismissible banner shown above the stats band whenever the CSV parse dropped rows it
 *  couldn't make sense of (missing block number / transaction hash) — surfaces the gap
 *  between "rows in the file" and "rows in the dataset" instead of silently hiding it. */
export function MalformedNotice({ count, onDismiss }: MalformedNoticeProps) {
  const rowWord = count === 1 ? 'row' : 'rows'
  const verb = count === 1 ? 'is' : 'are'
  return (
    <div className="malformed-notice" role="status">
      <span className="malformed-notice__icon" aria-hidden="true">
        <WarningIcon />
      </span>
      <p className="malformed-notice__text">
        {count.toLocaleString('en-US')} {rowWord} could not be parsed and {verb} excluded.
      </p>
      <button
        type="button"
        className="malformed-notice__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss notice"
      >
        <CloseIcon />
      </button>
    </div>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 9.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="0.9" fill="currentColor" />
    </svg>
  )
}

function NoResultsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M15.3 15.3 20.5 20.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7.7 10.5h5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 9.5v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="0.9" fill="currentColor" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

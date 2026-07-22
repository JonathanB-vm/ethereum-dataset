import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { COLUMNS, getColumnMeta, type ColumnMeta } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { weiToEth, weiToGwei } from '../../data/transform'
import { HUMAN_UNIT } from '../table/rowDetailFields'
import { computeColumnStats } from './columnStats'
import { DictionaryPanelContext, useDictionaryPanel } from './dictionaryPanelContext'
import { visibleSources, type SourceFilter } from './sourceFilter'
import './dictionary.css'

// Context is defined in `./dictionaryPanelContext` (not here) so this file only exports
// components — lets any column header (deep inside DataTable) and the header's "Data
// dictionary" button (a sibling in App.tsx's Header slot) open the same panel without
// prop-drilling a callback through columns.tsx/getColumnsForTab's otherwise-pure,
// module-stable column-def builders.

type PanelState = { field: keyof EthRecord } | { field: undefined } | null

interface DictionaryPanelProviderProps {
  /** The full loaded dataset — live stats are always computed against it, independent of
   *  the active tab/filter state, so a field's numbers don't change depending on which tab
   *  happened to be open when its ⓘ was clicked. */
  records: EthRecord[]
  children: ReactNode
}

export function DictionaryPanelProvider({ records, children }: DictionaryPanelProviderProps) {
  const [state, setState] = useState<PanelState>(null)
  // Captures whichever element was focused (i.e. the trigger just clicked) at open time, so
  // Esc/backdrop/× can restore focus to it on close — same pattern as Task 9's filter
  // popover and export menu, generalized here since there are 35+ possible openers.
  const triggerRef = useRef<HTMLElement | null>(null)

  const openField = useCallback((field: keyof EthRecord) => {
    triggerRef.current = document.activeElement as HTMLElement | null
    setState({ field })
  }, [])
  const openFull = useCallback(() => {
    triggerRef.current = document.activeElement as HTMLElement | null
    setState({ field: undefined })
  }, [])
  const close = useCallback(() => {
    setState(null)
    triggerRef.current?.focus()
    triggerRef.current = null
  }, [])

  const value = useMemo(() => ({ openField, openFull }), [openField, openFull])

  return (
    <DictionaryPanelContext.Provider value={value}>
      {children}
      {state && <DictionaryPanel records={records} field={state.field} onClose={close} />}
    </DictionaryPanelContext.Provider>
  )
}

/** "Data dictionary" button — lives in the header's actions slot (App.tsx), opens full mode. */
export function DictionaryButton() {
  const { openFull } = useDictionaryPanel()
  return (
    <button type="button" className="dictionary-button" onClick={openFull}>
      <BookIcon />
      Data dictionary
    </button>
  )
}

/** Info trigger planted at the left edge of every column header (columns.tsx) — opens single-column mode for `field`. */
export function DictionaryInfoTrigger({ field, label }: { field: keyof EthRecord; label: string }) {
  const { openField } = useDictionaryPanel()
  return (
    <button
      type="button"
      className="col-header__info"
      aria-label={`About ${label}`}
      title={`About ${label}`}
      onClick={(e) => {
        // Sits inside the same header-cell flex row as the sort button and filter trigger —
        // stop the click from doing anything else those siblings listen for.
        e.stopPropagation()
        openField(field)
      }}
    >
      <InfoIcon />
    </button>
  )
}

/** Stroke-drawn ⓘ matching FilterControls' FunnelIcon weight — replaces the old text glyph,
 *  which rendered at inconsistent sizes/baselines across platforms' fallback fonts. */
function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.4v3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
    </svg>
  )
}

// ---------- the panel itself ----------

interface DictionaryPanelProps {
  records: EthRecord[]
  /** Set → single-column mode for this field. Unset → full mode, all 35 fields. */
  field?: keyof EthRecord
  onClose: () => void
}

const SOURCE_LABELS: Record<ColumnMeta['source'], string> = {
  token_transfers: 'Token Transfers',
  transactions: 'Transactions',
  both: 'Both',
  derived: 'Derived',
}

// token_transfers → accent, transactions → positive, both/derived → muted, per the brief.
const SOURCE_BADGE_CLASS: Record<ColumnMeta['source'], string> = {
  token_transfers: 'source-badge--accent',
  transactions: 'source-badge--positive',
  both: 'source-badge--muted',
  derived: 'source-badge--muted',
}

// Section display order lives in sourceFilter.ts (ALL_SOURCES) — FullDictionary renders
// whatever `visibleSources(filter)` returns, which is that full order when unfiltered.

function SourceBadge({ source }: { source: ColumnMeta['source'] }) {
  return <span className={`source-badge ${SOURCE_BADGE_CLASS[source]}`}>{SOURCE_LABELS[source]}</span>
}

/**
 * `computeColumnStats`'s min/max are always the field's raw stored value (wei, for the
 * five wei-scale fields) — reusing `RowDetail`'s own `HUMAN_UNIT` field→unit map (rather
 * than duplicating it) to convert that raw stat display-side, the same way the table's
 * Gas Price/Value ETH columns and `RowDetail`'s own raw+human rendering already do.
 * Returns `null` for fields with no display unit (`HUMAN_UNIT` doesn't cover them), so the
 * caller falls back to showing the raw value un-annotated.
 */
function convertStatValue(field: keyof EthRecord, raw: string): { value: string; unit: string } | null {
  const unit = HUMAN_UNIT[field]
  if (!unit) return null
  const converted = unit === 'ETH' ? weiToEth(raw) : unit === 'Gwei' ? weiToGwei(raw) : null
  return converted != null ? { value: converted, unit } : null
}

/** Min/Max stat row: unit-converted value + unit label when the field has a display unit
 *  (e.g. "0.0586 Gwei"), with the raw stored value always kept available via `title` and a
 *  faint secondary line — consistent with `RowDetail`'s raw-primary/human-secondary pattern,
 *  just with the roles swapped (converted value leads here, since a bare "58631115" reads as
 *  meaningless without the Gwei scale a stats summary is meant to convey at a glance). */
function StatValue({ field, raw }: { field: keyof EthRecord; raw: string }) {
  const converted = convertStatValue(field, raw)
  if (!converted) {
    return <span className="dictionary-stat__value dictionary-stat__value--mono">{raw}</span>
  }
  return (
    <span className="dictionary-stat__value-group">
      <span className="dictionary-stat__value dictionary-stat__value--mono" title={`${raw} (raw)`}>
        {converted.value} {converted.unit}
      </span>
      <span className="dictionary-stat__value-raw">raw: {raw}</span>
    </span>
  )
}

function FillBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  return (
    <div className="fill-bar" role="img" aria-label={`${pct}% filled`}>
      <span className="fill-bar__track">
        <span className="fill-bar__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="fill-bar__pct">{pct}%</span>
    </div>
  )
}

export function DictionaryPanel({ records, field, onClose }: DictionaryPanelProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Focus trap: aria-modal promises AT the background is inert, so keyboard focus must
      // not tab out into it either — wrap at the panel's first/last focusable element.
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = panelRef.current.contains(active)
      if (e.shiftKey) {
        if (active === first || !inside) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !inside) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const meta = field ? getColumnMeta(field) : undefined
  const title = field ? (meta?.label ?? String(field)) : 'Data dictionary'

  return (
    <div className="dictionary-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="dictionary-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dictionary-panel__header">
          <h2 className="dictionary-panel__title">{title}</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="dictionary-panel__close"
            aria-label="Close data dictionary"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="dictionary-panel__body">
          {field && meta ? (
            <FieldDetail field={field} meta={meta} records={records} />
          ) : (
            <FullDictionary records={records} />
          )}
        </div>
      </div>
    </div>
  )
}

function FieldDetail({ field, meta, records }: { field: keyof EthRecord; meta: ColumnMeta; records: EthRecord[] }) {
  const stats = computeColumnStats(records, field)
  return (
    <div className="dictionary-field">
      <div className="dictionary-field__meta-row">
        <SourceBadge source={meta.source} />
        <span className="dictionary-field__kind">{meta.kind}</span>
      </div>
      <p className="dictionary-field__description">{meta.description}</p>
      <code className="dictionary-field__name">{field}</code>

      <dl className="dictionary-stats">
        <div className="dictionary-stat">
          <dt className="dictionary-stat__label">Fill rate</dt>
          <dd className="dictionary-stat__value">
            <FillBar value={stats.fillRate} />
          </dd>
        </div>
        <div className="dictionary-stat">
          <dt className="dictionary-stat__label">Distinct values</dt>
          <dd className="dictionary-stat__value dictionary-stat__value--mono">
            {stats.distinct.toLocaleString('en-US')}
          </dd>
        </div>
        {stats.min != null && (
          <div className="dictionary-stat">
            <dt className="dictionary-stat__label">Min</dt>
            <dd>
              <StatValue field={field} raw={stats.min} />
            </dd>
          </div>
        )}
        {stats.max != null && (
          <div className="dictionary-stat">
            <dt className="dictionary-stat__label">Max</dt>
            <dd>
              <StatValue field={field} raw={stats.max} />
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

// The three filter buttons, in on-screen order. Labels reuse SOURCE_LABELS so the buttons
// speak the same vocabulary as the section badges they filter.
const SOURCE_FILTERS: SourceFilter[] = ['both', 'token_transfers', 'transactions']

function FullDictionary({ records }: { records: EthRecord[] }) {
  // Toggle semantics: clicking the active filter deselects it (back to all sections),
  // so `null` — not a fourth "All" button — is the unfiltered state.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter | null>(null)
  // 35 fields × a full-dataset scan each — worth memoizing so re-renders of the open panel
  // (e.g. parent state changes) don't recompute every column's stats from scratch.
  const statsByField = useMemo(
    () => new Map(COLUMNS.map((c) => [c.field, computeColumnStats(records, c.field)])),
    [records],
  )
  return (
    <div className="dictionary-full">
      <div className="dictionary-filter" role="group" aria-label="Filter fields by source">
        {SOURCE_FILTERS.map((f) => {
          const active = sourceFilter === f
          return (
            <button
              key={f}
              type="button"
              className={`dictionary-filter__btn${active ? ' dictionary-filter__btn--active' : ''}`}
              aria-pressed={active}
              onClick={() => setSourceFilter(active ? null : f)}
            >
              {SOURCE_LABELS[f]}
            </button>
          )
        })}
      </div>
      {visibleSources(sourceFilter).map((source) => {
        const fields = COLUMNS.filter((c) => c.source === source)
        if (fields.length === 0) return null
        return (
          <section key={source} className="dictionary-group">
            <div className="dictionary-group__header">
              <SourceBadge source={source} />
              <span className="dictionary-group__count">{fields.length} fields</span>
            </div>
            <ul className="dictionary-group__list">
              {fields.map((c) => {
                const stats = statsByField.get(c.field) ?? computeColumnStats(records, c.field)
                return (
                  <li key={c.field} className="dictionary-entry">
                    <div className="dictionary-entry__row">
                      <span className="dictionary-entry__label">{c.label}</span>
                      <code className="dictionary-entry__field">{c.field}</code>
                    </div>
                    <p className="dictionary-entry__description">{c.description}</p>
                    <FillBar value={stats.fillRate} />
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function BookIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.2c1.6-.6 3.4-.6 5 0v9.6c-1.6-.6-3.4-.6-5 0V3.2zM13.5 3.2c-1.6-.6-3.4-.6-5 0v9.6c1.6-.6 3.4-.6 5 0V3.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

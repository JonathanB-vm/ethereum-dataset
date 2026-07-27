import { useEffect, useId, useState } from 'react'
import type { Column } from '@tanstack/react-table'
import type { EthRecord } from '../../data/types'
import type { ColumnMeta } from '../../data/dictionary'
import { FilterPopover } from './FilterPopover'
import { enumDisplayValue, type RangeFilterValue } from './filters'
import { decimalToWei, toBigInt } from '../../data/transform'

/**
 * A column whose cells are displayed in a converted unit. `decimals` is the exponent that
 * converts a typed bound back to the stored wei value — the same number `decimalRangeFilterFn`
 * uses in filters.ts, kept here so the label and the validation can never disagree about
 * which unit a bound is in.
 */
export interface RangeUnit {
  /** Shown in the input labels, e.g. "ETH". */
  label: string
  /** 18 for ETH, 9 for Gwei. */
  decimals: number
}

interface FilterControlsProps {
  column: Column<EthRecord, unknown>
  kind: ColumnMeta['kind']
  label: string
  /** Only set for the two columns whose filterFn is 'rangeEth'/'rangeGwei' (columns.tsx). */
  rangeUnit?: RangeUnit
}

const DEBOUNCE_MS = 250

function isFilterActive(kind: ColumnMeta['kind'], value: unknown): boolean {
  if (kind === 'number' || kind === 'bignum') {
    const range = value as RangeFilterValue | undefined
    return !!(range && (range.min?.trim() || range.max?.trim()))
  }
  if (kind === 'enum' || kind === 'boolean') {
    return Array.isArray(value) && value.length > 0
  }
  return typeof value === 'string' && value !== ''
}

/**
 * Per-column filter panel. Which panel renders is driven entirely by the column's
 * dictionary `kind` (see columns.tsx `filterFnForKind`) — the same axis that chose the
 * registered TanStack filterFn, so the control offered always matches the comparison
 * actually run. The funnel, popover and dismissal behavior live in FilterPopover.
 */
export function FilterControls({ column, kind, label, rangeUnit }: FilterControlsProps) {
  const isActive = isFilterActive(kind, column.getFilterValue())
  return (
    <FilterPopover label={label} isActive={isActive}>
      {kind === 'number' || kind === 'bignum' ? (
        <RangePanel column={column} unit={rangeUnit} />
      ) : kind === 'enum' || kind === 'boolean' ? (
        <EnumPanel column={column} />
      ) : (
        <TextPanel column={column} />
      )}
    </FilterPopover>
  )
}

function TextPanel({ column }: { column: Column<EthRecord, unknown> }) {
  const [text, setText] = useState(() => (column.getFilterValue() as string | undefined) ?? '')

  useEffect(() => {
    const t = window.setTimeout(() => {
      column.setFilterValue(text === '' ? undefined : text)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  return (
    <label className="filter-popover__field">
      <span className="filter-popover__label">Contains</span>
      <input
        type="text"
        className="filter-popover__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. 0xabc…"
        autoFocus
      />
    </label>
  )
}

/**
 * A typed bound as a comparable integer, using exactly the conversion the registered
 * filterFn will use: raw integer parsing for `'range'` columns, decimal-to-wei for the
 * `'rangeEth'`/`'rangeGwei'` ones. Null means "this text is not a number".
 */
function boundToComparable(raw: string, decimals: number | null): bigint | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (decimals == null) return toBigInt(trimmed)
  const wei = decimalToWei(trimmed, decimals)
  return wei == null ? null : BigInt(wei)
}

/** `unit`, when set, labels the inputs so a typed bound's unit is never a guess, and supplies the decimals its validation uses — see RangeUnit. */
function RangePanel({ column, unit }: { column: Column<EthRecord, unknown>; unit?: RangeUnit }) {
  const initial = (column.getFilterValue() as RangeFilterValue | undefined) ?? {}
  const [min, setMin] = useState(initial.min ?? '')
  const [max, setMax] = useState(initial.max ?? '')
  const [minError, setMinError] = useState<string | null>(null)
  const [maxError, setMaxError] = useState<string | null>(null)
  const errorIdBase = useId()
  const unitSuffix = unit ? ` (${unit.label})` : ''
  const decimals = unit?.decimals ?? null

  useEffect(() => {
    const t = window.setTimeout(() => {
      // Validation rides this debounce rather than running per keystroke: a bound is
      // half-typed for most of its life, and flagging "0." as an error mid-decimal would
      // punish normal typing.
      const minValue = min.trim() === '' ? null : boundToComparable(min, decimals)
      const maxValue = max.trim() === '' ? null : boundToComparable(max, decimals)
      const minInvalid = min.trim() !== '' && minValue == null
      const maxInvalid = max.trim() !== '' && maxValue == null

      const next: RangeFilterValue = {}
      // An unparseable bound is left OUT of the filter value, so a chip can never read
      // `≥ abc`. `rangeFilter` would have ignored it anyway — the difference is that the
      // message below now says why nothing happened.
      if (!minInvalid && min.trim() !== '') next.min = min.trim()
      if (!maxInvalid && max.trim() !== '') next.max = max.trim()

      const reversed = minValue != null && maxValue != null && minValue > maxValue
      setMinError(minInvalid ? 'Not a number' : reversed ? 'Min is greater than Max' : null)
      setMaxError(maxInvalid ? 'Not a number' : null)

      column.setFilterValue(next.min == null && next.max == null ? undefined : next)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, decimals])

  const minErrorId = `${errorIdBase}-min`
  const maxErrorId = `${errorIdBase}-max`
  // Explicit htmlFor/id association rather than the usual implicit label-wraps-input: with
  // an implicit wrap, the error <span> would have to live inside the same <label> to sit
  // beneath the input, which folds the error text into the label's accessible name the
  // moment it renders (assistive tech — and getByLabelText — would read "Min Not a
  // number" instead of "Min"). Explicit association keeps the label's name exactly the
  // unit text no matter what else is in the field.
  const minInputId = `${errorIdBase}-min-input`
  const maxInputId = `${errorIdBase}-max-input`

  return (
    <div className="filter-popover__range">
      <div className="filter-popover__field">
        <label htmlFor={minInputId} className="filter-popover__label">
          Min{unitSuffix}
        </label>
        <input
          id={minInputId}
          type="text"
          inputMode={unit ? 'decimal' : 'numeric'}
          className={`filter-popover__input filter-popover__input--mono${
            minError ? ' filter-popover__input--invalid' : ''
          }`}
          value={min}
          onChange={(e) => setMin(e.target.value)}
          placeholder="0"
          aria-invalid={minError ? true : undefined}
          aria-describedby={minError ? minErrorId : undefined}
          autoFocus
        />
        {minError && (
          <span id={minErrorId} className="filter-popover__error">
            {minError}
          </span>
        )}
      </div>
      <div className="filter-popover__field">
        <label htmlFor={maxInputId} className="filter-popover__label">
          Max{unitSuffix}
        </label>
        <input
          id={maxInputId}
          type="text"
          inputMode={unit ? 'decimal' : 'numeric'}
          className={`filter-popover__input filter-popover__input--mono${
            maxError ? ' filter-popover__input--invalid' : ''
          }`}
          value={max}
          onChange={(e) => setMax(e.target.value)}
          placeholder="max"
          aria-invalid={maxError ? true : undefined}
          aria-describedby={maxError ? maxErrorId : undefined}
        />
        {maxError && (
          <span id={maxErrorId} className="filter-popover__error">
            {maxError}
          </span>
        )}
      </div>
    </div>
  )
}

function EnumPanel({ column }: { column: Column<EthRecord, unknown> }) {
  // Faceted unique values (built off the pre-filtered-by-this-column row model, via
  // `getFacetedUniqueValues` wired in DataTable.tsx) is exactly "distinct observed values
  // with counts" — no manual scan of `records` needed here.
  const facets = column.getFacetedUniqueValues()
  const selected = (column.getFilterValue() as string[] | undefined) ?? []

  const options = Array.from(facets.entries())
    .filter(([value]) => value != null && value !== '')
    .map(([value, count]) => ({
      display: enumDisplayValue(value as string | number | boolean),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))

  function toggle(display: string) {
    const next = selected.includes(display) ? selected.filter((v) => v !== display) : [...selected, display]
    column.setFilterValue(next.length === 0 ? undefined : next)
  }

  if (options.length === 0) {
    return <p className="filter-popover__empty">No values to filter on</p>
  }

  return (
    <ul className="filter-popover__list">
      {options.map((opt) => (
        <li key={opt.display}>
          <label className="filter-popover__checkbox">
            <input type="checkbox" checked={selected.includes(opt.display)} onChange={() => toggle(opt.display)} />
            <span className="filter-popover__checkbox-label">{opt.display}</span>
            <span className="filter-popover__checkbox-count">{opt.count.toLocaleString('en-US')}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

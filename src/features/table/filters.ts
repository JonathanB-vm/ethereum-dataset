import type { FilterFn } from '@tanstack/react-table'
import { LOADED_COLUMNS } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { decimalToWei, isValidDecimals, toBigInt } from '../../data/transform'

/** Per-column min/max filter state ({} or all-undefined means "no bound set"). */
export interface RangeFilterValue {
  min?: string
  max?: string
}

/**
 * `kind: 'hex' | 'address' | 'text'` columns — plain case-insensitive substring match.
 * An empty query is "no filter", so it passes everything (including a null cell).
 */
export function textFilter(value: string | null | undefined, query: string): boolean {
  if (query === '') return true
  if (value == null) return false
  return value.toLowerCase().includes(query.toLowerCase())
}

/**
 * `kind: 'number' | 'bignum'` columns — min/max bounds, both optional and independently
 * usable. Compares via `toBigInt` (never `Number`/`parseFloat`): these BigQuery numeric
 * strings carry up to 256-bit precision (e.g. `value_lossless_tx`), well past what an IEEE
 * double can represent exactly, so a float-based compare would silently misorder values
 * near the top of the range.
 */
export function rangeFilter(rawValue: string | number | null, range: RangeFilterValue): boolean {
  const minStr = range.min?.trim()
  const maxStr = range.max?.trim()
  const minB = minStr ? toBigInt(minStr) : null
  const maxB = maxStr ? toBigInt(maxStr) : null
  // Bounds the user typed but that don't parse as an integer (garbage input, still being
  // typed, …) are treated as not-yet-set rather than rejecting every row.
  if (minB == null && maxB == null) return true

  const value = toBigInt(typeof rawValue === 'number' ? String(rawValue) : rawValue)
  if (value == null) return false
  if (minB != null && value < minB) return false
  if (maxB != null && value > maxB) return false
  return true
}

/**
 * Range filter for the derived Normalized Quantity column. Bounds are typed in *token units*
 * — "≥ 1" means one whole token — but each row is stored at its own contract's scale, so the
 * bound is converted per row via that row's `decimals` before the ordinary BigInt comparison.
 * A single fixed exponent (the `rangeEth`/`rangeGwei` approach) cannot work here: the unit
 * genuinely differs from row to row.
 *
 * A row whose decimals are unknown fails any set bound — it has no normalized value to
 * compare, the same reason `rangeFilter` rejects a null cell.
 */
export function normalizedRangeFilter(
  quantity: string | null,
  decimals: number | null,
  range: RangeFilterValue,
): boolean {
  const minStr = range.min?.trim()
  const maxStr = range.max?.trim()
  if (!minStr && !maxStr) return true
  if (!isValidDecimals(decimals) || quantity == null) return false
  const min = minStr ? (decimalToWei(minStr, decimals) ?? undefined) : undefined
  const max = maxStr ? (decimalToWei(maxStr, decimals) ?? undefined) : undefined
  return rangeFilter(quantity, { min, max })
}

/** Canonical string form a raw cell value is compared against in an enum/boolean checkbox filter. */
export function enumDisplayValue(value: string | number | boolean | null): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/**
 * `kind: 'enum' | 'boolean'` columns — checkbox multi-select. `selected` holds the
 * canonical (`enumDisplayValue`) form of each checked option; an empty selection is "no
 * filter" and passes everything.
 */
export function enumFilter(selected: string[], value: string | number | boolean | null): boolean {
  if (selected.length === 0) return true
  if (value == null) return false
  return selected.includes(enumDisplayValue(value))
}

const ALL_FIELDS = LOADED_COLUMNS.map((c) => c.field)

/**
 * Global search — case-insensitive substring match across all 34 loaded dictionary fields
 * of a record, regardless of which columns the active tab happens to display.
 */
export function globalFilterFn(record: EthRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  for (const field of ALL_FIELDS) {
    const v = record[field]
    if (v == null) continue
    if (String(v).toLowerCase().includes(q)) return true
  }
  return false
}

/**
 * `value_lossless_tx` ("Value ETH") and `gas_price_tx` ("Gas Price Gwei") store raw wei
 * but are *displayed* converted to ETH / Gwei — so their filter bounds have to be typed
 * (and compared) in that same display unit, not raw wei, or "≥ 50" would silently mean
 * "≥ 50 wei" (a no-op) instead of "≥ 50 ETH"/"≥ 50 Gwei". This converts the user-typed
 * decimal bound to wei via `decimalToWei` before delegating to `rangeFilter`'s ordinary
 * (already-wei-scale, BigInt-safe) comparison — an unparseable/empty bound converts to
 * `undefined`, which `rangeFilter` already treats as "not set" rather than rejecting every
 * row, so a bound that's still mid-typing (e.g. a lone "0.") doesn't hide the whole column.
 */
function decimalRangeFilterFn(decimals: number): FilterFn<EthRecord> {
  return (row, columnId, filterValue: RangeFilterValue | undefined) => {
    const range = filterValue ?? {}
    const min = range.min?.trim() ? (decimalToWei(range.min, decimals) ?? undefined) : undefined
    const max = range.max?.trim() ? (decimalToWei(range.max, decimals) ?? undefined) : undefined
    return rangeFilter(row.getValue(columnId), { min, max })
  }
}

// TanStack Table's filter-fn registry is an empty interface consumers augment by
// declaration merging (same pattern as `SortingFns` in columns.tsx) — this is what lets
// column defs reference these filters by the string keys `'text'` / `'range'` /
// `'enumMulti'` / `'rangeEth'` / `'rangeGwei'` instead of importing the function itself.
declare module '@tanstack/table-core' {
  interface FilterFns {
    text: FilterFn<EthRecord>
    range: FilterFn<EthRecord>
    enumMulti: FilterFn<EthRecord>
    /** `value_lossless_tx` only — bounds typed in ETH, compared in wei. */
    rangeEth: FilterFn<EthRecord>
    /** `gas_price_tx` only — bounds typed in Gwei, compared in wei. */
    rangeGwei: FilterFn<EthRecord>
  }
}

/** Adapts the pure, TanStack-agnostic filter functions above to TanStack's `(row, columnId, filterValue)` shape. */
export const customFilterFns = {
  text: (row, columnId, filterValue: string) => textFilter(row.getValue(columnId), filterValue),
  range: (row, columnId, filterValue: RangeFilterValue) => rangeFilter(row.getValue(columnId), filterValue),
  enumMulti: (row, columnId, filterValue: string[]) => enumFilter(filterValue, row.getValue(columnId)),
  rangeEth: decimalRangeFilterFn(18),
  rangeGwei: decimalRangeFilterFn(9),
} satisfies Record<string, FilterFn<EthRecord>>

/** Registered as the table's `globalFilterFn` option — operates on the whole record, not just the column TanStack happens to be iterating. */
export const tableGlobalFilterFn: FilterFn<EthRecord> = (row, _columnId, filterValue) =>
  globalFilterFn(row.original, String(filterValue ?? ''))

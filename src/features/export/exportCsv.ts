import Papa from 'papaparse'
import type { EthRecord } from '../../data/types'

/**
 * Cell → CSV string. Every BigQuery numeric field on `EthRecord` is already a plain
 * `string` (never parsed into a `number`/`bigint` upstream, precisely so it can round-trip
 * losslessly) — this only ever does `String(v)` on it, never a numeric conversion, so
 * 256-bit values like `value_lossless_tx` come out byte-for-byte identical to the source.
 */
function cellValue(record: EthRecord, field: string): string {
  const v = record[field as keyof EthRecord]
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * Resolvers for columns that exist on screen but not on the record — currently only
 * `normalized_quantity`, which is computed from `quantity` and a token-decimals lookup.
 * Keyed by column id, which is what `getVisibleLeafColumns()` reports.
 */
export type DerivedCells = Record<string, (record: EthRecord) => string>

/**
 * Pure CSV builder — no DOM, no side effects. Header row is the raw field list (matching
 * the source dataset's own column names, so the export re-imports cleanly), one row per
 * record in `fields` order. `Papa.unparse` handles quoting/escaping (commas, quotes,
 * newlines — e.g. `event_signature` values like `Transfer(address,address,uint256)`).
 *
 * A field with a `derived` resolver takes its value from that resolver instead of the
 * record. Derived values are written at full precision with no display formatting, for the
 * same round-trip reason as the raw columns.
 */
export function buildCsv(rows: EthRecord[], fields: string[], derived?: DerivedCells): string {
  const data = rows.map((row) =>
    fields.map((field) => derived?.[field]?.(row) ?? cellValue(row, field)),
  )
  return Papa.unparse({ fields, data })
}

/** Triggers a browser file download of `csv` via a throwaway Blob URL + anchor click. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

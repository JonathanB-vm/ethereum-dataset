import Papa from 'papaparse'
import type { EthRecord } from '../../data/types'

/**
 * Cell → CSV string. Every BigQuery numeric field on `EthRecord` is already a plain
 * `string` (never parsed into a `number`/`bigint` upstream, precisely so it can round-trip
 * losslessly) — this only ever does `String(v)` on it, never a numeric conversion, so
 * 256-bit values like `value_lossless_tx` come out byte-for-byte identical to the source.
 */
function cellValue(record: EthRecord, field: keyof EthRecord): string {
  const v = record[field]
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * Pure CSV builder — no DOM, no side effects. Header row is the raw field list (matching
 * the source dataset's own column names, so the export re-imports cleanly), one row per
 * record in `fields` order. `Papa.unparse` handles quoting/escaping (commas, quotes,
 * newlines — e.g. `event_signature` values like `Transfer(address,address,uint256)`).
 */
export function buildCsv(rows: EthRecord[], fields: (keyof EthRecord)[]): string {
  const data = rows.map((row) => fields.map((field) => cellValue(row, field)))
  return Papa.unparse({ fields: fields as string[], data })
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

import { getColumnMeta } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { compareNumericStrings } from '../../data/transform'

export interface ColumnStats {
  /** Fraction (0..1) of records where this field is non-null. */
  fillRate: number
  /** Count of distinct non-null values observed. */
  distinct: number
  /** Only set for `number`/`bignum` kind fields with at least one non-null value. */
  min?: string
  /** Only set for `number`/`bignum` kind fields with at least one non-null value. */
  max?: string
}

/**
 * Pure, live stats for a single dictionary field over a set of records — powers
 * `DictionaryPanel`'s single-column and full modes. `field` is looked up against the
 * dictionary (`getColumnMeta`) purely to decide whether min/max apply; fill rate and
 * distinct count are computed for every field regardless of `kind`.
 *
 * min/max use `compareNumericStrings` (BigInt-based, never `Number`/`parseFloat`) so a
 * 256-bit value like `value_lossless_tx` orders correctly and `'9' < '10'` numerically
 * rather than lexicographically.
 */
export function computeColumnStats(records: EthRecord[], field: keyof EthRecord): ColumnStats {
  const total = records.length
  const distinctValues = new Set<string>()
  const numericValues: string[] = []
  let nonNullCount = 0

  for (const record of records) {
    const value = record[field]
    if (value == null) continue
    nonNullCount++
    const str = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
    distinctValues.add(str)
    numericValues.push(str)
  }

  const stats: ColumnStats = {
    fillRate: total === 0 ? 0 : nonNullCount / total,
    distinct: distinctValues.size,
  }

  const meta = getColumnMeta(field as string)
  const isNumericKind = meta?.kind === 'number' || meta?.kind === 'bignum'
  if (isNumericKind && numericValues.length > 0) {
    let min = numericValues[0]
    let max = numericValues[0]
    for (const v of numericValues) {
      if (compareNumericStrings(v, min) < 0) min = v
      if (compareNumericStrings(v, max) > 0) max = v
    }
    stats.min = min
    stats.max = max
  }

  return stats
}

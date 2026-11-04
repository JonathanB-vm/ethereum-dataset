import { VARIABLES } from '../../registry/registry'
import { decodeMaybeGzipped } from './gzip'
import type { EthRecord } from './types'

/**
 * Research-variable values for the loaded rows, read from
 * `public/data/variable-values.json.gz` (written by `npm run data:variables`).
 *
 * Values are per transaction, so every row of a transaction (each of its transfers, or
 * its single plain row) reads the same value. `null` means "not computed for this
 * transaction", which the table renders as a dash, never as 0.
 */
export interface VariableValues {
  get(id: string, record: Pick<EthRecord, 'block_number' | 'transaction_index'>): number | null
  /** Transactions covered. 0 for the empty lookup. */
  readonly size: number
}

// (block, index) packed into one number: blocks fit in 32 bits and indexes in 16, so the
// key stays well under 2^53. A number key keeps the Map lookup off the string-hash path,
// which matters at one lookup per cell per sort comparison.
const keyOf = (block: number, txIndex: number) => block * 65_536 + txIndex

export const EMPTY_VARIABLE_VALUES: VariableValues = { get: () => null, size: 0 }

/**
 * Total parser: never throws. A malformed payload yields the empty lookup, and a variable
 * whose arrays are the wrong length — or whose version no longer matches the registry,
 * meaning its formula changed after the values were computed — is dropped rather than
 * shown with values that might belong to a different rule.
 */
export function parseVariableValues(json: unknown): VariableValues {
  if (typeof json !== 'object' || json === null) return EMPTY_VARIABLE_VALUES
  const { blocks, txIndexes, values, versions } = json as {
    blocks?: unknown
    txIndexes?: unknown
    values?: unknown
    versions?: unknown
  }
  if (!Array.isArray(blocks) || !Array.isArray(txIndexes) || blocks.length !== txIndexes.length) {
    return EMPTY_VARIABLE_VALUES
  }
  if (typeof values !== 'object' || values === null) return EMPTY_VARIABLE_VALUES
  const versionOf = (typeof versions === 'object' && versions !== null ? versions : {}) as Record<string, unknown>

  const index = new Map<number, number>()
  for (let i = 0; i < blocks.length; i++) index.set(keyOf(Number(blocks[i]), Number(txIndexes[i])), i)

  const columns = new Map<string, unknown[]>()
  for (const v of VARIABLES) {
    const column = (values as Record<string, unknown>)[v.id]
    if (!Array.isArray(column) || column.length !== blocks.length) continue
    if (versionOf[v.id] !== v.version) continue
    columns.set(v.id, column)
  }

  return {
    size: blocks.length,
    get(id, record) {
      const column = columns.get(id)
      if (column === undefined) return null
      const i = index.get(keyOf(record.block_number, record.transaction_index))
      if (i === undefined) return null
      const value = column[i]
      return typeof value === 'number' ? value : null
    },
  }
}

/**
 * Fetches the values artifact. Like the token registry, an enhancement rather than a
 * dependency: every failure resolves to the empty lookup, so a missing file costs the
 * variable columns their values and nothing else.
 */
export function variableValuesProvider(url = '/data/variable-values.json.gz') {
  return {
    async load(): Promise<VariableValues> {
      try {
        const res = await fetch(url)
        if (!res.ok) return EMPTY_VARIABLE_VALUES
        const text = await decodeMaybeGzipped(new Uint8Array(await res.arrayBuffer()))
        return parseVariableValues(JSON.parse(text))
      } catch {
        return EMPTY_VARIABLE_VALUES
      }
    },
  }
}

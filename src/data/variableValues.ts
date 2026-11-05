import {
  registerVariableColumns,
  VARIABLE_COLUMNS,
  variableColumnMeta,
  type ColumnMeta,
  type VariableDefinitionLike,
} from './dictionary'
import { decodeMaybeGzipped } from './gzip'
import type { EthRecord } from './types'

/**
 * Research-variable values for the loaded rows, read from
 * `public/data/variable-values.json.gz` (written by `npm run data:variables`) or, with an
 * API, from `/v1/variables/values` — the same columnar shape either way.
 *
 * Values are per transaction, so every row of a transaction (each of its transfers, or
 * its single plain row) reads the same value. `null` means "not computed for this
 * transaction", which the table renders as a dash, never as 0.
 */
export interface VariableValues {
  get(id: string, record: Pick<EthRecord, 'block_number' | 'transaction_index'>): number | null
  /** Transactions covered. 0 for the empty lookup. */
  readonly size: number
  /**
   * The variables to show, in order: the payload's own catalog when it carries one (an API
   * that knows about approved requests), otherwise the registry's.
   */
  readonly columns: ColumnMeta[]
}

// (block, index) packed into one number: blocks fit in 32 bits and indexes in 16, so the
// key stays well under 2^53. A number key keeps the Map lookup off the string-hash path,
// which matters at one lookup per cell per sort comparison.
const keyOf = (block: number, txIndex: number) => block * 65_536 + txIndex

export const EMPTY_VARIABLE_VALUES: VariableValues = { get: () => null, size: 0, columns: VARIABLE_COLUMNS }

const empty = (columns: ColumnMeta[]): VariableValues => ({ ...EMPTY_VARIABLE_VALUES, columns })

/** The payload's `variables` catalog as dictionary entries, or null if it has none usable. */
function catalogColumns(raw: unknown): ColumnMeta[] | null {
  if (!Array.isArray(raw)) return null
  const columns: ColumnMeta[] = []
  for (const v of raw as Partial<VariableDefinitionLike>[]) {
    if (typeof v?.id !== 'string' || typeof v.label !== 'string' || typeof v.version !== 'number') continue
    const createdBy = v.created_by && typeof v.created_by === 'object' ? v.created_by : { id: '', name: 'unknown' }
    columns.push(variableColumnMeta({ ...v, created_by: createdBy, created_at: v.created_at ?? '' } as VariableDefinitionLike))
  }
  return columns
}

/**
 * Total parser: never throws. A malformed payload yields the empty lookup, and a variable
 * whose arrays are the wrong length — or whose version no longer matches its definition,
 * meaning its formula changed after the values were computed — is dropped rather than
 * shown with values that might belong to a different rule.
 */
export function parseVariableValues(json: unknown): VariableValues {
  if (typeof json !== 'object' || json === null) return EMPTY_VARIABLE_VALUES
  const { blocks, txIndexes, values, versions, variables } = json as {
    blocks?: unknown
    txIndexes?: unknown
    values?: unknown
    versions?: unknown
    variables?: unknown
  }
  const live = catalogColumns(variables)
  if (live) registerVariableColumns(live)
  const columns = live ?? VARIABLE_COLUMNS

  if (!Array.isArray(blocks) || !Array.isArray(txIndexes) || blocks.length !== txIndexes.length) {
    return empty(columns)
  }
  if (typeof values !== 'object' || values === null) return empty(columns)
  const versionOf = (typeof versions === 'object' && versions !== null ? versions : {}) as Record<string, unknown>

  const index = new Map<number, number>()
  for (let i = 0; i < blocks.length; i++) index.set(keyOf(Number(blocks[i]), Number(txIndexes[i])), i)

  const byId = new Map<string, unknown[]>()
  for (const c of columns) {
    const column = (values as Record<string, unknown>)[c.field]
    if (!Array.isArray(column) || column.length !== blocks.length) continue
    if (versionOf[c.field] !== c.variable?.version) continue
    byId.set(c.field, column)
  }

  return {
    size: blocks.length,
    columns,
    get(id, record) {
      const column = byId.get(id)
      if (column === undefined) return null
      const i = index.get(keyOf(record.block_number, record.transaction_index))
      if (i === undefined) return null
      const value = column[i]
      return typeof value === 'number' ? value : null
    },
  }
}

/**
 * Fetches the values. Like the token registry, an enhancement rather than a dependency:
 * every failure resolves to the empty lookup, so a missing file costs the variable
 * columns their values and nothing else.
 */
export function variableValuesProvider(url = '/data/variable-values.json.gz') {
  return {
    async load(): Promise<VariableValues> {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (!res.ok) return EMPTY_VARIABLE_VALUES
        const text = await decodeMaybeGzipped(new Uint8Array(await res.arrayBuffer()))
        return parseVariableValues(JSON.parse(text))
      } catch {
        return EMPTY_VARIABLE_VALUES
      }
    },
  }
}

/**
 * The guided query builder behind the "Build" tab: a researcher's choices (which table,
 * what the value is, which conditions) become the SQL that computes the column.
 *
 * Pure, so every rule is unit-testable. The SQL it writes follows the request contract
 * (api/variableRequests.ts) — one SELECT returning block_number, transaction_index and
 * value over {block_from}/{block_to} — and is laid out for a human, because an admin reads
 * it before approving. Every typed value is validated and written as a literal of the
 * column's own kind, so a builder query is safe by construction; the server still checks
 * it like any other.
 */

import { decimalToWei } from '../../data/transform'

export type ColumnKind = 'number' | 'bignum' | 'address' | 'hash' | 'enum' | 'text' | 'bool' | 'datetime'

export interface SchemaColumn {
  name: string
  type: string
  kind: ColumnKind
  nullable: boolean
  description: string
  unit?: 'wei'
}

export interface SchemaTable {
  name: string
  label: string
  description: string
  columns: SchemaColumn[]
}

/** Which rows the value is computed from. Token transfers are combined per transaction. */
export type Source = 'transactions' | 'token_transfers'

/**
 * `flag`: 1 when the conditions match (for transfers: when any transfer matches), else 0.
 * `count`: matching transfers per transaction. `sum`: a column summed over matching
 * transfers. `column`: a transaction's own column value (0 where conditions don't match).
 */
export type Output = 'flag' | 'count' | 'sum' | 'column'

export type Operator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'empty' | 'not_empty' | 'is_true' | 'is_false'

/** Display unit for wei-denominated amounts. */
export type AmountUnit = 'eth' | 'gwei' | 'wei'

export interface Condition {
  id: string
  column: string
  op: Operator
  value: string
  unit: AmountUnit
}

export interface BuilderState {
  source: Source
  output: Output
  /** The column summed (`sum`) or read (`column`). */
  valueColumn: string
  valueUnit: AmountUnit
  match: 'all' | 'any'
  conditions: Condition[]
}

export const INITIAL_BUILDER: BuilderState = {
  source: 'transactions',
  output: 'flag',
  valueColumn: '',
  valueUnit: 'eth',
  match: 'all',
  conditions: [],
}

export const SOURCE_LABEL: Record<Source, string> = {
  transactions: 'Transactions',
  token_transfers: 'Token transfers',
}

export const OUTPUTS: Record<Source, { output: Output; label: string; hint: string }[]> = {
  transactions: [
    { output: 'flag', label: 'Yes / no flag', hint: '1 when the transaction matches the conditions, otherwise 0.' },
    { output: 'column', label: 'A column’s value', hint: 'The transaction’s own value of one column. Non-matching transactions get 0.' },
  ],
  token_transfers: [
    { output: 'flag', label: 'Yes / no flag', hint: '1 when any of the transaction’s transfers matches, otherwise 0.' },
    { output: 'count', label: 'Count', hint: 'How many of the transaction’s transfers match.' },
    { output: 'sum', label: 'Sum', hint: 'A column summed over the transaction’s matching transfers.' },
  ],
}

export const OPERATOR_LABEL: Record<Operator, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  empty: 'is empty',
  not_empty: 'is not empty',
  is_true: 'is true',
  is_false: 'is false',
}

const SQL_OP: Partial<Record<Operator, string>> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }

/** Operators that make sense for a column. */
export function operatorsFor(column: SchemaColumn): Operator[] {
  const ops: Operator[] = (() => {
    switch (column.kind) {
      case 'number':
      case 'bignum':
      case 'datetime':
        return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']
      case 'address':
      case 'hash':
        return ['eq', 'ne']
      case 'enum':
        return ['eq', 'ne']
      case 'text':
        return ['eq', 'ne', 'contains']
      case 'bool':
        return ['is_true', 'is_false']
    }
  })()
  return column.nullable ? [...ops, 'empty', 'not_empty'] : ops
}

/** Whether an operator takes a typed value. */
export const needsValue = (op: Operator) => !['empty', 'not_empty', 'is_true', 'is_false'].includes(op)

/** Columns a value can be read from or summed: numbers only. */
export function numericColumns(table: SchemaTable | undefined): SchemaColumn[] {
  return (table?.columns ?? []).filter((c) => c.kind === 'number' || c.kind === 'bignum')
}

const UNIT_DECIMALS: Record<AmountUnit, number> = { eth: 18, gwei: 9, wei: 0 }
const UNIT_LABEL: Record<AmountUnit, string> = { eth: 'ETH', gwei: 'Gwei', wei: 'wei' }

/** A ClickHouse string literal. */
export function sqlString(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The SQL comparison for one condition, or an error message explaining what is wrong. */
export function conditionSql(c: Condition, column: SchemaColumn | undefined): { sql: string } | { error: string } {
  if (!column) return { error: 'Choose a column for every condition.' }
  const col = column.name
  if (!operatorsFor(column).includes(c.op)) return { error: `“${OPERATOR_LABEL[c.op]}” doesn’t apply to ${col}.` }
  if (c.op === 'empty') return { sql: `${col} IS NULL` }
  if (c.op === 'not_empty') return { sql: `${col} IS NOT NULL` }
  if (c.op === 'is_true') return { sql: col }
  if (c.op === 'is_false') return { sql: `NOT ${col}` }

  const raw = c.value.trim()
  if (raw === '') return { error: `Enter a value for ${col}.` }
  const op = SQL_OP[c.op]

  switch (column.kind) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return { error: `${col} needs a number (got “${raw}”).` }
      return { sql: `${col} ${op} ${raw}` }
    }
    case 'bignum': {
      const decimals = column.unit === 'wei' ? UNIT_DECIMALS[c.unit] : 0
      const wei = decimalToWei(raw, decimals)
      if (wei === null || wei.startsWith('-')) {
        return { error: `${col} needs a non-negative ${column.unit === 'wei' ? 'amount' : 'whole number'} (got “${raw}”).` }
      }
      if (column.unit !== 'wei' && raw.includes('.')) return { error: `${col} needs a whole number (got “${raw}”).` }
      return { sql: `${col} ${op} toUInt256('${wei}')` }
    }
    case 'address':
    case 'hash': {
      const length = column.kind === 'address' ? 40 : 64
      const hex = raw.toLowerCase().replace(/^0x/, '')
      if (!new RegExp(`^[0-9a-f]{${length}}$`).test(hex)) {
        return { error: `${col} needs a 0x-prefixed ${column.kind === 'address' ? 'address (40 hex digits)' : 'hash (64 hex digits)'}.` }
      }
      return { sql: `${col} ${op} unhex('${hex}')` }
    }
    case 'datetime': {
      if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(raw)) {
        return { error: `${col} needs a UTC time like 2026-07-14 23:40:00.` }
      }
      return { sql: `${col} ${op} toDateTime(${sqlString(raw.length === 10 ? `${raw} 00:00:00` : raw)}, 'UTC')` }
    }
    case 'enum':
    case 'text':
      if (c.op === 'contains') return { sql: `position(${col}, ${sqlString(raw)}) > 0` }
      return { sql: `${col} ${op} ${sqlString(raw)}` }
    case 'bool':
      return { error: `${col} is true or false; pick “is true” or “is false”.` }
  }
}

export type BuildResult =
  | { ok: true; sql: string; valueType: 'flag' | 'number'; summary: string }
  | { ok: false; errors: string[] }

const RANGE = (prefix = '') =>
  `${prefix}block_number >= {block_from:UInt32}\n  AND ${prefix}block_number <= {block_to:UInt32}`

/** The value column read or summed, in the chosen unit for a wei amount. */
function valueExpr(column: SchemaColumn, unit: AmountUnit): string {
  const base = column.nullable ? `ifNull(${column.name}, 0)` : column.name
  const scale = column.unit === 'wei' && unit !== 'wei' ? ` / 1e${UNIT_DECIMALS[unit]}` : ''
  return `toFloat64(${base})${scale}`
}

/** Turns the builder's state into SQL, or every reason it can't yet. */
export function buildQuery(state: BuilderState, schema: SchemaTable[]): BuildResult {
  const table = schema.find((t) => t.name === state.source)
  if (!table) return { ok: false, errors: ['The table list hasn’t loaded yet.'] }
  const errors: string[] = []

  const allowed = OUTPUTS[state.source].map((o) => o.output)
  if (!allowed.includes(state.output)) errors.push('Choose what the value should be.')

  const conds: string[] = []
  for (const c of state.conditions) {
    const r = conditionSql(c, table.columns.find((col) => col.name === c.column))
    if ('error' in r) errors.push(r.error)
    else conds.push(r.sql)
  }
  if (state.output === 'flag' && state.conditions.length === 0) errors.push('Add at least one condition for a yes / no flag.')

  const valueColumn =
    state.output === 'sum' || state.output === 'column'
      ? numericColumns(table).find((c) => c.name === state.valueColumn)
      : undefined
  if ((state.output === 'sum' || state.output === 'column') && !valueColumn) errors.push('Choose the column to use as the value.')

  if (errors.length) return { ok: false, errors }

  const joiner = state.match === 'all' ? ' AND ' : ' OR '
  const cond = conds.length === 0 ? '' : conds.length === 1 ? conds[0] : conds.map((c) => `(${c})`).join(joiner)
  const valueType: 'flag' | 'number' = state.output === 'flag' ? 'flag' : 'number'
  const summary = describe(state, table, valueColumn)

  if (state.source === 'transactions') {
    const value =
      state.output === 'flag'
        ? `toUInt8(${cond})`
        : cond
          ? `if(${cond}, ${valueExpr(valueColumn!, state.valueUnit)}, 0)`
          : valueExpr(valueColumn!, state.valueUnit)
    return {
      ok: true,
      valueType,
      summary,
      sql: `SELECT\n    block_number,\n    transaction_index,\n    ${value} AS value\nFROM transactions\nWHERE ${RANGE()}`,
    }
  }

  // Token transfers: aggregated per transaction, then joined onto every transaction so a
  // transaction with no (matching) transfers gets 0 rather than no value at all.
  const agg = (() => {
    switch (state.output) {
      case 'flag':
        return `toUInt8(countIf(${cond}) > 0)`
      case 'count':
        return cond ? `countIf(${cond})` : 'count()'
      default:
        return cond
          ? `sumIf(${valueExpr(valueColumn!, state.valueUnit)}, ${cond})`
          : `sum(${valueExpr(valueColumn!, state.valueUnit)})`
    }
  })()
  return {
    ok: true,
    valueType,
    summary,
    sql:
      'SELECT\n' +
      '    t.block_number AS block_number,\n' +
      '    t.transaction_index AS transaction_index,\n' +
      '    ifNull(a.value, 0) AS value\n' +
      'FROM transactions AS t\n' +
      'LEFT JOIN\n' +
      '(\n' +
      `    SELECT block_number, transaction_index, ${agg} AS value\n` +
      '    FROM token_transfers\n' +
      `    WHERE ${RANGE().replace('\n  AND', '\n      AND')}\n` +
      '    GROUP BY block_number, transaction_index\n' +
      ') AS a\n' +
      '    ON t.block_number = a.block_number AND t.transaction_index = a.transaction_index\n' +
      `WHERE ${RANGE('t.')}`,
  }
}

/** The builder's query in plain words, for the researcher and the reviewing admin. */
export function describe(state: BuilderState, table: SchemaTable, valueColumn?: SchemaColumn): string {
  const phrase = (c: Condition) => {
    const col = table.columns.find((x) => x.name === c.column)
    const unit = col?.unit === 'wei' ? ` ${UNIT_LABEL[c.unit]}` : ''
    return needsValue(c.op) ? `${c.column} ${OPERATOR_LABEL[c.op]} ${c.value.trim()}${unit}` : `${c.column} ${OPERATOR_LABEL[c.op]}`
  }
  const conds = state.conditions.map(phrase).join(state.match === 'all' ? ' and ' : ' or ')
  const valueName = valueColumn
    ? `${valueColumn.name}${valueColumn.unit === 'wei' ? ` in ${UNIT_LABEL[state.valueUnit]}` : ''}`
    : ''
  if (state.source === 'transactions') {
    if (state.output === 'flag') return `1 if the transaction's ${conds}, otherwise 0.`
    return conds ? `The transaction's ${valueName} if its ${conds}, otherwise 0.` : `The transaction's ${valueName}.`
  }
  const where = conds ? ` where ${conds}` : ''
  if (state.output === 'flag') return `1 if any of the transaction's token transfers has ${conds}, otherwise 0.`
  if (state.output === 'count') return `Number of the transaction's token transfers${where}.`
  return `Sum of ${valueName} over the transaction's token transfers${where}.`
}

let nextId = 0
export function newCondition(column = ''): Condition {
  nextId += 1
  return { id: `c${nextId}`, column, op: 'eq', value: '', unit: 'eth' }
}

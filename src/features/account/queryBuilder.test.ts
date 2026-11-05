// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildSchema } from '../../../api/schemaCatalog'
import { checkQueryText } from '../../../api/variableRequests'
import {
  buildQuery,
  conditionSql,
  INITIAL_BUILDER,
  newCondition,
  operatorsFor,
  type BuilderState,
  type Condition,
  type SchemaColumn,
} from './queryBuilder'

// The live schema's real column types, as the API serves them.
const SCHEMA = buildSchema([
  { table: 'transactions', name: 'block_number', type: 'UInt32' },
  { table: 'transactions', name: 'transaction_index', type: 'UInt16' },
  { table: 'transactions', name: 'from_address', type: 'FixedString(20)' },
  { table: 'transactions', name: 'to_address', type: 'Nullable(FixedString(20))' },
  { table: 'transactions', name: 'value', type: 'UInt256' },
  { table: 'transactions', name: 'gas', type: 'UInt64' },
  { table: 'transactions', name: 'gas_price', type: 'UInt128' },
  { table: 'transactions', name: 'block_timestamp', type: 'DateTime' },
  { table: 'transactions', name: 'transaction_type', type: 'UInt8' },
  { table: 'token_transfers', name: 'block_number', type: 'UInt32' },
  { table: 'token_transfers', name: 'transaction_index', type: 'UInt16' },
  { table: 'token_transfers', name: 'address', type: 'FixedString(20)' },
  { table: 'token_transfers', name: 'event_type', type: 'LowCardinality(String)' },
  { table: 'token_transfers', name: 'quantity', type: 'UInt256' },
  { table: 'token_transfers', name: 'removed', type: 'Bool' },
])
const tx = (name: string) => SCHEMA[0].columns.find((c) => c.name === name) as SchemaColumn
const tt = (name: string) => SCHEMA[1].columns.find((c) => c.name === name) as SchemaColumn
const cond = (p: Partial<Condition>): Condition => ({ ...newCondition(), ...p })
const state = (p: Partial<BuilderState>): BuilderState => ({ ...INITIAL_BUILDER, ...p })
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

describe('conditionSql', () => {
  it('converts an ETH or Gwei amount to exact wei for a wei column', () => {
    expect(conditionSql(cond({ column: 'value', op: 'gt', value: '1.5', unit: 'eth' }), tx('value'))).toEqual({
      sql: "value > toUInt256('1500000000000000000')",
    })
    expect(conditionSql(cond({ column: 'gas_price', op: 'lte', value: '30', unit: 'gwei' }), tx('gas_price'))).toEqual({
      sql: "gas_price <= toUInt256('30000000000')",
    })
  })

  it('writes an address as binary, case-insensitively, and rejects a malformed one', () => {
    expect(conditionSql(cond({ column: 'address', op: 'eq', value: USDT }), tt('address'))).toEqual({
      sql: "address = unhex('dac17f958d2ee523a2206206994597c13d831ec7')",
    })
    expect(conditionSql(cond({ column: 'address', op: 'eq', value: '0x123' }), tt('address'))).toHaveProperty('error')
  })

  it('quotes text so a value can never break out of its literal', () => {
    expect(conditionSql(cond({ column: 'event_type', op: 'eq', value: "ERC-20' OR 1=1 --" }), tt('event_type'))).toEqual({
      sql: "event_type = 'ERC-20\\' OR 1=1 --'",
    })
  })

  it('rejects non-numbers for numeric columns and fractions for whole-number big columns', () => {
    expect(conditionSql(cond({ column: 'gas', op: 'gt', value: '1; DROP' }), tx('gas'))).toHaveProperty('error')
    expect(conditionSql(cond({ column: 'quantity', op: 'gt', value: '1.5' }), tt('quantity'))).toHaveProperty('error')
  })

  it('offers emptiness checks only for nullable columns, and true/false only for booleans', () => {
    expect(operatorsFor(tx('to_address'))).toContain('empty')
    expect(operatorsFor(tx('from_address'))).not.toContain('empty')
    expect(operatorsFor(tt('removed'))).toEqual(['is_true', 'is_false'])
    expect(conditionSql(cond({ column: 'to_address', op: 'empty' }), tx('to_address'))).toEqual({ sql: 'to_address IS NULL' })
  })

  it('writes a UTC time, accepting a bare date', () => {
    expect(conditionSql(cond({ column: 'block_timestamp', op: 'gte', value: '2026-07-14' }), tx('block_timestamp'))).toEqual({
      sql: "block_timestamp >= toDateTime('2026-07-14 00:00:00', 'UTC')",
    })
  })
})

describe('buildQuery', () => {
  const big = cond({ column: 'value', op: 'gt', value: '1', unit: 'eth' })

  it('builds a transaction flag that passes the server’s own checks', () => {
    const r = buildQuery(state({ conditions: [big] }), SCHEMA)
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.valueType).toBe('flag')
    expect(r.sql).toContain("toUInt8(value > toUInt256('1000000000000000000')) AS value")
    expect(r.summary).toBe("1 if the transaction's value is greater than 1 ETH, otherwise 0.")
    expect(checkQueryText(r.sql)).toEqual([])
  })

  it('combines conditions with AND or OR, parenthesized', () => {
    const r = buildQuery(
      state({ match: 'any', conditions: [big, cond({ column: 'gas', op: 'gt', value: '100000' })] }),
      SCHEMA,
    )
    expect(r.ok && r.sql).toContain("(value > toUInt256('1000000000000000000')) OR (gas > 100000)")
  })

  it('reads a column’s value in the chosen unit, zero where conditions do not match', () => {
    const r = buildQuery(
      state({ output: 'column', valueColumn: 'value', valueUnit: 'eth', conditions: [cond({ column: 'transaction_type', op: 'eq', value: '2' })] }),
      SCHEMA,
    )
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.valueType).toBe('number')
    expect(r.sql).toContain('if(transaction_type = 2, toFloat64(value) / 1e18, 0) AS value')
    expect(checkQueryText(r.sql)).toEqual([])
  })

  it('aggregates token transfers per transaction and gives transactions without any a 0', () => {
    const r = buildQuery(
      state({ source: 'token_transfers', output: 'count', conditions: [cond({ column: 'event_type', op: 'eq', value: 'ERC-20' })] }),
      SCHEMA,
    )
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.sql).toContain("countIf(event_type = 'ERC-20') AS value")
    expect(r.sql).toContain('FROM transactions AS t\nLEFT JOIN')
    expect(r.sql).toContain('ifNull(a.value, 0) AS value')
    expect(r.summary).toBe("Number of the transaction's token transfers where event_type is ERC-20.")
    expect(checkQueryText(r.sql)).toEqual([])
  })

  it('builds a transfers flag and a sum', () => {
    const flag = buildQuery(
      state({ source: 'token_transfers', output: 'flag', conditions: [cond({ column: 'address', op: 'eq', value: USDT })] }),
      SCHEMA,
    )
    expect(flag.ok && flag.sql).toContain("toUInt8(countIf(address = unhex('dac17f958d2ee523a2206206994597c13d831ec7')) > 0)")
    const sum = buildQuery(state({ source: 'token_transfers', output: 'sum', valueColumn: 'quantity' }), SCHEMA)
    expect(sum.ok && sum.sql).toContain('sum(toFloat64(quantity)) AS value')
  })

  it('lists every problem at once instead of building something half-right', () => {
    const r = buildQuery(
      state({ output: 'column', conditions: [cond({ column: 'gas', op: 'gt', value: 'lots' }), cond({ column: '' })] }),
      SCHEMA,
    )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors).toEqual([
      'gas needs a number (got “lots”).',
      'Choose a column for every condition.',
      'Choose the column to use as the value.',
    ])
    expect(buildQuery(state({}), SCHEMA)).toEqual({ ok: false, errors: ['Add at least one condition for a yes / no flag.'] })
  })

  it('rejects an output the chosen table does not offer', () => {
    expect(buildQuery(state({ output: 'count', conditions: [big] }), SCHEMA).ok).toBe(false)
  })
})

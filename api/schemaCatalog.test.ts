import { describe, expect, it } from 'vitest'
import { buildSchema, kindOf, SCHEMA_TABLES } from './schemaCatalog.ts'

describe('kindOf', () => {
  it.each([
    ['FixedString(20)', 'address', false],
    ['Nullable(FixedString(20))', 'address', true],
    ['FixedString(32)', 'hash', false],
    ['UInt256', 'bignum', false],
    ['Nullable(UInt128)', 'bignum', true],
    ['UInt64', 'number', false],
    ['Float64', 'number', false],
    ['Bool', 'bool', false],
    ['DateTime', 'datetime', false],
    ['LowCardinality(String)', 'enum', false],
    ['String', 'text', false],
  ])('%s is %s', (type, kind, nullable) => {
    expect(kindOf(type)).toEqual({ kind, nullable })
  })
})

describe('buildSchema', () => {
  it('lists only the curated tables, with live types, descriptions and wei units', () => {
    const schema = buildSchema([
      { table: 'transactions', name: 'value', type: 'UInt256' },
      { table: 'transactions', name: 'brand_new_column', type: 'UInt8' },
      { table: 'users', name: 'email', type: 'String' },
    ])
    expect(schema.map((t) => t.name)).toEqual(['transactions'])
    const [value, fresh] = schema[0].columns
    expect(value).toMatchObject({ kind: 'bignum', unit: 'wei', description: 'ETH sent with the transaction.' })
    // A column added later still appears, just without a description.
    expect(fresh).toMatchObject({ name: 'brand_new_column', kind: 'number', description: '' })
    expect(SCHEMA_TABLES).not.toContain('users')
  })
})

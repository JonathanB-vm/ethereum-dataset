// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  blockSpan,
  buildVariableValues,
  listVariables,
  MAX_VARIABLES_PER_REQUEST,
  mergeVariableValues,
  parseVariablesParam,
} from './variables.ts'
import { buildServer } from './server.ts'
import { ClickHouseClient } from './clickhouse.ts'
import { ScopeError } from './scope.ts'

describe('parseVariablesParam', () => {
  it('is empty when absent or blank', () => {
    expect(parseVariablesParam(undefined)).toEqual([])
    expect(parseVariablesParam(' ')).toEqual([])
  })

  it('keeps request order, trims, and drops duplicates', () => {
    expect(parseVariablesParam('from_high_user, simple_transaction,from_high_user')).toEqual([
      'from_high_user',
      'simple_transaction',
    ])
  })

  it('rejects an unknown id with a 400-class error naming it', () => {
    expect(() => parseVariablesParam('simple_transaction,nope')).toThrow(ScopeError)
    expect(() => parseVariablesParam('nope')).toThrow(/nope/)
  })

  it('caps the number of variables per request', () => {
    expect(MAX_VARIABLES_PER_REQUEST).toBeGreaterThanOrEqual(2)
  })
})

describe('buildVariableValues', () => {
  it('bounds the read by variable and block range, binding every value', () => {
    const { sql, params } = buildVariableValues(['simple_transaction', 'from_high_user'], 10, 20)
    expect(sql).toContain('variable_id IN {ids:Array(String)}')
    expect(sql).toContain('block_number >= {block_from:UInt32}')
    expect(sql).toContain('block_number <= {block_to:UInt32}')
    expect(sql).not.toContain('simple_transaction')
    expect(params).toEqual({
      ids: "['simple_transaction','from_high_user']",
      block_from: 10,
      block_to: 20,
    })
  })
})

describe('blockSpan', () => {
  it('is the min and max block of the page, or null when empty', () => {
    expect(blockSpan([])).toBeNull()
    expect(blockSpan([{ block_number: 7 }, { block_number: '3' }, { block_number: 5 }])).toEqual({
      from: 3,
      to: 7,
    })
  })
})

describe('mergeVariableValues', () => {
  const rows = [
    { block_number: 1, transaction_index: 0, transaction_hash: '0xa' },
    { block_number: 1, transaction_index: 1, transaction_hash: '0xb' },
  ]

  it('attaches each variable by (block, index) and leaves uncomputed ones null', () => {
    const merged = mergeVariableValues(rows, ['simple_transaction', 'from_high_user'], [
      { variable_id: 'simple_transaction', block_number: '1', transaction_index: '0', value: 1 },
      { variable_id: 'simple_transaction', block_number: 1, transaction_index: 1, value: 0 },
      { variable_id: 'from_high_user', block_number: 1, transaction_index: 0, value: 0 },
    ])
    expect(merged).toEqual([
      { ...rows[0], simple_transaction: 1, from_high_user: 0 },
      { ...rows[1], simple_transaction: 0, from_high_user: null },
    ])
  })

  it('does not mutate the input rows', () => {
    mergeVariableValues(rows, ['simple_transaction'], [])
    expect(rows[0]).not.toHaveProperty('simple_transaction')
  })
})

describe('listVariables', () => {
  it('resolves the creator and filters by tag, text and creator', () => {
    const all = listVariables({})
    expect(all.map((v) => v.id)).toEqual(['simple_transaction', 'from_high_user'])
    expect(all[0].created_by).toEqual({ id: 'nir-chemaya', name: 'Nir Chemaya' })
    expect(listVariables({ tag: 'rolling-window' }).map((v) => v.id)).toEqual(['from_high_user'])
    expect(listVariables({ q: 'simple' }).map((v) => v.id)).toEqual(['simple_transaction'])
    expect(listVariables({ created_by: 'someone-else' })).toEqual([])
  })
})

// The catalog endpoints read the registry, not ClickHouse, so they are tested without a
// server: the client below points nowhere and is never called.
describe('catalog endpoints', () => {
  const app = buildServer({ client: new ClickHouseClient({ url: 'http://127.0.0.1:1' }) })

  it('GET /v1/variables lists the catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/variables?tag=flag' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.variables.map((v: { id: string }) => v.id)).toEqual([
      'simple_transaction',
      'from_high_user',
    ])
    expect(body.variables[1].created_by.name).toBe('Nir Chemaya')
  })

  it('GET /v1/variables/:id returns one entry, or 404', async () => {
    const ok = await app.inject({ method: 'GET', url: '/v1/variables/from_high_user' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().tags).toContain('rolling-window')
    const missing = await app.inject({ method: 'GET', url: '/v1/variables/nope' })
    expect(missing.statusCode).toBe(404)
  })

  it('GET /v1/users lists the demo users', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users' })
    expect(res.json()).toEqual({ users: [{ id: 'nir-chemaya', name: 'Nir Chemaya' }] })
  })

  it('rejects an unknown variable on a list endpoint before querying', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/transactions?block_from=1&block_to=2&variables=nope',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/nope/)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_VARIABLE_VALUES, parseVariableValues, variableValuesProvider } from './variableValues'

const PAYLOAD = {
  schemaVersion: 1,
  blocks: [100, 100, 101],
  txIndexes: [0, 1, 0],
  versions: { simple_transaction: 1, from_high_user: 1 },
  values: { simple_transaction: [1, 0, 0], from_high_user: [0, 0, 1] },
}

const at = (block_number: number, transaction_index: number) => ({ block_number, transaction_index })

describe('parseVariableValues', () => {
  it('looks values up by (block, transaction index)', () => {
    const v = parseVariableValues(PAYLOAD)
    expect(v.size).toBe(3)
    expect(v.get('simple_transaction', at(100, 0))).toBe(1)
    expect(v.get('simple_transaction', at(100, 1))).toBe(0)
    expect(v.get('from_high_user', at(101, 0))).toBe(1)
  })

  it('is null for an uncovered transaction or an unknown variable — never 0', () => {
    const v = parseVariableValues(PAYLOAD)
    expect(v.get('simple_transaction', at(999, 0))).toBeNull()
    expect(v.get('nope', at(100, 0))).toBeNull()
  })

  it('drops a variable computed under an older formula version', () => {
    const v = parseVariableValues({ ...PAYLOAD, versions: { simple_transaction: 0, from_high_user: 1 } })
    expect(v.get('simple_transaction', at(100, 0))).toBeNull()
    expect(v.get('from_high_user', at(101, 0))).toBe(1)
  })

  it('drops a variable whose array length does not match the key arrays', () => {
    const v = parseVariableValues({ ...PAYLOAD, values: { ...PAYLOAD.values, simple_transaction: [1] } })
    expect(v.get('simple_transaction', at(100, 0))).toBeNull()
  })

  it('returns the empty lookup for any unrecognised shape', () => {
    expect(parseVariableValues(null)).toBe(EMPTY_VARIABLE_VALUES)
    expect(parseVariableValues({})).toBe(EMPTY_VARIABLE_VALUES)
    expect(parseVariableValues({ blocks: [1], txIndexes: [] })).toBe(EMPTY_VARIABLE_VALUES)
  })
})

describe('variableValuesProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('parses a plain (already-decompressed) JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PAYLOAD))))
    const v = await variableValuesProvider().load()
    expect(v.get('simple_transaction', at(100, 0))).toBe(1)
  })

  it('resolves to the empty lookup on a non-OK status or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    expect((await variableValuesProvider().load()).size).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    expect((await variableValuesProvider().load()).size).toBe(0)
  })
})

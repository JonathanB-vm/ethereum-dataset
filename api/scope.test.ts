import { describe, expect, it } from 'vitest'
import {
  classifySearch,
  DEFAULT_LIMIT,
  MAX_BLOCK_SPAN,
  MAX_LIMIT_ANONYMOUS,
  MAX_LIMIT_KEYED,
  parseScope,
  resolveLimit,
  ScopeError,
} from './scope.ts'

const ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const HASH = '0xa1f85713792f2d9c10d14079d4b2990ea0d72cbe35c95d28d377fe17073d6d35'

describe('parseScope', () => {
  it('accepts a block range', () => {
    expect(parseScope({ block_from: 25_534_200, block_to: 25_534_299 })).toEqual({
      kind: 'range',
      from: 25_534_200,
      to: 25_534_299,
    })
  })

  it('accepts range bounds as strings from the query string', () => {
    expect(parseScope({ block_from: '100', block_to: '200' })).toEqual({
      kind: 'range',
      from: 100,
      to: 200,
    })
  })

  it('accepts an address and lowercases it', () => {
    expect(parseScope({ address: ADDRESS.toUpperCase().replace('0X', '0x') })).toEqual({
      kind: 'address',
      address: ADDRESS,
    })
  })

  it('accepts a transaction hash', () => {
    expect(parseScope({ hash: HASH })).toEqual({ kind: 'txHash', hash: HASH })
  })

  it('prefers the narrowest scope when several are given', () => {
    // A hash lookup is one primary-key read; the range would be a scan.
    const scope = parseScope({ hash: HASH, address: ADDRESS, block_from: 1, block_to: 2 })
    expect(scope.kind).toBe('txHash')
  })

  it('rejects an unbounded request and names what is required', () => {
    expect(() => parseScope({})).toThrow(ScopeError)
    expect(() => parseScope({})).toThrow(/block_from and block_to, or address, or hash/)
  })

  it('rejects a range wider than the cap', () => {
    expect(() => parseScope({ block_from: 0, block_to: MAX_BLOCK_SPAN })).toThrow(
      /maximum is 100000/,
    )
  })

  it('accepts a range exactly at the cap', () => {
    const scope = parseScope({ block_from: 0, block_to: MAX_BLOCK_SPAN - 1 })
    expect(scope).toEqual({ kind: 'range', from: 0, to: MAX_BLOCK_SPAN - 1 })
  })

  it('rejects an inverted range', () => {
    expect(() => parseScope({ block_from: 500, block_to: 100 })).toThrow(
      /greater than or equal/,
    )
  })

  it('rejects a half-specified range', () => {
    expect(() => parseScope({ block_from: 100 })).toThrow(ScopeError)
    expect(() => parseScope({ block_to: 100 })).toThrow(ScopeError)
  })

  it('rejects a malformed address', () => {
    expect(() => parseScope({ address: '0xnothex' })).toThrow(/20-byte hex/)
  })

  it('rejects an address of the wrong length', () => {
    expect(() => parseScope({ address: '0xdac17f958d' })).toThrow(/20-byte hex/)
  })

  it('rejects a hash of the wrong length', () => {
    expect(() => parseScope({ hash: ADDRESS })).toThrow(/32-byte hex/)
  })

  it('rejects a negative block number', () => {
    expect(() => parseScope({ block_from: -5, block_to: 10 })).toThrow(
      /non-negative integer/,
    )
  })

  it('rejects a non-numeric block number', () => {
    expect(() => parseScope({ block_from: 'abc', block_to: '10' })).toThrow(
      /non-negative integer/,
    )
  })
})

describe('resolveLimit', () => {
  it('defaults to a 50-row page', () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT)
  })

  it('honours a smaller request', () => {
    expect(resolveLimit(25)).toBe(25)
  })

  it('clamps an anonymous caller to 1,000', () => {
    expect(resolveLimit(50_000)).toBe(MAX_LIMIT_ANONYMOUS)
  })

  it('clamps a keyed caller to 10,000 instead', () => {
    expect(resolveLimit(50_000, true)).toBe(MAX_LIMIT_KEYED)
  })

  it('rejects a zero or negative page size', () => {
    expect(() => resolveLimit(0)).toThrow(ScopeError)
    expect(() => resolveLimit(-1)).toThrow(ScopeError)
  })

  it('rejects a fractional page size', () => {
    expect(() => resolveLimit(1.5)).toThrow(ScopeError)
  })
})

describe('classifySearch', () => {
  it('reads 66 hex characters as a transaction hash', () => {
    expect(classifySearch(HASH)).toEqual({ kind: 'txHash', value: HASH })
  })

  it('reads 42 hex characters as an address', () => {
    expect(classifySearch(ADDRESS)).toEqual({ kind: 'address', value: ADDRESS })
  })

  it('reads digits as a block number', () => {
    expect(classifySearch('25534200')).toEqual({ kind: 'block', value: 25_534_200 })
  })

  it('falls back to a text filter', () => {
    expect(classifySearch('USDT')).toEqual({ kind: 'text', value: 'USDT' })
  })

  it('is case-insensitive about hex input', () => {
    expect(classifySearch(ADDRESS.toUpperCase().replace('0X', '0x')).kind).toBe('address')
  })

  it('tolerates surrounding whitespace', () => {
    expect(classifySearch(`  ${ADDRESS}  `).kind).toBe('address')
  })
})

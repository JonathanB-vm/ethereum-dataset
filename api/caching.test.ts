import { describe, expect, it } from 'vitest'
import { cacheHeadersFor, FINALITY_LAG, IMMUTABLE, isFinalized, NEAR_HEAD } from './caching.ts'
import type { Scope } from './scope.ts'

const HEAD = 25_534_299
const range = (from: number, to: number): Scope => ({ kind: 'range', from, to })

describe('isFinalized', () => {
  it('treats a range well behind head as final', () => {
    expect(isFinalized(range(25_000_000, 25_100_000), HEAD)).toBe(true)
  })

  it('treats a range touching head as not final', () => {
    expect(isFinalized(range(25_534_200, HEAD), HEAD)).toBe(false)
  })

  it('is exact at the finality boundary', () => {
    expect(isFinalized(range(0, HEAD - FINALITY_LAG), HEAD)).toBe(true)
    expect(isFinalized(range(0, HEAD - FINALITY_LAG + 1), HEAD)).toBe(false)
  })

  it('never marks an address lookup final', () => {
    // An address query can return rows from anywhere, including the head.
    expect(isFinalized({ kind: 'address', address: '0x' + 'a'.repeat(40) }, HEAD)).toBe(
      false,
    )
  })

  it('never marks a hash lookup final', () => {
    expect(isFinalized({ kind: 'txHash', hash: '0x' + 'b'.repeat(64) }, HEAD)).toBe(false)
  })
})

describe('cacheHeadersFor', () => {
  it('marks a finalized range immutable', () => {
    expect(cacheHeadersFor(range(1_000, 2_000), HEAD)['Cache-Control']).toBe(IMMUTABLE)
  })

  it('gives head-adjacent data a short ttl', () => {
    expect(cacheHeadersFor(range(25_534_290, HEAD), HEAD)['Cache-Control']).toBe(NEAR_HEAD)
  })

  it('includes the release in the ETag so a correction invalidates the cache', () => {
    // Without this, a re-published month would stay cached for a year.
    const headers = cacheHeadersFor(range(1_000, 2_000), HEAD, '2026.09')
    expect(headers.ETag).toBe('"2026.09-1000-2000"')
  })

  it('changes the ETag when the release changes', () => {
    const a = cacheHeadersFor(range(1_000, 2_000), HEAD, '2026.09').ETag
    const b = cacheHeadersFor(range(1_000, 2_000), HEAD, '2026.10').ETag
    expect(a).not.toBe(b)
  })

  it('omits an ETag on near-head responses', () => {
    expect(cacheHeadersFor(range(25_534_290, HEAD), HEAD, '2026.09').ETag).toBeUndefined()
  })
})

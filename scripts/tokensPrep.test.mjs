import { describe, expect, it } from 'vitest'
import { parseTokenDecimals, buildTokensArtifact } from './tokensPrep.mjs'

describe('parseTokenDecimals', () => {
  it('accepts integer strings in range', () => {
    expect(parseTokenDecimals('6')).toBe(6)
    expect(parseTokenDecimals('18')).toBe(18)
    expect(parseTokenDecimals(' 0 ')).toBe(0)
    expect(parseTokenDecimals('77')).toBe(77)
  })

  it('rejects empty, non-numeric, negative, fractional and out-of-range values', () => {
    // Empty decimals is the common case for NFTs in the real tokens.csv.
    expect(parseTokenDecimals('')).toBeNull()
    expect(parseTokenDecimals(undefined)).toBeNull()
    expect(parseTokenDecimals('abc')).toBeNull()
    expect(parseTokenDecimals('-1')).toBeNull()
    expect(parseTokenDecimals('1.5')).toBeNull()
    expect(parseTokenDecimals('78')).toBeNull()
  })
})

describe('buildTokensArtifact', () => {
  const addresses = new Set(['0xusdt', '0xweth', '0xusdc'])

  it('keeps only contracts present in the dataset', () => {
    const out = buildTokensArtifact(addresses, [
      { address: '0xusdt', symbol: 'USDT', decimals: '6' },
      { address: '0xnotinthedataset', symbol: 'XXX', decimals: '18' },
    ])
    expect(Object.keys(out.tokens)).toEqual(['0xusdt'])
  })

  it('drops rows whose decimals are unusable', () => {
    const out = buildTokensArtifact(addresses, [
      { address: '0xusdt', symbol: 'USDT', decimals: '6' },
      { address: '0xweth', symbol: 'NFT', decimals: '' },
    ])
    expect(out.tokens).toEqual({ '0xusdt': { symbol: 'USDT', decimals: 6 } })
  })

  it('lowercases addresses on both sides of the match', () => {
    const out = buildTokensArtifact(new Set(['0xusdt']), [
      { address: '0xUSDT', symbol: 'USDT', decimals: '6' },
    ])
    expect(out.tokens['0xusdt'].decimals).toBe(6)
  })

  it('reports coverage counts', () => {
    const out = buildTokensArtifact(addresses, [
      { address: '0xusdt', symbol: 'USDT', decimals: '6' },
      { address: '0xweth', symbol: 'WETH', decimals: '18' },
    ])
    // USDC is in the dataset but absent from the token rows — exactly the real-world gap.
    expect(out.contractsInDataset).toBe(3)
    expect(out.contractsWithDecimals).toBe(2)
  })

  it('takes the last row when a contract repeats', () => {
    const out = buildTokensArtifact(new Set(['0xa']), [
      { address: '0xa', symbol: 'OLD', decimals: '6' },
      { address: '0xa', symbol: 'NEW', decimals: '8' },
    ])
    expect(out.tokens['0xa']).toEqual({ symbol: 'NEW', decimals: 8 })
  })

  it('stores a null symbol when the source has none', () => {
    const out = buildTokensArtifact(new Set(['0xa']), [{ address: '0xa', decimals: '2' }])
    expect(out.tokens['0xa']).toEqual({ symbol: null, decimals: 2 })
  })
})

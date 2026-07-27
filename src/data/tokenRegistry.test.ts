import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  parseTokenRegistry,
  lookupToken,
  tokenDecimals,
  tokenRegistryProvider,
} from './tokenRegistry'

const PAYLOAD = {
  contractsInDataset: 3,
  contractsWithDecimals: 2,
  tokens: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  },
}

describe('parseTokenRegistry', () => {
  it('reads entries into a Map keyed by address', () => {
    const reg = parseTokenRegistry(PAYLOAD)
    expect(reg.size).toBe(2)
    expect(reg.get('0xdac17f958d2ee523a2206206994597c13d831ec7')).toEqual({
      symbol: 'USDT',
      decimals: 6,
    })
  })

  it('lowercases addresses so lookups are case-insensitive', () => {
    const reg = parseTokenRegistry({
      tokens: { '0xDAC17F958D2EE523A2206206994597C13D831EC7': { symbol: 'USDT', decimals: 6 } },
    })
    expect(reg.get('0xdac17f958d2ee523a2206206994597c13d831ec7')?.decimals).toBe(6)
  })

  it('skips individual malformed entries without discarding the rest', () => {
    const reg = parseTokenRegistry({
      tokens: {
        '0xgood': { symbol: 'OK', decimals: 6 },
        '0xbad1': { symbol: 'NO', decimals: -1 },
        '0xbad2': { symbol: 'NO', decimals: 'six' },
        '0xbad3': { symbol: 'NO' },
        '0xbad4': null,
      },
    })
    expect(reg.size).toBe(1)
    expect(reg.get('0xgood')?.decimals).toBe(6)
  })

  it('tolerates a missing symbol by storing null', () => {
    const reg = parseTokenRegistry({ tokens: { '0xa': { decimals: 8 } } })
    expect(reg.get('0xa')).toEqual({ symbol: null, decimals: 8 })
  })

  it('returns an empty registry for any unrecognised shape', () => {
    expect(parseTokenRegistry(null).size).toBe(0)
    expect(parseTokenRegistry('nope').size).toBe(0)
    expect(parseTokenRegistry({}).size).toBe(0)
    expect(parseTokenRegistry({ tokens: [] }).size).toBe(0)
  })
})

describe('lookupToken / tokenDecimals', () => {
  const reg = parseTokenRegistry(PAYLOAD)

  it('finds a token regardless of the queried address casing', () => {
    expect(lookupToken(reg, '0xDAC17F958D2EE523A2206206994597C13D831EC7')?.symbol).toBe('USDT')
    expect(tokenDecimals(reg, '0xdac17f958d2ee523a2206206994597c13d831ec7')).toBe(6)
  })

  it('returns null for an unknown or null address', () => {
    // USDC is genuinely absent from the real tokens.csv — this is the common case.
    expect(lookupToken(reg, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBeNull()
    expect(tokenDecimals(reg, null)).toBeNull()
  })
})

describe('tokenRegistryProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads and parses the artifact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }),
    )
    const reg = await tokenRegistryProvider('/data/tokens.json').load()
    expect(reg.size).toBe(2)
  })

  it('resolves to an empty registry on a 404 rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(tokenRegistryProvider().load()).resolves.toEqual(new Map())
  })

  it('resolves to an empty registry when the network or JSON parse fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(tokenRegistryProvider().load()).resolves.toEqual(new Map())
  })

  it('resolves to an empty registry when the response body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad json')) }),
    )
    await expect(tokenRegistryProvider().load()).resolves.toEqual(new Map())
  })
})

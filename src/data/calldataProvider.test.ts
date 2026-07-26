import { describe, it, expect, vi, afterEach } from 'vitest'
import { calldataProvider, calldataShard } from './calldataProvider'

function jsonResponse(body: unknown): Response {
  return new Response(new TextEncoder().encode(JSON.stringify(body)), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('calldataShard', () => {
  it('matches the prep script: first hex byte after 0x, lowercased', () => {
    expect(calldataShard('0xAB12cd')).toBe('ab')
    expect(calldataShard('0x0058db')).toBe('00')
  })

  // Pinned to agree with shardKey's own test in scripts/datasetPrep.test.mjs — the two
  // implementations are the contract, so every case pinned there is pinned here too.
  it('tolerates an uppercase 0X prefix', () => {
    expect(calldataShard('0XAB12cd')).toBe('ab')
  })

  it('tolerates a missing 0x prefix', () => {
    expect(calldataShard('ff9900')).toBe('ff')
  })

  it('returns null when there is no byte to key on', () => {
    expect(calldataShard('0x')).toBeNull()
    expect(calldataShard('')).toBeNull()
    expect(calldataShard(null as unknown as string)).toBeNull()
    expect(calldataShard(undefined as unknown as string)).toBeNull()
  })
})

describe('calldataProvider', () => {
  it('fetches the shard named by the tx hash and returns the calldata', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ '0xab11': '0xa9059cbb' }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = calldataProvider('/data/calldata')
    await expect(provider.get('0xab11')).resolves.toBe('0xa9059cbb')
    expect(fetchMock).toHaveBeenCalledWith('/data/calldata/ab.json.gz')
  })

  it("returns '0x' for a transaction absent from its shard", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ '0xabff': '0xdead' })))
    const provider = calldataProvider()
    await expect(provider.get('0xab11')).resolves.toBe('0x')
  })

  it("returns '0x' when the shard file does not exist at all", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const provider = calldataProvider()
    await expect(provider.get('0xab11')).resolves.toBe('0x')
  })

  it('fetches each shard at most once, even for concurrent gets', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ '0xab11': '0x11', '0xab22': '0x22' }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = calldataProvider()
    const [a, b] = await Promise.all([provider.get('0xab11'), provider.get('0xab22')])
    expect(a).toBe('0x11')
    expect(b).toBe('0x22')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects on a network failure so the caller can offer a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const provider = calldataProvider()
    await expect(provider.get('0xab11')).rejects.toThrow('offline')
  })

  it('does not cache a failed shard — a later get retries', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ '0xab11': '0xok' }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = calldataProvider()
    await expect(provider.get('0xab11')).rejects.toThrow('offline')
    await expect(provider.get('0xab11')).resolves.toBe('0xok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("returns '0x' for an unusable hash without fetching", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(calldataProvider().get('0x')).resolves.toBe('0x')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

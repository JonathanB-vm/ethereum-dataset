import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/apiPages.json'
import { ApiQueryProvider, toEthRecord } from './apiProvider'
import { MemoryQueryProvider } from './memoryProvider'
import {
  UnboundedQueryError,
  type QueryProvider,
  type QueryScope,
} from './queryProvider'
import type { EthRecord } from './types'

/**
 * One suite, both implementations.
 *
 * The fixture is recorded from the real API running against the loaded 100-block sample
 * (see api/queries.integration.test.ts for how to bring that up), so the API provider is
 * exercised against genuine responses without needing a server, and the memory provider
 * is given exactly the same rows. Anything the two disagree about is a contract break.
 */

interface Fixture {
  range: { blockFrom: number; blockTo: number }
  limit: number
  pages: Record<string, { rows: Record<string, unknown>[]; nextCursor: string | null }>
  stats: Record<string, unknown>
  head: { block: number; timestamp: string; release?: string }
}

const fx = fixture as unknown as Fixture
const SCOPE: QueryScope = { kind: 'range', ...fx.range }

/** Every row the fixture holds, in order, as the UI's record shape. */
const FIXTURE_ROWS: EthRecord[] = Object.values(fx.pages).flatMap((p) =>
  p.rows.map((r) => toEthRecord(r, 'all')),
)

/** Serves the recorded responses, so no network or server is involved. */
function recordedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://api.test')
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })

    if (url.pathname === '/v1/head') return json(fx.head)
    if (url.pathname === '/v1/stats') return json(fx.stats)
    if (url.pathname === '/v1/records') {
      const from = Number(url.searchParams.get('block_from'))
      const to = Number(url.searchParams.get('block_to'))
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return json({ error: 'bad_scope', message: 'a bounded scope is required' }, 400)
      }
      const page = fx.pages[url.searchParams.get('cursor') ?? '']
      if (!page) return json({ error: 'bad_cursor', message: 'unknown cursor' }, 400)
      return json(page)
    }
    return json({ error: 'not_found', message: 'no route' }, 404)
  }) as typeof fetch
}

const IMPLEMENTATIONS: [string, () => QueryProvider][] = [
  ['MemoryQueryProvider', () => new MemoryQueryProvider(FIXTURE_ROWS)],
  [
    'ApiQueryProvider',
    () => new ApiQueryProvider({ baseUrl: 'http://api.test', fetchImpl: recordedFetch() }),
  ],
]

describe.each(IMPLEMENTATIONS)('QueryProvider contract: %s', (_name, make) => {
  const provider = make()

  it('returns a bounded first page', async () => {
    const page = await provider.query({ view: 'all', scope: SCOPE, limit: fx.limit })
    expect(page.rows.length).toBeLessThanOrEqual(fx.limit)
    expect(page.rows.length).toBeGreaterThan(0)
  })

  it('walks every row exactly once across pages', async () => {
    const seen: string[] = []
    let cursor: string | null | undefined = null
    for (let i = 0; i < 50; i++) {
      const page = await provider.query({
        view: 'all',
        scope: SCOPE,
        limit: fx.limit,
        cursor,
      })
      for (const r of page.rows) {
        seen.push(
          `${r.block_number}/${r.transaction_index}/${r.event_index ?? ''}/${r.batch_index ?? ''}`,
        )
      }
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(FIXTURE_ROWS.length)
    expect(new Set(seen).size).toBe(FIXTURE_ROWS.length)
  })

  it('reports no cursor on the last page', async () => {
    let cursor: string | null | undefined = null
    let last = null
    for (let i = 0; i < 50; i++) {
      const page: Awaited<ReturnType<QueryProvider['query']>> = await provider.query({
        view: 'all',
        scope: SCOPE,
        limit: fx.limit,
        cursor,
      })
      last = page
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(last?.nextCursor).toBeNull()
  })

  it('treats the cursor as opaque', async () => {
    const page = await provider.query({ view: 'all', scope: SCOPE, limit: fx.limit })
    // Nothing about the key or offset should be legible in it.
    expect(page.nextCursor).toBeTruthy()
    expect(page.nextCursor).not.toContain(String(fx.range.blockFrom))
  })

  it('rejects a range wider than the cap', async () => {
    await expect(
      provider.query({
        view: 'all',
        scope: { kind: 'range', blockFrom: 0, blockTo: 200_000 },
      }),
    ).rejects.toThrow(UnboundedQueryError)
  })

  it('rejects an inverted range', async () => {
    await expect(
      provider.query({
        view: 'all',
        scope: { kind: 'range', blockFrom: 500, blockTo: 100 },
      }),
    ).rejects.toThrow(UnboundedQueryError)
  })

  it('returns rows in the shape the UI renders', async () => {
    const { rows } = await provider.query({ view: 'all', scope: SCOPE, limit: 5 })
    for (const r of rows) {
      expect(typeof r.block_number).toBe('number')
      expect(r.transaction_hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(typeof r.is_token_transfer).toBe('boolean')
      // Wei stays a string end to end; a number here would mean silent rounding.
      if (r.value_lossless_tx !== null) expect(typeof r.value_lossless_tx).toBe('string')
    }
  })

  it('reports a head block', async () => {
    const head = await provider.head()
    expect(head.block).toBeGreaterThan(0)
  })
})

describe('the two providers agree', () => {
  it('on the rows returned for the same scope', async () => {
    const [memory, api] = IMPLEMENTATIONS.map(([, make]) => make())
    const a = await memory.query({ view: 'all', scope: SCOPE, limit: fx.limit })
    const b = await api.query({ view: 'all', scope: SCOPE, limit: fx.limit })
    expect(a.rows.map((r) => r.transaction_hash)).toEqual(
      b.rows.map((r) => r.transaction_hash),
    )
  })

  it('on which rows are transfers', async () => {
    const [memory, api] = IMPLEMENTATIONS.map(([, make]) => make())
    const a = await memory.query({ view: 'all', scope: SCOPE, limit: fx.limit })
    const b = await api.query({ view: 'all', scope: SCOPE, limit: fx.limit })
    expect(a.rows.map((r) => r.is_token_transfer)).toEqual(
      b.rows.map((r) => r.is_token_transfer),
    )
  })
})

describe('MemoryQueryProvider', () => {
  const provider = new MemoryQueryProvider(FIXTURE_ROWS)

  it('filters to the transfers view', async () => {
    const { rows } = await provider.query({ view: 'transfers', scope: SCOPE, limit: 500 })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.is_token_transfer)).toBe(true)
  })

  it('filters to the transactions view', async () => {
    const { rows } = await provider.query({
      view: 'transactions',
      scope: SCOPE,
      limit: 500,
    })
    expect(rows.every((r) => !r.is_token_transfer)).toBe(true)
  })

  it('counts each transaction once when summing wei, despite the flat join', async () => {
    // The flat shape repeats a transaction's value on every one of its transfer rows;
    // summing naively would multiply the total.
    const stats = await provider.stats(SCOPE)
    const unique = new Set(FIXTURE_ROWS.map((r) => r.transaction_hash))
    expect(stats.txCount).toBe(unique.size)
    expect(BigInt(stats.totalEthMovedWei)).toBeGreaterThanOrEqual(0n)
  })

  it('excludes out-of-scope blocks', async () => {
    const { rows } = await provider.query({
      view: 'all',
      scope: { kind: 'range', blockFrom: 1, blockTo: 2 },
      limit: 10,
    })
    expect(rows).toHaveLength(0)
  })

  it('finds rows by address', async () => {
    const target = FIXTURE_ROWS.find((r) => r.from_address_tx)!.from_address_tx!
    const { rows } = await provider.query({
      view: 'all',
      scope: { kind: 'address', address: target.toUpperCase() },
      limit: 10,
    })
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('ApiQueryProvider', () => {
  const provider = new ApiQueryProvider({
    baseUrl: 'http://api.test',
    fetchImpl: recordedFetch(),
  })

  it('maps the stats response onto ScopedStats', async () => {
    const stats = await provider.stats(SCOPE)
    expect(stats.txCount).toBe(Number(fx.stats.tx_count))
    expect(stats.transferCount).toBe(Number(fx.stats.transfer_count))
    expect(stats.totalEthMovedWei).toBe(String(fx.stats.eth_moved))
    // Wei must survive as a string, not become a float.
    expect(BigInt(stats.totalEthMovedWei).toString()).toBe(stats.totalEthMovedWei)
  })

  it('refuses stats for a non-range scope', async () => {
    await expect(
      provider.stats({ kind: 'address', address: '0x' + 'a'.repeat(40) }),
    ).rejects.toThrow(UnboundedQueryError)
  })

  it('passes the release through from head', async () => {
    expect((await provider.head()).release).toBe(fx.head.release)
  })

  it('surfaces a server 400 as UnboundedQueryError', async () => {
    const badFetch = (async () =>
      new Response(JSON.stringify({ error: 'bad_scope', message: 'nope' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    const p = new ApiQueryProvider({ baseUrl: 'http://api.test', fetchImpl: badFetch })
    await expect(p.query({ view: 'all', scope: SCOPE })).rejects.toThrow(
      UnboundedQueryError,
    )
  })
})

describe('toEthRecord', () => {
  it('accepts the normalized transactions shape', () => {
    const r = toEthRecord(
      {
        block_number: 1,
        transaction_hash: '0x' + 'a'.repeat(64),
        from_address: '0x' + 'b'.repeat(40),
        value: '1794013457006467492343',
        gas_price: '57259455',
      },
      'transactions',
    )
    expect(r.is_token_transfer).toBe(false)
    // The unsuffixed transaction columns land on the _tx fields the UI reads.
    expect(r.from_address_tx).toBe('0x' + 'b'.repeat(40))
    expect(r.value_lossless_tx).toBe('1794013457006467492343')
    expect(r.gas_price_tx).toBe('57259455')
  })

  it('accepts the normalized transfers shape', () => {
    const r = toEthRecord(
      { block_number: 1, quantity: '4461668424664140127867736845293397079' },
      'transfers',
    )
    expect(r.is_token_transfer).toBe(true)
    expect(r.quantity).toBe('4461668424664140127867736845293397079')
  })

  it('drops value_tx, which the data model removed as a duplicate', () => {
    expect(toEthRecord({ value_tx: '1.0' }, 'all').value_tx).toBeNull()
  })
})

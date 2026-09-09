// @vitest-environment node
/**
 * End-to-end tests of the API surface, driven through Fastify's inject() so no port is
 * bound. They need the local ClickHouse holding the 100-block sample and are reported as
 * skipped -- not passed -- when it is absent. See queries.integration.test.ts for setup.
 */

import { describe, expect, it } from 'vitest'
import { ClickHouseClient } from './clickhouse.ts'
import { buildServer, RATE_LIMIT_ANONYMOUS, RATE_LIMIT_KEYED } from './server.ts'
import { IMMUTABLE, NEAR_HEAD } from './caching.ts'

const FIRST_BLOCK = 25_534_200
const LAST_BLOCK = 25_534_299
const TOTAL_TRANSACTIONS = 40_642
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'

const client = new ClickHouseClient()
const available = await client.ping()
if (!available) console.warn('ClickHouse not reachable — API server tests skipped')

const itLive = it.runIf(available)
const app = buildServer({ client, release: '2026.09' })

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers })

describe('GET /v1/head', () => {
  itLive('reports the latest ingested block and the release', async () => {
    const res = await get('/v1/head')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ block: LAST_BLOCK, release: '2026.09' })
  })
})

describe('scoping', () => {
  itLive('rejects an unbounded list request with 400', async () => {
    const res = await get('/v1/transactions')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('bad_scope')
    expect(res.json().message).toMatch(/block_from and block_to, or address, or hash/)
  })

  itLive('rejects a range wider than the cap', async () => {
    const res = await get('/v1/transactions?block_from=0&block_to=200000')
    expect(res.statusCode).toBe(400)
  })

  itLive('rejects a tampered cursor with 400, not 500', async () => {
    const res = await get(
      `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&cursor=notacursor`,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('bad_cursor')
  })
})

describe('GET /v1/transactions', () => {
  itLive('returns a page and a next cursor', async () => {
    const res = await get(
      `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&limit=10`,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rows).toHaveLength(10)
    expect(body.nextCursor).toBeTruthy()
  })

  itLive('follows the cursor to a disjoint second page', async () => {
    const first = (
      await get(`/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&limit=10`)
    ).json()
    const second = (
      await get(
        `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&limit=10` +
          `&cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json()
    const firstKeys = new Set(
      first.rows.map((r: Record<string, unknown>) => r.transaction_hash),
    )
    expect(
      second.rows.every((r: Record<string, unknown>) => !firstKeys.has(r.transaction_hash)),
    ).toBe(true)
  })

  itLive('omits the cursor on the last page', async () => {
    const res = await get(
      `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=1000`,
    )
    expect(res.json().nextCursor).toBeNull()
  })

  itLive('clamps an over-large limit rather than failing', async () => {
    const res = await get(
      `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&limit=99999`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().rows.length).toBeLessThanOrEqual(1_000)
  })

  itLive('serves values as lossless strings, never JSON numbers', async () => {
    const res = await get(
      `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&limit=200`,
    )
    const values = res.json().rows.map((r: Record<string, string>) => r.value)
    expect(values.every((v: unknown) => typeof v === 'string')).toBe(true)
    // The raw body must not contain a bare 22-digit number, which would mean a value
    // was serialized as a JSON number and silently rounded.
    expect(res.body).not.toMatch(/:\s*\d{18,}/)
  })
})

describe('caching', () => {
  itLive('marks a finalized range immutable with a release-stamped ETag', async () => {
    const res = await get('/v1/transactions?block_from=1000&block_to=2000')
    expect(res.headers['cache-control']).toBe(IMMUTABLE)
    expect(res.headers.etag).toBe('"2026.09-1000-2000"')
  })

  itLive('gives a head-adjacent range a short ttl', async () => {
    const res = await get(
      `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}`,
    )
    expect(res.headers['cache-control']).toBe(NEAR_HEAD)
  })
})

describe('rate limit headers', () => {
  itLive('advertises the anonymous limit', async () => {
    const res = await get('/v1/head')
    expect(res.headers['x-ratelimit-limit']).toBe(String(RATE_LIMIT_ANONYMOUS))
  })

  itLive('advertises the higher keyed limit', async () => {
    const res = await get('/v1/head', { 'x-api-key': 'demo' })
    expect(res.headers['x-ratelimit-limit']).toBe(String(RATE_LIMIT_KEYED))
  })
})

describe('GET /v1/transactions/:hash', () => {
  itLive('returns one transaction with its calldata', async () => {
    const page = (
      await get(`/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=1`)
    ).json()
    const hash = page.rows[0].transaction_hash
    const res = await get(`/v1/transactions/${hash}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().transaction_hash).toBe(hash)
    expect(res.json()).toHaveProperty('input')
  })

  itLive('404s on an unknown hash', async () => {
    const res = await get(`/v1/transactions/0x${'f'.repeat(64)}`)
    expect(res.statusCode).toBe(404)
  })

  itLive('400s on a malformed hash', async () => {
    const res = await get('/v1/transactions/0xdeadbeef')
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/addresses/:addr', () => {
  itLive('returns transfers touching an address', async () => {
    const res = await get(`/v1/addresses/${USDT}/transfers?limit=5`)
    expect(res.statusCode).toBe(200)
    expect(res.json().rows.length).toBe(5)
  })

  itLive('includes transactions sent TO the address', async () => {
    // Regression guard for the UNION ALL materialized view bug.
    const res = await get(`/v1/addresses/${USDT}/transactions?limit=50`)
    expect(res.json().rows.some((r: Record<string, string>) => r.role === 'to')).toBe(true)
  })

  itLive('400s on a malformed address', async () => {
    const res = await get('/v1/addresses/0xnope/transfers')
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/stats and /v1/blocks/:n', () => {
  itLive('totals a block range from the materialized aggregates', async () => {
    const res = await get(`/v1/stats?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}`)
    expect(Number(res.json().tx_count)).toBe(TOTAL_TRANSACTIONS)
  })

  itLive('returns one block summary', async () => {
    const res = await get(`/v1/blocks/${FIRST_BLOCK}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().block_number).toBe(FIRST_BLOCK)
  })

  itLive('404s on a block outside the dataset', async () => {
    const res = await get('/v1/blocks/1')
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /v1/search', () => {
  itLive('routes a hash, an address and a block number', async () => {
    expect((await get(`/v1/search?q=0x${'a'.repeat(64)}`)).json().kind).toBe('transaction')
    expect((await get(`/v1/search?q=${USDT}`)).json().kind).toBe('address')
    expect((await get('/v1/search?q=25534200')).json().kind).toBe('block')
    expect((await get('/v1/search?q=USDT')).json().kind).toBe('text')
  })
})

describe('GET /v1/records (the flat join)', () => {
  itLive('reproduces the flat CSV row shape', async () => {
    const res = await get(
      `/v1/records?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=1000`,
    )
    expect(res.statusCode).toBe(200)
    const rows = res.json().rows
    // Both kinds appear: transfer rows and plain-transaction rows.
    expect(rows.some((r: Record<string, unknown>) => r.is_token_transfer === 1)).toBe(true)
    expect(rows.some((r: Record<string, unknown>) => r.is_token_transfer === 0)).toBe(true)
  })

  itLive('leaves transfer columns null on plain-transaction rows', async () => {
    const res = await get(
      `/v1/records?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=1000`,
    )
    const rows = res.json().rows as Record<string, unknown>[]
    const plain = rows.find((r) => r.is_token_transfer === 0)!
    // join_use_nulls makes an unmatched row genuinely null, so a plain transaction is
    // distinguishable from a transfer whose fields happen to be zero.
    expect(plain.address).toBeNull()
    expect(plain.event_type).toBeNull()
    expect(plain.quantity).toBeNull()
    // The transaction side is still fully populated.
    expect(plain.from_address_tx).toMatch(/^0x[0-9a-f]{40}$/)
  })

  itLive('keeps the transfer and transaction address columns distinct', async () => {
    const res = await get(
      `/v1/records?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=100`,
    )
    const rows = res.json().rows as Record<string, unknown>[]
    const transfer = rows.find((r) => r.is_token_transfer === 1)!
    // The CSV suffixes the transaction side precisely because both sides carry a
    // from_address; collapsing them would silently mislabel every transfer row.
    expect(transfer.from_address).not.toBe(transfer.from_address_tx)
  })

  itLive(
    'reconstructs every row of the source CSV, with no gaps or duplicates',
    async () => {
      // 74,889 is what the source CSV holds for these 100 blocks: 43,941 transfer rows
      // plus 30,948 plain-transaction rows. Matching it exactly is the proof that
      // normalizing into three tables lost nothing.
      interface RecordsPage {
        rows: Record<string, unknown>[]
        nextCursor: string | null
      }
      const seen = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 200; page++) {
        const url: string =
          `/v1/records?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}&limit=10000` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
        const body: RecordsPage = (await get(url, { 'x-api-key': 'test' })).json()
        for (const r of body.rows) {
          seen.add(
            `${r.block_number}/${r.transaction_index}/${r.event_index ?? ''}/${r.batch_index ?? ''}`,
          )
        }
        cursor = body.nextCursor
        if (!cursor) break
      }
      expect(seen.size).toBe(74_889)
    },
    30_000,
  )

  itLive('requires a block range', async () => {
    const res = await get(`/v1/records?address=${USDT}`)
    expect(res.statusCode).toBe(400)
  })
})

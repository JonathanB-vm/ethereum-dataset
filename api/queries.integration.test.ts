// @vitest-environment node
/**
 * Integration tests against a real ClickHouse holding the 100-block sample.
 *
 * Runs in the node environment: jsdom cannot reach a local server, and under it these
 * tests silently skip while appearing healthy.
 *
 * Skipped automatically when no server is reachable, so `npm test` stays green without
 * Docker. To run them:
 *
 *   docker run -d --name eth-ch -p 8123:8123 \
 *     -v "$PWD/data:/var/lib/clickhouse/user_files/import" clickhouse/clickhouse-server
 *   docker exec -i eth-ch clickhouse-client --multiquery < pipeline/clickhouse/schema.sql
 *   docker exec -i eth-ch clickhouse-client --multiquery < pipeline/clickhouse/load.sql
 */

import { describe, expect, it } from 'vitest'
import { ClickHouseClient } from './clickhouse'
import { decodeCursor, encodeCursor, type Cursor } from './cursor'
import {
  buildAddressPage,
  buildHead,
  buildPage,
  buildStats,
  buildTxByHash,
  sortKeyOf,
  type Table,
} from './queries'
import type { Scope } from './scope'

// Ground truth for the loaded sample, cross-checked against the source CSV.
const FIRST_BLOCK = 25_534_200
const LAST_BLOCK = 25_534_299
const TOTAL_TRANSACTIONS = 40_642
const TOTAL_TRANSFERS = 43_941
const TOTAL_ETH_MOVED = '11165260460080245057022'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'

const client = new ClickHouseClient()

// Resolved at module load, not in beforeAll, so unreachable ClickHouse reports these as
// *skipped* rather than passed. A test that silently passes when its subject is absent is
// worse than no test.
const available = await client.ping()
if (!available) {
  console.warn('ClickHouse not reachable — API integration tests will be skipped')
}

const itLive = it.runIf(available)

const RANGE: Scope = { kind: 'range', from: FIRST_BLOCK, to: LAST_BLOCK }

/** Walk every page of a table with keyset pagination, returning the rows collected. */
async function walkAllPages(table: Table, pageSize: number) {
  const seen: string[] = []
  let cursor: Cursor | undefined
  let pages = 0

  for (;;) {
    const q = buildPage({ table, scope: RANGE, limit: pageSize, cursor })
    const rows = await client.query(q)
    if (rows.length === 0) break
    pages++
    for (const row of rows) {
      const k = sortKeyOf(row, table)
      seen.push(
        `${k.block_number}/${k.transaction_index}/${k.event_index ?? ''}/${k.batch_index ?? ''}`,
      )
    }
    if (rows.length < pageSize) break
    // Round-trip through the wire format, as a real client would.
    cursor = decodeCursor(
      encodeCursor({ key: sortKeyOf(rows[rows.length - 1], table), dir: 'asc' }),
    )
    if (pages > 2000) throw new Error('pagination did not terminate')
  }
  return { seen, pages }
}

describe('head', () => {
  itLive('reports the latest ingested block', async () => {
    const row = await client.queryOne<{ block: number }>(buildHead())
    expect(Number(row?.block)).toBe(LAST_BLOCK)
  })
})

describe('buildPage', () => {
  itLive('returns a page of the requested size', async () => {
    const rows = await client.query(
      buildPage({ table: 'transactions', scope: RANGE, limit: 50 }),
    )
    expect(rows).toHaveLength(50)
  })

  itLive('renders hashes and addresses as 0x hex', async () => {
    const rows = await client.query<Record<string, string>>(
      buildPage({ table: 'transactions', scope: RANGE, limit: 1 }),
    )
    expect(rows[0].transaction_hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(rows[0].from_address).toMatch(/^0x[0-9a-f]{40}$/)
  })

  itLive('returns 256-bit values as lossless decimal strings', async () => {
    const rows = await client.query<Record<string, string>>(
      buildPage({ table: 'token_transfers', scope: RANGE, limit: 500 }),
    )
    const big = rows.map((r) => r.quantity).sort((a, b) => b.length - a.length)[0]
    expect(typeof big).toBe('string')
    // A value past 2^53 must survive as text; JSON numbers would have rounded it.
    expect(BigInt(big).toString()).toBe(big)
  })

  itLive('respects a narrowed block range', async () => {
    const rows = await client.query<{ block_number: number }>(
      buildPage({
        table: 'transactions',
        scope: { kind: 'range', from: FIRST_BLOCK, to: FIRST_BLOCK },
        limit: 1000,
      }),
    )
    expect(rows.every((r) => Number(r.block_number) === FIRST_BLOCK)).toBe(true)
  })

  itLive('orders descending when asked', async () => {
    const rows = await client.query<{ block_number: number }>(
      buildPage({ table: 'transactions', scope: RANGE, limit: 5, dir: 'desc' }),
    )
    expect(Number(rows[0].block_number)).toBe(LAST_BLOCK)
  })
})

describe('keyset pagination', () => {
  itLive('walks every transaction exactly once, with no gaps or duplicates', async () => {
    const { seen, pages } = await walkAllPages('transactions', 5_000)
    expect(seen).toHaveLength(TOTAL_TRANSACTIONS)
    expect(new Set(seen).size).toBe(TOTAL_TRANSACTIONS)
    expect(pages).toBeGreaterThan(1)
  })

  itLive('walks every transfer exactly once across many small pages', async () => {
    // Small pages exercise the four-part transfer key, where a batch transfer puts
    // several rows on the same (block, tx, event) and only batch_index separates them.
    const { seen } = await walkAllPages('token_transfers', 997)
    expect(seen).toHaveLength(TOTAL_TRANSFERS)
    expect(new Set(seen).size).toBe(TOTAL_TRANSFERS)
  })

  itLive('never revisits a row when the page size divides the total evenly', async () => {
    const { seen } = await walkAllPages('transactions', 20_321)
    expect(new Set(seen).size).toBe(TOTAL_TRANSACTIONS)
  })
})

describe('buildTxByHash', () => {
  itLive('finds a transaction and includes its calldata', async () => {
    const first = await client.query<Record<string, string>>(
      buildPage({ table: 'transactions', scope: RANGE, limit: 1 }),
    )
    const hash = first[0].transaction_hash
    const row = await client.queryOne<Record<string, string>>(buildTxByHash(hash))
    expect(row?.transaction_hash).toBe(hash)
    expect(row).toHaveProperty('input')
  })

  itLive('returns nothing for an unknown hash', async () => {
    const row = await client.queryOne(buildTxByHash('0x' + 'f'.repeat(64)))
    expect(row).toBeNull()
  })
})

describe('buildAddressPage', () => {
  itLive('finds transfers where the address is the token contract', async () => {
    const rows = await client.query<Record<string, string>>(
      buildAddressPage('token_transfers', USDT, 10),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.role === 'token')).toBe(true)
  })

  itLive('finds transactions sent TO an address, not only FROM', async () => {
    // The regression guard for the UNION ALL materialized view bug: with a single
    // UNION ALL view only role='from' was ever populated, so this returned nothing.
    const rows = await client.query<Record<string, string>>(
      buildAddressPage('transactions', USDT, 50),
    )
    expect(rows.some((r) => r.role === 'to')).toBe(true)
  })

  itLive('paginates an address page by key', async () => {
    const first = await client.query<Record<string, string>>(
      buildAddressPage('token_transfers', USDT, 5),
    )
    const cursor: Cursor = {
      key: sortKeyOf(first[4], 'token_transfers'),
      dir: 'asc',
    }
    const second = await client.query<Record<string, string>>(
      buildAddressPage('token_transfers', USDT, 5, cursor),
    )
    const firstKeys = new Set(first.map((r) => `${r.block_number}/${r.event_index}`))
    expect(
      second.every((r) => !firstKeys.has(`${r.block_number}/${r.event_index}`)),
    ).toBe(true)
  })
})

describe('buildStats', () => {
  itLive('matches the fact tables exactly', async () => {
    const row = await client.queryOne<Record<string, string>>(
      buildStats(FIRST_BLOCK, LAST_BLOCK),
    )
    expect(Number(row?.blocks)).toBe(100)
    expect(Number(row?.tx_count)).toBe(TOTAL_TRANSACTIONS)
    expect(Number(row?.transfer_count)).toBe(TOTAL_TRANSFERS)
    expect(row?.eth_moved).toBe(TOTAL_ETH_MOVED)
  })

  itLive('reports a non-zero minimum gas price', async () => {
    // Zero here would mean the feeding views wrote 0 instead of the identity element.
    const row = await client.queryOne<Record<string, string>>(
      buildStats(FIRST_BLOCK, LAST_BLOCK),
    )
    expect(BigInt(row!.gas_price_min)).toBeGreaterThan(0n)
  })

  itLive('counts unique addresses across both fact tables', async () => {
    const row = await client.queryOne<Record<string, number>>(
      buildStats(FIRST_BLOCK, LAST_BLOCK),
    )
    expect(Number(row?.unique_addresses)).toBeGreaterThan(1_000)
  })
})

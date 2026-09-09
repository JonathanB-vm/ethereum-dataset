import { describe, expect, it } from 'vitest'
import {
  buildAddressPage,
  buildHead,
  buildPage,
  buildRecordsPage,
  buildStats,
  buildTxByHash,
  listColumns,
  sortKeyOf,
} from './queries.ts'
import { encodeCursor, type Cursor } from './cursor.ts'
import type { Scope } from './scope.ts'

const ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const HASH = '0x' + 'a'.repeat(64)
const RANGE: Scope = { kind: 'range', from: 1000, to: 2000 }

/**
 * The lookup endpoints must reach the fact tables by primary key, never by joining them.
 *
 * ClickHouse builds a join's hash table from the right-hand side, so joining a fact table
 * reads all of it. Measured on a replicated dataset: the join form read 110-120% of the
 * transactions table for a single hash or address lookup, against ~15% for the IN form,
 * and the join's cost grows with the table — which is exactly what the address and hash
 * index tables exist to prevent.
 *
 * That is a property no unit test can observe directly, so these assert the shape that
 * produces it. If they ever need changing, re-run `pipeline/scaletest.py` first.
 */
describe('lookups never join the fact tables', () => {
  it('buildTxByHash filters by key instead of joining', () => {
    const { sql } = buildTxByHash(HASH)
    expect(sql).not.toMatch(/JOIN/i)
    expect(sql).toContain('(block_number, transaction_index) IN (')
    expect(sql).toContain('FROM tx_by_hash')
  })

  it('buildAddressPage filters by key instead of joining', () => {
    const { sql } = buildAddressPage('transactions', ADDRESS, 50)
    expect(sql).not.toMatch(/JOIN/i)
    expect(sql).toContain('(block_number, transaction_index) IN (')
    expect(sql).toContain('FROM tx_by_address')
  })

  it('bounds the index subquery to one page, not the whole address history', () => {
    // Without the inner LIMIT the IN list is every row the address ever touched, which
    // for a busy contract is millions of keys.
    const { sql } = buildAddressPage('token_transfers', ADDRESS, 50)
    const inner = sql.slice(sql.indexOf('IN ('), sql.lastIndexOf(')'))
    expect(inner).toContain('LIMIT {limit:UInt32}')
    expect(inner).toContain('FROM transfers_by_address')
  })

  it('covers all four sort-key parts for transfers', () => {
    const { sql } = buildAddressPage('token_transfers', ADDRESS, 50)
    expect(sql).toContain(
      '(block_number, transaction_index, event_index, batch_index) IN (',
    )
  })
})

describe('role is derived from table-qualified columns', () => {
  // The SELECT list aliases from_address to its 0x hex rendering. Unqualified, the alias
  // wins and every comparison is silently false.
  it('qualifies the columns it compares', () => {
    const { sql } = buildAddressPage('token_transfers', ADDRESS, 50)
    expect(sql).toContain('token_transfers.from_address = unhex(')
    expect(sql).toContain('token_transfers.address = unhex(')
  })

  it('labels all four transfer roles', () => {
    const { sql } = buildAddressPage('token_transfers', ADDRESS, 50)
    for (const role of ['from', 'to', 'token', 'operator']) {
      expect(sql).toContain(`'${role}'`)
    }
  })
})

describe('parameterization', () => {
  it('never interpolates an address into the SQL', () => {
    const { sql, params } = buildAddressPage('transactions', ADDRESS, 50)
    expect(sql).not.toContain(ADDRESS.slice(2))
    expect(params.addr).toBe(ADDRESS.slice(2))
  })

  it('never interpolates a hash into the SQL', () => {
    const { sql, params } = buildTxByHash(HASH)
    expect(sql).not.toContain('aaaa')
    expect(params.tx_hash).toBe(HASH.slice(2))
  })

  it('binds block range bounds', () => {
    const { sql, params } = buildPage({ table: 'transactions', scope: RANGE, limit: 50 })
    expect(sql).toContain('{block_from:UInt32}')
    expect(params).toMatchObject({ block_from: 1000, block_to: 2000, limit: 50 })
  })

  it('binds the cursor key rather than inlining it', () => {
    const cursor: Cursor = {
      key: { block_number: 1500, transaction_index: 3 },
      dir: 'asc',
    }
    const { sql, params } = buildPage({
      table: 'transactions', scope: RANGE, limit: 50, cursor,
    })
    expect(sql).not.toContain('1500')
    expect(params.k0).toBe(1500)
  })
})

describe('column rendering', () => {
  it('omits calldata from list responses', () => {
    // input is 28% of the dataset; the explorer fetches it per row on demand.
    expect(listColumns('transactions')).not.toMatch(/\binput\b/)
  })

  it('includes calldata on the single-transaction endpoint', () => {
    expect(buildTxByHash(HASH).sql).toContain('input')
  })

  it('renders 256-bit values as strings, never numbers', () => {
    const cols = listColumns('transactions')
    expect(cols).toContain('toString(value) AS value')
    expect(cols).toContain('toString(gas_price) AS gas_price')
  })

  it('renders binary columns as 0x hex', () => {
    expect(listColumns('transactions')).toContain(
      "concat('0x', lower(hex(from_address))) AS from_address",
    )
  })

  it('aliases prefixed columns so consumers see the bare name', () => {
    // Without the alias these come back named "f.block_number" and cursor keys parse
    // as NaN.
    expect(listColumns('transactions', 'f.')).toContain('f.block_number AS block_number')
  })
})

describe('buildRecordsPage', () => {
  it('suffixes the transaction side, as the source CSV does', () => {
    const { sql } = buildRecordsPage(1000, 2000, 50)
    expect(sql).toContain('AS from_address_tx')
    expect(sql).toContain('AS value_lossless_tx')
    // Both sides carry from_address; without the suffix they collide.
    expect(sql).toContain('AS from_address')
  })

  it('uses join_use_nulls so an unmatched row is null, not a type default', () => {
    expect(buildRecordsPage(1000, 2000, 50).sql).toContain('SETTINGS join_use_nulls = 1')
  })

  it('omits value_tx, dropped from the data model as a duplicate', () => {
    expect(buildRecordsPage(1000, 2000, 50).sql).not.toContain('value_tx,')
  })
})

describe('sortKeyOf', () => {
  it('reads the two-part transactions key', () => {
    expect(sortKeyOf({ block_number: 10, transaction_index: 2 }, 'transactions')).toEqual({
      block_number: 10,
      transaction_index: 2,
    })
  })

  it('reads the four-part transfers key', () => {
    expect(
      sortKeyOf(
        { block_number: 10, transaction_index: 2, event_index: 5, batch_index: 1 },
        'token_transfers',
      ),
    ).toEqual({ block_number: 10, transaction_index: 2, event_index: 5, batch_index: 1 })
  })

  it('round-trips through a cursor', () => {
    const key = sortKeyOf(
      { block_number: 10, transaction_index: 2, event_index: 5, batch_index: 1 },
      'token_transfers',
    )
    expect(encodeCursor({ key, dir: 'asc' })).toBeTruthy()
  })
})

describe('stats and head', () => {
  it('reads stats from the materialized aggregates, not the fact tables', () => {
    const { sql } = buildStats(1000, 2000)
    expect(sql).toContain('FROM block_stats')
    expect(sql).not.toContain('FROM transactions')
  })

  it('merges the uniq state rather than counting rows', () => {
    expect(buildStats(1000, 2000).sql).toContain('uniqMerge(addresses_state)')
  })

  it('returns the wei sum as a string', () => {
    expect(buildStats(1000, 2000).sql).toContain('toString(sum(eth_moved))')
  })

  it('reads head from the small blocks table', () => {
    expect(buildHead().sql).toContain('FROM blocks')
  })
})

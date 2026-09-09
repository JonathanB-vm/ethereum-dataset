/**
 * Query builders.
 *
 * Every builder returns SQL plus bound parameters — no value is ever concatenated in.
 * Hex conversion happens here, at the API edge: ClickHouse stores 20- and 32-byte binary,
 * while the API speaks 0x-prefixed lowercase hex, and 256-bit numbers leave as decimal
 * strings so no precision is lost on the way to JSON.
 *
 * Spec: docs/superpowers/specs/2026-09-08-api-and-frontend.md
 */

import { keysetPredicate, type Cursor, type SortKey } from './cursor.ts'
import type { Scope } from './scope.ts'

export type Table = 'transactions' | 'token_transfers'

export const TX_SORT_COLUMNS = ['block_number', 'transaction_index'] as const
export const TRANSFER_SORT_COLUMNS = [
  'block_number',
  'transaction_index',
  'event_index',
  'batch_index',
] as const

export function sortColumnsFor(table: Table): readonly string[] {
  return table === 'transactions' ? TX_SORT_COLUMNS : TRANSFER_SORT_COLUMNS
}

/**
 * Column renderers. Each takes the table alias prefix so the same definitions serve both
 * the plain reads and the index-table joins, where an unqualified `block_number` would be
 * ambiguous.
 */
// Aliased whenever a prefix is in play: `f.block_number` would otherwise come back named
// "f.block_number", and every consumer -- cursor building included -- looks for
// "block_number".
const plain = (p: string) => (c: string) => (p ? `${p}${c} AS ${c}` : c)
const hex = (p: string) => (c: string) => `concat('0x', lower(hex(${p}${c}))) AS ${c}`
const hexNull = (p: string) => (c: string) =>
  `if(${p}${c} IS NULL, NULL, concat('0x', lower(hex(${p}${c})))) AS ${c}`
const big = (p: string) => (c: string) => `toString(${p}${c}) AS ${c}`
const bigNull = (p: string) => (c: string) =>
  `if(${p}${c} IS NULL, NULL, toString(${p}${c})) AS ${c}`

function txColumns(prefix = ''): string {
  const [id, h, hn, b, bn] = [
    plain(prefix),
    hex(prefix),
    hexNull(prefix),
    big(prefix),
    bigNull(prefix),
  ]
  return [
    id('block_number'),
    `toString(${prefix}block_timestamp) AS block_timestamp`,
    h('block_hash'),
    id('transaction_index'),
    h('transaction_hash'),
    id('nonce'),
    h('from_address'),
    hn('to_address'),
    b('value'),
    id('gas'),
    b('gas_price'),
    bn('max_fee_per_gas'),
    bn('max_priority_fee_per_gas'),
    id('transaction_type'),
    id('chain_id'),
    id('access_list'),
    h('r'),
    h('s'),
    id('v'),
    id('y_parity'),
  ].join(', ')
}

function transferColumns(prefix = ''): string {
  const [id, h, hn, b, bn] = [
    plain(prefix),
    hex(prefix),
    hexNull(prefix),
    big(prefix),
    bigNull(prefix),
  ]
  return [
    id('block_number'),
    `toString(${prefix}block_timestamp) AS block_timestamp`,
    h('block_hash'),
    id('transaction_index'),
    h('transaction_hash'),
    id('event_index'),
    id('batch_index'),
    h('address'),
    id('event_type'),
    h('event_hash'),
    id('event_signature'),
    hn('operator_address'),
    h('from_address'),
    h('to_address'),
    bn('token_id'),
    b('quantity'),
    id('removed'),
  ].join(', ')
}

/**
 * `input` is excluded from list responses on purpose: it is 28% of the dataset's bytes and
 * the explorer fetches it per row on demand, exactly as the CSV build does today.
 */
export function listColumns(table: Table, prefix = ''): string {
  return table === 'transactions' ? txColumns(prefix) : transferColumns(prefix)
}

export interface BuiltQuery {
  sql: string
  params: Record<string, string | number>
}

export interface PageRequest {
  table: Table
  scope: Scope
  limit: number
  cursor?: Cursor
  dir?: 'asc' | 'desc'
}

function scopePredicate(scope: Scope): BuiltQuery {
  switch (scope.kind) {
    case 'range':
      return {
        sql: 'block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}',
        params: { block_from: scope.from, block_to: scope.to },
      }
    case 'txHash':
      return {
        sql: 'transaction_hash = unhex({tx_hash:String})',
        params: { tx_hash: scope.hash.slice(2) },
      }
    case 'address':
      // Address scopes are served by buildAddressPage, which uses the index table.
      return {
        sql: 'from_address = unhex({addr:String})',
        params: { addr: scope.address.slice(2) },
      }
  }
}

/** A page of rows within a bounded scope, paginated by key. */
export function buildPage(req: PageRequest): BuiltQuery {
  const columns = sortColumnsFor(req.table)
  const dir = req.cursor?.dir ?? req.dir ?? 'asc'

  const where: string[] = []
  const params: Record<string, string | number> = {}

  const scope = scopePredicate(req.scope)
  where.push(scope.sql)
  Object.assign(params, scope.params)

  if (req.cursor) {
    const keyset = keysetPredicate(req.cursor, columns)
    where.push(keyset.sql)
    Object.assign(params, keyset.params)
  }

  params.limit = req.limit
  const order = columns.map((c) => `${c} ${dir.toUpperCase()}`).join(', ')

  return {
    sql:
      `SELECT ${listColumns(req.table)} FROM ${req.table} ` +
      `WHERE ${where.join(' AND ')} ` +
      `ORDER BY ${order} LIMIT {limit:UInt32}`,
    params,
  }
}

/**
 * Transactions or transfers touching an address, via the address index table.
 *
 * Two primary-key reads rather than a scan: the index table sorted by address, then the
 * fact table by its own key. Bloom filters alone would take seconds over a year because
 * addresses do not correlate with the primary key.
 */
export function buildAddressPage(
  table: Table,
  address: string,
  limit: number,
  cursor?: Cursor,
): BuiltQuery {
  const indexTable = table === 'transactions' ? 'tx_by_address' : 'transfers_by_address'
  const columns = sortColumnsFor(table)
  const join = columns.map((c) => `f.${c} = i.${c}`).join(' AND ')

  const where = ['i.address = unhex({addr:String})']
  const params: Record<string, string | number> = { addr: address.slice(2), limit }

  if (cursor) {
    const keyset = keysetPredicate(
      cursor,
      columns.map((c) => `i.${c}`),
    )
    where.push(keyset.sql)
    Object.assign(params, keyset.params)
  }

  return {
    sql:
      `SELECT ${listColumns(table, 'f.')}, i.role AS role ` +
      `FROM ${indexTable} i INNER JOIN ${table} f ON ${join} ` +
      `WHERE ${where.join(' AND ')} ` +
      `ORDER BY ${columns.map((c) => `i.${c}`).join(', ')} LIMIT {limit:UInt32}`,
    params,
  }
}

/** One transaction by hash, through the hash lookup table. Includes calldata. */
export function buildTxByHash(hash: string): BuiltQuery {
  return {
    sql:
      `SELECT ${listColumns('transactions', 'f.')}, f.input AS input ` +
      'FROM tx_by_hash k INNER JOIN transactions f ' +
      'ON f.block_number = k.block_number AND f.transaction_index = k.transaction_index ' +
      'WHERE k.transaction_hash = unhex({tx_hash:String})',
    params: { tx_hash: hash.slice(2) },
  }
}

/** Stats for a block range, read from the materialized aggregates. */
export function buildStats(from: number, to: number): BuiltQuery {
  return {
    sql:
      'SELECT count() AS blocks, sum(tx_count) AS tx_count, ' +
      'sum(transfer_count) AS transfer_count, sum(erc20_count) AS erc20_count, ' +
      'sum(erc721_count) AS erc721_count, sum(erc1155_count) AS erc1155_count, ' +
      'toString(sum(eth_moved)) AS eth_moved, ' +
      'toString(min(gas_price_min)) AS gas_price_min, ' +
      'toString(max(gas_price_max)) AS gas_price_max, ' +
      'uniqMerge(addresses_state) AS unique_addresses ' +
      'FROM block_stats ' +
      'WHERE block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}',
    params: { block_from: from, block_to: to },
  }
}

/** Latest ingested block, for the explorer's "current to block N" badge. */
export function buildHead(): BuiltQuery {
  return {
    sql:
      'SELECT max(block_number) AS block, toString(max(block_timestamp)) AS timestamp ' +
      'FROM blocks',
    params: {},
  }
}

/** The sort key of a row, for building the next page's cursor. */
export function sortKeyOf(row: Record<string, unknown>, table: Table): SortKey {
  const key: SortKey = {
    block_number: Number(row.block_number),
    transaction_index: Number(row.transaction_index),
  }
  if (table === 'token_transfers') {
    key.event_index = Number(row.event_index)
    key.batch_index = Number(row.batch_index)
  }
  return key
}

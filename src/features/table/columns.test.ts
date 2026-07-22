import { describe, it, expect } from 'vitest'
import { columnDisplayLabel, getColumnsForTab } from './columns'
import { COLUMNS } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'

/** Every accessor column here is built with `helper.accessor(field, {...})`, which sets
 *  `accessorKey` to the field name (no explicit `id` — TanStack derives that later, at
 *  table-build time). Reading `accessorKey` off the raw ColumnDef is what lets these tests
 *  assert on field order/identity without spinning up a full `useReactTable` instance. */
function fields(defs: ReturnType<typeof getColumnsForTab>): (keyof EthRecord)[] {
  return defs.map((d) => {
    if (!('accessorKey' in d) || d.accessorKey == null) {
      throw new Error(`column def missing accessorKey: ${JSON.stringify(d)}`)
    }
    return d.accessorKey as keyof EthRecord
  })
}

describe('getColumnsForTab', () => {
  it("'all' returns exactly the 35 dictionary columns, in CSV order", () => {
    const defs = getColumnsForTab('all')
    expect(defs).toHaveLength(35)
    expect(fields(defs)).toEqual(COLUMNS.map((c) => c.field))
  })

  it("'transfers' returns the 9 curated transfer columns, in the spec'd order", () => {
    const defs = getColumnsForTab('transfers')
    expect(defs).toHaveLength(9)
    expect(fields(defs)).toEqual([
      'block_timestamp',
      'transaction_hash',
      'event_type',
      'address',
      'from_address',
      'to_address',
      'quantity',
      'token_id',
      'event_index',
    ])
  })

  it("'transactions' returns the 10 curated transaction columns, in the spec'd order", () => {
    const defs = getColumnsForTab('transactions')
    expect(defs).toHaveLength(10)
    expect(fields(defs)).toEqual([
      'block_timestamp',
      'transaction_index',
      'transaction_hash',
      'from_address_tx',
      'to_address_tx',
      'value_lossless_tx',
      'gas_price_tx',
      'gas_tx',
      'nonce_tx',
      'type_tx',
    ])
  })

  it("attaches the 'bignum' sortingFn to quantity, value_lossless_tx, and gas_price_tx only", () => {
    const byField = (defs: ReturnType<typeof getColumnsForTab>, field: keyof EthRecord) =>
      defs.find((d) => 'accessorKey' in d && d.accessorKey === field)

    const quantity = byField(getColumnsForTab('transfers'), 'quantity')
    const tokenId = byField(getColumnsForTab('transfers'), 'token_id')
    const valueEth = byField(getColumnsForTab('transactions'), 'value_lossless_tx')
    const gasPrice = byField(getColumnsForTab('transactions'), 'gas_price_tx')
    const gasLimit = byField(getColumnsForTab('transactions'), 'gas_tx')

    expect(quantity?.sortingFn).toBe('bignum')
    expect(valueEth?.sortingFn).toBe('bignum')
    expect(gasPrice?.sortingFn).toBe('bignum')

    // Negative check: a neighboring bignum-*kind* field (token_id) and a plain number
    // field (gas_tx) must NOT have picked up 'bignum' just by being adjacent/similar —
    // it's only wired for the three columns the brief calls out.
    expect(tokenId?.sortingFn).toBeUndefined()
    expect(gasLimit?.sortingFn).toBeUndefined()
  })
})

describe('columnDisplayLabel', () => {
  it('uses unit-specific labels on the transactions tab (cells are ETH/Gwei there)', () => {
    expect(columnDisplayLabel('value_lossless_tx', 'transactions')).toBe('Value ETH')
    expect(columnDisplayLabel('gas_price_tx', 'transactions')).toBe('Gas Price Gwei')
  })

  it("uses the raw dictionary labels on 'all' (cells are raw wei there)", () => {
    expect(columnDisplayLabel('value_lossless_tx', 'all')).toBe('Value (lossless)')
    expect(columnDisplayLabel('gas_price_tx', 'all')).toBe('Gas Price')
  })

  it('falls back to the dictionary label for non-overridden fields on every tab', () => {
    expect(columnDisplayLabel('quantity', 'transfers')).toBe('Quantity')
    expect(columnDisplayLabel('quantity', 'all')).toBe('Quantity')
  })
})

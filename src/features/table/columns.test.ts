import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import type { Column } from '@tanstack/react-table'
import { columnDisplayLabel, getColumnsForTab } from './columns'
import { LOADED_COLUMNS } from '../../data/dictionary'
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
  it("'all' returns exactly the 34 loaded dictionary columns, in CSV order", () => {
    const defs = getColumnsForTab('all')
    expect(defs).toHaveLength(34)
    expect(fields(defs)).toEqual(LOADED_COLUMNS.map((c) => c.field))
    expect(fields(defs)).not.toContain('input_tx')
  })

  it("'transfers' returns the 10 curated transfer columns, in the spec'd order", () => {
    const defs = getColumnsForTab('transfers')
    expect(defs).toHaveLength(10)
    expect(fields(defs)).toEqual([
      'block_timestamp',
      'block_number',
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

  it("'transactions' returns the 11 curated transaction columns, in the spec'd order", () => {
    const defs = getColumnsForTab('transactions')
    expect(defs).toHaveLength(11)
    expect(fields(defs)).toEqual([
      'block_timestamp',
      'block_number',
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

  it("attaches the 'bignum' sortingFn to quantity, token_id, value_lossless_tx, and gas_price_tx", () => {
    const byField = (defs: ReturnType<typeof getColumnsForTab>, field: keyof EthRecord) =>
      defs.find((d) => 'accessorKey' in d && d.accessorKey === field)

    const quantity = byField(getColumnsForTab('transfers'), 'quantity')
    const tokenId = byField(getColumnsForTab('transfers'), 'token_id')
    const valueEth = byField(getColumnsForTab('transactions'), 'value_lossless_tx')
    const gasPrice = byField(getColumnsForTab('transactions'), 'gas_price_tx')
    const gasLimit = byField(getColumnsForTab('transactions'), 'gas_tx')

    expect(quantity?.sortingFn).toBe('bignum')
    // token_id is also a bignum-kind field (a big-number STRING) — it must sort via the
    // BigInt-aware comparator too, not TanStack's default alphanumeric fallback.
    expect(tokenId?.sortingFn).toBe('bignum')
    expect(valueEth?.sortingFn).toBe('bignum')
    expect(gasPrice?.sortingFn).toBe('bignum')

    // Negative check: a plain number field (gas_tx) must NOT have picked up 'bignum' — it's
    // a real JS number under the hood, so the default sort is already correct for it.
    expect(gasLimit?.sortingFn).toBeUndefined()
  })

  it("'all' tab: every column whose dictionary kind is 'bignum' carries sortingFn 'bignum', and no other column does", () => {
    const defs = getColumnsForTab('all')
    const byField = (field: keyof EthRecord) => defs.find((d) => 'accessorKey' in d && d.accessorKey === field)
    const expectedBignumFields = new Set(LOADED_COLUMNS.filter((c) => c.kind === 'bignum').map((c) => c.field))

    for (const meta of LOADED_COLUMNS) {
      const def = byField(meta.field)
      if (expectedBignumFields.has(meta.field)) {
        expect(def?.sortingFn, `${String(meta.field)} (kind: bignum) should sort via 'bignum'`).toBe('bignum')
      } else {
        expect(def?.sortingFn, `${String(meta.field)} (kind: ${meta.kind}) should not sort via 'bignum'`).toBeUndefined()
      }
    }
  })

  it('block_number is range-filterable on both curated tabs and on all', () => {
    for (const tab of ['transfers', 'transactions', 'all'] as const) {
      const def = getColumnsForTab(tab).find(
        (d) => 'accessorKey' in d && d.accessorKey === 'block_number',
      )
      expect(def, `block_number missing from the ${tab} tab`).toBeDefined()
      expect(def?.filterFn).toBe('range')
    }
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

/**
 * Resolves the label a def's header renderer will *actually* display — not the
 * columnDisplayLabel utility, but the real ColumnDef path: invoke the def's `header`
 * function (safe with a stub column — it only creates elements, never reads the column
 * until render) and read the `label` prop off the SortableHeader element it returns
 * (the second child of the `.col-header-cell` wrapper — the ⓘ info trigger sits first).
 */
function headerLabel(tab: Parameters<typeof getColumnsForTab>[0], field: keyof EthRecord): string {
  const def = getColumnsForTab(tab).find((d) => 'accessorKey' in d && d.accessorKey === field)
  if (!def || typeof def.header !== 'function') {
    throw new Error(`no function header for ${String(field)} on tab ${tab}`)
  }
  // Task 7's header() now also reads `table.getState().sorting.length` (for SortableHeader's
  // `sortCount` prop) directly in the render function body, not deferred until SortableHeader
  // itself renders — so the stub context needs a minimal `table` alongside the stub `column`.
  const el = def.header({
    column: {} as Column<EthRecord, unknown>,
    table: { getState: () => ({ sorting: [] }) } as never,
  } as never) as ReactElement
  const children = (el.props as { children: ReactElement[] }).children
  return (children[1].props as { label: string }).label
}

describe('column-def header labels (the rendered path, not just the utility)', () => {
  it('transactions defs render unit-specific labels for the two converted columns', () => {
    expect(headerLabel('transactions', 'value_lossless_tx')).toBe('Value ETH')
    expect(headerLabel('transactions', 'gas_price_tx')).toBe('Gas Price Gwei')
  })

  it("'all' defs render the raw dictionary labels for those same fields", () => {
    expect(headerLabel('all', 'value_lossless_tx')).toBe('Value (lossless)')
    expect(headerLabel('all', 'gas_price_tx')).toBe('Gas Price')
  })

  it('non-overridden fields render their dictionary label on every tab', () => {
    expect(headerLabel('transfers', 'quantity')).toBe('Quantity')
    expect(headerLabel('all', 'quantity')).toBe('Quantity')
    expect(headerLabel('transactions', 'gas_tx')).toBe('Gas Limit')
  })
})

/** `sortDescFirst` lives directly on the ColumnDef, so it can be read off without a table instance. */
function descFirst(defs: ReturnType<typeof getColumnsForTab>, field: string): boolean | undefined {
  const def = defs.find((d) => 'accessorKey' in d && d.accessorKey === field)
  if (!def) throw new Error(`no column def for ${field}`)
  return def.sortDescFirst
}

describe('first-click sort direction', () => {
  it('descends first on magnitude columns, so the interesting rows land on page 1', () => {
    expect(descFirst(getColumnsForTab('transfers'), 'quantity')).toBe(true)
    expect(descFirst(getColumnsForTab('transactions'), 'value_lossless_tx')).toBe(true)
    expect(descFirst(getColumnsForTab('transactions'), 'gas_price_tx')).toBe(true)
    expect(descFirst(getColumnsForTab('transactions'), 'gas_tx')).toBe(true)
  })

  it('ascends first on positions, counters and identifiers', () => {
    expect(descFirst(getColumnsForTab('transfers'), 'block_number')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transfers'), 'event_index')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transfers'), 'token_id')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transactions'), 'nonce_tx')).toBeFalsy()
    expect(descFirst(getColumnsForTab('transactions'), 'transaction_index')).toBeFalsy()
  })

  it('applies the same rule on the All Records tab', () => {
    const all = getColumnsForTab('all')
    expect(descFirst(all, 'max_fee_per_gas_tx')).toBe(true)
    expect(descFirst(all, 'max_priority_fee_per_gas_tx')).toBe(true)
    expect(descFirst(all, 'value_tx')).toBe(true)
    expect(descFirst(all, 'chain_id_tx')).toBeFalsy()
  })
})

import { describe, it, expect } from 'vitest'
import { COLUMNS, LOADED_COLUMNS, getColumnMeta } from './dictionary'

describe('column dictionary', () => {
  it('documents all 36 fields — 35 dataset columns in CSV order, plus one derived', () => {
    expect(COLUMNS).toHaveLength(36)
    expect(COLUMNS[0].field).toBe('block_hash')
    expect(COLUMNS[35].field).toBe('is_token_transfer')
  })

  it('every column has a non-empty description and a source', () => {
    for (const c of COLUMNS) {
      expect(c.description.length).toBeGreaterThan(10)
      expect(['token_transfers', 'transactions', 'both', 'derived']).toContain(c.source)
    }
  })

  it('looks up by field name', () => {
    expect(getColumnMeta('gas_price_tx')?.source).toBe('transactions')
    expect(getColumnMeta('event_type')?.source).toBe('token_transfers')
    expect(getColumnMeta('block_hash')?.source).toBe('both')
    expect(getColumnMeta('nope')).toBeUndefined()
  })

  it('marks exactly one field as on-demand, and it is input_tx', () => {
    const onDemand = COLUMNS.filter((c) => c.availability === 'on-demand')
    expect(onDemand).toHaveLength(1)
    expect(onDemand[0].field).toBe('input_tx')
  })

  it('marks exactly one field as derived, and it is normalized_quantity', () => {
    const derived = COLUMNS.filter((c) => c.availability === 'derived')
    expect(derived).toHaveLength(1)
    expect(derived[0].field).toBe('normalized_quantity')
  })

  it('every column declares a valid availability', () => {
    for (const c of COLUMNS) {
      expect(['loaded', 'on-demand', 'derived']).toContain(c.availability)
    }
  })

  it('LOADED_COLUMNS is the 34 in-memory columns, in CSV order, without input_tx', () => {
    expect(LOADED_COLUMNS).toHaveLength(34)
    expect(LOADED_COLUMNS.map((c) => c.field)).not.toContain('input_tx')
    expect(LOADED_COLUMNS.every((c) => c.availability === 'loaded')).toBe(true)
    expect(LOADED_COLUMNS.map((c) => c.field)).toEqual(
      COLUMNS.filter((c) => c.availability === 'loaded').map((c) => c.field),
    )
  })
})

describe('normalized_quantity dictionary entry', () => {
  it('is documented as a derived column', () => {
    const meta = getColumnMeta('normalized_quantity')
    expect(meta).toBeDefined()
    expect(meta?.label).toBe('Normalized Quantity')
    expect(meta?.source).toBe('derived')
    expect(meta?.availability).toBe('derived')
    expect(meta?.kind).toBe('bignum')
  })

  it('stays out of LOADED_COLUMNS, which must only hold real EthRecord fields', () => {
    // LOADED_COLUMNS drives global search, column stats and the all-columns export — all of
    // which read record[field]. A derived field has no value to read.
    expect(LOADED_COLUMNS.map((c) => c.field)).not.toContain('normalized_quantity')
    expect(LOADED_COLUMNS).toHaveLength(34)
  })

  it('sits immediately after quantity in COLUMNS order', () => {
    const fields = COLUMNS.map((c) => c.field)
    expect(fields[fields.indexOf('quantity') + 1]).toBe('normalized_quantity')
  })
})

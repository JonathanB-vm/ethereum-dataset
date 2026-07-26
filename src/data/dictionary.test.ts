import { describe, it, expect } from 'vitest'
import { COLUMNS, LOADED_COLUMNS, getColumnMeta } from './dictionary'

describe('column dictionary', () => {
  it('documents all 35 CSV columns in CSV order', () => {
    expect(COLUMNS).toHaveLength(35)
    expect(COLUMNS[0].field).toBe('block_hash')
    expect(COLUMNS[34].field).toBe('is_token_transfer')
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

  it('every column declares a valid availability', () => {
    for (const c of COLUMNS) {
      expect(['loaded', 'on-demand']).toContain(c.availability)
    }
  })

  it('LOADED_COLUMNS is the 34 in-memory columns, in CSV order, without input_tx', () => {
    expect(LOADED_COLUMNS).toHaveLength(34)
    expect(LOADED_COLUMNS.map((c) => c.field)).not.toContain('input_tx')
    expect(LOADED_COLUMNS.every((c) => c.availability === 'loaded')).toBe(true)
    expect(LOADED_COLUMNS.map((c) => c.field)).toEqual(
      COLUMNS.filter((c) => c.field !== 'input_tx').map((c) => c.field),
    )
  })
})

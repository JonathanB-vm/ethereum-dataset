import { describe, it, expect } from 'vitest'
import { COLUMNS, getColumnMeta } from './dictionary'

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
})

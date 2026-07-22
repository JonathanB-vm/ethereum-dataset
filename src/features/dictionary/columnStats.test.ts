import { describe, it, expect } from 'vitest'
import { computeColumnStats } from './columnStats'
import type { EthRecord } from '../../data/types'

const BASE: EthRecord = {
  block_hash: '0xb', block_number: 25534300, block_timestamp: '2026-07-14 23:55:11+00:00',
  transaction_hash: '0xt1', transaction_index: 0, event_index: null, batch_index: null,
  address: null, event_type: null, event_hash: null, event_signature: null,
  operator_address: null, from_address: null, to_address: null, token_id: null,
  quantity: null, removed: null, nonce_tx: null, from_address_tx: null, to_address_tx: null,
  value_tx: null, value_lossless_tx: null, gas_tx: null, gas_price_tx: null, input_tx: null,
  max_fee_per_gas_tx: null, max_priority_fee_per_gas_tx: null, type_tx: null,
  chain_id_tx: null, access_list_tx: null, r_tx: null, s_tx: null, v_tx: null,
  y_parity_tx: null, is_token_transfer: false,
}
const mk = (p: Partial<EthRecord>): EthRecord => ({ ...BASE, ...p })

describe('computeColumnStats', () => {
  it('computes fill rate as the non-null fraction over total', () => {
    const s = computeColumnStats(
      [mk({ gas_tx: 21000 }), mk({ gas_tx: null }), mk({ gas_tx: 30000 }), mk({ gas_tx: null })],
      'gas_tx',
    )
    expect(s.fillRate).toBeCloseTo(0.5)
  })

  it('fill rate is 1 when every row has a value, and 0 for an empty dataset', () => {
    expect(computeColumnStats([mk({ gas_tx: 1 }), mk({ gas_tx: 2 })], 'gas_tx').fillRate).toBe(1)
    expect(computeColumnStats([], 'gas_tx').fillRate).toBe(0)
  })

  it('counts distinct non-null values', () => {
    const s = computeColumnStats(
      [
        mk({ event_type: 'ERC-20' }),
        mk({ event_type: 'ERC-20' }),
        mk({ event_type: 'ERC-721' }),
        mk({ event_type: null }),
      ],
      'event_type',
    )
    expect(s.distinct).toBe(2)
  })

  it('computes numeric min/max on a bignum field using BigInt order, not lexicographic order', () => {
    // Lexicographically '10' < '2' < '9' — a naive string compare would report min='10',
    // max='9'. Numeric order must give min='2', max='10'.
    const s = computeColumnStats(
      [
        mk({ value_lossless_tx: '9' }),
        mk({ value_lossless_tx: '10' }),
        mk({ value_lossless_tx: '2' }),
      ],
      'value_lossless_tx',
    )
    expect(s.min).toBe('2')
    expect(s.max).toBe('10')
  })

  it('computes numeric min/max on a plain number-kind field', () => {
    const s = computeColumnStats(
      [mk({ block_number: 9 }), mk({ block_number: 10 }), mk({ block_number: 2 })],
      'block_number',
    )
    expect(s.min).toBe('2')
    expect(s.max).toBe('10')
  })

  it('does not compute min/max for hex-kind fields', () => {
    const s = computeColumnStats(
      [mk({ transaction_hash: '0x9' }), mk({ transaction_hash: '0x10' })],
      'transaction_hash',
    )
    expect(s.min).toBeUndefined()
    expect(s.max).toBeUndefined()
  })

  it('does not compute min/max for enum/boolean/text/address kinds', () => {
    expect(computeColumnStats([mk({ event_type: 'ERC-20' })], 'event_type').min).toBeUndefined()
    expect(computeColumnStats([mk({ removed: true })], 'removed').min).toBeUndefined()
    expect(computeColumnStats([mk({ address: '0xa' })], 'address').min).toBeUndefined()
    expect(computeColumnStats([mk({ event_signature: 'Transfer(...)' })], 'event_signature').min).toBeUndefined()
  })

  it('min/max are undefined for a numeric field with no non-null values', () => {
    const s = computeColumnStats([mk({ gas_tx: null }), mk({ gas_tx: null })], 'gas_tx')
    expect(s.min).toBeUndefined()
    expect(s.max).toBeUndefined()
  })
})

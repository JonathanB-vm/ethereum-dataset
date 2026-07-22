import { describe, it, expect } from 'vitest'
import { computeStats } from './computeStats'
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

describe('computeStats', () => {
  it('splits row kinds and counts event types', () => {
    const s = computeStats([
      mk({}),
      mk({ transaction_hash: '0xt2', is_token_transfer: true, event_type: 'ERC-20' }),
      mk({ transaction_hash: '0xt3', is_token_transfer: true, event_type: 'ERC-20' }),
      mk({ transaction_hash: '0xt4', is_token_transfer: true, event_type: 'ERC-721' }),
    ])
    expect(s.totalRecords).toBe(4)
    expect(s.txCount).toBe(1)
    expect(s.transferCount).toBe(3)
    expect(s.eventTypeCounts).toEqual([
      { type: 'ERC-20', count: 2 },
      { type: 'ERC-721', count: 1 },
    ])
  })

  it('sums ETH over unique tx hashes only', () => {
    const s = computeStats([
      mk({ transaction_hash: '0xa', value_lossless_tx: '2000000000000000000' }),
      mk({ transaction_hash: '0xa', value_lossless_tx: '2000000000000000000', is_token_transfer: true }),
      mk({ transaction_hash: '0xb2', value_lossless_tx: '500000000000000000' }),
    ])
    expect(s.totalEthMoved).toBe('2.5')
  })

  it('computes gas price range in gwei over unique txs', () => {
    const s = computeStats([
      mk({ transaction_hash: '0xa', gas_price_tx: '2000000000' }),
      mk({ transaction_hash: '0xb2', gas_price_tx: '58631115' }),
    ])
    expect(s.gasPriceMinGwei).toBe('0.05')
    expect(s.gasPriceMaxGwei).toBe('2')
  })

  it('counts unique addresses across all address fields', () => {
    const s = computeStats([
      mk({ from_address_tx: '0x1', to_address_tx: '0x2' }),
      mk({ transaction_hash: '0xt9', is_token_transfer: true, from_address: '0x2', to_address: '0x3', address: '0x4' }),
    ])
    expect(s.uniqueAddresses).toBe(4)
  })

  it('handles empty input', () => {
    const s = computeStats([])
    expect(s.blockNumber).toBeNull()
    expect(s.gasPriceMinGwei).toBeNull()
    expect(s.totalEthMoved).toBe('0')
  })
})

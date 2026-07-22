import { describe, it, expect } from 'vitest'
import { enumFilter, globalFilterFn, rangeFilter, textFilter } from './filters'
import type { EthRecord } from '../../data/types'

// UINT256_MAX — the top of the 256-bit numeric range these BigQuery numeric-string
// columns (quantity, value_lossless_tx, gas_price_tx, …) can legally hold. Any filter
// logic that routes through `Number`/`parseFloat` loses precision well before this and
// would silently miscompare — these fixtures are chosen specifically to catch that.
const UINT256_MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const UINT256_MAX_MINUS_1 = '115792089237316195423570985008687907853269984665640564039457584007913129639934'

function makeRecord(overrides: Partial<EthRecord> = {}): EthRecord {
  return {
    block_hash: '0xblockhash',
    block_number: 25534300,
    block_timestamp: '2026-07-14 23:55:11+00:00',
    transaction_hash: '0xabc123',
    transaction_index: 1,
    event_index: null,
    batch_index: null,
    address: null,
    event_type: null,
    event_hash: null,
    event_signature: null,
    operator_address: null,
    from_address: null,
    to_address: null,
    token_id: null,
    quantity: null,
    removed: null,
    nonce_tx: null,
    from_address_tx: null,
    to_address_tx: null,
    value_tx: null,
    value_lossless_tx: null,
    gas_tx: null,
    gas_price_tx: null,
    input_tx: null,
    max_fee_per_gas_tx: null,
    max_priority_fee_per_gas_tx: null,
    type_tx: null,
    chain_id_tx: null,
    access_list_tx: null,
    r_tx: null,
    s_tx: null,
    v_tx: null,
    y_parity_tx: null,
    is_token_transfer: false,
    ...overrides,
  }
}

describe('textFilter', () => {
  it('matches a case-insensitive substring', () => {
    expect(textFilter('0xAbC123', 'abc')).toBe(true)
  })

  it('rejects a non-matching substring', () => {
    expect(textFilter('0xAbC123', 'zzz')).toBe(false)
  })

  it('an empty query passes everything', () => {
    expect(textFilter('anything', '')).toBe(true)
    expect(textFilter(null, '')).toBe(true)
  })

  it('a null value fails a non-empty query', () => {
    expect(textFilter(null, 'abc')).toBe(false)
  })
})

describe('rangeFilter', () => {
  it('min-only: passes values >= min, rejects values < min, at 256-bit precision', () => {
    expect(rangeFilter(UINT256_MAX, { min: UINT256_MAX_MINUS_1 })).toBe(true)
    expect(rangeFilter(UINT256_MAX_MINUS_1, { min: UINT256_MAX })).toBe(false)
  })

  it('max-only: passes values <= max, rejects values > max, at 256-bit precision', () => {
    expect(rangeFilter(UINT256_MAX_MINUS_1, { max: UINT256_MAX })).toBe(true)
    expect(rangeFilter(UINT256_MAX, { max: UINT256_MAX_MINUS_1 })).toBe(false)
  })

  it('both bounds — inclusive boundaries, exclusive outside', () => {
    expect(rangeFilter('10', { min: '10', max: '100' })).toBe(true)
    expect(rangeFilter('100', { min: '10', max: '100' })).toBe(true)
    expect(rangeFilter('9', { min: '10', max: '100' })).toBe(false)
    expect(rangeFilter('101', { min: '10', max: '100' })).toBe(false)
  })

  it('no bounds set passes everything, including a null value', () => {
    expect(rangeFilter(null, {})).toBe(true)
    expect(rangeFilter('123', {})).toBe(true)
  })

  it('a null value fails an active range', () => {
    expect(rangeFilter(null, { min: '1' })).toBe(false)
  })

  it('accepts a plain-number column value (not just numeric strings)', () => {
    expect(rangeFilter(42, { min: '10', max: '100' })).toBe(true)
    expect(rangeFilter(5, { min: '10', max: '100' })).toBe(false)
  })
})

describe('enumFilter', () => {
  it('an empty selection passes everything', () => {
    expect(enumFilter([], 'ERC-20')).toBe(true)
    expect(enumFilter([], null)).toBe(true)
  })

  it('matches a selected string value, rejects an unselected one', () => {
    expect(enumFilter(['ERC-20'], 'ERC-20')).toBe(true)
    expect(enumFilter(['ERC-20'], 'ERC-721')).toBe(false)
  })

  it('stringifies booleans as True/False to match the checkbox labels', () => {
    expect(enumFilter(['True'], true)).toBe(true)
    expect(enumFilter(['False'], true)).toBe(false)
    expect(enumFilter(['False'], false)).toBe(true)
  })

  it('a null value fails an active selection', () => {
    expect(enumFilter(['ERC-20'], null)).toBe(false)
  })
})

describe('globalFilterFn', () => {
  it('matches a fragment of a hash field', () => {
    const record = makeRecord({ transaction_hash: '0xdeadbeef00', event_hash: '0xfeedface' })
    expect(globalFilterFn(record, 'deadbeef')).toBe(true)
  })

  it('rejects a query present nowhere in the record', () => {
    const record = makeRecord({ transaction_hash: '0xdeadbeef00' })
    expect(globalFilterFn(record, 'nomatchvalue')).toBe(false)
  })

  it('is case-insensitive', () => {
    const record = makeRecord({ from_address: '0xABCDEF' })
    expect(globalFilterFn(record, 'abcdef')).toBe(true)
  })

  it('an empty query passes everything', () => {
    expect(globalFilterFn(makeRecord(), '')).toBe(true)
  })

  it('matches numeric and boolean fields too, not just strings', () => {
    const record = makeRecord({ block_number: 25534300, is_token_transfer: true })
    expect(globalFilterFn(record, '25534300')).toBe(true)
  })
})

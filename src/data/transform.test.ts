import { describe, it, expect } from 'vitest'
import {
  weiToEth, weiToGwei, formatTimestamp, truncateHex,
  formatBigInt, compareNumericStrings, toBigInt,
} from './transform'

describe('toBigInt', () => {
  it('parses plain integer strings', () => expect(toBigInt('123')).toBe(123n))
  it('strips BigQuery trailing decimals', () => expect(toBigInt('84858226069838.0')).toBe(84858226069838n))
  it('handles 256-bit values losslessly', () =>
    expect(toBigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935'))
      .toBe(2n ** 256n - 1n))
  it('returns null for null/empty', () => {
    expect(toBigInt(null)).toBeNull()
    expect(toBigInt('')).toBeNull()
  })
})

describe('weiToEth', () => {
  it('converts wei to ETH', () => expect(weiToEth('1000000000000000000')).toBe('1'))
  it('shows up to 6 decimals, trimmed', () => expect(weiToEth('84858226069838.0')).toBe('0.000084'))
  it('handles zero', () => expect(weiToEth('0')).toBe('0'))
  it('null passthrough', () => expect(weiToEth(null)).toBeNull())
})

describe('weiToGwei', () => {
  it('converts wei to gwei with ≤2 decimals', () => expect(weiToGwei('2063407496')).toBe('2.06'))
  it('whole gwei has no decimals', () => expect(weiToGwei('2000000000')).toBe('2'))
})

describe('formatTimestamp', () => {
  it('renders UTC human form', () =>
    expect(formatTimestamp('2026-07-14 23:55:11+00:00')).toBe('2026-07-14 23:55:11 UTC'))
})

describe('truncateHex', () => {
  it('truncates long hex', () =>
    expect(truncateHex('0x0058db6926d4d88a6595b82e177bdcb2be8579b96e895ceaa90e7cbfce236fc5'))
      .toBe('0x0058…6fc5'))
  it('leaves short values alone', () => expect(truncateHex('0x1')).toBe('0x1'))
})

describe('formatBigInt', () => {
  it('adds thousands separators', () => expect(formatBigInt('25534300')).toBe('25,534,300'))
  it('null passthrough', () => expect(formatBigInt(null)).toBeNull())
})

describe('compareNumericStrings', () => {
  it('compares as numbers not strings', () =>
    expect(compareNumericStrings('9', '10')).toBeLessThan(0))
  it('handles 256-bit values', () =>
    expect(compareNumericStrings('115792089237316195423570985008687907853269984665640564039457584007913129639935', '1'))
      .toBeGreaterThan(0))
  it('sorts nulls last', () => {
    expect(compareNumericStrings(null, '0')).toBeGreaterThan(0)
    expect(compareNumericStrings('0', null)).toBeLessThan(0)
  })
})

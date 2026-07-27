import { describe, it, expect } from 'vitest'
import {
  weiToEth, weiToGwei, formatTimestamp, truncateHex, truncateMiddle,
  formatBigInt, compareNumericStrings, toBigInt, decimalToWei,
  isValidDecimals, normalizeQuantity, formatNormalizedQuantity, compareNormalizedQuantity,
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

describe('truncateMiddle', () => {
  it('keeps the head and tail of a long value with … between', () => {
    const input = '0x' + 'ab'.repeat(100) // 202 chars of calldata-like hex
    const out = truncateMiddle(input)
    expect(out).toBe(`${input.slice(0, 24)}…${input.slice(-12)}`)
    expect(out).toHaveLength(24 + 1 + 12)
  })
  it('leaves short values alone', () => expect(truncateMiddle('0xdeadbeef')).toBe('0xdeadbeef'))
  it('does not "truncate" when nothing would be saved (boundary length)', () => {
    const exact = 'a'.repeat(24 + 12 + 1) // 37 chars — same length as the truncated form
    expect(truncateMiddle(exact)).toBe(exact)
    const oneOver = 'a'.repeat(24 + 12 + 2)
    expect(truncateMiddle(oneOver)).toBe(`${'a'.repeat(24)}…${'a'.repeat(12)}`)
  })
  it('honors custom head/tail lengths', () =>
    expect(truncateMiddle('abcdefghijklmnop', 4, 3)).toBe('abcd…nop'))
})

describe('formatBigInt', () => {
  it('adds thousands separators', () => expect(formatBigInt('25534300')).toBe('25,534,300'))
  it('null passthrough', () => expect(formatBigInt(null)).toBeNull())
})

describe('decimalToWei', () => {
  it('converts a whole ETH amount to wei (18 decimals)', () =>
    expect(decimalToWei('1', 18)).toBe('1000000000000000000'))
  it('converts a fractional ETH amount to wei', () =>
    expect(decimalToWei('0.5', 18)).toBe('500000000000000000'))
  it('converts a fractional Gwei amount to wei (9 decimals)', () =>
    expect(decimalToWei('2.06', 9)).toBe('2060000000'))
  it('zero at any precision is "0"', () => expect(decimalToWei('0', 9)).toBe('0'))
  it('truncates (does not round) fractional digits past `decimals`', () =>
    expect(decimalToWei('1.123456789012345678999', 18)).toBe('1123456789012345678'))
  it('returns null for empty input', () => {
    expect(decimalToWei('', 18)).toBeNull()
    expect(decimalToWei('   ', 18)).toBeNull()
  })
  it('returns null for non-numeric input', () => {
    expect(decimalToWei('abc', 18)).toBeNull()
    expect(decimalToWei('1.2.3', 18)).toBeNull()
    expect(decimalToWei('.', 18)).toBeNull()
  })
  it('handles a leading-dot decimal and a trailing-dot integer', () => {
    expect(decimalToWei('.5', 18)).toBe('500000000000000000')
    expect(decimalToWei('5.', 9)).toBe('5000000000')
  })
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

describe('isValidDecimals', () => {
  it('accepts integers 0 through 77', () => {
    expect(isValidDecimals(0)).toBe(true)
    expect(isValidDecimals(18)).toBe(true)
    expect(isValidDecimals(77)).toBe(true)
  })

  it('rejects non-integers, negatives, out-of-range and non-numbers', () => {
    expect(isValidDecimals(1.5)).toBe(false)
    expect(isValidDecimals(-1)).toBe(false)
    expect(isValidDecimals(78)).toBe(false)
    expect(isValidDecimals(Number.NaN)).toBe(false)
    expect(isValidDecimals('6')).toBe(false)
    expect(isValidDecimals(null)).toBe(false)
  })
})

describe('normalizeQuantity', () => {
  it('divides by 10^decimals exactly, with no truncation', () => {
    // The worked example from the spec: 80 USDT stored as 80000000 at decimals 6.
    expect(normalizeQuantity('80000000', 6)).toBe('80')
    expect(normalizeQuantity('500000000000000000', 18)).toBe('0.5')
    expect(normalizeQuantity('5', 18)).toBe('0.000000000000000005')
    expect(normalizeQuantity('1234567890123', 6)).toBe('1234567.890123')
  })

  it('returns the integer unchanged at decimals 0', () => {
    expect(normalizeQuantity('42', 0)).toBe('42')
  })

  it('returns "0" for a zero quantity', () => {
    expect(normalizeQuantity('0', 18)).toBe('0')
  })

  it('returns null for a null/blank quantity or invalid decimals', () => {
    expect(normalizeQuantity(null, 6)).toBeNull()
    expect(normalizeQuantity('', 6)).toBeNull()
    expect(normalizeQuantity('80000000', -1)).toBeNull()
    expect(normalizeQuantity('80000000', 1.5)).toBeNull()
  })
})

describe('formatNormalizedQuantity', () => {
  it('formats the spec worked example', () => {
    expect(formatNormalizedQuantity('80000000', 6)).toBe('80')
  })

  it('adds thousands separators to the integer part', () => {
    expect(formatNormalizedQuantity('1500000000', 6)).toBe('1,500')
    expect(formatNormalizedQuantity('1234567890123', 6)).toBe('1,234,567.890123')
  })

  it('truncates the fraction to 6 digits and strips trailing zeros', () => {
    expect(formatNormalizedQuantity('500000000000000000', 18)).toBe('0.5')
    // 1.2345678 at 18 decimals -> truncated, not rounded, to 6 fraction digits.
    expect(formatNormalizedQuantity('1234567800000000000', 18)).toBe('1.234567')
  })

  it('marks non-zero dust below display precision rather than showing 0', () => {
    expect(formatNormalizedQuantity('5', 18)).toBe('<0.000001')
    expect(formatNormalizedQuantity('999999999999', 18)).toBe('<0.000001')
  })

  it('shows a true zero as "0", distinct from dust', () => {
    expect(formatNormalizedQuantity('0', 18)).toBe('0')
  })

  it('returns null for a null quantity or invalid decimals', () => {
    expect(formatNormalizedQuantity(null, 6)).toBeNull()
    expect(formatNormalizedQuantity('80000000', 78)).toBeNull()
  })
})

describe('compareNormalizedQuantity', () => {
  it('orders correctly across different decimal scales', () => {
    // 0.5 WETH (18 dp) vs 80 USDT (6 dp) — 0.5 is the smaller normalized value even
    // though its raw integer (5e17) is far larger than 80000000.
    expect(compareNormalizedQuantity('500000000000000000', 18, '80000000', 6)).toBeLessThan(0)
    expect(compareNormalizedQuantity('80000000', 6, '500000000000000000', 18)).toBeGreaterThan(0)
  })

  it('returns 0 for equal normalized values at different scales', () => {
    // 1 token at 6 dp vs 1 token at 18 dp.
    expect(compareNormalizedQuantity('1000000', 6, '1000000000000000000', 18)).toBe(0)
  })

  it('sorts unknown decimals and null quantities last', () => {
    expect(compareNormalizedQuantity('1', 6, '1', null)).toBeLessThan(0)
    expect(compareNormalizedQuantity('1', null, '1', 6)).toBeGreaterThan(0)
    expect(compareNormalizedQuantity(null, 6, '1', 6)).toBeGreaterThan(0)
    expect(compareNormalizedQuantity(null, null, null, null)).toBe(0)
  })
})

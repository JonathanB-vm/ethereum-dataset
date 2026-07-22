const WEI_PER_ETH = 10n ** 18n
const WEI_PER_GWEI = 10n ** 9n

/** Parse a BigQuery numeric string ("123", "123.0") to bigint. Null-safe. */
export function toBigInt(v: string | null): bigint | null {
  if (v == null || v.trim() === '') return null
  const dot = v.indexOf('.')
  const intPart = dot === -1 ? v : v.slice(0, dot)
  try {
    return BigInt(intPart)
  } catch {
    return null
  }
}

function divToDecimal(wei: bigint, divisor: bigint, maxFrac: number): string {
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const whole = abs / divisor
  const fracDigits = divisor.toString().length - 1
  const frac = (abs % divisor).toString().padStart(fracDigits, '0').slice(0, maxFrac).replace(/0+$/, '')
  const s = frac ? `${whole}.${frac}` : whole.toString()
  return neg ? `-${s}` : s
}

export function weiToEth(wei: string | null): string | null {
  const w = toBigInt(wei)
  return w == null ? null : divToDecimal(w, WEI_PER_ETH, 6)
}

export function weiToGwei(wei: string | null): string | null {
  const w = toBigInt(wei)
  return w == null ? null : divToDecimal(w, WEI_PER_GWEI, 2)
}

/** "2026-07-14 23:55:11+00:00" → "2026-07-14 23:55:11 UTC" */
export function formatTimestamp(ts: string): string {
  return ts.replace(/\+00:00$/, ' UTC')
}

export function truncateHex(hex: string, lead = 6, tail = 4): string {
  if (hex.length <= lead + tail + 1) return hex
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`
}

export function formatBigInt(v: string | null): string | null {
  const b = toBigInt(v)
  if (b == null) return null
  return b.toLocaleString('en-US')
}

/** Numeric-aware comparator for BigQuery numeric strings. Nulls sort last. */
export function compareNumericStrings(a: string | null, b: string | null): number {
  const ba = toBigInt(a)
  const bb = toBigInt(b)
  if (ba == null && bb == null) return 0
  if (ba == null) return 1
  if (bb == null) return -1
  return ba < bb ? -1 : ba > bb ? 1 : 0
}

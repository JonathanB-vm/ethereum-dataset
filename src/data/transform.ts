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

/**
 * Head…tail truncation for arbitrarily long raw values (input_tx calldata, access lists,
 * signature components) — same shape and "don't truncate when nothing is saved" guard as
 * truncateHex above, but with defaults sized for RowDetail's field values rather than
 * table cells. Callers keep the full value available via `title`/copy.
 */
export function truncateMiddle(value: string, head = 24, tail = 12): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

/** Thousands-separated plain integer for UI copy (tab counts, row/page counts, tile values). */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatBigInt(v: string | null): string | null {
  const b = toBigInt(v)
  if (b == null) return null
  return b.toLocaleString('en-US')
}

/**
 * Parses a decimal string in a *display* unit (e.g. "0.5" ETH, "2.06" Gwei) into the
 * wei-scale integer string BigQuery's raw columns actually store, so a filter bound typed
 * in the unit the column displays can be compared against the raw stored value. BigInt-only
 * (never `Number`/`parseFloat`) — same precision rationale as `toBigInt` above. The
 * fractional part is truncated (not rounded) past `decimals` digits, matching how the rest
 * of this module treats excess precision. Returns `null` for empty/invalid input (more than
 * one `.`, non-digit characters, …) so a caller can treat that as "bound not set yet"
 * instead of rejecting every row while the user is still typing.
 */
export function decimalToWei(input: string, decimals: number): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  const negative = trimmed.startsWith('-')
  const body = negative ? trimmed.slice(1) : trimmed
  if (!/^\d*\.?\d*$/.test(body) || body === '' || body === '.') return null

  const [intPartRaw, fracPartRaw = ''] = body.split('.')
  const intPart = intPartRaw === '' ? '0' : intPartRaw
  const frac = fracPartRaw.slice(0, decimals).padEnd(decimals, '0')

  const scaled = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac === '' ? '0' : frac)
  return (negative ? -scaled : scaled).toString()
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

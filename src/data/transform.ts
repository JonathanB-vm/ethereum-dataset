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

/** Fraction digits shown in the table. Beyond this, a value is truncated — never rounded. */
const NORMALIZED_DISPLAY_DIGITS = 6

/**
 * A token's `decimals` is only usable if it is a plain integer in 0..77 — 77 is the most
 * base-10 digits a 256-bit unsigned integer can carry, so anything larger could not describe
 * a real on-chain quantity. Everything else (empty, negative, fractional, non-numeric) is
 * "unknown", which the UI renders as a dash rather than guessing a divisor.
 */
export function isValidDecimals(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 77
}

/** Splits |quantity| into its whole part and its zero-padded fractional digits. */
function splitScaled(quantity: string | null, decimals: number) {
  if (!isValidDecimals(decimals)) return null
  const raw = toBigInt(quantity)
  if (raw == null) return null
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const divisor = 10n ** BigInt(decimals)
  return {
    negative,
    isZero: abs === 0n,
    whole: abs / divisor,
    // padStart to `decimals` so 5 at 18 dp yields "000000000000000005", not "5".
    frac: decimals === 0 ? '' : (abs % divisor).toString().padStart(decimals, '0'),
  }
}

/**
 * `quantity ÷ 10^decimals` as an exact decimal string — every digit, no truncation. This is
 * the lossless form: it is what the CSV export writes, so a normalized value round-trips
 * with the same fidelity as the raw columns. `formatNormalizedQuantity` is the display form.
 */
export function normalizeQuantity(quantity: string | null, decimals: number): string | null {
  const parts = splitScaled(quantity, decimals)
  if (parts == null) return null
  const frac = parts.frac.replace(/0+$/, '')
  const body = frac === '' ? parts.whole.toString() : `${parts.whole}.${frac}`
  return parts.negative ? `-${body}` : body
}

/**
 * Display form: thousands separators on the whole part (matching `BigNumCell`, the Quantity
 * column this sits beside) and at most 6 fraction digits.
 *
 * The `<0.000001` case is the reason this isn't just `normalizeQuantity` truncated: an
 * 18-decimal token's dust would otherwise render as a bare "0", indistinguishable from a
 * genuine zero-value transfer. Truncating to a marker keeps "something small moved" and
 * "nothing moved" visually distinct.
 */
export function formatNormalizedQuantity(
  quantity: string | null,
  decimals: number,
): string | null {
  const parts = splitScaled(quantity, decimals)
  if (parts == null) return null

  const frac = parts.frac.slice(0, NORMALIZED_DISPLAY_DIGITS).replace(/0+$/, '')
  const whole = parts.whole.toLocaleString('en-US')

  let body: string
  if (frac !== '') {
    body = `${whole}.${frac}`
  } else if (!parts.isZero && parts.whole === 0n) {
    // Non-zero, but every significant digit sits past the display precision.
    return `${parts.negative ? '>-' : '<'}0.${'0'.repeat(NORMALIZED_DISPLAY_DIGITS - 1)}1`
  } else {
    body = whole
  }
  return parts.negative ? `-${body}` : body
}

/**
 * Compares two normalized quantities that may be on *different* scales — the whole point of
 * sorting this column, since each row's divisor comes from its own token contract.
 *
 * Compares `a / 10^da` against `b / 10^db` by cross-multiplication (`a·10^db` vs `b·10^da`),
 * which is exact in `BigInt` and needs no division. Doing this in floating point would
 * misorder values near the top of the 256-bit range. Nulls and unknown decimals sort last,
 * matching `compareNumericStrings`.
 */
export function compareNormalizedQuantity(
  aQty: string | null,
  aDec: number | null,
  bQty: string | null,
  bDec: number | null,
): number {
  const a = isValidDecimals(aDec) ? toBigInt(aQty) : null
  const b = isValidDecimals(bDec) ? toBigInt(bQty) : null
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const left = a * 10n ** BigInt(bDec as number)
  const right = b * 10n ** BigInt(aDec as number)
  return left < right ? -1 : left > right ? 1 : 0
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

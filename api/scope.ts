/**
 * Query scoping and limits.
 *
 * Every request must be bounded — a block range, an address, or a transaction hash.
 * "Everything" is not a valid scope and returns 400 with a message naming what is
 * required. Dune's docs quantify why: a hash lookup over ~1.6 B rows takes ~6 minutes
 * without a block filter and 13 seconds with one.
 *
 * Spec: docs/superpowers/specs/2026-09-08-api-and-frontend.md
 */

/** The widest block span one request may cover. */
export const MAX_BLOCK_SPAN = 100_000

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT_ANONYMOUS = 1_000
export const MAX_LIMIT_KEYED = 10_000

export type Scope =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'address'; address: string }
  | { kind: 'txHash'; hash: string }

export class ScopeError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'ScopeError'
  }
}

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/
const HEX_HASH = /^0x[0-9a-f]{64}$/

/** Normalize a hex string for comparison. Addresses are stored lowercase throughout. */
export function normalizeHex(value: string): string {
  return value.trim().toLowerCase()
}

export function isAddress(value: string): boolean {
  return HEX_ADDRESS.test(normalizeHex(value))
}

export function isTxHash(value: string): boolean {
  return HEX_HASH.test(normalizeHex(value))
}

interface RawQuery {
  block_from?: string | number
  block_to?: string | number
  address?: string
  hash?: string
}

function toInt(value: string | number, field: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new ScopeError(`${field} must be a non-negative integer`)
  }
  return n
}

/**
 * Resolve a request's scope, or explain what is missing.
 *
 * A hash is the narrowest scope and wins, then an address, then a block range — so a
 * request carrying both a hash and a range is served by the hash lookup table.
 */
export function parseScope(query: RawQuery): Scope {
  if (query.hash !== undefined && query.hash !== '') {
    const hash = normalizeHex(query.hash)
    if (!isTxHash(hash)) {
      throw new ScopeError('hash must be a 0x-prefixed 32-byte hex string')
    }
    return { kind: 'txHash', hash }
  }

  if (query.address !== undefined && query.address !== '') {
    const address = normalizeHex(query.address)
    if (!isAddress(address)) {
      throw new ScopeError('address must be a 0x-prefixed 20-byte hex string')
    }
    return { kind: 'address', address }
  }

  const hasFrom = query.block_from !== undefined && query.block_from !== ''
  const hasTo = query.block_to !== undefined && query.block_to !== ''
  if (!hasFrom || !hasTo) {
    throw new ScopeError(
      'a bounded scope is required: pass block_from and block_to, or address, or hash',
    )
  }

  const from = toInt(query.block_from as string | number, 'block_from')
  const to = toInt(query.block_to as string | number, 'block_to')
  if (to < from) {
    throw new ScopeError('block_to must be greater than or equal to block_from')
  }
  const span = to - from + 1
  if (span > MAX_BLOCK_SPAN) {
    throw new ScopeError(
      `block range spans ${span} blocks; the maximum is ${MAX_BLOCK_SPAN}`,
    )
  }
  return { kind: 'range', from, to }
}

/** Clamp a requested page size to the caller's tier, rejecting nonsense outright. */
export function resolveLimit(
  requested: string | number | undefined,
  hasApiKey = false,
): number {
  const max = hasApiKey ? MAX_LIMIT_KEYED : MAX_LIMIT_ANONYMOUS
  if (requested === undefined || requested === '') return DEFAULT_LIMIT
  const n = typeof requested === 'number' ? requested : Number(requested)
  if (!Number.isInteger(n) || n < 1) {
    throw new ScopeError('limit must be a positive integer')
  }
  return Math.min(n, max)
}

/**
 * Classify a free-text search box entry the way the explorer's header does: 66 hex
 * characters is a transaction hash, 42 is an address, digits are a block number,
 * anything else is a filter on the current view.
 */
export function classifySearch(
  input: string,
): { kind: 'txHash' | 'address'; value: string } | { kind: 'block'; value: number } | { kind: 'text'; value: string } {
  const v = normalizeHex(input)
  if (isTxHash(v)) return { kind: 'txHash', value: v }
  if (isAddress(v)) return { kind: 'address', value: v }
  if (/^\d+$/.test(v)) return { kind: 'block', value: Number(v) }
  return { kind: 'text', value: input.trim() }
}

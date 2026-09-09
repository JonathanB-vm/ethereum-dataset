/**
 * Cache policy.
 *
 * Block data is immutable once finalized, which makes most of this API infinitely
 * cacheable — something none of the surveyed public explorers exploit. A response whose
 * whole block range sits at or below `head - FINALITY_LAG` can never change, so it is
 * served `immutable` and Cloudflare keeps it forever. Anything touching the head is
 * served with a short TTL instead.
 *
 * Spec: docs/superpowers/specs/2026-09-08-api-and-frontend.md
 */

import type { Scope } from './scope'

/** Blocks this far behind head are final; see the ingest spec. */
export const FINALITY_LAG = 100

export const IMMUTABLE = 'public, max-age=31536000, immutable'
export const NEAR_HEAD = 'public, max-age=15'

export interface CacheHeaders {
  'Cache-Control': string
  ETag?: string
}

/**
 * Whether a scope is entirely inside the finalized region.
 *
 * Only a block range can be proven final from the scope alone. An address or hash lookup
 * may return rows from anywhere including the head, so those are never marked immutable.
 */
export function isFinalized(scope: Scope, head: number): boolean {
  if (scope.kind !== 'range') return false
  return scope.to <= head - FINALITY_LAG
}

/**
 * Cache headers for a response.
 *
 * `release` identifies the dataset version, so a re-published correction invalidates
 * previously immutable responses rather than leaving stale ones cached for a year.
 */
export function cacheHeadersFor(
  scope: Scope,
  head: number,
  release?: string,
): CacheHeaders {
  if (!isFinalized(scope, head)) {
    return { 'Cache-Control': NEAR_HEAD }
  }
  const headers: CacheHeaders = { 'Cache-Control': IMMUTABLE }
  if (release) {
    headers.ETag = `"${release}-${scope.from}-${scope.to}"`
  }
  return headers
}

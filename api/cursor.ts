/**
 * Keyset ("cursor") pagination.
 *
 * Every page is fetched with `WHERE key > cursor ORDER BY key LIMIT n`, which costs the
 * same on page 10,000 as on page 1. OFFSET is never used: it is the anti-pattern every
 * surveyed explorer works around, and Etherscan's 10,000-record window exists precisely
 * because of it.
 *
 * The cursor is opaque to clients — base64url of the last row's sort key — so the shape
 * can change without breaking them. It is not signed: it encodes only a position that the
 * caller could have constructed anyway, and every query is separately bounded and capped,
 * so a forged cursor can only select a different page of data the caller may already read.
 *
 * Spec: docs/superpowers/specs/2026-09-08-api-and-frontend.md
 */

export type SortDir = 'asc' | 'desc'

/** The sort key of the fact tables, in ORDER BY order. */
export interface SortKey {
  block_number: number
  transaction_index: number
  /** Present for token_transfers, absent for transactions. */
  event_index?: number
  batch_index?: number
}

export interface Cursor {
  key: SortKey
  dir: SortDir
  /**
   * Set when sorting by a non-key column (e.g. `value`). The key still travels, as the
   * tiebreaker that makes the ordering total — without it, rows sharing a sort value can
   * be skipped or repeated across pages.
   */
  sortValue?: string
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCursorError'
  }
}

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

const isNonNegInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0

export function encodeCursor(cursor: Cursor): string {
  const { key, dir, sortValue } = cursor
  const payload: unknown[] = [
    key.block_number,
    key.transaction_index,
    key.event_index ?? null,
    key.batch_index ?? null,
    dir,
  ]
  if (sortValue !== undefined) payload.push(sortValue)
  return toBase64Url(JSON.stringify(payload))
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(raw))
  } catch {
    throw new InvalidCursorError('cursor is not valid base64url JSON')
  }
  if (!Array.isArray(parsed) || parsed.length < 5) {
    throw new InvalidCursorError('cursor has the wrong shape')
  }
  const [block, txIndex, eventIndex, batchIndex, dir, sortValue] = parsed
  if (!isNonNegInt(block) || !isNonNegInt(txIndex)) {
    throw new InvalidCursorError('cursor key must be non-negative integers')
  }
  if (eventIndex !== null && !isNonNegInt(eventIndex)) {
    throw new InvalidCursorError('cursor event_index must be a non-negative integer')
  }
  if (batchIndex !== null && !isNonNegInt(batchIndex)) {
    throw new InvalidCursorError('cursor batch_index must be a non-negative integer')
  }
  if (dir !== 'asc' && dir !== 'desc') {
    throw new InvalidCursorError('cursor direction must be asc or desc')
  }
  const key: SortKey = { block_number: block, transaction_index: txIndex }
  if (eventIndex !== null) key.event_index = eventIndex
  if (batchIndex !== null) key.batch_index = batchIndex

  const cursor: Cursor = { key, dir }
  if (sortValue !== undefined) {
    if (typeof sortValue !== 'string') {
      throw new InvalidCursorError('cursor sort value must be a string')
    }
    cursor.sortValue = sortValue
  }
  return cursor
}

/**
 * The keyset comparison for the next page, as a ClickHouse expression plus bound
 * parameters. Tuple comparison expresses "strictly after this row in sort order" in one
 * predicate that the primary key can still serve.
 *
 * Parameters are always bound, never interpolated: the API must not build SQL by string
 * concatenation.
 */
export function keysetPredicate(
  cursor: Cursor,
  columns: readonly string[],
): { sql: string; params: Record<string, number> } {
  const key = cursor.key
  const values: number[] = [key.block_number, key.transaction_index]
  if (key.event_index !== undefined) values.push(key.event_index)
  if (key.batch_index !== undefined) values.push(key.batch_index)

  if (values.length !== columns.length) {
    throw new InvalidCursorError(
      `cursor has ${values.length} key parts but the table sorts on ${columns.length}`,
    )
  }

  const params: Record<string, number> = {}
  const placeholders = values.map((v, i) => {
    params[`k${i}`] = v
    return `{k${i}:UInt64}`
  })
  const op = cursor.dir === 'asc' ? '>' : '<'
  return {
    sql: `(${columns.join(', ')}) ${op} (${placeholders.join(', ')})`,
    params,
  }
}

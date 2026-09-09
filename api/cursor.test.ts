import { describe, expect, it } from 'vitest'
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  keysetPredicate,
  type Cursor,
} from './cursor.ts'

const TX_CURSOR: Cursor = {
  key: { block_number: 25_534_200, transaction_index: 17 },
  dir: 'asc',
}

const TRANSFER_CURSOR: Cursor = {
  key: {
    block_number: 25_534_200,
    transaction_index: 17,
    event_index: 3,
    batch_index: 0,
  },
  dir: 'asc',
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a transactions key', () => {
    expect(decodeCursor(encodeCursor(TX_CURSOR))).toEqual(TX_CURSOR)
  })

  it('round-trips a token_transfers key with its extra parts', () => {
    expect(decodeCursor(encodeCursor(TRANSFER_CURSOR))).toEqual(TRANSFER_CURSOR)
  })

  it('round-trips a descending cursor', () => {
    const desc: Cursor = { ...TX_CURSOR, dir: 'desc' }
    expect(decodeCursor(encodeCursor(desc)).dir).toBe('desc')
  })

  it('carries a sort value for non-key sorts', () => {
    const c: Cursor = { ...TX_CURSOR, sortValue: '1794013457006467492343' }
    // The tiebreaker key must survive alongside it, or rows sharing a value get
    // skipped or repeated across pages.
    const back = decodeCursor(encodeCursor(c))
    expect(back.sortValue).toBe('1794013457006467492343')
    expect(back.key).toEqual(TX_CURSOR.key)
  })

  it('preserves a 256-bit sort value exactly', () => {
    const huge = '4461668424664140127867736845293397079'
    const c: Cursor = { ...TX_CURSOR, sortValue: huge }
    expect(decodeCursor(encodeCursor(c)).sortValue).toBe(huge)
  })

  it('produces a url-safe token', () => {
    const encoded = encodeCursor(TRANSFER_CURSOR)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encodeURIComponent(encoded)).toBe(encoded)
  })

  it('is opaque — the token is not the raw key', () => {
    expect(encodeCursor(TX_CURSOR)).not.toContain('25534200')
  })
})

describe('decodeCursor rejects malformed input', () => {
  it('rejects a non-base64 string', () => {
    expect(() => decodeCursor('!!!not base64!!!')).toThrow(InvalidCursorError)
  })

  it('rejects valid base64 that is not JSON', () => {
    expect(() => decodeCursor(btoa('hello'))).toThrow(InvalidCursorError)
  })

  it('rejects JSON of the wrong shape', () => {
    expect(() => decodeCursor(btoa(JSON.stringify({ block: 1 })))).toThrow(
      InvalidCursorError,
    )
  })

  it('rejects a truncated key', () => {
    expect(() => decodeCursor(btoa(JSON.stringify([1, 2])))).toThrow(InvalidCursorError)
  })

  it('rejects a negative block number', () => {
    expect(() =>
      decodeCursor(btoa(JSON.stringify([-1, 0, null, null, 'asc']))),
    ).toThrow(/non-negative/)
  })

  it('rejects a non-integer key part', () => {
    expect(() =>
      decodeCursor(btoa(JSON.stringify([1.5, 0, null, null, 'asc']))),
    ).toThrow(/non-negative/)
  })

  it('rejects an unknown sort direction', () => {
    expect(() =>
      decodeCursor(btoa(JSON.stringify([1, 0, null, null, 'sideways']))),
    ).toThrow(/asc or desc/)
  })

  it('rejects a non-string sort value', () => {
    expect(() =>
      decodeCursor(btoa(JSON.stringify([1, 0, null, null, 'asc', 42]))),
    ).toThrow(/sort value/)
  })
})

describe('keysetPredicate', () => {
  const TX_COLUMNS = ['block_number', 'transaction_index'] as const
  const TRANSFER_COLUMNS = [
    'block_number',
    'transaction_index',
    'event_index',
    'batch_index',
  ] as const

  it('builds a tuple comparison for the next ascending page', () => {
    const { sql, params } = keysetPredicate(TX_CURSOR, TX_COLUMNS)
    expect(sql).toBe('(block_number, transaction_index) > ({k0:UInt64}, {k1:UInt64})')
    expect(params).toEqual({ k0: 25_534_200, k1: 17 })
  })

  it('flips the comparison for a descending page', () => {
    const { sql } = keysetPredicate({ ...TX_CURSOR, dir: 'desc' }, TX_COLUMNS)
    expect(sql).toContain(') < (')
  })

  it('covers all four parts of the transfers sort key', () => {
    const { sql, params } = keysetPredicate(TRANSFER_CURSOR, TRANSFER_COLUMNS)
    expect(sql).toBe(
      '(block_number, transaction_index, event_index, batch_index) > ' +
        '({k0:UInt64}, {k1:UInt64}, {k2:UInt64}, {k3:UInt64})',
    )
    expect(params).toEqual({ k0: 25_534_200, k1: 17, k2: 3, k3: 0 })
  })

  it('never interpolates values into the SQL', () => {
    const { sql } = keysetPredicate(TX_CURSOR, TX_COLUMNS)
    expect(sql).not.toContain('25534200')
  })

  it('rejects a cursor whose key does not match the table it is used against', () => {
    // A transactions cursor replayed against token_transfers would silently paginate
    // wrongly; fail loudly instead.
    expect(() => keysetPredicate(TX_CURSOR, TRANSFER_COLUMNS)).toThrow(
      InvalidCursorError,
    )
  })

  it('never emits OFFSET', () => {
    const { sql } = keysetPredicate(TRANSFER_CURSOR, TRANSFER_COLUMNS)
    expect(sql.toUpperCase()).not.toContain('OFFSET')
  })
})

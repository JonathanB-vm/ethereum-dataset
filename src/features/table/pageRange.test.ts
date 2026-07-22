import { describe, it, expect } from 'vitest'
import { pageRange } from './pageRange'

describe('pageRange', () => {
  it('computes the first page range', () => {
    expect(pageRange(0, 50, 96)).toEqual({ from: 1, to: 50 })
  })

  it('computes a later page range, clamped to the total', () => {
    expect(pageRange(1, 50, 96)).toEqual({ from: 51, to: 96 })
  })

  it('returns an empty range when there are no rows, regardless of page/size', () => {
    expect(pageRange(0, 50, 0)).toEqual({ from: 0, to: 0 })
  })

  it('handles an exact multiple of page size (no partial last page)', () => {
    expect(pageRange(1, 50, 100)).toEqual({ from: 51, to: 100 })
  })

  it('handles a single-page total smaller than the page size', () => {
    expect(pageRange(0, 100, 96)).toEqual({ from: 1, to: 96 })
  })
})

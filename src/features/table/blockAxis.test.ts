import { describe, it, expect } from 'vitest'
import { axisIndexForBlock, blockTimeLabel } from './blockAxis'
import type { BlockAxisEntry } from '../../data/types'

// Deliberately gapped: 200, 205, 206, 300. Index 1 is block 205, NOT block 201.
const GAPPED: BlockAxisEntry[] = [
  { block: 200, time: '2026-07-14 23:35:11+00:00' },
  { block: 205, time: '2026-07-14 23:36:11+00:00' },
  { block: 206, time: '2026-07-14 23:36:23+00:00' },
  { block: 300, time: '2026-07-14 23:55:59+00:00' },
]

describe('axisIndexForBlock', () => {
  it('returns the index of an exact block match', () => {
    expect(axisIndexForBlock(GAPPED, '206')).toBe(2)
  })

  it('indexes by position in the axis, not by numeric distance from the first block', () => {
    // Block 201 does not exist. Position 1 in the axis is block 205.
    expect(axisIndexForBlock(GAPPED, '205')).toBe(1)
    expect(axisIndexForBlock(GAPPED, '300')).toBe(3)
  })

  it('snaps a block that is not on the axis to the nearest one', () => {
    expect(axisIndexForBlock(GAPPED, '204')).toBe(1) // nearer 205 than 200
    expect(axisIndexForBlock(GAPPED, '250')).toBe(2) // nearer 206 than 300
  })

  it('clamps out-of-range values to the ends', () => {
    expect(axisIndexForBlock(GAPPED, '1')).toBe(0)
    expect(axisIndexForBlock(GAPPED, '999999')).toBe(3)
  })

  it('returns null for unparseable input or an empty axis', () => {
    expect(axisIndexForBlock(GAPPED, 'abc')).toBeNull()
    expect(axisIndexForBlock(GAPPED, '')).toBeNull()
    expect(axisIndexForBlock([], '200')).toBeNull()
  })
})

describe('blockTimeLabel', () => {
  it('extracts HH:MM:SS and marks it UTC', () => {
    expect(blockTimeLabel('2026-07-14 23:35:11+00:00')).toBe('23:35:11 UTC')
  })

  it('renders a dash when there is no timestamp', () => {
    expect(blockTimeLabel(undefined)).toBe('—')
    expect(blockTimeLabel('')).toBe('—')
  })
})

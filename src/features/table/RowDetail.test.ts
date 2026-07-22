import { describe, it, expect } from 'vitest'
import { GROUPS } from './rowDetailFields'
import { COLUMNS } from '../../data/dictionary'

// Drift protection: RowDetail.tsx's GROUPS constant is a fixed, hand-maintained partition
// of every dictionary field into three sections. Nothing enforces at compile time that it
// stays in sync with COLUMNS as that dictionary evolves — these tests are the enforcement.
describe('RowDetail GROUPS', () => {
  const allFields = GROUPS.flatMap((g) => g.fields)
  const columnFields = COLUMNS.map((c) => c.field)

  it('has exactly as many fields as COLUMNS (no fields silently dropped or added)', () => {
    expect(allFields).toHaveLength(COLUMNS.length)
  })

  it('has no duplicate fields across the three groups', () => {
    expect(new Set(allFields).size).toBe(allFields.length)
  })

  it('is set-equal to COLUMNS.map(c => c.field) — no omissions, no foreign fields', () => {
    expect(new Set(allFields)).toEqual(new Set(columnFields))
  })
})

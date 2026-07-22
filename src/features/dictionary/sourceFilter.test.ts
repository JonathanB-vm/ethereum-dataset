import { describe, it, expect } from 'vitest'
import { visibleSources } from './sourceFilter'

describe('visibleSources', () => {
  it('no filter → every source group, in display order', () =>
    expect(visibleSources(null)).toEqual(['both', 'token_transfers', 'transactions', 'derived']))

  it("'both' → the shared group plus derived (derived belongs to neither record type alone)", () =>
    expect(visibleSources('both')).toEqual(['both', 'derived']))

  it('a record-type filter → only that group', () => {
    expect(visibleSources('token_transfers')).toEqual(['token_transfers'])
    expect(visibleSources('transactions')).toEqual(['transactions'])
  })
})

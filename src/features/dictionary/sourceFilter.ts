import type { ColumnMeta } from '../../data/dictionary'

/**
 * The full-dictionary source filter (DictionaryPanel's FullDictionary mode): three toggle
 * buttons — Both / Token Transfers / Transactions — narrow the section list to one source
 * group; no selection shows every group. Split into its own module (not DictionaryPanel.tsx,
 * which may only export components per the fast-refresh lint rule) so the section-visibility
 * mapping is unit-testable.
 */
export type SourceFilter = 'both' | 'token_transfers' | 'transactions'

/** Section display order when unfiltered — mirrors DictionaryPanel's SOURCE_ORDER. */
const ALL_SOURCES: ColumnMeta['source'][] = ['both', 'token_transfers', 'transactions', 'derived', 'variable']

/**
 * Which source sections a filter selection shows. 'both' includes the derived and
 * research-variable groups: is_token_transfer and normalized_quantity belong to neither
 * record type alone, and a variable's per-transaction value sits on every row of its
 * transaction, so the shared view is the only filtered view where they aren't misleading.
 */
export function visibleSources(filter: SourceFilter | null): ColumnMeta['source'][] {
  if (filter == null) return ALL_SOURCES
  if (filter === 'both') return ['both', 'derived', 'variable']
  return [filter]
}

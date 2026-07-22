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
const ALL_SOURCES: ColumnMeta['source'][] = ['both', 'token_transfers', 'transactions', 'derived']

/**
 * Which source sections a filter selection shows. 'both' includes the derived group:
 * its one field (is_token_transfer) belongs to neither record type alone, so the shared
 * view is the only filtered view where it isn't misleading.
 */
export function visibleSources(filter: SourceFilter | null): ColumnMeta['source'][] {
  if (filter == null) return ALL_SOURCES
  if (filter === 'both') return ['both', 'derived']
  return [filter]
}

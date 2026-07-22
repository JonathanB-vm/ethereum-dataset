import { createContext, useContext } from 'react'
import type { EthRecord } from '../../data/types'

/**
 * Split out from DictionaryPanel.tsx so that file only exports components (satisfies the
 * `react(only-export-components)` fast-refresh lint rule) — this file exports the context
 * object and its consumer hook, neither of which is a component.
 */
export interface DictionaryPanelContextValue {
  openField: (field: keyof EthRecord) => void
  openFull: () => void
}

export const DictionaryPanelContext = createContext<DictionaryPanelContextValue | null>(null)

export function useDictionaryPanel(): DictionaryPanelContextValue {
  const ctx = useContext(DictionaryPanelContext)
  if (!ctx) throw new Error('useDictionaryPanel must be used within a DictionaryPanelProvider')
  return ctx
}

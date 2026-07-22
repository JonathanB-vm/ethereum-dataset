import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { formatCount as fmt } from '../../data/transform'

export type TabId = 'transfers' | 'transactions' | 'all'

interface TabsProps {
  active: TabId
  onChange: (tab: TabId) => void
  /** Live counts, computed by the caller from the loaded records — never hard-coded. */
  counts: Record<TabId, number>
}

const TAB_DEFS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'transfers', label: 'Token Transfers' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'all', label: 'All Records' },
]

export function Tabs({ active, onChange, counts }: TabsProps) {
  // APG tabs pattern: one tab stop for the whole tablist (roving tabindex), Left/Right/
  // Home/End move between tabs, and selection follows focus.
  function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const idx = TAB_DEFS.findIndex((t) => t.id === active)
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
        next = (idx - 1 + TAB_DEFS.length) % TAB_DEFS.length
        break
      case 'ArrowRight':
        next = (idx + 1) % TAB_DEFS.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = TAB_DEFS.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const id = TAB_DEFS[next].id
    onChange(id)
    document.getElementById(`table-tab-${id}`)?.focus()
  }

  return (
    <div className="table-tabs" role="tablist" aria-label="Record view">
      {TAB_DEFS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`table-tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls="table-panel"
          tabIndex={active === t.id ? 0 : -1}
          className={`table-tab${active === t.id ? ' table-tab--active' : ''}`}
          onClick={() => onChange(t.id)}
          onKeyDown={handleKeyDown}
        >
          {t.label}
          <span className="table-tab__count">({fmt(counts[t.id])})</span>
        </button>
      ))}
    </div>
  )
}

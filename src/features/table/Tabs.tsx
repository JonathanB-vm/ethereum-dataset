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

const fmt = (n: number): string => n.toLocaleString('en-US')

export function Tabs({ active, onChange, counts }: TabsProps) {
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
          className={`table-tab${active === t.id ? ' table-tab--active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          <span className="table-tab__count">({fmt(counts[t.id])})</span>
        </button>
      ))}
    </div>
  )
}

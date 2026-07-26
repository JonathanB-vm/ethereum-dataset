import type { Ref } from 'react'

interface GlobalSearchInputProps {
  value: string
  onChange: (value: string) => void
  /** React 19 accepts `ref` as a plain prop on function components — no `forwardRef` needed. */
  ref?: Ref<HTMLInputElement>
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)

/** Lives in Header's right-side slot (App.tsx) — global, whole-record search across all 34 loaded dictionary fields, independent of which tab/columns are on screen. */
export function GlobalSearchInput({ value, onChange, ref }: GlobalSearchInputProps) {
  return (
    <div className="global-search">
      <SearchIcon />
      <input
        ref={ref}
        type="text"
        inputMode="search"
        className="global-search__input"
        placeholder="Search hashes, addresses…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search all records"
      />
      <kbd className="global-search__kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 13l-2.5-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

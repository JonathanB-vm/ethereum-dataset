import { useEffect, useRef, useState, type ReactNode } from 'react'

interface FilterPopoverProps {
  /** Column label, used for both the trigger's and the dialog's accessible name. */
  label: string
  /** Drives the accent state and the dot — computed by the caller, since what counts as "set" differs per panel. */
  isActive: boolean
  children: ReactNode
}

/**
 * The funnel trigger and the popover it opens: open/close state, outside-click and Escape
 * dismissal, and the accessible names. Everything about *what* is being filtered lives in
 * the panel passed as `children`.
 *
 * Extracted from FilterControls so the block/time range control can reuse one
 * implementation of this behavior instead of maintaining a second copy of the Escape and
 * outside-click handling.
 */
export function FilterPopover({ label, isActive, children }: FilterPopoverProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      // Outside click doesn't return focus to the trigger: the user just deliberately
      // moved focus/attention somewhere else on the page (another header, a table cell,
      // …), so forcing it back here would fight that action instead of respecting it.
      // Escape, below, is a keyboard-only close with nowhere else for focus to logically
      // go, which is exactly the case focus-return exists for.
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="filter-control" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-control__trigger${isActive ? ' filter-control__trigger--active' : ''}`}
        aria-label={`Filter ${label}`}
        aria-expanded={open}
        onClick={(e) => {
          // The sort toggle lives in a sibling button, not a parent — this stopPropagation
          // is only to keep a click from immediately re-triggering the outside-click
          // listener registered above once `open` flips true.
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <FunnelIcon />
        {isActive && <span className="filter-control__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div
          className="filter-popover"
          role="dialog"
          aria-label={`Filter ${label}`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
      <path
        d="M2 3h12l-4.5 5.4V13l-3 1.3V8.4L2 3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

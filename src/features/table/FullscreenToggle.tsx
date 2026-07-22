import { forwardRef } from 'react'

interface FullscreenToggleProps {
  isFullscreen: boolean
  onToggle: () => void
}

/**
 * Icon-only toggle planted in `.table-toolbar` (App.tsx), next to ExportButton. Owns no
 * state itself — App.tsx owns `isFullscreen` (it has to: entering/exiting fullscreen moves
 * a class on `.table-card`, a sibling of this button, not a descendant) and passes the
 * current mode + a plain toggle callback down. `ref` is forwarded so App.tsx can return
 * focus here on exit (button click *or* Esc) without querying the DOM for it.
 */
export const FullscreenToggle = forwardRef<HTMLButtonElement, FullscreenToggleProps>(
  function FullscreenToggle({ isFullscreen, onToggle }, ref) {
    const label = isFullscreen ? 'Exit full screen' : 'Expand table'
    return (
      <button
        ref={ref}
        type="button"
        className="fullscreen-toggle"
        aria-pressed={isFullscreen}
        aria-label={label}
        title={label}
        onClick={onToggle}
      >
        {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
      </button>
    )
  },
)

/** Four outward-pointing corner brackets — the conventional "enter fullscreen" glyph.
 *  Exported: DataTable's per-row preview button uses the same glyph (smaller, via CSS)
 *  so "this opens fullscreen" reads as one consistent affordance everywhere. */
export function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M6 2.5H2.5V6M10 2.5h3.5V6M2.5 10v3.5H6M13.5 10v3.5H10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The same brackets turned inward — the conventional "exit fullscreen" glyph. */
function CollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M2.5 6H6V2.5M13.5 6H10V2.5M6 13.5V10H2.5M10 13.5V10h3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

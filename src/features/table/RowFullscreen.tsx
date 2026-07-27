import { useEffect, useRef } from 'react'
import type { EthRecord } from '../../data/types'
import { truncateHex } from '../../data/transform'
import type { TokenRegistry } from '../../data/tokenRegistry'
import { RowDetail } from './RowDetail'

interface RowFullscreenProps {
  record: EthRecord
  onClose: () => void
  /** Exit animation in progress — adds `--closing`; DataTable unmounts shortly after. */
  closing: boolean
  /** Threaded straight through to RowDetail, so the promoted view can't disagree with the
   *  inline expanded row it was opened from. */
  tokens: TokenRegistry
}

/**
 * Fullscreen preview of one row — the same RowDetail panel the inline expand renders,
 * promoted to a full-viewport dialog. Opened by the per-row preview button in
 * DataTable.tsx's expander cell; DataTable owns which record (if any) is open and
 * restores focus to the opening button on close.
 *
 * Overlay contract matches DictionaryPanel: Esc closes, focus lands on the close button
 * on open, Tab is trapped inside (aria-modal promises AT the background is inert, so
 * keyboard focus must not tab out into it either). z-index sits above
 * `.table-card--fullscreen` so the preview also works from table fullscreen — and since
 * this renders with role="dialog", App.tsx's table-fullscreen Escape handler already
 * defers to it: one Esc closes this, the next exits table fullscreen.
 */
export function RowFullscreen({ record, onClose, closing, tokens }: RowFullscreenProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    closeBtnRef.current?.focus()
    // Save/restore the previous inline value rather than set/clear: when table fullscreen
    // is active underneath, App.tsx is already holding body overflow 'hidden' — clearing
    // to '' on close would release App's lock along with ours.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Focus trap — same pattern as DictionaryPanel: wrap at the first/last focusable.
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = panelRef.current.contains(active)
      if (e.shiftKey) {
        if (active === first || !inside) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !inside) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className={`row-fullscreen${closing ? ' row-fullscreen--closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Row details"
    >
      <div className="row-fullscreen__bar">
        <h2 className="row-fullscreen__title">Row details</h2>
        <span className="row-fullscreen__hash" title={record.transaction_hash}>
          {truncateHex(record.transaction_hash, 10, 6)}
        </span>
        <button
          ref={closeBtnRef}
          type="button"
          className="row-fullscreen__close"
          aria-label="Close row details"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="row-fullscreen__body">
        <RowDetail record={record} tokens={tokens} />
      </div>
    </div>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path
        d="M3.5 3.5l9 9M12.5 3.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

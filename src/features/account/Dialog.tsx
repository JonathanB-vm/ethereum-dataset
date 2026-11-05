import { useEffect, useRef, type ReactNode } from 'react'
import './account.css'

interface DialogProps {
  title: string
  onClose: () => void
  /**
   * `modal`: centered card. `panel`: right-hand slide-over, like the data dictionary.
   * `auth`: centered card whose content lays itself out — no title bar, a floating close.
   * `wide`: a large centered workspace, for forms with a side panel.
   */
  variant?: 'modal' | 'panel' | 'auth' | 'wide'
  children: ReactNode
  footer?: ReactNode
}

/**
 * The overlay shell for the account features, with the same contract as the data
 * dictionary and row fullscreen: Esc closes, focus moves into the dialog on open and
 * returns to whatever opened it on close, and Tab is trapped inside (aria-modal promises
 * the background is inert).
 */
export function Dialog({ title, onClose, variant = 'modal', children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button')
    first?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const focusables = ref.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const head = focusables[0]
      const tail = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault()
        head.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [onClose])

  return (
    <div className="acct-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`acct-dialog acct-dialog--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {variant === 'auth' ? (
          <>
            {children}
            <CloseButton onClose={onClose} className="acct-icon-btn acct-dialog__float-close" />
          </>
        ) : (
          <>
            <div className="acct-dialog__header">
              <h2 className="acct-dialog__title">{title}</h2>
              <CloseButton onClose={onClose} className="acct-icon-btn" />
            </div>
            <div className="acct-dialog__body">{children}</div>
          </>
        )}
        {footer && <div className="acct-dialog__footer">{footer}</div>}
      </div>
    </div>
  )
}

function CloseButton({ onClose, className }: { onClose: () => void; className: string }) {
  return (
    <button type="button" className={className} aria-label="Close" onClick={onClose}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
        <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  )
}

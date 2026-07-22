import { useEffect, useRef, useState } from 'react'

interface CopyButtonProps {
  /** Full (untruncated) value written to the clipboard. */
  value: string
}

/** Small icon button — copies `value`, flips to a check mark for 1.2s, then reverts. */
export function CopyButton({ value }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => window.clearTimeout(timeoutRef.current)
  }, [])

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Rows will later be clickable (row-detail drawer, etc.) — don't let a copy click bubble.
    e.stopPropagation()
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {
        // Clipboard permission denied or unavailable — fail silently, no confirmation shown.
      })
  }

  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' copy-btn--copied' : ''}`}
      onClick={handleClick}
      aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
          <path d="M2.5 10.5v-7a1 1 0 0 1 1-1h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}

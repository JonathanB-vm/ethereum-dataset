import type { ReactNode } from 'react'
import { ThemeToggle } from './ThemeToggle'

interface HeaderProps {
  blockNumber: number | null
  blockTime: string | null
  children?: ReactNode // right-side slot: global search etc.
}

/** Stroke-drawn Ethereum octahedron — same line weight/language as the table's funnel and
 *  ⓘ icons, replacing the old `⬨` text glyph (whose size/weight varied by platform font). */
function EthMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 12.7 8.1 8 10.9 3.3 8.1 8 1.6z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M3.7 9.7 8 14.4l4.3-4.7L8 12.2 3.7 9.7z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Header({ blockNumber, blockTime, children }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo" aria-hidden="true">
          <EthMark />
        </span>
        <div>
          <h1>Ethereum Dataset Explorer</h1>
          <p className="app-header__sub">BigQuery · blockchain_analytics_ethereum_mainnet_us</p>
        </div>
      </div>
      {blockNumber != null && (
        <span className="block-badge" title={blockTime ?? undefined}>
          <span className="block-badge__dot" aria-hidden="true" />
          Block #{blockNumber.toLocaleString('en-US')}
        </span>
      )}
      <div className="app-header__actions">
        {children}
        <ThemeToggle />
      </div>
    </header>
  )
}

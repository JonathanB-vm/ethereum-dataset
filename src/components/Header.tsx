import type { ReactNode } from 'react'
import { ThemeToggle } from './ThemeToggle'

interface HeaderProps {
  blockNumber: number | null
  blockTime: string | null
  children?: ReactNode // right-side slot: global search etc.
}

export function Header({ blockNumber, blockTime, children }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo" aria-hidden="true">
          ⬨
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

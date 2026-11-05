import { useEffect, useRef, useState } from 'react'
import { initials } from '../../../registry/registry'
import type { AuthSettings } from './accountApi'
import { ProposeVariableModal } from './ProposeVariableModal'
import { RequestsPanel } from './RequestsPanel'
import { SignInDialog } from './SignInDialog'
import { useAccount } from './useAccount'
import './account.css'

type Overlay = 'propose' | 'mine' | 'review' | null

/**
 * The header's account control: sign in, then a menu to propose a variable, follow your
 * requests and — for admins — review the queue. Rendered only when the explorer runs
 * against an API (App.tsx checks `VITE_API_URL`).
 */
export function AccountButton({ onVariableAdded }: { onVariableAdded: () => void }) {
  const account = useAccount()
  const [menuOpen, setMenuOpen] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [menuOpen])

  if (account.loading) return null
  if (!account.settings) return null // API unreachable: hide rather than offer a broken sign-in

  const { user } = account
  if (!user) return <SignInButton settings={account.settings} account={account} />

  const choose = (o: Overlay) => {
    setMenuOpen(false)
    setOverlay(o)
  }

  return (
    <div className="acct-menu-wrap" ref={menuRef}>
      <button
        type="button"
        className="acct-avatar"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Account: ${user.name}`}
        title={user.name}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {initials(user.name)}
      </button>
      {menuOpen && (
        <div className="acct-menu" role="menu">
          <div className="acct-menu__who">
            <span>{user.name}</span>
            <span className="acct-muted">{user.role === 'admin' ? 'Admin' : 'Researcher'}</span>
          </div>
          <button type="button" role="menuitem" className="acct-menu__item" onClick={() => choose('propose')}>
            Propose a variable…
          </button>
          <button type="button" role="menuitem" className="acct-menu__item" onClick={() => choose('mine')}>
            My requests
          </button>
          {user.role === 'admin' && (
            <button type="button" role="menuitem" className="acct-menu__item" onClick={() => choose('review')}>
              Review requests
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="acct-menu__item acct-menu__item--danger"
            onClick={() => {
              setMenuOpen(false)
              account.signOut()
            }}
          >
            Sign out
          </button>
        </div>
      )}
      {notice && (
        <div className="acct-toast" role="status" onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {overlay === 'propose' && (
        <ProposeVariableModal
          onClose={() => setOverlay(null)}
          onSubmitted={(r) => {
            setOverlay(null)
            setNotice(`Request for ${r.variableId} submitted for review`)
          }}
        />
      )}
      {(overlay === 'mine' || overlay === 'review') && (
        <RequestsPanel user={user} mode={overlay} onClose={() => setOverlay(null)} onVariableAdded={onVariableAdded} />
      )}
    </div>
  )
}

// ---------- signed out ----------

function SignInButton({ settings, account }: { settings: AuthSettings; account: ReturnType<typeof useAccount> }) {
  const [open, setOpen] = useState(false)
  if (!settings.google_client_id && !settings.dev_login) return null
  return (
    <>
      <button type="button" className="acct-btn acct-signin" onClick={() => setOpen(true)}>
        Sign in
      </button>
      {open && (
        <SignInDialog
          settings={settings}
          onClose={() => setOpen(false)}
          signInWithGoogle={account.signInWithGoogle}
          signInDev={account.signInDev}
        />
      )}
    </>
  )
}

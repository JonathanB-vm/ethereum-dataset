import { useEffect, useRef, useState, type FormEvent } from 'react'
import { initials } from '../../../registry/registry'
import type { AuthSettings } from './accountApi'
import { Dialog } from './Dialog'

interface Props {
  settings: AuthSettings
  onClose: () => void
  signInWithGoogle: (credential: string) => Promise<void>
  signInDev: (email: string, name: string) => Promise<void>
}

/**
 * The sign-in card. The left pane is a fragment of the explorer's own table — a research
 * column with its creator's badge — and the badge follows the name typed on the right,
 * because putting a column under your name is what signing in is for. Browsing never
 * needs an account.
 */
export function SignInDialog({ settings, onClose, signInWithGoogle, signInDev }: Props) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const submitEmail = (e: FormEvent) => {
    e.preventDefault()
    void run(() => signInDev(email.trim(), name.trim()))
  }

  const badgeName = name.trim() || email.split('@')[0] || ''
  const hasGoogle = Boolean(settings.google_client_id)

  return (
    <Dialog title="Sign in" onClose={onClose} variant="auth">
      <div className="auth">
        <aside className="auth__preview" aria-hidden="true">
          <ColumnPreview badge={badgeName ? initials(badgeName) : 'You'} />
          <p className="auth__preview-caption">
            Propose a column for the dataset. An admin reviews every query before it runs, and the column carries your
            initials.
          </p>
        </aside>

        <div className="auth__main">
          <span className="auth__mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none">
              <path d="M8 1.6 12.7 8.1 8 10.9 3.3 8.1 8 1.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M3.7 9.7 8 14.4l4.3-4.7L8 12.2 3.7 9.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          </span>
          <h2 className="auth__title">Sign in to Ethereum Dataset Explorer</h2>
          <p className="auth__lede">Browsing stays open to everyone. Sign in to propose variables and follow your requests.</p>

          {hasGoogle && (
            <GoogleButton
              clientId={settings.google_client_id!}
              onCredential={(credential) => run(() => signInWithGoogle(credential))}
            />
          )}

          {settings.dev_login && (
            <>
              {hasGoogle && (
                <div className="auth__divider" role="separator">
                  <span>or</span>
                </div>
              )}
              <form className="auth__form" onSubmit={submitEmail}>
                <label className="auth__field">
                  <span>Email</span>
                  <input
                    className="acct-input"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label className="auth__field">
                  <span>Name</span>
                  <input
                    className="acct-input"
                    autoComplete="name"
                    placeholder="Shown on the columns you propose"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <button type="submit" className="acct-btn acct-btn--primary auth__submit" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in with email'}
                </button>
              </form>
              <p className="auth__note">
                Email sign-in works only on this local server (<code>AUTH_DEV_LOGIN=1</code>). It is never enabled on a
                public site, where Google sign-in is used.
              </p>
            </>
          )}

          {!hasGoogle && !settings.dev_login && (
            <p className="auth__note">Sign-in isn&apos;t set up on this server yet. Ask an admin to configure Google sign-in.</p>
          )}

          {error && (
            <p className="acct-error auth__error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** A strip of the table's research-column treatment: tinted, with the creator's badge. */
function ColumnPreview({ badge }: { badge: string }) {
  const rows = [
    ['0x3f9a…c41e', '1'],
    ['0x88d2…07b5', '0'],
    ['0xa1c4…9f30', '1'],
    ['0x5e07…d2a8', '0'],
    ['0xc6b9…41f7', '0'],
  ]
  return (
    <div className="auth-preview">
      <div className="auth-preview__head">
        <span className="auth-preview__th">Tx Hash</span>
        <span className="auth-preview__th auth-preview__th--variable">
          Your variable
          <span className="auth-preview__badge">{badge}</span>
        </span>
      </div>
      {rows.map(([hash, v]) => (
        <div key={hash} className="auth-preview__row">
          <span className="auth-preview__td">{hash}</span>
          <span className="auth-preview__td auth-preview__td--variable">{v}</span>
        </div>
      ))}
    </div>
  )
}

interface GoogleId {
  accounts: {
    id: {
      initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void
    }
  }
}

/**
 * Google's own button (Google's brand rules require their rendering), themed to match the
 * explorer. The credential it returns goes to the API, which verifies it with Google.
 */
function GoogleButton({ clientId, onCredential }: { clientId: string; onCredential: (c: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const render = () => {
      const google = (window as unknown as { google?: GoogleId }).google
      if (!google || !ref.current) return
      const dark = document.documentElement.dataset.theme !== 'light'
      google.accounts.id.initialize({ client_id: clientId, callback: (r) => onCredential(r.credential) })
      google.accounts.id.renderButton(ref.current, {
        theme: dark ? 'filled_black' : 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width: 320,
      })
    }
    if (document.querySelector('script[data-gsi]')) {
      render()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.dataset.gsi = 'true'
    script.onload = render
    document.head.appendChild(script)
  }, [clientId, onCredential])
  return <div ref={ref} className="auth__google" />
}

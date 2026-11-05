import { useCallback, useEffect, useState } from 'react'
import { accountApi, type AccountUser, type AuthSettings } from './accountApi'

export interface AccountState {
  /** Null until the API answered (or when it is unreachable). */
  settings: AuthSettings | null
  user: AccountUser | null
  /** True while the first `me` call is in flight. */
  loading: boolean
  signInWithGoogle: (credential: string) => Promise<void>
  signInDev: (email: string, name: string) => Promise<void>
  signOut: () => Promise<void>
}

/** The signed-in user, from the API's session cookie. An unreachable API reads as signed out. */
export function useAccount(): AccountState {
  const [settings, setSettings] = useState<AuthSettings | null>(null)
  const [user, setUser] = useState<AccountUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([accountApi.settings().catch(() => null), accountApi.me().catch(() => null)]).then(([s, u]) => {
      if (cancelled) return
      setSettings(s)
      setUser(u)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const signInWithGoogle = useCallback(async (credential: string) => {
    setUser(await accountApi.signInWithGoogle(credential))
  }, [])
  const signInDev = useCallback(async (email: string, name: string) => {
    setUser(await accountApi.signInDev(email, name))
  }, [])
  const signOut = useCallback(async () => {
    await accountApi.signOut().catch(() => {})
    setUser(null)
  }, [])

  return { settings, user, loading, signInWithGoogle, signInDev, signOut }
}

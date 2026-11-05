/**
 * Authentication: Google sign-in and a signed session cookie.
 *
 * The browser runs Google Identity Services, which hands it an ID token (a JWT signed by
 * Google). The browser posts that token here once; the server verifies it against Google's
 * published keys, upserts the user, and sets a session cookie. From then on the cookie is
 * the credential. Viewing the dataset never needs it — only proposing and reviewing
 * variables do.
 *
 * No auth library: RS256 verification and the cookie's HMAC are both a few lines of
 * node:crypto, and keeping them here keeps every check visible and tested.
 *
 * Configuration (environment):
 *   GOOGLE_CLIENT_ID  OAuth Web client id; the ID token's audience must equal it
 *   SESSION_SECRET    HMAC key for the session cookie (random per process if unset)
 *   ADMIN_EMAILS      comma-separated; these accounts are admins
 *   AUTH_DEV_LOGIN    "1" enables POST /v1/auth/dev — local development and tests only
 */

import crypto from 'node:crypto'
import type { AppStore, AppUser } from './store.ts'
import { chDateTime } from './store.ts'

export const SESSION_COOKIE = 'eth_session'
const SESSION_TTL_SECONDS = 7 * 24 * 3600

export interface AuthConfig {
  googleClientId: string
  sessionSecret: string
  adminEmails: string[]
  devLogin: boolean
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    // A random secret still works for one process; sessions just don't survive a restart.
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    devLogin: env.AUTH_DEV_LOGIN === '1',
  }
}

export class AuthError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 401) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

// ---------------------------------------------------------------------------
// Session cookie: base64url(JSON payload) "." base64url(HMAC-SHA256)
// ---------------------------------------------------------------------------

interface SessionPayload {
  uid: string
  /** Expiry, unix seconds. */
  exp: number
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url')

function hmac(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

export function signSession(uid: string, secret: string, now = Date.now()): string {
  const payload: SessionPayload = { uid, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS }
  const body = b64url(JSON.stringify(payload))
  return `${body}.${hmac(body, secret)}`
}

/** The user id in a valid, unexpired session token, or null. Never throws. */
export function verifySession(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = hmac(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (typeof payload.uid !== 'string' || payload.exp * 1000 <= now) return null
    return payload.uid
  } catch {
    return null
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** Set-Cookie value. `Secure` is added when the API is served over https. */
export function sessionCookie(token: string, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}` +
    (secure ? '; Secure' : '')
  )
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// ---------------------------------------------------------------------------
// Google ID token verification
// ---------------------------------------------------------------------------

export interface GoogleClaims {
  sub: string
  email: string
  emailVerified: boolean
  name: string
  picture: string
}

export type Jwk = crypto.JsonWebKey & { kid?: string }
export type JwksFetcher = () => Promise<Jwk[]>

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com']

/**
 * Google's signing keys, cached for as long as Google's own Cache-Control allows. Keys
 * rotate, so a token signed with an unknown `kid` triggers one refetch before failing.
 */
export function googleJwksFetcher(fetchImpl: typeof fetch = fetch): JwksFetcher & { refresh: () => void } {
  let cache: { keys: Jwk[]; until: number } | null = null
  const fetcher = async () => {
    if (cache && Date.now() < cache.until) return cache.keys
    const res = await fetchImpl(GOOGLE_JWKS_URL)
    if (!res.ok) throw new AuthError('could not fetch Google signing keys', 503)
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600)
    const { keys } = (await res.json()) as { keys: Jwk[] }
    cache = { keys, until: Date.now() + maxAge * 1000 }
    return keys
  }
  return Object.assign(fetcher, { refresh: () => (cache = null) })
}

/**
 * Verifies a Google ID token: RS256 signature by a current Google key, issuer, audience
 * (our client id), and expiry. Throws AuthError on any failure.
 */
export async function verifyGoogleIdToken(
  token: string,
  opts: { clientId: string; jwks: JwksFetcher & { refresh?: () => void }; now?: number },
): Promise<GoogleClaims> {
  if (!opts.clientId) throw new AuthError('Google sign-in is not configured (GOOGLE_CLIENT_ID)', 501)
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError('malformed ID token')
  const [h, p, s] = parts

  let header: { alg?: string; kid?: string }
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  } catch {
    throw new AuthError('malformed ID token')
  }
  if (header.alg !== 'RS256') throw new AuthError('unexpected token algorithm')

  let keys = await opts.jwks()
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk && opts.jwks.refresh) {
    opts.jwks.refresh()
    keys = await opts.jwks()
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk) throw new AuthError('token signed by an unknown key')

  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
  if (!valid) throw new AuthError('invalid token signature')

  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) throw new AuthError('unexpected token issuer')
  if (claims.aud !== opts.clientId) throw new AuthError('token was issued for a different client')
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new AuthError('token expired')

  return {
    sub: String(claims.sub ?? ''),
    email: String(claims.email ?? ''),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: String(claims.name ?? claims.email ?? ''),
    picture: String(claims.picture ?? ''),
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Finds or creates the user behind a sign-in. Matching is by Google subject first, then by
 * verified email — which is how a seeded account (Nir Chemaya, created before he ever
 * signed in) gets claimed: an admin records his email, and his first sign-in links it.
 *
 * Admin rights follow ADMIN_EMAILS on every sign-in, so removing an address from the list
 * demotes that account the next time it signs in.
 */
export async function upsertSignedInUser(
  store: AppStore,
  identity: { sub: string; email: string; emailVerified: boolean; name: string; picture: string },
  adminEmails: string[],
): Promise<AppUser> {
  if (!identity.emailVerified) throw new AuthError('this Google account has no verified email', 403)
  const isAdmin = adminEmails.includes(identity.email.toLowerCase())

  const existing =
    (identity.sub ? await store.findUserByGoogleSub(identity.sub) : null) ??
    (await store.findUserByEmail(identity.email))

  const user: AppUser = existing
    ? {
        ...existing,
        googleSub: existing.googleSub || identity.sub,
        email: identity.email,
        name: existing.name || identity.name,
        pictureUrl: identity.picture || existing.pictureUrl,
        role: isAdmin ? 'admin' : 'researcher',
      }
    : {
        id: crypto.randomUUID(),
        googleSub: identity.sub,
        email: identity.email,
        name: identity.name || identity.email,
        pictureUrl: identity.picture,
        role: isAdmin ? 'admin' : 'researcher',
        createdAt: chDateTime(),
      }
  await store.saveUser(user)
  return user
}

/** The public shape of a user: no Google subject. */
export function publicUser(u: AppUser) {
  return { id: u.id, name: u.name, email: u.email, picture_url: u.pictureUrl, role: u.role }
}

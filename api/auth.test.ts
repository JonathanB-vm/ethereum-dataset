// @vitest-environment node
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AuthError,
  authConfigFromEnv,
  parseCookies,
  signSession,
  upsertSignedInUser,
  verifyGoogleIdToken,
  verifySession,
  type Jwk,
} from './auth.ts'
import { MemoryStore } from './store.ts'

const SECRET = 'test-secret'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'

// A locally generated key stands in for Google's: tokens are signed exactly as Google
// signs them (RS256), so the whole verification path runs without touching the network.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'test-kid'
const jwk: Jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: KID }
const jwks = async () => [jwk]

function token(claims: Record<string, unknown>, opts: { kid?: string; key?: crypto.KeyObject; alg?: string } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), opts.key ?? privateKey).toString('base64url')
  return `${header}.${body}.${sig}`
}

const NOW = Date.UTC(2026, 10, 5)
const valid = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '10769150350006150715113082367',
  email: 'nir@example.com',
  email_verified: true,
  name: 'Nir Chemaya',
  picture: 'https://example.com/p.png',
  exp: NOW / 1000 + 3600,
}
const verify = (t: string) => verifyGoogleIdToken(t, { clientId: CLIENT_ID, jwks, now: NOW })

describe('session cookie', () => {
  it('round-trips a user id', () => {
    expect(verifySession(signSession('u1', SECRET, NOW), SECRET, NOW)).toBe('u1')
  })

  it('rejects a tampered payload, a wrong secret, and an expired token', () => {
    const t = signSession('u1', SECRET, NOW)
    const [, sig] = t.split('.')
    const forged = `${Buffer.from(JSON.stringify({ uid: 'admin', exp: 9e9 })).toString('base64url')}.${sig}`
    expect(verifySession(forged, SECRET, NOW)).toBeNull()
    expect(verifySession(t, 'other-secret', NOW)).toBeNull()
    expect(verifySession(t, SECRET, NOW + 8 * 24 * 3600 * 1000)).toBeNull()
    expect(verifySession(undefined, SECRET)).toBeNull()
    expect(verifySession('garbage', SECRET)).toBeNull()
  })

  it('parses the cookie header', () => {
    expect(parseCookies('a=1; eth_session=x.y; b=%20z')).toEqual({ a: '1', eth_session: 'x.y', b: ' z' })
    expect(parseCookies(undefined)).toEqual({})
  })
})

describe('verifyGoogleIdToken', () => {
  it('accepts a valid token and returns its identity', async () => {
    await expect(verify(token(valid))).resolves.toEqual({
      sub: valid.sub,
      email: 'nir@example.com',
      emailVerified: true,
      name: 'Nir Chemaya',
      picture: valid.picture,
    })
  })

  it('rejects the wrong audience, issuer, an expired token and a non-RS256 header', async () => {
    await expect(verify(token({ ...valid, aud: 'someone-else' }))).rejects.toThrow(/different client/)
    await expect(verify(token({ ...valid, iss: 'https://evil.example' }))).rejects.toThrow(/issuer/)
    await expect(verify(token({ ...valid, exp: NOW / 1000 - 1 }))).rejects.toThrow(/expired/)
    await expect(verify(token(valid, { alg: 'HS256' }))).rejects.toThrow(/algorithm/)
  })

  it('rejects a token signed by a different key, or by an unknown key id', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    await expect(verify(token(valid, { key: other }))).rejects.toThrow(/signature/)
    await expect(verify(token(valid, { kid: 'nope' }))).rejects.toThrow(/unknown key/)
  })

  it('refetches the keys once when the key id is new (Google rotated its keys)', async () => {
    let calls = 0
    const rotating = Object.assign(async () => (calls++ === 0 ? [] : [jwk]), { refresh: () => {} })
    await expect(verifyGoogleIdToken(token(valid), { clientId: CLIENT_ID, jwks: rotating, now: NOW })).resolves.toMatchObject({ sub: valid.sub })
    expect(calls).toBe(2)
  })

  it('refuses when Google sign-in is not configured', async () => {
    await expect(verifyGoogleIdToken(token(valid), { clientId: '', jwks, now: NOW })).rejects.toMatchObject({ statusCode: 501 })
  })
})

describe('upsertSignedInUser', () => {
  const identity = { sub: 's1', email: 'Researcher@Example.com', emailVerified: true, name: 'Ada', picture: '' }

  it('creates a researcher on first sign-in and finds them again by Google subject', async () => {
    const store = new MemoryStore()
    const first = await upsertSignedInUser(store, identity, [])
    expect(first.role).toBe('researcher')
    const again = await upsertSignedInUser(store, { ...identity, email: 'new@example.com' }, [])
    expect(again.id).toBe(first.id)
    expect(again.email).toBe('new@example.com')
  })

  it('claims a seeded account by its email and links the Google subject', async () => {
    const store = new MemoryStore()
    await store.saveUser({ id: 'nir-chemaya', googleSub: '', email: 'nir@example.com', name: 'Nir Chemaya', pictureUrl: '', role: 'researcher', createdAt: '' })
    const user = await upsertSignedInUser(store, { ...identity, email: 'NIR@example.com', sub: 'g-nir' }, [])
    expect(user.id).toBe('nir-chemaya')
    expect(user.googleSub).toBe('g-nir')
    expect(user.name).toBe('Nir Chemaya')
  })

  it('grants and revokes admin from the allowlist on every sign-in', async () => {
    const store = new MemoryStore()
    expect((await upsertSignedInUser(store, identity, ['researcher@example.com'])).role).toBe('admin')
    expect((await upsertSignedInUser(store, identity, [])).role).toBe('researcher')
  })

  it('refuses an unverified email', async () => {
    await expect(upsertSignedInUser(new MemoryStore(), { ...identity, emailVerified: false }, [])).rejects.toBeInstanceOf(AuthError)
  })
})

describe('authConfigFromEnv', () => {
  it('reads and normalizes the allowlist, and only enables dev login on "1"', () => {
    const c = authConfigFromEnv({ ADMIN_EMAILS: ' A@x.com, b@y.com ,', AUTH_DEV_LOGIN: 'true' })
    expect(c.adminEmails).toEqual(['a@x.com', 'b@y.com'])
    expect(c.devLogin).toBe(false)
    expect(c.sessionSecret.length).toBeGreaterThan(20)
  })
})

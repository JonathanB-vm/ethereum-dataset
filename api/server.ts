/**
 * The read API.
 *
 * REST, JSON, versioned under /v1. Hex fields are 0x-prefixed lowercase strings and
 * 256-bit numbers are decimal strings, matching what the explorer already handles with
 * BigInt. Every list endpoint is cursor-paginated and every request is bounded.
 *
 * Spec: docs/superpowers/specs/2026-09-08-api-and-frontend.md
 */

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { cacheHeadersFor } from './caching.ts'
import { ClickHouseClient, ClickHouseError } from './clickhouse.ts'
import { decodeCursor, encodeCursor, InvalidCursorError, type Cursor } from './cursor.ts'
import {
  buildAddressPage,
  buildHead,
  buildPage,
  buildRecordsPage,
  buildStats,
  buildTxByHash,
  sortKeyOf,
  type Table,
} from './queries.ts'
import {
  classifySearch,
  isTxHash,
  normalizeHex,
  parseScope,
  resolveLimit,
  ScopeError,
  type Scope,
} from './scope.ts'
import {
  blockSpan,
  buildVariableValues,
  columnarValues,
  filterCatalog,
  listVariables,
  mergeCatalog,
  mergeVariableValues,
  parseVariablesParam,
  type VariableResource,
} from './variables.ts'
import { USERS } from '../registry/registry.ts'
import {
  AuthError,
  authConfigFromEnv,
  clearedSessionCookie,
  googleJwksFetcher,
  parseCookies,
  publicUser,
  SESSION_COOKIE,
  sessionCookie,
  signSession,
  upsertSignedInUser,
  verifyGoogleIdToken,
  verifySession,
  type AuthConfig,
  type JwksFetcher,
} from './auth.ts'
import { ClickHouseStore, type AppStore, type AppUser, type RequestStatus, type VariableRequest } from './store.ts'
import {
  approveRequest,
  createRequest,
  estimateDraft,
  QUERY_TEMPLATE,
  rejectRequest,
  RequestError,
  type RequestContext,
  type RequestDraft,
} from './variableRequests.ts'

/** Blockscout's anonymous default; the row cap and timeout are the real protection. */
export const RATE_LIMIT_ANONYMOUS = 300
export const RATE_LIMIT_KEYED = 600

export interface ServerOptions {
  client?: ClickHouseClient
  release?: string
  /** App data (users, requests, runs, catalog). Defaults to ClickHouse via `client`. */
  store?: AppStore
  auth?: AuthConfig
  /** Google signing keys; injectable so tests can sign their own tokens. */
  jwks?: JwksFetcher & { refresh?: () => void }
  /** Range an approved variable is computed over; defaults to every loaded block. */
  computeRange?: () => Promise<{ from: number; to: number }>
  /**
   * Connection for researcher-submitted SQL, as the restricted research user. Defaults to
   * RESEARCH_CLICKHOUSE_USER / RESEARCH_CLICKHOUSE_PASSWORD; without them, variable
   * requests are refused rather than run as the API's own user. `null` disables them.
   */
  researchClient?: ClickHouseClient | null
}

/** The research user's connection from the environment, or null if it is not configured. */
export function researchClientFromEnv(env: NodeJS.ProcessEnv = process.env): ClickHouseClient | null {
  const user = env.RESEARCH_CLICKHOUSE_USER
  if (!user) return null
  return new ClickHouseClient({ user, password: env.RESEARCH_CLICKHOUSE_PASSWORD ?? '' })
}

interface PageQuery {
  block_from?: string
  block_to?: string
  address?: string
  hash?: string
  cursor?: string
  limit?: string
  sort?: 'asc' | 'desc'
  /** Comma-separated research-variable ids to attach to each row. Opt-in. */
  variables?: string
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false })
  const client = options.client ?? new ClickHouseClient()
  const release = options.release ?? process.env.DATASET_RELEASE ?? 'dev'
  const store = options.store ?? new ClickHouseStore(client)
  const auth = options.auth ?? authConfigFromEnv()
  const jwks = options.jwks ?? googleJwksFetcher()
  const researchClient = options.researchClient !== undefined ? options.researchClient : researchClientFromEnv()
  const requests: RequestContext = { store, client, researchClient, computeRange: options.computeRange }

  /** Cached briefly so every request does not re-query the head block. */
  let headCache: { block: number; timestamp: string; at: number } | null = null
  async function currentHead() {
    if (headCache && Date.now() - headCache.at < 10_000) return headCache
    const row = await client.queryOne<{ block: number; timestamp: string }>(buildHead())
    headCache = {
      block: Number(row?.block ?? 0),
      timestamp: String(row?.timestamp ?? ''),
      at: Date.now(),
    }
    return headCache
  }

  /** Whether the caller presented an API key, which raises both their limits. */
  const hasKey = (req: {
    headers: Record<string, string | string[] | undefined>
  }): boolean => Boolean(req.headers['x-api-key'])

  app.addHook('onRequest', async (req, reply) => {
    const keyed = hasKey(req)
    reply.header('x-ratelimit-limit', keyed ? RATE_LIMIT_KEYED : RATE_LIMIT_ANONYMOUS)
    reply.header('x-ratelimit-remaining', keyed ? RATE_LIMIT_KEYED : RATE_LIMIT_ANONYMOUS)
  })

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ScopeError) {
      return reply.code(400).send({ error: 'bad_scope', message: error.message })
    }
    if (error instanceof InvalidCursorError) {
      return reply.code(400).send({ error: 'bad_cursor', message: error.message })
    }
    if (error instanceof AuthError) {
      return reply.code(error.statusCode).send({ error: 'auth', message: error.message })
    }
    if (error instanceof RequestError) {
      return reply
        .code(error.statusCode)
        .send({ error: 'bad_request', message: error.message, details: error.details })
    }
    if (error instanceof ClickHouseError) {
      // Never leak the upstream query text to the caller.
      return reply.code(502).send({ error: 'upstream', message: 'query failed' })
    }
    return reply.code(500).send({ error: 'internal', message: 'unexpected error' })
  })

  /**
   * Attaches the requested research variables to a page, with one extra read bounded by the
   * page's own block span. A no-op when none were requested.
   */
  async function withVariables(
    rows: Record<string, unknown>[],
    ids: string[],
  ): Promise<Record<string, unknown>[]> {
    const span = blockSpan(rows)
    if (ids.length === 0 || span === null) return rows
    const values = await client.query<Parameters<typeof mergeVariableValues>[2][number]>(
      buildVariableValues(ids, span.from, span.to),
    )
    return mergeVariableValues(rows, ids, values)
  }

  function applyCache(reply: FastifyReply, scope: Scope, head: number) {
    for (const [k, v] of Object.entries(cacheHeadersFor(scope, head, release))) {
      reply.header(k, v)
    }
  }

  /** `?variables=` validated against the live catalog, which includes approved requests. */
  async function variableIdsFrom(raw: string | undefined): Promise<string[]> {
    if (raw == null || raw.trim() === '') return []
    const all = await cachedCatalog()
    return parseVariablesParam(raw, (id) => all.some((v) => v.id === id))
  }

  /** Serve one page and attach the cursor for the next. */
  async function servePage(
    table: Table,
    query: PageQuery,
    reply: FastifyReply,
    keyed: boolean,
  ): Promise<unknown> {
    const scope = parseScope(query)
    const limit = resolveLimit(query.limit, keyed)
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
    const dir = query.sort === 'desc' ? 'desc' : 'asc'
    const variableIds = await variableIdsFrom(query.variables)

    const built =
      scope.kind === 'address'
        ? buildAddressPage(table, scope.address, limit, cursor)
        : buildPage({ table, scope, limit, cursor, dir })

    const rows = await client.query<Record<string, unknown>>(built)
    const { block: head } = await currentHead()
    applyCache(reply, scope, head)

    const nextCursor =
      rows.length === limit
        ? encodeCursor({ key: sortKeyOf(rows[rows.length - 1], table), dir } as Cursor)
        : null

    return { rows: await withVariables(rows, variableIds), nextCursor }
  }

  app.get('/v1/head', async (_req, reply) => {
    const head = await currentHead()
    reply.header('Cache-Control', 'public, max-age=15')
    return { block: head.block, timestamp: head.timestamp, release }
  })

  app.get<{ Querystring: PageQuery }>('/v1/transactions', (req, reply) =>
    servePage('transactions', req.query, reply, hasKey(req)),
  )

  app.get<{ Querystring: PageQuery }>('/v1/transfers', (req, reply) =>
    servePage('token_transfers', req.query, reply, hasKey(req)),
  )

  /** The flat 35-column "All Records" view, rebuilt as a query-time join. */
  app.get<{ Querystring: PageQuery }>('/v1/records', async (req, reply) => {
    const scope = parseScope(req.query)
    if (scope.kind !== 'range') {
      throw new ScopeError('the records view requires a block range')
    }
    const limit = resolveLimit(req.query.limit, hasKey(req))
    const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : undefined
    const variableIds = await variableIdsFrom(req.query.variables)
    const rows = await client.query<Record<string, unknown>>(
      buildRecordsPage(scope.from, scope.to, limit, cursor),
    )
    const { block: head } = await currentHead()
    applyCache(reply, scope, head)

    const last = rows[rows.length - 1]
    const nextCursor =
      rows.length === limit && last
        ? encodeCursor({
            key: {
              block_number: Number(last.block_number),
              transaction_index: Number(last.transaction_index),
              event_index: Number(last.event_index ?? 0),
              batch_index: Number(last.batch_index ?? 0),
            },
            dir: 'asc',
          })
        : null
    return { rows: await withVariables(rows, variableIds), nextCursor }
  })

  app.get<{ Params: { hash: string } }>('/v1/transactions/:hash', async (req, reply) => {
    const hash = normalizeHex(req.params.hash)
    if (!isTxHash(hash)) throw new ScopeError('hash must be a 0x-prefixed 32-byte hex string')
    const row = await client.queryOne(buildTxByHash(hash))
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'no such transaction' })
    return row
  })

  app.get<{ Params: { n: string } }>('/v1/blocks/:n', async (req, reply) => {
    const n = Number(req.params.n)
    if (!Number.isInteger(n) || n < 0) throw new ScopeError('block must be a non-negative integer')
    const row = await client.queryOne(buildStats(n, n))
    const { block: head } = await currentHead()
    applyCache(reply, { kind: 'range', from: n, to: n }, head)
    if (!row || Number((row as Record<string, unknown>).blocks) === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'no such block' })
    }
    return { block_number: n, ...row }
  })

  app.get<{ Params: { addr: string }; Querystring: PageQuery }>(
    '/v1/addresses/:addr/transactions',
    (req, reply) =>
      servePage(
        'transactions',
        { ...req.query, address: req.params.addr },
        reply,
        hasKey(req),
      ),
  )

  app.get<{ Params: { addr: string }; Querystring: PageQuery }>(
    '/v1/addresses/:addr/transfers',
    (req, reply) =>
      servePage(
        'token_transfers',
        { ...req.query, address: req.params.addr },
        reply,
        hasKey(req),
      ),
  )

  app.get<{ Querystring: PageQuery }>('/v1/stats', async (req, reply) => {
    const scope = parseScope(req.query)
    if (scope.kind !== 'range') {
      throw new ScopeError('stats require a block range')
    }
    const row = await client.queryOne(buildStats(scope.from, scope.to))
    const { block: head } = await currentHead()
    applyCache(reply, scope, head)
    return row ?? {}
  })

  /** Typed global search, mirroring the explorer's header behaviour. */
  app.get<{ Querystring: { q?: string } }>('/v1/search', async (req) => {
    const q = req.query.q ?? ''
    if (q === '') throw new ScopeError('q is required')
    const hit = classifySearch(q)
    if (hit.kind === 'txHash') return { kind: 'transaction', href: `/v1/transactions/${hit.value}` }
    if (hit.kind === 'address') return { kind: 'address', href: `/v1/addresses/${hit.value}/transactions` }
    if (hit.kind === 'block') return { kind: 'block', href: `/v1/blocks/${hit.value}` }
    return { kind: 'text', value: hit.value }
  })

  // ---------------------------------------------------------------------------
  // Research-variable catalog
  // ---------------------------------------------------------------------------

  /**
   * The registry seed merged with approved variables in the database. Falls back to the
   * seed alone when the database is unreachable, so the catalog never disappears.
   */
  async function catalog(): Promise<VariableResource[]> {
    try {
      const [entries, users] = await Promise.all([store.listCatalog(), store.listUsers()])
      return mergeCatalog(entries, users)
    } catch {
      return listVariables({})
    }
  }

  /** Short-lived, so a fresh approval shows up within seconds but a page burst is one read. */
  let catalogCache: { at: number; value: VariableResource[] } | null = null
  async function cachedCatalog(): Promise<VariableResource[]> {
    if (catalogCache && Date.now() - catalogCache.at < 5_000) return catalogCache.value
    catalogCache = { at: Date.now(), value: await catalog() }
    return catalogCache.value
  }

  /**
   * Optional filters: `tag` (exact), `q` (substring of id, label, description or tags),
   * `created_by` (user id).
   */
  app.get<{ Querystring: { tag?: string; q?: string; created_by?: string } }>(
    '/v1/variables',
    async (req, reply) => {
      reply.header('Cache-Control', 'public, max-age=30')
      return { variables: filterCatalog(await cachedCatalog(), req.query) }
    },
  )

  /**
   * Every catalog variable's values over a block range, in the same columnar shape as
   * public/data/variable-values.json.gz — catalog metadata included — so the explorer
   * loads both through one parser.
   */
  app.get<{ Querystring: PageQuery & { ids?: string } }>('/v1/variables/values', async (req) => {
    const scope = parseScope(req.query)
    if (scope.kind !== 'range') throw new ScopeError('variable values require a block range')
    const all = await cachedCatalog()
    const ids = req.query.ids ? parseVariablesParam(req.query.ids, (id) => all.some((v) => v.id === id)) : all.map((v) => v.id)
    const defs = all.filter((v) => ids.includes(v.id))
    const rows = ids.length
      ? await client.query<{ variable_id: string; block_number: number; transaction_index: number; value: number }>(
          buildVariableValues(ids, scope.from, scope.to),
        )
      : []
    return columnarValues(rows, defs)
  })

  app.get<{ Params: { id: string } }>('/v1/variables/:id', async (req, reply) => {
    const variable = (await cachedCatalog()).find((v) => v.id === req.params.id)
    if (!variable) return reply.code(404).send({ error: 'not_found', message: 'no such variable' })
    reply.header('Cache-Control', 'public, max-age=30')
    return { ...variable, runs: await store.listRuns(variable.id).catch(() => []) }
  })

  /** Users, from the users table; the registry's demo list if the table is empty or unreachable. */
  app.get('/v1/users', async () => {
    const users = await store.listUsers().catch(() => [])
    return {
      users: users.length
        ? users.map((u) => ({ id: u.id, name: u.name, role: u.role }))
        : USERS,
    }
  })

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  const secureCookies = process.env.NODE_ENV === 'production'

  async function currentUser(req: { headers: Record<string, string | string[] | undefined> }) {
    const cookie = req.headers.cookie
    const uid = verifySession(parseCookies(Array.isArray(cookie) ? cookie[0] : cookie)[SESSION_COOKIE], auth.sessionSecret)
    return uid ? store.getUser(uid) : null
  }

  async function requireUser(req: { headers: Record<string, string | string[] | undefined> }) {
    const user = await currentUser(req)
    if (!user) throw new AuthError('sign in to do this')
    return user
  }

  async function requireAdmin(req: { headers: Record<string, string | string[] | undefined> }) {
    const user = await requireUser(req)
    if (user.role !== 'admin') throw new AuthError('only an admin can do this', 403)
    return user
  }

  function signIn(reply: FastifyReply, user: AppUser) {
    reply.header('Set-Cookie', sessionCookie(signSession(user.id, auth.sessionSecret), secureCookies))
    return { user: publicUser(user) }
  }

  /** Public auth settings the browser needs to render the sign-in button. */
  app.get('/v1/auth/config', async () => ({
    google_client_id: auth.googleClientId || null,
    dev_login: auth.devLogin,
  }))

  app.post<{ Body: { credential?: string } }>('/v1/auth/google', async (req, reply) => {
    const credential = req.body?.credential
    if (!credential) throw new AuthError('missing Google credential', 400)
    const claims = await verifyGoogleIdToken(credential, { clientId: auth.googleClientId, jwks })
    return signIn(reply, await upsertSignedInUser(store, claims, auth.adminEmails))
  })

  /** Local development and tests only: sign in as any email without Google. */
  app.post<{ Body: { email?: string; name?: string } }>('/v1/auth/dev', async (req, reply) => {
    if (!auth.devLogin) return reply.code(404).send({ error: 'not_found', message: 'not found' })
    const email = req.body?.email?.trim()
    if (!email) throw new AuthError('email is required', 400)
    const identity = { sub: '', email, emailVerified: true, name: req.body?.name?.trim() || email, picture: '' }
    return signIn(reply, await upsertSignedInUser(store, identity, auth.adminEmails))
  })

  app.get('/v1/auth/me', async (req) => {
    const user = await currentUser(req)
    return { user: user ? publicUser(user) : null }
  })

  app.post('/v1/auth/logout', async (_req, reply) => {
    reply.header('Set-Cookie', clearedSessionCookie())
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Variable requests
  // ---------------------------------------------------------------------------

  /** The request as the API returns it, with requester and reviewer names resolved. */
  async function requestResource(r: VariableRequest) {
    const users = await store.listUsers()
    const name = (id: string) => (id ? (users.find((u) => u.id === id)?.name ?? id) : null)
    return { ...r, requestedByName: name(r.requestedBy), reviewedByName: name(r.reviewedBy) }
  }

  app.get('/v1/variable-requests/template', async () => ({ query_sql: QUERY_TEMPLATE }))

  app.post<{ Body: RequestDraft }>('/v1/variable-requests/estimate', async (req) => {
    await requireUser(req)
    return { estimate: await estimateDraft(requests, req.body ?? ({} as RequestDraft)) }
  })

  app.post<{ Body: RequestDraft }>('/v1/variable-requests', async (req, reply) => {
    const user = await requireUser(req)
    const created = await createRequest(requests, user, req.body ?? ({} as RequestDraft))
    return reply.code(201).send({ request: await requestResource(created) })
  })

  /** A researcher sees their own requests; an admin sees everyone's. */
  app.get<{ Querystring: { status?: RequestStatus; mine?: string } }>('/v1/variable-requests', async (req) => {
    const user = await requireUser(req)
    const mineOnly = user.role !== 'admin' || req.query.mine === '1'
    const list = await store.listRequests({
      requestedBy: mineOnly ? user.id : undefined,
      status: req.query.status,
    })
    return { requests: await Promise.all(list.map(requestResource)) }
  })

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/v1/variable-requests/:id/approve',
    async (req, reply) => {
      const admin = await requireAdmin(req)
      const { request, done } = await approveRequest(requests, admin, req.params.id, req.body?.note ?? '')
      // The computation continues after the response; the UI polls the request's status.
      done.then(() => (catalogCache = null)).catch(() => {})
      return reply.code(202).send({ request: await requestResource(request) })
    },
  )

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/v1/variable-requests/:id/reject',
    async (req) => {
      const admin = await requireAdmin(req)
      return { request: await requestResource(await rejectRequest(requests, admin, req.params.id, req.body?.note ?? '')) }
    },
  )

  app.get('/health', async () => ({ ok: await client.ping() }))

  return app
}

/* c8 ignore start -- process entry point, exercised by running it */
const isEntryPoint =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (isEntryPoint) {
  const port = Number(process.env.PORT ?? 3001)
  buildServer()
    .listen({ port, host: '0.0.0.0' })
    .then(() => console.log(`api listening on :${port}`))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
/* c8 ignore stop */

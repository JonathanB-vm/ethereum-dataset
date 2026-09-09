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

/** Blockscout's anonymous default; the row cap and timeout are the real protection. */
export const RATE_LIMIT_ANONYMOUS = 300
export const RATE_LIMIT_KEYED = 600

export interface ServerOptions {
  client?: ClickHouseClient
  release?: string
}

interface PageQuery {
  block_from?: string
  block_to?: string
  address?: string
  hash?: string
  cursor?: string
  limit?: string
  sort?: 'asc' | 'desc'
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false })
  const client = options.client ?? new ClickHouseClient()
  const release = options.release ?? process.env.DATASET_RELEASE ?? 'dev'

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
    if (error instanceof ClickHouseError) {
      // Never leak the upstream query text to the caller.
      return reply.code(502).send({ error: 'upstream', message: 'query failed' })
    }
    return reply.code(500).send({ error: 'internal', message: 'unexpected error' })
  })

  function applyCache(reply: FastifyReply, scope: Scope, head: number) {
    for (const [k, v] of Object.entries(cacheHeadersFor(scope, head, release))) {
      reply.header(k, v)
    }
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

    return { rows, nextCursor }
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
    return { rows, nextCursor }
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

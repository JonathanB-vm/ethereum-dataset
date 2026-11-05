// @vitest-environment node
/**
 * The whole researcher-request flow against a real ClickHouse holding the 100-block
 * sample: sign in, estimate, submit, approve as admin, and check the column landed in
 * every table it should. Uses dev login, so no Google client is needed.
 *
 * Every row it writes is tagged with a per-run id and deleted afterwards. Skipped — not
 * passed — when ClickHouse is unreachable or the schema predates the request tables.
 */

import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickHouseClient } from './clickhouse.ts'
import { buildServer } from './server.ts'
import { setupResearchUser } from '../pipeline/clickhouse/research_user.ts'

const FIRST_BLOCK = 25_534_200
const LAST_BLOCK = 25_534_299
const TOTAL_TRANSACTIONS = 40_642

const client = new ClickHouseClient()
const ready =
  (await client.ping()) &&
  (await client
    .query({ sql: "SELECT 1 FROM system.tables WHERE database = 'eth' AND name = 'variable_requests'" })
    .then((r) => r.length > 0)
    .catch(() => false))
if (!ready) console.warn('ClickHouse unreachable or schema not applied — request integration tests skipped')
const itLive = it.runIf(ready)

const RUN = crypto.randomBytes(3).toString('hex')
const VARIABLE = `it_big_sender_${RUN}`
const RESEARCHER = `researcher-${RUN}@test.local`
const ADMIN = `admin-${RUN}@test.local`

// A throwaway restricted research user, exactly as `npm run db:research-user` makes one.
const RESEARCH_USER = `eth_research_it_${RUN}`
const RESEARCH_PASSWORD = crypto.randomBytes(18).toString('base64url')
const researchClient = new ClickHouseClient({ user: RESEARCH_USER, password: RESEARCH_PASSWORD })

beforeAll(async () => {
  if (ready) await setupResearchUser(client, RESEARCH_USER, RESEARCH_PASSWORD)
}, 60_000)

const app = buildServer({
  client,
  researchClient,
  release: 'test',
  auth: { googleClientId: '', sessionSecret: `secret-${RUN}`, adminEmails: [ADMIN], devLogin: true },
})

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { email, name: email.split('@')[0] } })
  expect(res.statusCode).toBe(200)
  return String(res.headers['set-cookie']).split(';')[0]
}

const QUERY = `SELECT block_number, transaction_index,
       toUInt8(value > toUInt256('1000000000000000000')) AS value
FROM transactions
WHERE block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}`

// Lightweight DELETEs take a second or two each under the parallel suite's load, hence the
// generous budget; they touch different tables, so they run concurrently.
afterAll(async () => {
  if (!ready) return
  const del = (table: string, where: string, params: Record<string, string>) =>
    client.query({ sql: `DELETE FROM ${table} WHERE ${where}`, params }).catch(() => {})
  await Promise.all([
    del('tx_variable_values', 'variable_id = {v:String}', { v: VARIABLE }),
    del('variables', 'id = {v:String}', { v: VARIABLE }),
    del('variable_runs', 'variable_id = {v:String}', { v: VARIABLE }),
    del('variable_requests', 'variable_id = {v:String}', { v: VARIABLE }),
    del('users', "email LIKE {p:String}", { p: `%-${RUN}@test.local` }),
    client.query({ sql: `DROP USER IF EXISTS ${RESEARCH_USER}` }).catch(() => {}),
  ])
}, 60_000)

describe('researcher variable requests, end to end', () => {
  itLive('rejects anonymous submissions and unsafe SQL', async () => {
    const anon = await app.inject({ method: 'POST', url: '/v1/variable-requests', payload: {} })
    expect(anon.statusCode).toBe(401)

    const cookie = await login(RESEARCHER)
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/variable-requests/estimate',
      headers: { cookie },
      payload: { query_sql: `${QUERY}; DROP TABLE transactions` },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().details.join(' ')).toMatch(/one statement/)

    const wrongColumns = await app.inject({
      method: 'POST',
      url: '/v1/variable-requests/estimate',
      headers: { cookie },
      payload: { query_sql: 'SELECT block_number FROM transactions WHERE block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}' },
    })
    expect(wrongColumns.statusCode).toBe(400)
    expect(wrongColumns.json().details.join(' ')).toMatch(/exactly block_number, transaction_index, value/)
  })

  itLive('estimates, submits, blocks a non-admin approval, then computes on admin approval', async () => {
    const researcher = await login(RESEARCHER)

    const est = await app.inject({
      method: 'POST',
      url: '/v1/variable-requests/estimate',
      headers: { cookie: researcher },
      payload: { query_sql: QUERY },
    })
    expect(est.statusCode).toBe(200)
    const { estimate } = est.json()
    expect(estimate.samples).toHaveLength(2)
    expect(estimate.samples[1].readRows).toBeGreaterThan(0)
    expect(estimate.loaded.resultRows).toBeGreaterThan(30_000)
    expect(estimate.planner[0]).toMatchObject({ table: 'transactions' })
    expect(['light', 'moderate', 'heavy']).toContain(estimate.tier)

    const created = await app.inject({
      method: 'POST',
      url: '/v1/variable-requests',
      headers: { cookie: researcher },
      payload: { variable_id: VARIABLE, label: 'Big sender', description: 'Sent more than 1 ETH', tags: ['value'], query_sql: QUERY },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().request.id

    const mine = await app.inject({ method: 'GET', url: '/v1/variable-requests', headers: { cookie: researcher } })
    expect(mine.json().requests.map((r: { id: string }) => r.id)).toContain(id)

    const forbidden = await app.inject({ method: 'POST', url: `/v1/variable-requests/${id}/approve`, headers: { cookie: researcher } })
    expect(forbidden.statusCode).toBe(403)

    const admin = await login(ADMIN)
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/variable-requests/${id}/approve`,
      headers: { cookie: admin },
      payload: { note: 'ok' },
    })
    expect(approved.statusCode).toBe(202)

    let status = 'running'
    for (let i = 0; i < 60 && status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const all = (await app.inject({ method: 'GET', url: '/v1/variable-requests', headers: { cookie: admin } })).json()
      status = all.requests.find((r: { id: string }) => r.id === id).status
    }
    expect(status).toBe('completed')

    const stored = await client.queryOne<{ n: string }>({
      sql: 'SELECT count() AS n FROM tx_variable_values FINAL WHERE variable_id = {v:String}',
      params: { v: VARIABLE },
    })
    expect(Number(stored?.n)).toBe(TOTAL_TRANSACTIONS)

    const catalog = (await app.inject({ method: 'GET', url: `/v1/variables/${VARIABLE}` })).json()
    expect(catalog.created_by.name).toBe(RESEARCHER.split('@')[0])
    expect(catalog.approved_by.name).toBe(ADMIN.split('@')[0])
    expect(catalog.runs[0]).toMatchObject({ status: 'completed', rowsWritten: TOTAL_TRANSACTIONS })

    // The new column is immediately servable alongside the seed variables.
    const values = (
      await app.inject({ method: 'GET', url: `/v1/variables/values?block_from=${FIRST_BLOCK}&block_to=${LAST_BLOCK}` })
    ).json()
    expect(values.variables.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining(['simple_transaction', VARIABLE]))
    expect(values.blocks).toHaveLength(TOTAL_TRANSACTIONS)
    expect(values.values[VARIABLE].filter((x: number) => x === 1).length).toBeGreaterThan(0)
  })

  itLive('a researcher query cannot read private tables, even to leak them through an error', async () => {
    const cookie = await login(RESEARCHER)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/variable-requests/estimate',
      headers: { cookie },
      payload: {
        // Casting an email to a number would put the email in ClickHouse's error message.
        query_sql:
          'SELECT toUInt32(1) AS block_number, toUInt16(1) AS transaction_index, toUInt8(email) AS value ' +
          'FROM users WHERE {block_from:UInt32} <= {block_to:UInt32}',
      },
    })
    expect(res.statusCode).toBe(400)
    const body = res.body
    expect(body).toMatch(/Not enough privileges|ACCESS_DENIED/)
    expect(body).not.toContain(`researcher-${RUN}@test.local`)
    expect(body).not.toContain('@')
  })

  itLive('the research user is denied external table functions however the text is disguised', async () => {
    for (const sql of [
      "SELECT * FROM url('http://example.com', CSV, 'a String')",
      "SELECT * FROM file('x.csv', CSV, 'a String')",
      'SELECT * FROM remote(\'localhost\', system.one)',
      'SELECT email FROM users',
      'SELECT query FROM system.query_log',
    ]) {
      await expect(researchClient.query({ sql, settings: { readonly: 2 } }), sql).rejects.toThrow(/privileges|ACCESS_DENIED/i)
    }
    // ...while the dataset itself stays readable.
    const [row] = await researchClient.query<{ n: string }>({ sql: 'SELECT count() AS n FROM transactions' })
    expect(Number(row.n)).toBe(TOTAL_TRANSACTIONS)
  })

  itLive('readonly=2 stops a write even if text validation were bypassed', async () => {
    await expect(
      client.query({ sql: "INSERT INTO users (id, name, created_at, updated_at) VALUES ('x', 'x', now(), now64())", settings: { readonly: 2 } }),
    ).rejects.toThrow(/readonly/i)
  })
})

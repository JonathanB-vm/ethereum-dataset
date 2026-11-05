// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ClickHouseClient, QuerySpec } from './clickhouse.ts'
import { MemoryStore, type AppUser } from './store.ts'
import {
  approveRequest,
  checkDraft,
  checkQueryText,
  createRequest,
  normalizeQuery,
  QUERY_TEMPLATE,
  rejectRequest,
  RequestError,
  wrapInsert,
  type RequestContext,
  type RequestDraft,
} from './variableRequests.ts'

const GOOD = QUERY_TEMPLATE

describe('checkQueryText', () => {
  it('accepts the template and WITH queries, with comments and one trailing semicolon', () => {
    expect(checkQueryText(GOOD)).toEqual([])
    expect(checkQueryText(`-- note\nWITH x AS (SELECT 1)\n${GOOD};`)).toEqual([])
  })

  it.each([
    ['INSERT INTO variables VALUES (1)', /SELECT or WITH/],
    ['DROP TABLE transactions', /SELECT or WITH/],
    [`${GOOD}; DROP TABLE transactions`, /one statement/],
    ['SELECT 1 AS block_number, 2 AS transaction_index, 3 AS value', /block_from/],
    [`${GOOD} AND 1 IN (SELECT * FROM url('http://x', CSV, 'a Int8'))`, /url\(\) is not allowed/],
    [`${GOOD} UNION ALL SELECT * FROM remote('h', db.t)`, /remote\(\) is not allowed/],
    [`${GOOD} SETTINGS readonly = 0`, /SETTINGS/],
    [`${GOOD} FORMAT JSON`, /FORMAT/],
    [`${GOOD} INTO OUTFILE 'x'`, /OUTFILE/],
    ['   ', /empty/],
  ])('rejects %s', (sql, message) => {
    expect(checkQueryText(sql).join(' | ')).toMatch(message)
  })

  it('ignores forbidden words inside comments and string literals', () => {
    expect(checkQueryText(`-- reads like url('x') but is a comment\n${GOOD}`)).toEqual([])
    expect(checkQueryText(`${GOOD} AND 'url(' != ''`)).toEqual([])
  })

  it.each([
    // A `--` inside a string must not comment out the rest of the line for the checker.
    [`${GOOD} AND '--' != '' AND 1 IN (SELECT * FROM url('http://x', CSV, 'a Int8'))`, /url\(\)/],
    [`${GOOD} AND 'it''s -- fine' != '' AND 1 IN (SELECT * FROM file('x', CSV, 'a Int8'))`, /file\(\)/],
    // A backslash-escaped quote does not end the literal, so its `--` is still inside it.
    [`${GOOD} AND 'a\\'--' != '' AND 1 IN (SELECT * FROM s3('x'))`, /s3\(\)/],
    // Quoting the function name does not hide it.
    [`${GOOD} AND 1 IN (SELECT * FROM "url"('http://x', CSV, 'a Int8'))`, /url\(\)/],
    [`${GOOD} AND 1 IN (SELECT * FROM \`remote\`('h', db.t))`, /remote\(\)/],
    // Nor does a comment between the name and its parenthesis.
    [`${GOOD} AND 1 IN (SELECT * FROM url/**/('http://x', CSV, 'a Int8'))`, /url\(\)/],
    // A semicolon hidden behind a fake comment start inside a string is still found.
    [`${GOOD} AND '--' != ''; DROP TABLE transactions`, /one statement/],
  ])('sees through literal and identifier tricks: %s', (sql, message) => {
    expect(checkQueryText(sql).join(' | ')).toMatch(message)
  })

  it('does not accept range parameters that only appear inside a string', () => {
    const sql = "SELECT block_number, transaction_index, 1 AS value FROM transactions WHERE '{block_from:UInt32} {block_to:UInt32}' != ''"
    expect(checkQueryText(sql).join()).toMatch(/block_from/)
  })
})

describe('checkDraft', () => {
  const draft: RequestDraft = { variable_id: 'big_sender', label: 'Big sender', query_sql: GOOD, tags: ['value'] }

  it('accepts a complete draft', () => {
    expect(checkDraft(draft, new Set())).toEqual([])
  })

  it('reports a bad id, a taken id, a missing label and bad tags', () => {
    expect(checkDraft({ ...draft, variable_id: 'Big-Sender' }, new Set()).join()).toMatch(/snake_case/)
    expect(checkDraft(draft, new Set(['big_sender'])).join()).toMatch(/already used/)
    expect(checkDraft({ ...draft, label: ' ' }, new Set()).join()).toMatch(/label is required/)
    expect(checkDraft({ ...draft, tags: ['Not OK'] }, new Set()).join()).toMatch(/kebab-case/)
  })
})

describe('wrapInsert', () => {
  it('wraps the query in an INSERT whose every value except the query is bound', () => {
    const sql = wrapInsert(`${GOOD};`)
    expect(sql).toMatch(/^INSERT INTO tx_variable_values /)
    expect(sql).toContain('{variable_id:String}')
    expect(sql).toContain('{version:UInt32}')
    expect(sql).toContain(normalizeQuery(GOOD))
    expect(sql.trimEnd().endsWith(')')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle, against the in-memory store and a scripted ClickHouse
// ---------------------------------------------------------------------------

const SUMMARY = { readRows: 1000, readBytes: 40_000, writtenRows: 0, resultRows: 400, elapsedMs: 2, memoryBytes: 1e6 }

/** Answers the handful of query shapes the request flow sends. */
function fakeClient(opts: { insertFails?: boolean } = {}) {
  const sent: QuerySpec[] = []
  const respond = async (spec: QuerySpec) => {
    sent.push(spec)
    if (spec.sql.startsWith('DESCRIBE')) {
      return [
        { name: 'block_number', type: 'UInt32' },
        { name: 'transaction_index', type: 'UInt16' },
        { name: 'value', type: 'UInt8' },
      ]
    }
    return []
  }
  const client = {
    query: respond,
    queryOne: async () => null,
    queryWithSummary: async (spec: QuerySpec) => {
      sent.push(spec)
      if (spec.sql.startsWith('INSERT')) {
        if (opts.insertFails) throw new Error('Code: 62. DB::Exception: Syntax error\nmore')
        return { rows: [], summary: { ...SUMMARY, writtenRows: 40_642 } }
      }
      return { rows: [], summary: SUMMARY }
    },
  }
  return { client: client as unknown as ClickHouseClient, sent }
}

const researcher: AppUser = { id: 'r1', googleSub: 'g1', email: 'r@x.com', name: 'Ada', pictureUrl: '', role: 'researcher', createdAt: '' }
const admin: AppUser = { ...researcher, id: 'a1', email: 'a@x.com', name: 'Admin', role: 'admin' }
const draft: RequestDraft = { variable_id: 'big_sender', label: 'Big sender', description: 'Sent more than 1 ETH', query_sql: GOOD }

/** The API's own connection: must never be handed researcher SQL. */
function mainClient() {
  const sent: QuerySpec[] = []
  const client = {
    query: async (spec: QuerySpec) => (sent.push(spec), []),
    queryOne: async (spec: QuerySpec) => (sent.push(spec), null),
    queryWithSummary: async (spec: QuerySpec) => (sent.push(spec), { rows: [], summary: SUMMARY }),
  }
  return { client: client as unknown as ClickHouseClient, sent }
}

function ctx(research: ClickHouseClient | null, main = mainClient()): RequestContext & { store: MemoryStore } {
  return { store: new MemoryStore(), client: main.client, researchClient: research, computeRange: async () => ({ from: 100, to: 199 }) }
}

describe('request lifecycle', () => {
  it('runs every piece of researcher SQL as the research user, never the API user', async () => {
    const research = fakeClient()
    const main = mainClient()
    const c = ctx(research.client, main)
    const req = await createRequest(c, researcher, draft)
    await (await approveRequest(c, admin, req.id)).done
    const marker = 'toUInt256'
    expect(research.sent.filter((q) => q.sql.includes(marker)).length).toBeGreaterThanOrEqual(4) // describe, 2 samples, insert
    expect(main.sent.some((q) => q.sql.includes(marker))).toBe(false)
  })

  it('refuses requests outright when no research user is configured', async () => {
    const c = ctx(null)
    await expect(createRequest(c, researcher, draft)).rejects.toMatchObject({ statusCode: 503 })
    expect(await c.store.listRequests()).toEqual([])
  })

  it('stores a valid request as pending, with a measured estimate, and only ever runs it read-only', async () => {
    const { client, sent } = fakeClient()
    const c = ctx(client)
    const req = await createRequest(c, researcher, draft)
    expect(req).toMatchObject({ status: 'pending', variableId: 'big_sender', requestedBy: 'r1' })
    expect((req.estimate as { samples: unknown[] }).samples).toHaveLength(2)
    expect(sent.length).toBeGreaterThan(0)
    for (const q of sent) expect(q.settings?.readonly).toBe(2)
  })

  it('refuses a second request for a name that is already requested', async () => {
    const c = ctx(fakeClient().client)
    await createRequest(c, researcher, draft)
    await expect(createRequest(c, researcher, draft)).rejects.toBeInstanceOf(RequestError)
  })

  it('refuses a registry variable name', async () => {
    const c = ctx(fakeClient().client)
    await expect(createRequest(c, researcher, { ...draft, variable_id: 'simple_transaction' })).rejects.toThrow(/not valid/)
  })

  it('approval computes the column, logs the run and adds it to the catalog with both people', async () => {
    const { client, sent } = fakeClient()
    const c = ctx(client)
    const req = await createRequest(c, researcher, draft)
    const { request, done } = await approveRequest(c, admin, req.id, 'looks good')
    expect(request.status).toBe('running')
    const final = await done
    expect(final.status).toBe('completed')

    const insert = sent.find((q) => q.sql.startsWith('INSERT'))!
    expect(insert.params).toMatchObject({ variable_id: 'big_sender', block_from: 100, block_to: 199 })
    expect(insert.settings?.readonly).toBeUndefined()

    const [run] = await c.store.listRuns('big_sender')
    expect(run).toMatchObject({ status: 'completed', rowsWritten: 40_642, requestId: req.id })
    const [entry] = await c.store.listCatalog()
    expect(entry).toMatchObject({ id: 'big_sender', createdBy: 'r1', approvedBy: 'a1', status: 'active' })
    expect((await c.store.getRequest(req.id))?.reviewNote).toBe('looks good')
  })

  it('a failed computation marks the request and the run failed, and adds nothing to the catalog', async () => {
    const c = ctx(fakeClient({ insertFails: true }).client)
    const req = await createRequest(c, researcher, draft)
    const final = await (await approveRequest(c, admin, req.id)).done
    expect(final).toMatchObject({ status: 'failed', error: 'Syntax error' })
    expect((await c.store.listRuns())[0].status).toBe('failed')
    expect(await c.store.listCatalog()).toEqual([])
  })

  it('reject records the note, and a decided request cannot be decided again', async () => {
    const c = ctx(fakeClient().client)
    const req = await createRequest(c, researcher, draft)
    const rejected = await rejectRequest(c, admin, req.id, 'needs a clearer rule')
    expect(rejected).toMatchObject({ status: 'rejected', reviewNote: 'needs a clearer rule', reviewedBy: 'a1' })
    await expect(approveRequest(c, admin, req.id)).rejects.toMatchObject({ statusCode: 409 })
    await expect(rejectRequest(c, admin, 'missing', '')).rejects.toMatchObject({ statusCode: 404 })
  })
})

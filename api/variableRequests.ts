/**
 * Researcher variable requests: validate a proposal, store it for review, and — once an
 * admin approves — compute it and add it to the catalog.
 *
 * The query contract. A researcher writes ONE read-only SELECT (or WITH ... SELECT) that
 * returns exactly three columns, `block_number, transaction_index, value`, and is bounded
 * by `{block_from:UInt32}` and `{block_to:UInt32}`. The server, not the researcher, wraps
 * it into the INSERT that stores the values, so a request can never write anything itself.
 *
 * The security boundary is a dedicated ClickHouse user (`ctx.researchClient`, created by
 * `npm run db:research-user`): SELECT on the public dataset tables only, INSERT on
 * tx_variable_values only, and no SOURCES grants. ClickHouse enforces that whatever the
 * SQL says, so a query cannot read users or requests, cannot reach url()/file()/s3()/
 * remote(), and cannot leak private data through an error message — which is why
 * ClickHouse's errors are shown to the researcher verbatim: they can only describe public
 * data. Request features refuse to run at all without that user configured.
 *
 * Layered on top:
 *   - static checks here, on tokenized text (one statement, SELECT/WITH, no external
 *     table functions) — they give clear messages early; the grants are what is relied on
 *   - `readonly=2` plus time / row / memory caps on every execution before approval
 *   - a human admin reads the SQL and the measured cost before anything runs at scale
 */

import crypto from 'node:crypto'
import type { ClickHouseClient } from './clickhouse.ts'
import { bytesPerStoredRow, estimateQuery, loadedRange, SAMPLE_SETTINGS, type Estimate } from './estimate.ts'
import {
  chDateTime,
  type AppStore,
  type AppUser,
  type CatalogEntry,
  type VariableRequest,
  type VariableRun,
} from './store.ts'
import { VARIABLES } from '../registry/registry.ts'

export interface RequestDraft {
  variable_id: string
  label: string
  description?: string
  tags?: string[]
  value_type?: 'flag' | 'number'
  query_sql: string
}

export class RequestError extends Error {
  readonly statusCode: number
  readonly details: string[]
  constructor(message: string, details: string[] = [], statusCode = 400) {
    super(message)
    this.name = 'RequestError'
    this.details = details
    this.statusCode = statusCode
  }
}

/** Pre-filled in the proposal modal. */
export const QUERY_TEMPLATE = `SELECT
    block_number,
    transaction_index,
    toUInt8(value > toUInt256('1000000000000000000')) AS value   -- e.g. sent more than 1 ETH
FROM transactions
WHERE block_number >= {block_from:UInt32}
  AND block_number <= {block_to:UInt32}`

const ID_PATTERN = /^[a-z][a-z0-9_]{1,62}$/
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Table functions that reach outside the dataset — files, URLs, other databases, shell
 * commands. readonly=2 does not forbid them (verified: url() runs under it); the research
 * user's missing SOURCES grants do. This list exists to give a clear message early.
 */
const FORBIDDEN_FUNCTIONS = [
  'url', 'urlCluster', 'file', 'fileCluster', 's3', 's3Cluster', 'gcs', 'azureBlobStorage',
  'hdfs', 'hdfsCluster', 'remote', 'remoteSecure', 'cluster', 'clusterAllReplicas', 'mysql',
  'postgresql', 'sqlite', 'mongodb', 'redis', 'jdbc', 'odbc', 'executable', 'input', 'iceberg',
  'deltaLake', 'hudi', 'dictionary',
]
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_FUNCTIONS.join('|')})\\s*\\(`, 'i')

/**
 * The SQL as ClickHouse's lexer sees it, for the static checks: comments removed, string
 * literals emptied (`''`), and quoted identifiers unquoted (`"url"` -> `url`), so a check
 * can neither be hidden behind a `--` inside a string nor dodged by quoting a name.
 * Backslash escapes and doubled quotes inside literals are honored; an unterminated
 * literal or comment swallows the rest, as it would for ClickHouse.
 */
export function lexicalSkeleton(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      out += ' '
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let content = ''
      while (j < sql.length) {
        if (sql[j] === '\\') {
          content += sql.slice(j, j + 2)
          j += 2
        } else if (sql[j] === c && sql[j + 1] === c) {
          content += c
          j += 2
        } else if (sql[j] === c) {
          break
        } else {
          content += sql[j++]
        }
      }
      i = j + 1
      out += c === "'" ? "''" : ` ${content} `
    } else {
      out += c
      i++
    }
  }
  return out
}

/**
 * The researcher's SQL, normalized for execution: comments kept (they help the reviewer),
 * surrounding whitespace and one trailing semicolon removed.
 */
export function normalizeQuery(sql: string): string {
  return sql.trim().replace(/;\s*$/, '').trim()
}

/** Static checks on the query text. Empty means it may proceed to a read-only describe. */
export function checkQueryText(sql: string): string[] {
  const errors: string[] = []
  const code = lexicalSkeleton(normalizeQuery(sql)).trim()
  if (code === '') return ['the query is empty']
  if (!/^(select|with)\b/i.test(code)) errors.push('the query must start with SELECT or WITH')
  if (code.includes(';')) errors.push('only one statement is allowed (remove the extra semicolons)')
  if (!code.includes('{block_from:UInt32}') || !code.includes('{block_to:UInt32}')) {
    errors.push('the query must filter on {block_from:UInt32} and {block_to:UInt32}')
  }
  const fn = FORBIDDEN_RE.exec(code)
  if (fn) errors.push(`the table function ${fn[1]}() is not allowed`)
  if (/\binto\s+outfile\b/i.test(code)) errors.push('INTO OUTFILE is not allowed')
  if (/\bformat\s+\w+\s*$/i.test(code)) errors.push('remove the FORMAT clause; the server chooses it')
  if (/\bsettings\b/i.test(code)) errors.push('SETTINGS clauses are not allowed')
  return errors
}

/** Field checks on the rest of the draft. `takenIds` are ids already in use or requested. */
export function checkDraft(draft: RequestDraft, takenIds: Set<string>): string[] {
  const errors: string[] = []
  const id = draft.variable_id?.trim() ?? ''
  if (!ID_PATTERN.test(id)) {
    errors.push('the column name must be snake_case: a lowercase letter, then letters, digits or _ (2-63 chars)')
  } else if (takenIds.has(id)) {
    errors.push(`the column name ${id} is already used or requested`)
  }
  if (!draft.label?.trim()) errors.push('a label is required')
  if ((draft.label ?? '').length > 80) errors.push('the label is longer than 80 characters')
  if ((draft.description ?? '').length > 4000) errors.push('the description is longer than 4000 characters')
  const tags = draft.tags ?? []
  if (tags.length > 10) errors.push('at most 10 tags')
  for (const t of tags) if (!TAG_PATTERN.test(t)) errors.push(`tag "${t}" must be lowercase kebab-case`)
  if (draft.value_type && draft.value_type !== 'flag' && draft.value_type !== 'number') {
    errors.push('value type must be flag or number')
  }
  return [...errors, ...checkQueryText(draft.query_sql ?? '')]
}

const INTEGER_TYPE = /^(Nullable\()?(U?Int(8|16|32|64|128|256))\)?$/
const NUMERIC_TYPE = /^(Nullable\()?(U?Int\d+|Float(32|64)|Decimal.*|Bool)\)?$/

/**
 * Checks the query's output columns without running it: DESCRIBE plans the query and
 * reports the result schema. Runs read-only.
 */
export async function checkOutputSchema(client: ClickHouseClient, sql: string): Promise<string[]> {
  let cols: { name: string; type: string }[]
  try {
    cols = await client.query<{ name: string; type: string }>({
      sql: `DESCRIBE TABLE (${normalizeQuery(sql)})`,
      params: { block_from: 0, block_to: 0 },
      settings: SAMPLE_SETTINGS,
    })
  } catch (err) {
    return [`ClickHouse rejected the query: ${firstLine(err)}`]
  }
  const names = cols.map((c) => c.name)
  const expected = ['block_number', 'transaction_index', 'value']
  if (names.length !== 3 || expected.some((n) => !names.includes(n))) {
    return [`the query must return exactly block_number, transaction_index, value (it returns: ${names.join(', ')})`]
  }
  const errors: string[] = []
  const type = (n: string) => cols.find((c) => c.name === n)?.type ?? ''
  for (const n of ['block_number', 'transaction_index']) {
    if (!INTEGER_TYPE.test(type(n))) errors.push(`${n} must be an integer (it is ${type(n)})`)
  }
  if (!NUMERIC_TYPE.test(type('value'))) errors.push(`value must be numeric (it is ${type('value')})`)
  return errors
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0].replace(/^Code: \d+\. DB::Exception: /, '').slice(0, 300)
}

/** The INSERT that stores a request's values. Every value except the query is bound. */
export function wrapInsert(query: string): string {
  return (
    'INSERT INTO tx_variable_values ' +
    '(variable_id, block_number, transaction_index, value, version, computed_at) ' +
    'SELECT {variable_id:String}, toUInt32(block_number), toUInt16(transaction_index), ' +
    `toFloat64(value), {version:UInt32}, now() FROM (\n${normalizeQuery(query)}\n)`
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface RequestContext {
  store: AppStore
  /** The API's own connection: app data, the loaded range, storage statistics. Never runs researcher SQL. */
  client: ClickHouseClient
  /**
   * The restricted research user (see pipeline/clickhouse/research_user.ts). Every
   * execution of researcher SQL goes through it; null means request features are off.
   */
  researchClient: ClickHouseClient | null
  /** Block range an approved variable is computed over; defaults to everything loaded. */
  computeRange?: () => Promise<{ from: number; to: number }>
}

/** The research connection, or a refusal: researcher SQL never falls back to the API's own user. */
function research(ctx: RequestContext): ClickHouseClient {
  if (!ctx.researchClient) {
    throw new RequestError(
      'variable requests are disabled: the server has no restricted research user configured ' +
        '(set RESEARCH_CLICKHOUSE_USER and RESEARCH_CLICKHOUSE_PASSWORD; see npm run db:research-user)',
      [],
      503,
    )
  }
  return ctx.researchClient
}

/** Ids no new request may take: catalog, registry seed, and live requests. */
async function takenIds(ctx: RequestContext): Promise<Set<string>> {
  const ids = new Set(VARIABLES.map((v) => v.id))
  for (const c of await ctx.store.listCatalog().catch(() => [])) ids.add(c.id)
  for (const r of await ctx.store.listRequests()) {
    if (r.status !== 'rejected' && r.status !== 'failed') ids.add(r.variableId)
  }
  return ids
}

async function rangeOf(ctx: RequestContext) {
  return ctx.computeRange ? ctx.computeRange() : loadedRange(ctx.client)
}

/** Validates a draft end to end — text, fields, output schema — and measures its cost. */
export async function estimateDraft(ctx: RequestContext, draft: RequestDraft): Promise<Estimate> {
  const textErrors = checkQueryText(draft.query_sql ?? '')
  if (textErrors.length) throw new RequestError('the query is not valid', textErrors)
  const schemaErrors = await checkOutputSchema(research(ctx), draft.query_sql)
  if (schemaErrors.length) throw new RequestError('the query is not valid', schemaErrors)
  const range = await rangeOf(ctx)
  try {
    return await estimateQuery(research(ctx), normalizeQuery(draft.query_sql), range, await bytesPerStoredRow(ctx.client))
  } catch (err) {
    throw new RequestError('the query failed on the sample', [firstLine(err)])
  }
}

export async function createRequest(
  ctx: RequestContext,
  user: AppUser,
  draft: RequestDraft,
): Promise<VariableRequest> {
  const errors = checkDraft(draft, await takenIds(ctx))
  if (errors.length) throw new RequestError('the request is not valid', errors)
  const estimate = await estimateDraft(ctx, draft)
  const request: VariableRequest = {
    id: crypto.randomUUID(),
    variableId: draft.variable_id.trim(),
    label: draft.label.trim(),
    description: (draft.description ?? '').trim(),
    tags: draft.tags ?? [],
    valueType: draft.value_type ?? 'flag',
    grain: 'transaction',
    querySql: normalizeQuery(draft.query_sql),
    requestedBy: user.id,
    status: 'pending',
    estimate,
    reviewNote: '',
    reviewedBy: '',
    reviewedAt: null,
    error: '',
    createdAt: chDateTime(),
  }
  await ctx.store.saveRequest(request)
  return request
}

export async function rejectRequest(
  ctx: RequestContext,
  admin: AppUser,
  id: string,
  note: string,
): Promise<VariableRequest> {
  const request = await ctx.store.getRequest(id)
  if (!request) throw new RequestError('no such request', [], 404)
  if (request.status !== 'pending') throw new RequestError(`the request is ${request.status}, not pending`, [], 409)
  const updated: VariableRequest = {
    ...request,
    status: 'rejected',
    reviewNote: note.trim(),
    reviewedBy: admin.id,
    reviewedAt: chDateTime(),
  }
  await ctx.store.saveRequest(updated)
  return updated
}

/**
 * Approves a pending request: marks it running and starts the computation. Returns the
 * running request immediately plus a promise for the outcome (the HTTP handler does not
 * wait for it; tests do).
 */
export async function approveRequest(
  ctx: RequestContext,
  admin: AppUser,
  id: string,
  note = '',
): Promise<{ request: VariableRequest; done: Promise<VariableRequest> }> {
  const request = await ctx.store.getRequest(id)
  if (!request) throw new RequestError('no such request', [], 404)
  if (request.status !== 'pending') throw new RequestError(`the request is ${request.status}, not pending`, [], 409)
  const running: VariableRequest = {
    ...request,
    status: 'running',
    reviewNote: note.trim(),
    reviewedBy: admin.id,
    reviewedAt: chDateTime(),
    error: '',
  }
  await ctx.store.saveRequest(running)
  return { request: running, done: compute(ctx, running, admin) }
}

async function compute(ctx: RequestContext, request: VariableRequest, admin: AppUser): Promise<VariableRequest> {
  const version = 1
  const started = Date.now()
  let run: VariableRun = {
    id: crypto.randomUUID(),
    variableId: request.variableId,
    version,
    requestId: request.id,
    blockFrom: 0,
    blockTo: 0,
    rowsWritten: 0,
    readRows: 0,
    readBytes: 0,
    elapsedMs: 0,
    status: 'running',
    error: '',
    startedAt: chDateTime(),
    finishedAt: null,
  }
  try {
    const range = await rangeOf(ctx)
    run = { ...run, blockFrom: range.from, blockTo: range.to }
    await ctx.store.saveRun(run)

    // Not read-only — this is the one write — so it runs as the research user, whose only
    // write grant is INSERT on tx_variable_values and who can read nothing private.
    const { summary } = await research(ctx).queryWithSummary({
      sql: wrapInsert(request.querySql),
      params: { variable_id: request.variableId, version, block_from: range.from, block_to: range.to },
      settings: { max_execution_time: 3600 },
    })
    run = {
      ...run,
      status: 'completed',
      rowsWritten: summary.writtenRows,
      readRows: summary.readRows,
      readBytes: summary.readBytes,
      elapsedMs: Date.now() - started,
      finishedAt: chDateTime(),
    }
    await ctx.store.saveRun(run)

    const entry: CatalogEntry = {
      id: request.variableId,
      label: request.label,
      description: request.description,
      tags: request.tags,
      createdBy: request.requestedBy,
      createdAt: chDateTime().slice(0, 10),
      grain: request.grain,
      valueType: request.valueType,
      formulaSummary: request.description.split('\n')[0].slice(0, 300),
      formulaSql: request.querySql,
      version,
      requestId: request.id,
      approvedBy: admin.id,
      approvedAt: chDateTime(),
      status: 'active',
    }
    await ctx.store.saveCatalogEntry(entry)

    const completed: VariableRequest = { ...request, status: 'completed' }
    await ctx.store.saveRequest(completed)
    return completed
  } catch (err) {
    const error = firstLine(err)
    await ctx.store.saveRun({ ...run, status: 'failed', error, elapsedMs: Date.now() - started, finishedAt: chDateTime() })
    const failed: VariableRequest = { ...request, status: 'failed', error }
    await ctx.store.saveRequest(failed)
    return failed
  }
}

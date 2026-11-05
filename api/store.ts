/**
 * App data: users, researcher variable requests, computation runs, and the variable
 * catalog's provenance fields.
 *
 * Everything outside this file talks to the `AppStore` interface. Today it is backed by
 * ClickHouse (low-volume ReplacingMergeTree tables, see pipeline/clickhouse/schema.sql);
 * when the site gets a real transactional database, that is one new implementation of
 * this interface and no change anywhere else. `MemoryStore` backs the unit tests.
 */

import type { ClickHouseClient } from './clickhouse.ts'

export type Role = 'researcher' | 'admin'

export interface AppUser {
  id: string
  googleSub: string
  email: string
  name: string
  pictureUrl: string
  role: Role
  createdAt: string
}

export type RequestStatus = 'pending' | 'rejected' | 'running' | 'completed' | 'failed'

export interface VariableRequest {
  id: string
  variableId: string
  label: string
  description: string
  tags: string[]
  valueType: 'flag' | 'number'
  grain: 'transaction'
  querySql: string
  requestedBy: string
  status: RequestStatus
  /** The sample-run cost estimate (api/estimate.ts), or null if none was taken. */
  estimate: unknown
  reviewNote: string
  reviewedBy: string
  reviewedAt: string | null
  error: string
  createdAt: string
}

export interface VariableRun {
  id: string
  variableId: string
  version: number
  requestId: string
  blockFrom: number
  blockTo: number
  rowsWritten: number
  readRows: number
  readBytes: number
  elapsedMs: number
  status: 'running' | 'completed' | 'failed'
  error: string
  startedAt: string
  finishedAt: string | null
}

/** A catalog row, as stored in eth.variables. */
export interface CatalogEntry {
  id: string
  label: string
  description: string
  tags: string[]
  createdBy: string
  createdAt: string
  grain: string
  valueType: string
  formulaSummary: string
  formulaSql: string
  version: number
  requestId: string
  approvedBy: string
  approvedAt: string | null
  status: 'active' | 'retired'
}

export interface AppStore {
  getUser(id: string): Promise<AppUser | null>
  findUserByGoogleSub(sub: string): Promise<AppUser | null>
  findUserByEmail(email: string): Promise<AppUser | null>
  listUsers(): Promise<AppUser[]>
  saveUser(user: AppUser): Promise<void>

  getRequest(id: string): Promise<VariableRequest | null>
  listRequests(filter?: { requestedBy?: string; status?: RequestStatus }): Promise<VariableRequest[]>
  saveRequest(request: VariableRequest): Promise<void>

  saveRun(run: VariableRun): Promise<void>
  listRuns(variableId?: string): Promise<VariableRun[]>

  listCatalog(): Promise<CatalogEntry[]>
  saveCatalogEntry(entry: CatalogEntry): Promise<void>
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — the DateTime literal ClickHouse parses without settings. */
export function chDateTime(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// ---------------------------------------------------------------------------
// In-memory, for tests
// ---------------------------------------------------------------------------

export class MemoryStore implements AppStore {
  readonly users = new Map<string, AppUser>()
  readonly requests = new Map<string, VariableRequest>()
  readonly runs = new Map<string, VariableRun>()
  readonly catalog = new Map<string, CatalogEntry>()

  async getUser(id: string) {
    return this.users.get(id) ?? null
  }
  async findUserByGoogleSub(sub: string) {
    return [...this.users.values()].find((u) => u.googleSub !== '' && u.googleSub === sub) ?? null
  }
  async findUserByEmail(email: string) {
    const e = email.toLowerCase()
    return [...this.users.values()].find((u) => u.email !== '' && u.email.toLowerCase() === e) ?? null
  }
  async listUsers() {
    return [...this.users.values()]
  }
  async saveUser(user: AppUser) {
    this.users.set(user.id, { ...user })
  }

  async getRequest(id: string) {
    return this.requests.get(id) ?? null
  }
  async listRequests(filter: { requestedBy?: string; status?: RequestStatus } = {}) {
    return [...this.requests.values()]
      .filter((r) => !filter.requestedBy || r.requestedBy === filter.requestedBy)
      .filter((r) => !filter.status || r.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveRequest(request: VariableRequest) {
    this.requests.set(request.id, { ...request })
  }

  async saveRun(run: VariableRun) {
    this.runs.set(run.id, { ...run })
  }
  async listRuns(variableId?: string) {
    return [...this.runs.values()].filter((r) => !variableId || r.variableId === variableId)
  }

  async listCatalog() {
    return [...this.catalog.values()]
  }
  async saveCatalogEntry(entry: CatalogEntry) {
    this.catalog.set(entry.id, { ...entry })
  }
}

// ---------------------------------------------------------------------------
// ClickHouse
// ---------------------------------------------------------------------------

/**
 * Writes are JSONEachRow inserts, so no value is ever spliced into SQL text; reads bind
 * every value as a parameter. `updated_at` is a millisecond timestamp so two writes in the
 * same second still order correctly under ReplacingMergeTree.
 */
export class ClickHouseStore implements AppStore {
  private readonly client: ClickHouseClient

  constructor(client: ClickHouseClient) {
    this.client = client
  }

  private insert(table: string, row: Record<string, unknown>) {
    const versioned = { ...row, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 23) }
    return this.client.query({ sql: `INSERT INTO ${table} FORMAT JSONEachRow\n${JSON.stringify(versioned)}` })
  }

  // users ---------------------------------------------------------------

  private static user(r: Record<string, unknown>): AppUser {
    return {
      id: String(r.id),
      googleSub: String(r.google_sub ?? ''),
      email: String(r.email ?? ''),
      name: String(r.name ?? ''),
      pictureUrl: String(r.picture_url ?? ''),
      role: r.role === 'admin' ? 'admin' : 'researcher',
      createdAt: String(r.created_at ?? ''),
    }
  }

  private async userWhere(where: string, params: Record<string, string>) {
    const rows = await this.client.query({ sql: `SELECT * FROM users FINAL WHERE ${where} LIMIT 1`, params })
    return rows[0] ? ClickHouseStore.user(rows[0]) : null
  }

  getUser(id: string) {
    return this.userWhere('id = {id:String}', { id })
  }
  findUserByGoogleSub(sub: string) {
    return this.userWhere("google_sub != '' AND google_sub = {sub:String}", { sub })
  }
  findUserByEmail(email: string) {
    return this.userWhere("email != '' AND lower(email) = lower({email:String})", { email })
  }
  async listUsers() {
    const rows = await this.client.query({ sql: 'SELECT * FROM users FINAL ORDER BY created_at' })
    return rows.map(ClickHouseStore.user)
  }
  async saveUser(u: AppUser) {
    await this.insert('users', {
      id: u.id,
      google_sub: u.googleSub,
      email: u.email,
      name: u.name,
      picture_url: u.pictureUrl,
      role: u.role,
      created_at: u.createdAt,
    })
  }

  // requests ------------------------------------------------------------

  private static request(r: Record<string, unknown>): VariableRequest {
    let estimate: unknown = null
    try {
      estimate = r.estimate ? JSON.parse(String(r.estimate)) : null
    } catch {
      estimate = null
    }
    return {
      id: String(r.id),
      variableId: String(r.variable_id),
      label: String(r.label),
      description: String(r.description ?? ''),
      tags: (r.tags as string[]) ?? [],
      valueType: r.value_type === 'number' ? 'number' : 'flag',
      grain: 'transaction',
      querySql: String(r.query_sql),
      requestedBy: String(r.requested_by),
      status: r.status as RequestStatus,
      estimate,
      reviewNote: String(r.review_note ?? ''),
      reviewedBy: String(r.reviewed_by ?? ''),
      reviewedAt: r.reviewed_at == null ? null : String(r.reviewed_at),
      error: String(r.error ?? ''),
      createdAt: String(r.created_at),
    }
  }

  async getRequest(id: string) {
    const rows = await this.client.query({
      sql: 'SELECT * FROM variable_requests FINAL WHERE id = {id:String} LIMIT 1',
      params: { id },
    })
    return rows[0] ? ClickHouseStore.request(rows[0]) : null
  }

  async listRequests(filter: { requestedBy?: string; status?: RequestStatus } = {}) {
    const where: string[] = ['1']
    const params: Record<string, string> = {}
    if (filter.requestedBy) {
      where.push('requested_by = {by:String}')
      params.by = filter.requestedBy
    }
    if (filter.status) {
      where.push('status = {status:String}')
      params.status = filter.status
    }
    const rows = await this.client.query({
      sql: `SELECT * FROM variable_requests FINAL WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      params,
    })
    return rows.map(ClickHouseStore.request)
  }

  async saveRequest(r: VariableRequest) {
    await this.insert('variable_requests', {
      id: r.id,
      variable_id: r.variableId,
      label: r.label,
      description: r.description,
      tags: r.tags,
      value_type: r.valueType,
      grain: r.grain,
      query_sql: r.querySql,
      requested_by: r.requestedBy,
      status: r.status,
      estimate: r.estimate == null ? '' : JSON.stringify(r.estimate),
      review_note: r.reviewNote,
      reviewed_by: r.reviewedBy,
      reviewed_at: r.reviewedAt,
      error: r.error,
      created_at: r.createdAt,
    })
  }

  // runs ----------------------------------------------------------------

  async saveRun(r: VariableRun) {
    await this.insert('variable_runs', {
      id: r.id,
      variable_id: r.variableId,
      version: r.version,
      request_id: r.requestId,
      block_from: r.blockFrom,
      block_to: r.blockTo,
      rows_written: r.rowsWritten,
      read_rows: r.readRows,
      read_bytes: r.readBytes,
      elapsed_ms: Math.round(r.elapsedMs),
      status: r.status,
      error: r.error,
      started_at: r.startedAt,
      finished_at: r.finishedAt,
    })
  }

  async listRuns(variableId?: string) {
    const rows = await this.client.query({
      sql:
        'SELECT * FROM variable_runs FINAL ' +
        (variableId ? 'WHERE variable_id = {id:String} ' : '') +
        'ORDER BY started_at DESC',
      params: variableId ? { id: variableId } : {},
    })
    return rows.map((r) => ({
      id: String(r.id),
      variableId: String(r.variable_id),
      version: Number(r.version),
      requestId: String(r.request_id ?? ''),
      blockFrom: Number(r.block_from),
      blockTo: Number(r.block_to),
      rowsWritten: Number(r.rows_written),
      readRows: Number(r.read_rows),
      readBytes: Number(r.read_bytes),
      elapsedMs: Number(r.elapsed_ms),
      status: r.status as VariableRun['status'],
      error: String(r.error ?? ''),
      startedAt: String(r.started_at),
      finishedAt: r.finished_at == null ? null : String(r.finished_at),
    }))
  }

  // catalog -------------------------------------------------------------

  async listCatalog() {
    const rows = await this.client.query({ sql: 'SELECT * FROM variables FINAL ORDER BY created_at, id' })
    return rows.map(
      (r): CatalogEntry => ({
        id: String(r.id),
        label: String(r.label),
        description: String(r.description ?? ''),
        tags: (r.tags as string[]) ?? [],
        createdBy: String(r.created_by),
        createdAt: String(r.created_at),
        grain: String(r.grain),
        valueType: String(r.value_type),
        formulaSummary: String(r.formula_summary ?? ''),
        formulaSql: String(r.formula_sql ?? ''),
        version: Number(r.version),
        requestId: String(r.request_id ?? ''),
        approvedBy: String(r.approved_by ?? ''),
        approvedAt: r.approved_at == null ? null : String(r.approved_at),
        status: r.status === 'retired' ? 'retired' : 'active',
      }),
    )
  }

  // eth.variables is ReplacingMergeTree(version) with no updated_at, so this is a plain
  // insert rather than `insert()`.
  async saveCatalogEntry(e: CatalogEntry) {
    const row = {
      id: e.id,
      label: e.label,
      description: e.description,
      tags: e.tags,
      created_by: e.createdBy,
      created_at: e.createdAt,
      grain: e.grain,
      value_type: e.valueType,
      formula_summary: e.formulaSummary,
      formula_sql: e.formulaSql,
      version: e.version,
      request_id: e.requestId,
      approved_by: e.approvedBy,
      approved_at: e.approvedAt,
      status: e.status,
    }
    await this.client.query({ sql: `INSERT INTO variables FORMAT JSONEachRow\n${JSON.stringify(row)}` })
  }
}

/**
 * Minimal ClickHouse client over the HTTP interface.
 *
 * Values are bound server-side via `param_<name>` and referenced in SQL as
 * `{<name>:<Type>}`, so the API never concatenates a value into a query. Deliberately
 * dependency-free: the HTTP interface is stable and this is the whole of what the API
 * needs from it.
 */

export interface ClickHouseConfig {
  url?: string
  database?: string
  user?: string
  password?: string
  /** Per-query safety settings; see the API spec's limits section. */
  settings?: Record<string, string | number>
}

export interface QuerySpec {
  sql: string
  params?: Record<string, string | number>
}

export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ClickHouseError'
  }
}

/**
 * Per-query caps from the API spec.
 *
 * Read-only is deliberately NOT set here: `readonly=1` forbids changing any other
 * setting, so sending it alongside these would make the request fail. It belongs on the
 * server-side user profile, which is where the spec puts it ("read-only ClickHouse user")
 * and where a client cannot opt out of it.
 */
export const API_SETTINGS = {
  max_execution_time: 30,
  max_memory_usage: 4_000_000_000,
} as const

export class ClickHouseClient {
  private readonly url: string
  private readonly database: string
  private readonly auth?: string
  private readonly settings: Record<string, string | number>

  constructor(config: ClickHouseConfig = {}) {
    this.url = config.url ?? process.env.CLICKHOUSE_URL ?? 'http://localhost:8123'
    this.database = config.database ?? process.env.CLICKHOUSE_DB ?? 'eth'
    this.settings = { ...API_SETTINGS, ...config.settings }
    const user = config.user ?? process.env.CLICKHOUSE_USER
    if (user) {
      this.auth = `${user}:${config.password ?? process.env.CLICKHOUSE_PASSWORD ?? ''}`
    }
  }

  /** Run a query and return its rows as objects. */
  async query<T = Record<string, unknown>>(spec: QuerySpec): Promise<T[]> {
    const url = new URL(this.url)
    url.searchParams.set('database', this.database)
    url.searchParams.set('default_format', 'JSONEachRow')
    for (const [k, v] of Object.entries(this.settings)) {
      url.searchParams.set(k, String(v))
    }
    for (const [k, v] of Object.entries(spec.params ?? {})) {
      url.searchParams.set(`param_${k}`, String(v))
    }

    const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
    if (this.auth) headers.Authorization = `Basic ${btoa(this.auth)}`

    const res = await fetch(url, { method: 'POST', body: spec.sql, headers })
    const text = await res.text()
    if (!res.ok) {
      throw new ClickHouseError(text.slice(0, 500), res.status)
    }
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T)
  }

  async queryOne<T = Record<string, unknown>>(spec: QuerySpec): Promise<T | null> {
    const rows = await this.query<T>(spec)
    return rows[0] ?? null
  }

  /** Whether the server is reachable — used to skip integration tests when it is not. */
  async ping(): Promise<boolean> {
    try {
      await this.query({ sql: 'SELECT 1' })
      return true
    } catch {
      return false
    }
  }
}

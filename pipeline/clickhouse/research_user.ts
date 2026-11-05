/**
 * The ClickHouse user that researcher-submitted SQL runs as.
 *
 *   RESEARCH_CLICKHOUSE_PASSWORD=... npm run db:research-user
 *
 * This is the security boundary for variable requests, enforced by ClickHouse itself
 * rather than by inspecting SQL text:
 *
 *   - SELECT on the public dataset tables only. No access to eth.users,
 *     eth.variable_requests, eth.variable_runs or any system table, so a query can neither
 *     read private data nor leak it through an error message.
 *   - INSERT on eth.tx_variable_values only: the one write an approved request performs.
 *   - No SOURCES grants (URL, FILE, S3, REMOTE, MYSQL, ...), so table functions that reach
 *     outside the database fail with ACCESS_DENIED however they are spelled.
 *
 * Idempotent: re-running resets the password and the grants to exactly this list.
 * Connection settings for the admin connection are the API's (CLICKHOUSE_URL, ...).
 */

import { ClickHouseClient } from '../../api/clickhouse.ts'

export const RESEARCH_USER_DEFAULT = 'eth_research'

/** Tables a researcher query may read: the dataset, its indexes and aggregates, and other variables' values. */
export const RESEARCH_READABLE_TABLES = [
  'transactions',
  'token_transfers',
  'blocks',
  'block_stats',
  'tx_by_address',
  'transfers_by_address',
  'tx_by_hash',
  'tx_variable_values',
] as const

/** A ClickHouse single-quoted string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const USER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** The statements that create or reset the research user. */
export function researchUserStatements(user: string, password: string, database = 'eth'): string[] {
  if (!USER_NAME.test(user)) throw new Error(`invalid ClickHouse user name: ${user}`)
  if (!USER_NAME.test(database)) throw new Error(`invalid database name: ${database}`)
  if (password.length < 12) throw new Error('the research user password must be at least 12 characters')
  return [
    `CREATE USER IF NOT EXISTS ${user} IDENTIFIED WITH sha256_password BY ${sqlString(password)}`,
    `ALTER USER ${user} IDENTIFIED WITH sha256_password BY ${sqlString(password)}`,
    // Start from nothing, so a grant removed from the list is also removed from the server.
    `REVOKE ALL ON *.* FROM ${user}`,
    // One table per GRANT: ClickHouse does not accept a list of tables in a single grant.
    ...RESEARCH_READABLE_TABLES.map((t) => `GRANT SELECT ON ${database}.${t} TO ${user}`),
    `GRANT INSERT ON ${database}.tx_variable_values TO ${user}`,
  ]
}

export async function setupResearchUser(admin: ClickHouseClient, user: string, password: string, database = 'eth') {
  for (const sql of researchUserStatements(user, password, database)) await admin.query({ sql })
}

/* c8 ignore start -- process entry point, exercised by running it */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (isEntryPoint) {
  const user = process.env.RESEARCH_CLICKHOUSE_USER || RESEARCH_USER_DEFAULT
  const password = process.env.RESEARCH_CLICKHOUSE_PASSWORD ?? ''
  setupResearchUser(new ClickHouseClient(), user, password, process.env.CLICKHOUSE_DB ?? 'eth')
    .then(() => console.log(`research user ${user} ready: SELECT on ${RESEARCH_READABLE_TABLES.length} dataset tables, INSERT on tx_variable_values`))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
/* c8 ignore stop */

/**
 * Computes research variables in ClickHouse.
 *
 *   npm run variables:compute -- --from <block> --to <block> [--only <id>[,<id>...]]
 *
 * Validates the registry, seeds registry/users.json into eth.users, upserts
 * registry/variables.json into the eth.variables catalog, then runs each variable's
 * formula file over the block range, logging every run to eth.variable_runs. Formulas
 * insert into eth.tx_variable_values, whose ReplacingMergeTree key makes a rerun of the
 * same range replace rows instead of duplicating them.
 *
 * Connection settings are the API's: CLICKHOUSE_URL, CLICKHOUSE_DB, CLICKHOUSE_USER,
 * CLICKHOUSE_PASSWORD.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { ClickHouseClient } from '../../api/clickhouse.ts'
import { chDateTime, ClickHouseStore } from '../../api/store.ts'
import {
  USERS,
  VARIABLES,
  validateRegistry,
  type VariableDefinition,
} from '../../registry/registry.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The catalog row for a definition, in eth.variables' column order. */
export function catalogRow(v: VariableDefinition): Record<string, unknown> {
  return {
    id: v.id,
    label: v.label,
    description: v.description ?? '',
    tags: v.tags ?? [],
    created_by: v.created_by,
    created_at: v.created_at,
    grain: v.grain,
    value_type: v.value_type,
    formula_summary: v.formula.summary,
    formula_sql: v.formula.sql,
    version: v.version,
  }
}

/**
 * JSONEachRow rather than bound parameters: the catalog carries an array column, and
 * JSON is the one encoding where no value needs hand-escaping.
 */
export function buildCatalogUpsert(variables: VariableDefinition[]): string {
  return (
    'INSERT INTO eth.variables FORMAT JSONEachRow\n' +
    variables.map((v) => JSON.stringify(catalogRow(v))).join('\n')
  )
}

function parseArgs(argv: string[]): { from: number; to: number; only: string[] | null } {
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const from = Number(flag('--from'))
  const to = Number(flag('--to'))
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    console.error('usage: npm run variables:compute -- --from <block> --to <block> [--only a,b]')
    process.exit(1)
  }
  const only = flag('--only')
  return { from, to, only: only ? only.split(',') : null }
}

async function main() {
  const { from, to, only } = parseArgs(process.argv)

  const errors = validateRegistry(VARIABLES, USERS)
  if (errors.length > 0) throw new Error(`registry is invalid:\n  ${errors.join('\n  ')}`)

  const selected = only ? VARIABLES.filter((v) => only.includes(v.id)) : VARIABLES
  const unknown = (only ?? []).filter((id) => !VARIABLES.some((v) => v.id === id))
  if (unknown.length > 0) throw new Error(`unknown variable(s): ${unknown.join(', ')}`)

  // A long range can take longer than the API's 30 s read cap.
  const client = new ClickHouseClient({ settings: { max_execution_time: 3600 } })
  const store = new ClickHouseStore(client)

  // Seed users: created once, never overwritten — a seeded user who has since signed in
  // (and gained an email, a Google link or a role) keeps what they gained.
  let seeded = 0
  for (const u of USERS) {
    if (await store.getUser(u.id)) continue
    await store.saveUser({ id: u.id, googleSub: '', email: '', name: u.name, pictureUrl: '', role: 'researcher', createdAt: chDateTime() })
    seeded++
  }
  console.log(`users           ${seeded} seeded (${USERS.length - seeded} already present)`)

  await client.query({ sql: buildCatalogUpsert(VARIABLES) })
  console.log(`catalog         ${VARIABLES.length} variables upserted`)

  for (const v of selected) {
    const sql = fs.readFileSync(path.join(REPO_ROOT, v.formula.sql), 'utf8')
    const started = Date.now()
    const run = {
      id: crypto.randomUUID(),
      variableId: v.id,
      version: v.version,
      requestId: '',
      blockFrom: from,
      blockTo: to,
      rowsWritten: 0,
      readRows: 0,
      readBytes: 0,
      elapsedMs: 0,
      status: 'running' as const,
      error: '',
      startedAt: chDateTime(),
      finishedAt: null,
    }
    await store.saveRun(run)
    try {
      const { summary } = await client.queryWithSummary({ sql, params: { block_from: from, block_to: to, version: v.version } })
      await store.saveRun({
        ...run,
        status: 'completed',
        rowsWritten: summary.writtenRows,
        readRows: summary.readRows,
        readBytes: summary.readBytes,
        elapsedMs: Date.now() - started,
        finishedAt: chDateTime(),
      })
    } catch (err) {
      const error = err instanceof Error ? err.message.split('\n')[0] : String(err)
      await store.saveRun({ ...run, status: 'failed', error, elapsedMs: Date.now() - started, finishedAt: chDateTime() })
      throw err
    }
    const row = await client.queryOne<{ rows: string; ones: string }>({
      sql:
        'SELECT count() AS rows, countIf(value = 1) AS ones FROM eth.tx_variable_values FINAL ' +
        'WHERE variable_id = {id:String} ' +
        'AND block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}',
      params: { id: v.id, block_from: from, block_to: to },
    })
    console.log(
      `${v.id.padEnd(22)}  ${Number(row?.rows ?? 0).toLocaleString('en-US')} rows, ` +
        `${Number(row?.ones ?? 0).toLocaleString('en-US')} ones  (${Date.now() - started} ms)`,
    )
  }
}

/* c8 ignore start -- process entry point, exercised by running it */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
/* c8 ignore stop */

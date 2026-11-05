// @vitest-environment node
/**
 * Research variables against a real ClickHouse holding the 100-block sample, with the
 * variables computed:
 *
 *   npm run variables:compute -- --from 25534200 --to 25534299
 *
 * The core check is parity: the ClickHouse formulas (pipeline/variables/*.sql) and the JS
 * reference (scripts/variablesPrep.mjs, which produced the committed
 * public/data/variable-values.json.gz the explorer reads) must give the same value for
 * every transaction. Two implementations of one rule drift silently otherwise.
 *
 * Skipped — not passed — when ClickHouse is unreachable or the variables were never
 * computed; see queries.integration.test.ts for why that distinction matters.
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ClickHouseClient } from './clickhouse.ts'
import { buildServer } from './server.ts'
import { VARIABLES } from '../registry/registry.ts'

const FIRST_BLOCK = 25_534_200
const LAST_BLOCK = 25_534_299
const TOTAL_TRANSACTIONS = 40_642

const client = new ClickHouseClient()
const reachable = await client.ping()
const computed =
  reachable &&
  Number(
    (
      await client
        .queryOne<{ n: string }>({ sql: 'SELECT count() AS n FROM tx_variable_values' })
        .catch(() => null)
    )?.n ?? 0,
  ) > 0
if (!computed) {
  console.warn(
    'ClickHouse unreachable or variables not computed — variable integration tests skipped ' +
      '(run npm run variables:compute -- --from 25534200 --to 25534299)',
  )
}
const itLive = it.runIf(computed)

const artifact = JSON.parse(
  zlib
    .gunzipSync(fs.readFileSync(new URL('../public/data/variable-values.json.gz', import.meta.url)))
    .toString('utf8'),
) as { blocks: number[]; txIndexes: number[]; values: Record<string, number[]> }

describe('ClickHouse formulas agree with the JS reference', () => {
  for (const v of VARIABLES) {
    itLive(`${v.id}: same value for every transaction`, async () => {
      const rows = await client.query<{ block_number: number; transaction_index: number; value: number }>({
        sql:
          'SELECT block_number, transaction_index, value FROM tx_variable_values FINAL ' +
          'WHERE variable_id = {id:String} ' +
          'AND block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32} ' +
          'ORDER BY block_number, transaction_index',
        params: { id: v.id, block_from: FIRST_BLOCK, block_to: LAST_BLOCK },
      })
      expect(rows).toHaveLength(TOTAL_TRANSACTIONS)

      const expected = new Map<string, number>()
      artifact.blocks.forEach((b, i) => expected.set(`${b}:${artifact.txIndexes[i]}`, artifact.values[v.id][i]))
      const mismatches = rows.filter(
        (r) => expected.get(`${r.block_number}:${r.transaction_index}`) !== Number(r.value),
      )
      expect(mismatches.slice(0, 5)).toEqual([])
    })
  }

  itLive('records which formula version produced the values', async () => {
    const rows = await client.query<{ variable_id: string; version: number }>({
      sql: 'SELECT DISTINCT variable_id, version FROM tx_variable_values FINAL ORDER BY variable_id',
    })
    for (const v of VARIABLES) {
      expect(rows.find((r) => r.variable_id === v.id)?.version).toBe(v.version)
    }
  })

  // The catalog also holds variables approved through requests — including the one the
  // request integration test adds while this file runs in parallel — so this checks that
  // every registry variable is present and correctly attributed, not that nothing else is.
  itLive('mirrors the registry in the eth.variables catalog', async () => {
    const rows = await client.query<{ id: string; created_by: string; tags: string[] }>({
      sql: 'SELECT id, created_by, tags FROM variables FINAL ORDER BY id',
    })
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(VARIABLES.map((v) => v.id)))
    for (const v of VARIABLES) expect(rows.find((r) => r.id === v.id)?.created_by).toBe(v.created_by)
  })
})

describe('list endpoints with ?variables=', () => {
  const app = buildServer({ client, release: 'test' })

  itLive('attaches the requested variables to every row', async () => {
    const res = await app.inject({
      method: 'GET',
      url:
        `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=1000` +
        '&variables=simple_transaction,from_high_user',
    })
    expect(res.statusCode).toBe(200)
    const { rows } = res.json() as { rows: Record<string, unknown>[] }
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect([0, 1]).toContain(r.simple_transaction)
      expect([0, 1]).toContain(r.from_high_user)
    }
  })

  itLive('gives every row of one transaction the same value on the records view', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/records?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=1000&variables=simple_transaction`,
    })
    const { rows } = res.json() as { rows: Record<string, unknown>[] }
    const byTx = new Map<unknown, Set<unknown>>()
    for (const r of rows) {
      const seen = byTx.get(r.transaction_hash) ?? new Set()
      seen.add(r.simple_transaction)
      byTx.set(r.transaction_hash, seen)
    }
    for (const values of byTx.values()) expect(values.size).toBe(1)
  })

  itLive('leaves rows untouched when no variables are requested', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/transactions?block_from=${FIRST_BLOCK}&block_to=${FIRST_BLOCK}&limit=5`,
    })
    for (const r of res.json().rows) expect(r).not.toHaveProperty('simple_transaction')
  })
})

/**
 * Computes every research variable in `registry/variables.json` for the CSV build.
 *
 *   node scripts/prepare-variables.mjs [--rows <rows.csv.gz>] [--out <file>] [--from-clickhouse]
 *
 * By default it computes the registry's variables with the JS reference implementations.
 * With `--from-clickhouse` it instead exports every active catalog variable — including
 * researcher variables approved through the API — from eth.tx_variable_values, with the
 * catalog's metadata embedded, so a rebuild and redeploy puts them on the static site.
 *
 * Reads the already-prepared `public/data/rows.csv.gz` (not the 2.19 GB source), so adding
 * a variable never means re-running `data:prep`. Writes
 * `public/data/variable-values.json.gz`:
 *
 *   { schemaVersion, blocks: [...], txIndexes: [...], versions: {id: n}, values: {id: [...]} }
 *
 * Parallel arrays, one entry per transaction in (block, index) order. The browser joins
 * them onto rows by (block_number, transaction_index).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import Papa from 'papaparse'
import { USERS, VARIABLES, validateRegistry } from '../registry/registry.ts'
import { computeVariableValues } from './variablesPrep.mjs'

function parseArgs(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name)
    if (i === -1) return fallback
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error('usage: node scripts/prepare-variables.mjs [--rows <rows.csv.gz>] [--out <file>] [--from-clickhouse]')
      process.exit(1)
    }
    return value
  }
  const dataDir = path.join(process.cwd(), 'public', 'data')
  return {
    rows: flag('--rows', path.join(dataDir, 'rows.csv.gz')),
    out: flag('--out', path.join(dataDir, 'variable-values.json.gz')),
    fromClickHouse: argv.includes('--from-clickhouse'),
  }
}

async function main() {
  const { rows: rowsPath, out, fromClickHouse } = parseArgs(process.argv)

  const errors = validateRegistry(VARIABLES, USERS)
  if (errors.length > 0) {
    console.error(`registry is invalid:\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }

  const text = zlib.gunzipSync(fs.readFileSync(rowsPath)).toString('utf8')
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })
  // Only the four columns the variables read. Same validity rule as the browser parser: a
  // row with no block number cannot be placed.
  const rows = []
  for (const r of data) {
    const block = Number.parseInt(r.block_number, 10)
    if (!Number.isFinite(block)) continue
    rows.push({
      block_number: block,
      transaction_index: Number.parseInt(r.transaction_index, 10) || 0,
      from_address_tx: r.from_address_tx?.trim() || null,
      is_token_transfer: String(r.is_token_transfer).trim().toLowerCase() === 'true',
    })
  }

  const payload = fromClickHouse ? await exportFromClickHouse(rows) : { schemaVersion: 1, ...computeVariableValues(rows, VARIABLES) }
  await fsp.writeFile(out, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }))

  const total = payload.blocks.length
  console.log(`transactions    ${total.toLocaleString('en-US')}`)
  for (const [id, column] of Object.entries(payload.values)) {
    const ones = column.filter((x) => x === 1).length
    const zeros = column.filter((x) => x === 0).length
    console.log(
      `${id.padEnd(22)}  1: ${ones.toLocaleString('en-US').padStart(7)}   ` +
        `0: ${zeros.toLocaleString('en-US').padStart(7)}`,
    )
  }
  console.log(`written to      ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
}

/**
 * Every active catalog variable's values for the rows' block range, in the same columnar
 * shape the API serves, catalog metadata included.
 */
async function exportFromClickHouse(rows) {
  const { ClickHouseClient } = await import('../api/clickhouse.ts')
  const { ClickHouseStore } = await import('../api/store.ts')
  const { buildVariableValues, columnarValues, mergeCatalog } = await import('../api/variables.ts')
  const client = new ClickHouseClient({ settings: { max_execution_time: 600 } })
  const store = new ClickHouseStore(client)
  const defs = mergeCatalog(await store.listCatalog(), await store.listUsers())
  let from = Infinity
  let to = -Infinity
  for (const r of rows) {
    if (r.block_number < from) from = r.block_number
    if (r.block_number > to) to = r.block_number
  }
  const values = await client.query(buildVariableValues(defs.map((d) => d.id), from, to))
  return columnarValues(values, defs)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

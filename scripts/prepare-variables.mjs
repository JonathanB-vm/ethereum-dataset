/**
 * Computes every research variable in `registry/variables.json` for the CSV build.
 *
 *   node scripts/prepare-variables.mjs [--rows <rows.csv.gz>] [--out <file>]
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
      console.error('usage: node scripts/prepare-variables.mjs [--rows <rows.csv.gz>] [--out <file>]')
      process.exit(1)
    }
    return value
  }
  const dataDir = path.join(process.cwd(), 'public', 'data')
  return {
    rows: flag('--rows', path.join(dataDir, 'rows.csv.gz')),
    out: flag('--out', path.join(dataDir, 'variable-values.json.gz')),
  }
}

async function main() {
  const { rows: rowsPath, out } = parseArgs(process.argv)

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

  const packed = computeVariableValues(rows, VARIABLES)
  const payload = { schemaVersion: 1, ...packed }
  await fsp.writeFile(out, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }))

  console.log(`transactions    ${packed.blocks.length.toLocaleString('en-US')}`)
  for (const v of VARIABLES) {
    const ones = packed.values[v.id].reduce((n, x) => n + x, 0)
    console.log(
      `${v.id.padEnd(22)}  1: ${ones.toLocaleString('en-US').padStart(7)}   ` +
        `0: ${(packed.blocks.length - ones).toLocaleString('en-US').padStart(7)}`,
    )
  }
  console.log(`written to      ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

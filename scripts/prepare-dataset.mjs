/**
 * Turns a raw BigQuery export into the artifacts the browser actually loads.
 *
 *   node scripts/prepare-dataset.mjs <source.csv> [--out <dir>]
 *
 * Writes, into <dir> (default `public/data`):
 *   rows.csv.gz            — every row, 34 columns (no input_tx)
 *   calldata/<xx>.json.gz  — { txHash: calldata } sharded by tx-hash first byte
 *   dataset.json           — manifest (counts, block range, time span)
 *
 * The source is streamed, never held in memory. Calldata is accumulated in RAM because
 * deduplicated it is only ~30 MB, versus 2.12 GB duplicated across rows.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import Papa from 'papaparse'
import { LOADED_FIELDS, projectRow, shardKey, hasCalldata } from './datasetPrep.mjs'

const ROWS_PER_BATCH = 1000

function parseArgs(argv) {
  const source = argv[2]
  const outFlag = argv.indexOf('--out')
  const out = outFlag !== -1 ? argv[outFlag + 1] : path.join(process.cwd(), 'public', 'data')
  if (!source || source.startsWith('--')) {
    console.error('usage: node scripts/prepare-dataset.mjs <source.csv> [--out <dir>]')
    process.exit(1)
  }
  return { source, out }
}

async function main() {
  const { source, out } = parseArgs(process.argv)
  const shardDir = path.join(out, 'calldata')
  await fsp.mkdir(shardDir, { recursive: true })

  const gzip = zlib.createGzip({ level: 6 })
  const rowsDone = pipeline(gzip, fs.createWriteStream(path.join(out, 'rows.csv.gz')))
  gzip.write(`${LOADED_FIELDS.join(',')}\r\n`)

  /** shard stem -> { [txHash]: calldata } */
  const calldata = new Map()
  let rows = 0
  let skipped = 0
  let blockMin = Number.POSITIVE_INFINITY
  let blockMax = Number.NEGATIVE_INFINITY
  let timeStart = null
  let timeEnd = null
  let batch = []

  // Papa.unparse on an array-of-arrays emits no header row and handles all quoting
  // (commas in event_signature, quotes, any residual newlines).
  function flush() {
    if (batch.length === 0) return true
    const csv = Papa.unparse(batch)
    batch = []
    return gzip.write(`${csv}\r\n`)
  }

  await new Promise((resolve, reject) => {
    Papa.parse(fs.createReadStream(source, { encoding: 'utf8' }), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (result, parser) => {
        const row = result.data
        const blockNumber = Number.parseInt(row.block_number, 10)
        const txHash = String(row.transaction_hash ?? '').trim()
        // Same validity rule as the browser parser (csvProvider.ts): a row without a block
        // number or a transaction hash cannot be placed, so it is counted, not shipped.
        if (!Number.isFinite(blockNumber) || txHash === '') {
          skipped++
          return
        }

        rows++
        if (blockNumber < blockMin) blockMin = blockNumber
        if (blockNumber > blockMax) blockMax = blockNumber
        const ts = String(row.block_timestamp ?? '').trim()
        if (ts !== '') {
          if (timeStart === null || ts < timeStart) timeStart = ts
          if (timeEnd === null || ts > timeEnd) timeEnd = ts
        }

        const projected = projectRow(row)
        batch.push(LOADED_FIELDS.map((f) => projected[f]))

        if (hasCalldata(row.input_tx)) {
          const key = shardKey(txHash)
          if (key !== null) {
            let bucket = calldata.get(key)
            if (bucket === undefined) {
              bucket = {}
              calldata.set(key, bucket)
            }
            // Last write wins; every row of a transaction carries the same calldata.
            bucket[txHash] = String(row.input_tx).trim()
          }
        }

        if (batch.length >= ROWS_PER_BATCH && !flush()) {
          // Respect gzip backpressure — without this the 2.19 GB source outruns the
          // writer and the process balloons.
          parser.pause()
          gzip.once('drain', () => parser.resume())
        }
        if (rows % 100000 === 0) console.log(`  ${rows.toLocaleString('en-US')} rows…`)
      },
      complete: resolve,
      error: reject,
    })
  })

  flush()
  gzip.end()
  await rowsDone

  let calldataTransactions = 0
  for (const [key, bucket] of calldata) {
    calldataTransactions += Object.keys(bucket).length
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(bucket), 'utf8'), { level: 6 })
    await fsp.writeFile(path.join(shardDir, `${key}.json.gz`), payload)
  }

  const manifest = {
    schemaVersion: 1,
    shardScheme: 'txhash-first-byte',
    rows,
    skippedRows: skipped,
    columns: LOADED_FIELDS.length,
    blockMin: rows > 0 ? blockMin : null,
    blockMax: rows > 0 ? blockMax : null,
    timeStart,
    timeEnd,
    calldataTransactions,
    calldataShards: calldata.size,
  }
  await fsp.writeFile(path.join(out, 'dataset.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`\nrows            ${rows.toLocaleString('en-US')} (${skipped} skipped)`)
  console.log(`blocks          ${manifest.blockMin}–${manifest.blockMax}`)
  console.log(`calldata        ${calldataTransactions.toLocaleString('en-US')} tx across ${calldata.size} shards`)
  console.log(`written to      ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

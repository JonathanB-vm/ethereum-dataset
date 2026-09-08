#!/usr/bin/env node
// Measures a BigQuery CSV export (streaming, so files larger than memory are fine).
// Usage:  node scripts/measure-csv.mjs analytics_25534200_25534299.csv
import fs from 'node:fs'
import Papa from 'papaparse'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/measure-csv.mjs <file.csv>')
  process.exit(1)
}

const bytes = fs.statSync(file).size
const blocks = new Set()
const txHashes = new Set()
const txWithInput = new Set()
let records = 0
let transfers = 0
let txRows = 0
let chars = 0
let inputChars = 0
let inputDupChars = 0
let numpyAccessLists = 0
let firstBlock = Infinity
let lastBlock = -Infinity
const eventTypes = new Map()

Papa.parse(fs.createReadStream(file), {
  header: true,
  skipEmptyLines: 'greedy',
  step({ data: r }) {
    records++
    const b = Number(r.block_number)
    if (Number.isFinite(b)) {
      blocks.add(b)
      if (b < firstBlock) firstBlock = b
      if (b > lastBlock) lastBlock = b
    }
    txHashes.add(r.transaction_hash)
    if (r.is_token_transfer === 'True') transfers++
    else txRows++
    if (r.event_type) eventTypes.set(r.event_type, (eventTypes.get(r.event_type) ?? 0) + 1)
    for (const v of Object.values(r)) chars += (v ?? '').length
    const inp = r.input_tx ?? ''
    inputChars += inp.length
    if (txWithInput.has(r.transaction_hash)) inputDupChars += inp.length
    else txWithInput.add(r.transaction_hash)
    if ((r.access_list_tx ?? '').includes('array(')) numpyAccessLists++
  },
  complete() {
    const nBlocks = blocks.size || 1
    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a')
    console.log(
      JSON.stringify(
        {
          file,
          fileMB: +(bytes / 1e6).toFixed(1),
          records,
          blocks: blocks.size,
          blockRange: [firstBlock, lastBlock],
          uniqueTx: txHashes.size,
          transferRows: transfers,
          plainTxRows: txRows,
          eventTypes: Object.fromEntries(eventTypes),
          perBlock: {
            records: +(records / nBlocks).toFixed(0),
            uniqueTx: +(txHashes.size / nBlocks).toFixed(0),
            transfers: +(transfers / nBlocks).toFixed(0),
            MB: +(bytes / 1e6 / nBlocks).toFixed(2),
          },
          inputTxShareOfBytes: pct(inputChars, chars),
          inputTxBytesThatAreDuplicates: pct(inputDupChars, inputChars),
          rowsWithNumpyAccessList: numpyAccessLists,
        },
        null,
        2,
      ),
    )
  },
  error(err) {
    console.error('parse error:', err.message)
    process.exit(1)
  },
})

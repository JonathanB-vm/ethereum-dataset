/**
 * Distills a BigQuery token-contract export down to the decimals lookup the browser loads.
 *
 *   node scripts/prepare-tokens.mjs <tokens.csv> [--rows <rows.csv.gz>] [--out <dir>]
 *
 * Writes `<dir>/tokens.json`: only the token contracts that appear in the shipped dataset,
 * and only those with usable decimals.
 *
 * Deliberately independent of `prepare-dataset.mjs`: it reads the already-built
 * `rows.csv.gz`, not the 2.19 GB source export, so refreshing token metadata is a
 * seconds-long job. Both inputs are streamed and parsed with Papaparse — `tokens.csv` has
 * commas and quotes inside `name`, and `rows.csv.gz` has them inside `event_signature`
 * (e.g. `Transfer(address,address,uint256)`), so neither can be split on commas.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import Papa from 'papaparse'
import { buildTokensArtifact } from './tokensPrep.mjs'

function parseArgs(argv) {
  const source = argv[2]
  const flag = (name, fallback) => {
    const i = argv.indexOf(name)
    if (i === -1) return fallback
    const value = argv[i + 1]
    if (value === undefined) {
      console.error(`usage: node scripts/prepare-tokens.mjs <tokens.csv> [--rows <rows.csv.gz>] [--out <dir>]`)
      process.exit(1)
    }
    return value
  }
  if (!source || source.startsWith('--')) {
    console.error('usage: node scripts/prepare-tokens.mjs <tokens.csv> [--rows <rows.csv.gz>] [--out <dir>]')
    process.exit(1)
  }
  const out = flag('--out', path.join(process.cwd(), 'public', 'data'))
  return { source, rows: flag('--rows', path.join(out, 'rows.csv.gz')), out }
}

/** Streams the shipped row artifact, collecting every distinct token-contract address. */
function readDatasetAddresses(rowsPath) {
  const addresses = new Set()
  return new Promise((resolve, reject) => {
    Papa.parse(fs.createReadStream(rowsPath).pipe(zlib.createGunzip()), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (result) => {
        const address = String(result.data.address ?? '').trim().toLowerCase()
        if (address !== '') addresses.add(address)
      },
      complete: () => resolve(addresses),
      error: reject,
    })
  })
}

/** Streams the token export, keeping only rows whose contract is in `addresses`. */
function readTokenRows(sourcePath, addresses) {
  const kept = []
  return new Promise((resolve, reject) => {
    Papa.parse(fs.createReadStream(sourcePath, { encoding: 'utf8' }), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (result) => {
        const row = result.data
        const address = String(row.address ?? '').trim().toLowerCase()
        // Filter during the stream: the export is ~224k rows and only a few hundred can
        // ever match, so there is no reason to hold the rest.
        if (addresses.has(address)) kept.push(row)
      },
      complete: () => resolve(kept),
      error: reject,
    })
  })
}

async function main() {
  const { source, rows, out } = parseArgs(process.argv)

  console.log(`Reading token contracts from ${rows}…`)
  const addresses = await readDatasetAddresses(rows)
  console.log(`  ${addresses.size.toLocaleString('en-US')} distinct token contracts in the dataset`)

  console.log(`Reading token metadata from ${source}…`)
  const tokenRows = await readTokenRows(source, addresses)
  const artifact = buildTokensArtifact(addresses, tokenRows)

  await fsp.mkdir(out, { recursive: true })
  const target = path.join(out, 'tokens.json')
  await fsp.writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  const { contractsInDataset, contractsWithDecimals } = artifact
  const pct = ((contractsWithDecimals / contractsInDataset) * 100).toFixed(1)
  console.log(`Wrote ${target}`)
  console.log(`  ${contractsWithDecimals} of ${contractsInDataset} contracts have usable decimals (${pct}%)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

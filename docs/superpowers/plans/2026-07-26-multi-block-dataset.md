# Multi-Block Dataset Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 600-row single-block dataset with the 100-block, 74,889-row export by shipping a 12 MB gzipped 34-column payload plus lazily-fetched per-transaction calldata, and make `block_number` a real column, filter, and stats dimension.

**Architecture:** An offline Node prep script stream-parses the 2.19 GB source CSV once and emits `public/data/rows.csv.gz` (34 columns), 256 `public/data/calldata/<xx>.json.gz` shards keyed by transaction-hash prefix, and a `dataset.json` manifest. The browser keeps its existing `fetch → PapaParse → EthRecord[]` architecture; `input_tx` leaves `EthRecord` entirely and is fetched per row through a new `CalldataProvider` seam. The data dictionary still documents all 35 fields via a new `availability` flag, while a derived `LOADED_COLUMNS` (34) drives the table, global search, and export.

**Tech Stack:** TypeScript ~6.0, React 19, Vite 8, Vitest 4 (jsdom, globals enabled), TanStack Table 8, PapaParse 5, Node 24 (`node:zlib`, `DecompressionStream`).

## Global Constraints

- **Never use `Number`/`parseFloat` on BigQuery numeric strings.** All comparison and arithmetic on wei/quantity/token-id values goes through `toBigInt` / `compareNumericStrings` in `src/data/transform.ts`. 256-bit values must survive intact.
- **`COLUMNS` stays at exactly 35 entries.** It is the data dictionary and documents the dataset, not the in-memory shape. `LOADED_COLUMNS` (34) is what anything touching a live record must use.
- **Exactly one column has `availability: 'on-demand'`: `input_tx`.**
- **Booleans render as `'True'` / `'False'`** (capitalized) on every user-facing surface — matches the CSV, export, and enum filter labels.
- **The 2.19 GB source CSV is never committed.** It is gitignored (`/analytics_*.csv`) and is an input to `npm run data:prep` only.
- **Run tests with `npm test`** (`vitest run`). Type-check with `npm run build` (`tsc -b && vite build`).
- **Source dataset facts, exact values:** 74,889 rows · 100 blocks · 25534200–25534299 · 43,941 transfers · 30,948 transactions · 40,642 distinct transactions · 12,220 with calldata · time span `2026-07-14 23:35:11+00:00` → `2026-07-14 23:54:59+00:00`.
- **Commit after every task.** Do not batch commits.

---

### Task 1: Prep-script pure helpers

**Files:**
- Create: `scripts/datasetPrep.mjs`
- Test: `scripts/datasetPrep.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `LOADED_FIELDS: string[]` (34 names, source-CSV order), `shardKey(txHash: string): string | null`, `collapseWhitespace(v: string | null | undefined): string`, `hasCalldata(v: unknown): boolean`, `projectRow(row: Record<string,string>): Record<string,string>`. Task 2 imports all five.

Plain `.mjs` (not TypeScript) so the script runs under `node` with no build step. Vitest's default `include` glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) picks up `.test.mjs` with no config change.

- [ ] **Step 1: Write the failing test**

Create `scripts/datasetPrep.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import {
  LOADED_FIELDS,
  shardKey,
  collapseWhitespace,
  hasCalldata,
  projectRow,
} from './datasetPrep.mjs'

describe('LOADED_FIELDS', () => {
  it('is the 34 shipped columns and excludes input_tx', () => {
    expect(LOADED_FIELDS).toHaveLength(34)
    expect(LOADED_FIELDS).not.toContain('input_tx')
    expect(LOADED_FIELDS[0]).toBe('block_hash')
    expect(LOADED_FIELDS[33]).toBe('is_token_transfer')
  })
})

describe('shardKey', () => {
  it('is the first hex byte after the 0x prefix, lowercased', () => {
    expect(shardKey('0xAB12cd34')).toBe('ab')
    expect(shardKey('0x0058db6926d4d88a')).toBe('00')
  })

  it('tolerates a missing 0x prefix', () => {
    expect(shardKey('ff9900')).toBe('ff')
  })

  it('returns null when there is no byte to key on', () => {
    expect(shardKey('0x')).toBeNull()
    expect(shardKey('')).toBeNull()
    expect(shardKey(null)).toBeNull()
    expect(shardKey(undefined)).toBeNull()
  })
})

describe('collapseWhitespace', () => {
  it("flattens BigQuery's multi-line Python-repr access lists to one line", () => {
    const raw = "[{'address': '0xabc', 'storage_keys': array(['0x0018',\n       '0x0019'], dtype=object)}]"
    expect(collapseWhitespace(raw)).toBe(
      "[{'address': '0xabc', 'storage_keys': array(['0x0018', '0x0019'], dtype=object)}]",
    )
  })

  it('trims and returns empty string for nullish input', () => {
    expect(collapseWhitespace('  [] ')).toBe('[]')
    expect(collapseWhitespace(null)).toBe('')
    expect(collapseWhitespace(undefined)).toBe('')
  })
})

describe('hasCalldata', () => {
  it('treats 0x and empty as no calldata', () => {
    expect(hasCalldata('0x')).toBe(false)
    expect(hasCalldata('0X')).toBe(false)
    expect(hasCalldata('')).toBe(false)
    expect(hasCalldata('   ')).toBe(false)
    expect(hasCalldata(null)).toBe(false)
    expect(hasCalldata(undefined)).toBe(false)
  })

  it('treats a real selector as calldata', () => {
    expect(hasCalldata('0xa9059cbb0000')).toBe(true)
  })
})

describe('projectRow', () => {
  const row = {
    block_hash: '0xc779',
    block_number: '25534300',
    transaction_hash: '0x0058',
    input_tx: '0xa9059cbb',
    access_list_tx: "[{'a': 1,\n   'b': 2}]",
    is_token_transfer: 'True',
  }

  it('drops input_tx and emits exactly the 34 shipped fields', () => {
    const out = projectRow(row)
    expect(Object.keys(out)).toEqual(LOADED_FIELDS)
    expect(out).not.toHaveProperty('input_tx')
  })

  it('collapses whitespace in access_list_tx only', () => {
    const out = projectRow(row)
    expect(out.access_list_tx).toBe("[{'a': 1, 'b': 2}]")
    expect(out.block_hash).toBe('0xc779')
  })

  it('emits empty string for fields missing from the source row', () => {
    expect(projectRow({}).quantity).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/datasetPrep.test.mjs`
Expected: FAIL — `Failed to resolve import "./datasetPrep.mjs"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/datasetPrep.mjs`:

```js
/**
 * Pure helpers shared by `prepare-dataset.mjs` and its tests. Kept free of `fs`/`zlib` so
 * every rule about what ships to the browser is unit-testable without touching a 2.19 GB
 * file.
 */

/**
 * The 34 columns that ship to the browser, in the source CSV's own order.
 * `input_tx` is deliberately absent: it is 96.9% of the source file's bytes and is
 * duplicated across every row of a transaction, so it is stored per-transaction in
 * `calldata/<shard>.json.gz` instead and fetched on demand.
 */
export const LOADED_FIELDS = [
  'block_hash',
  'block_number',
  'block_timestamp',
  'transaction_hash',
  'transaction_index',
  'event_index',
  'batch_index',
  'address',
  'event_type',
  'event_hash',
  'event_signature',
  'operator_address',
  'from_address',
  'to_address',
  'token_id',
  'quantity',
  'removed',
  'nonce_tx',
  'from_address_tx',
  'to_address_tx',
  'value_tx',
  'value_lossless_tx',
  'gas_tx',
  'gas_price_tx',
  'max_fee_per_gas_tx',
  'max_priority_fee_per_gas_tx',
  'type_tx',
  'chain_id_tx',
  'access_list_tx',
  'r_tx',
  's_tx',
  'v_tx',
  'y_parity_tx',
  'is_token_transfer',
]

/**
 * Shard file stem for a transaction hash: its first hex byte, lowercased — so
 * `0xAB12…` lives in `calldata/ab.json.gz`. Tx hashes are effectively uniform, so 256
 * shards split the 12,220 stored transactions evenly with no index file needed: the
 * client derives the shard name from the hash it already has.
 */
export function shardKey(txHash) {
  const s = String(txHash ?? '')
  const body = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
  if (body.length < 2) return null
  return body.slice(0, 2).toLowerCase()
}

/**
 * BigQuery exports `access_list_tx` as a Python/numpy repr containing literal newlines and
 * indentation. Rendered raw those cells look broken, so runs of whitespace collapse to a
 * single space. Cosmetic only — no tokens are lost.
 */
export function collapseWhitespace(v) {
  if (v == null) return ''
  return String(v).replace(/\s+/g, ' ').trim()
}

/**
 * Whether a transaction's calldata is worth storing. `0x` (a plain value transfer) and
 * empty carry no information — 28,422 of the source's 40,642 transactions are in this
 * category, and the client reconstructs them as `'0x'` on a shard miss.
 */
export function hasCalldata(v) {
  const s = String(v ?? '').trim()
  return s !== '' && s.toLowerCase() !== '0x'
}

/**
 * Project a parsed source row down to the 34 shipped columns. Missing fields become `''`
 * (not `undefined`) so every emitted CSV row has the same arity.
 */
export function projectRow(row) {
  const out = {}
  for (const field of LOADED_FIELDS) {
    const raw = row[field] ?? ''
    out[field] = field === 'access_list_tx' ? collapseWhitespace(raw) : String(raw)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/datasetPrep.test.mjs`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/datasetPrep.mjs scripts/datasetPrep.test.mjs
git commit -m "feat: pure helpers for the dataset prep script"
```

---

### Task 2: Prep-script CLI

**Files:**
- Create: `scripts/prepare-dataset.mjs`
- Modify: `package.json` (add the `data:prep` script)

**Interfaces:**
- Consumes: `LOADED_FIELDS`, `projectRow`, `shardKey`, `hasCalldata` from Task 1.
- Produces: `public/data/rows.csv.gz`, `public/data/calldata/<xx>.json.gz`, `public/data/dataset.json`. Task 6 fetches `rows.csv.gz`; Task 7 fetches the shards.

This task is verified by running the script against a small hand-built source CSV via the `--out` flag, **not** against the 2.19 GB file. Keep `--out` — it is what makes the script testable without a multi-gigabyte fixture.

- [ ] **Step 1: Write the script**

Create `scripts/prepare-dataset.mjs`:

```js
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
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"` immediately after `"build"`:

```json
    "data:prep": "node scripts/prepare-dataset.mjs",
```

- [ ] **Step 3: Build a tiny source fixture and run the script**

```bash
mkdir -p /tmp/dsprep
cat > /tmp/dsprep/mini.csv <<'CSV'
block_hash,block_number,block_timestamp,transaction_hash,transaction_index,event_index,batch_index,address,event_type,event_hash,event_signature,operator_address,from_address,to_address,token_id,quantity,removed,nonce_tx,from_address_tx,to_address_tx,value_tx,value_lossless_tx,gas_tx,gas_price_tx,input_tx,max_fee_per_gas_tx,max_priority_fee_per_gas_tx,type_tx,chain_id_tx,access_list_tx,r_tx,s_tx,v_tx,y_parity_tx,is_token_transfer
0xaaa,25534200,2026-07-14 23:35:11+00:00,0xab11,1,,,,,,,,,,,,,0,0xf1,0xf2,10.0,10,21000,5000,0x,6000.0,100.0,2,1.0,[],0xr,0xs,0x1,0x1,False
0xbbb,25534201,2026-07-14 23:35:23+00:00,0xcd22,2,5.0,,0xa0b8,ERC-20,0xddf2,"Transfer(address,address,uint256)",,0x11,0x22,,500,False,3,0x11,0xa0b8,0.0,0,50000,7000,0xa9059cbb,8000.0,200.0,2,1.0,"[{'address': '0xdd', 'storage_keys': array(['0x0018',
       '0x0019'], dtype=object)}]",0xr,0xs,0x0,0x0,True
0xccc,,2026-07-14 23:35:35+00:00,0xef33,3,,,,,,,,,,,,,4,0x33,0x44,1.0,1,21000,9000,0x,,,2,1.0,[],0xr,0xs,0x1,0x1,False
CSV
node scripts/prepare-dataset.mjs /tmp/dsprep/mini.csv --out /tmp/dsprep/out
cat /tmp/dsprep/out/dataset.json
```

Expected `dataset.json`: `"rows": 2`, `"skippedRows": 1` (the row with a blank `block_number`), `"columns": 34`, `"blockMin": 25534200`, `"blockMax": 25534201`, `"calldataTransactions": 1`, `"calldataShards": 1`.

- [ ] **Step 4: Verify the artifact contents**

```bash
gunzip -c /tmp/dsprep/out/rows.csv.gz | head -3
gunzip -c /tmp/dsprep/out/calldata/cd.json.gz
```

Expected: the header line has 34 names with no `input_tx`; row 2's `access_list_tx` is on **one line** with single spaces; the shard prints exactly `{"0xcd22":"0xa9059cbb"}`. The `0xab11` transaction must **not** appear in any shard — its calldata is `0x`.

- [ ] **Step 5: Commit**

```bash
git add scripts/prepare-dataset.mjs package.json
git commit -m "feat: dataset prep script emitting rows.csv.gz + calldata shards"
```

---

### Task 3: Dictionary `availability` flag and `LOADED_COLUMNS`

**Files:**
- Modify: `src/data/dictionary.ts`
- Test: `src/data/dictionary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DictionaryField = keyof EthRecord | 'input_tx'`; `ColumnMeta.availability: 'loaded' | 'on-demand'`; `interface LoadedColumnMeta`; `LOADED_COLUMNS: LoadedColumnMeta[]` (34 entries). Tasks 4, 8 and 10 all consume these.

This task is purely additive — `input_tx` is still on `EthRecord` at this point, so nothing breaks. Task 4 removes it.

- [ ] **Step 1: Write the failing test**

Replace the first `it` block in `src/data/dictionary.test.ts` and add two new ones. The full `describe` becomes:

```ts
import { describe, it, expect } from 'vitest'
import { COLUMNS, LOADED_COLUMNS, getColumnMeta } from './dictionary'

describe('column dictionary', () => {
  it('documents all 35 CSV columns in CSV order', () => {
    expect(COLUMNS).toHaveLength(35)
    expect(COLUMNS[0].field).toBe('block_hash')
    expect(COLUMNS[34].field).toBe('is_token_transfer')
  })

  it('every column has a non-empty description and a source', () => {
    for (const c of COLUMNS) {
      expect(c.description.length).toBeGreaterThan(10)
      expect(['token_transfers', 'transactions', 'both', 'derived']).toContain(c.source)
    }
  })

  it('looks up by field name', () => {
    expect(getColumnMeta('gas_price_tx')?.source).toBe('transactions')
    expect(getColumnMeta('event_type')?.source).toBe('token_transfers')
    expect(getColumnMeta('block_hash')?.source).toBe('both')
    expect(getColumnMeta('nope')).toBeUndefined()
  })

  it('marks exactly one field as on-demand, and it is input_tx', () => {
    const onDemand = COLUMNS.filter((c) => c.availability === 'on-demand')
    expect(onDemand).toHaveLength(1)
    expect(onDemand[0].field).toBe('input_tx')
  })

  it('every column declares a valid availability', () => {
    for (const c of COLUMNS) {
      expect(['loaded', 'on-demand']).toContain(c.availability)
    }
  })

  it('LOADED_COLUMNS is the 34 in-memory columns, in CSV order, without input_tx', () => {
    expect(LOADED_COLUMNS).toHaveLength(34)
    expect(LOADED_COLUMNS.map((c) => c.field)).not.toContain('input_tx')
    expect(LOADED_COLUMNS.every((c) => c.availability === 'loaded')).toBe(true)
    expect(LOADED_COLUMNS.map((c) => c.field)).toEqual(
      COLUMNS.filter((c) => c.field !== 'input_tx').map((c) => c.field),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/data/dictionary.test.ts`
Expected: FAIL — `LOADED_COLUMNS` is not exported, and `availability` does not exist on `ColumnMeta`.

- [ ] **Step 3: Update the dictionary types**

In `src/data/dictionary.ts`, replace lines 1–9 (the import and the `ColumnMeta` interface) with:

```ts
import type { EthRecord } from './types'

/**
 * Every field the *dataset* has — which is one more than `EthRecord` carries. `input_tx`
 * is documented here but never held in memory (see `availability` below), so it is not a
 * key of `EthRecord`.
 */
export type DictionaryField = keyof EthRecord | 'input_tx'

export interface ColumnMeta {
  field: DictionaryField
  label: string
  description: string
  source: 'token_transfers' | 'transactions' | 'both' | 'derived'
  kind: 'hex' | 'address' | 'number' | 'bignum' | 'timestamp' | 'enum' | 'boolean' | 'text'
  /**
   * `'loaded'` — the value is on every `EthRecord` in memory.
   * `'on-demand'` — documented, but fetched per row through `CalldataProvider`. Anything
   * that reads a value off a live record must iterate `LOADED_COLUMNS`, not `COLUMNS`.
   */
  availability: 'loaded' | 'on-demand'
}

/** A dictionary entry whose field really is present on `EthRecord`. */
export interface LoadedColumnMeta extends ColumnMeta {
  field: keyof EthRecord
  availability: 'loaded'
}
```

- [ ] **Step 4: Add `availability` to all 35 entries**

Append `, availability: 'loaded'` immediately before the closing `}` of **every** entry in the `COLUMNS` array, e.g.:

```ts
  { field: 'block_hash', label: 'Block Hash', description: 'Hash of the block this event was emitted from.', source: 'both', kind: 'hex', availability: 'loaded' },
```

Then change the `input_tx` entry (currently line 36) to be `'on-demand'` with a description that says so:

```ts
  { field: 'input_tx', label: 'Input Data', description: 'Data sent along with the transaction (contract calldata). Stored per transaction and fetched on demand — expand a row to load it.', source: 'transactions', kind: 'hex', availability: 'on-demand' },
```

- [ ] **Step 5: Export `LOADED_COLUMNS`**

Replace the tail of `src/data/dictionary.ts` (currently lines 49–53) with:

```ts
/**
 * The 34 columns actually present on an `EthRecord`. This — not `COLUMNS` — is what the
 * table, global search, and CSV export iterate: `COLUMNS` documents the dataset, and one
 * of its entries (`input_tx`) has no value to read off a record.
 */
export const LOADED_COLUMNS: LoadedColumnMeta[] = COLUMNS.filter(
  (c): c is LoadedColumnMeta => c.availability === 'loaded',
)

const byField = new Map(COLUMNS.map((c) => [c.field as string, c]))

export function getColumnMeta(field: string): ColumnMeta | undefined {
  return byField.get(field)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/data/dictionary.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 7: Verify nothing else broke**

Run: `npm test && npm run build`
Expected: all suites PASS, type-check clean. `input_tx` is still on `EthRecord`, so every existing consumer still compiles.

- [ ] **Step 8: Commit**

```bash
git add src/data/dictionary.ts src/data/dictionary.test.ts
git commit -m "feat: availability flag on dictionary columns, derived LOADED_COLUMNS"
```

---

### Task 4: Remove `input_tx` from `EthRecord` and migrate every consumer

**Files:**
- Modify: `src/data/types.ts:29` (delete), `src/features/table/columns.tsx`, `src/features/table/filters.ts:62,65`, `src/features/export/ExportButton.tsx:58,95`, `src/features/table/rowDetailFields.ts:16`, `src/features/table/RowDetail.tsx`, `src/features/dictionary/DictionaryPanel.tsx`, `src/features/dictionary/dictionaryPanelContext.ts:10`
- Test: `src/features/table/columns.test.ts:22-26`, `src/features/table/RowDetail.test.ts`

**Interfaces:**
- Consumes: `LOADED_COLUMNS`, `DictionaryField` from Task 3.
- Produces: an `EthRecord` with 34 fields. Task 6 parses into it; Task 8 replaces this task's static placeholder in `RowDetail` with a real fetch.

This is one task on purpose: deleting the field breaks eight files simultaneously, and leaving the build red between tasks would make every later task unverifiable. Work through all steps before running the suite.

- [ ] **Step 1: Delete the field from `EthRecord`**

In `src/data/types.ts`, delete line 29:

```ts
  input_tx: string | null
```

- [ ] **Step 2: Point the All Records tab and the header helpers at `LOADED_COLUMNS`**

In `src/features/table/columns.tsx`:

Change the import on line 2 to:

```ts
import { getColumnMeta, LOADED_COLUMNS, type ColumnMeta, type DictionaryField } from '../../data/dictionary'
```

Change the four helper signatures that take a field, so a dictionary field (which may be `'input_tx'`) is accepted for label lookup:

```ts
function metaLabel(field: DictionaryField): string {
  return getColumnMeta(field)?.label ?? String(field)
}

export function columnDisplayLabel(field: DictionaryField, tab: TabId): string {
  if (tab === 'all') return metaLabel(field)
  return DISPLAY_LABEL_OVERRIDES[field as keyof EthRecord] ?? metaLabel(field)
}

function header(tab: TabId, field: DictionaryField, rangeUnit?: string) {
  // body unchanged
}

function filterFor(field: DictionaryField) {
  // body unchanged
}
```

Replace the `allColumns` definition (lines 242–249) with:

```ts
const allColumns: ColumnDef<EthRecord>[] = LOADED_COLUMNS.map((meta) =>
  helper.accessor(meta.field, {
    header: header('all', meta.field),
    cell: (info) => <RawCell value={info.getValue()} />,
    sortingFn: meta.kind === 'bignum' ? 'bignum' : undefined,
    filterFn: filterFor(meta.field),
  }),
) as ColumnDef<EthRecord>[]
```

And update the comment block above it (lines 235–240): "Every one of the 35 dictionary columns" becomes "Every one of the 34 loaded dictionary columns (`input_tx` is fetched per row — see RowDetail)".

- [ ] **Step 3: Point global search at `LOADED_COLUMNS`**

In `src/features/table/filters.ts`, change line 2's import to `import { LOADED_COLUMNS } from '../../data/dictionary'`, then line 62 to:

```ts
const ALL_FIELDS = LOADED_COLUMNS.map((c) => c.field)
```

and the docstring on line 65 from "all 35 dictionary fields" to "all 34 loaded dictionary fields".

- [ ] **Step 4: Update the export**

In `src/features/export/ExportButton.tsx`, change line 3 to `import { LOADED_COLUMNS } from '../../data/dictionary'`, line 58 to:

```ts
      ? LOADED_COLUMNS.map((c) => c.field)
```

and the menu label on line 95 to `All 34 columns`.

- [ ] **Step 5: Widen the row-detail and dictionary field types**

In `src/features/table/rowDetailFields.ts`, change line 1–17 so `FieldGroup` accepts a dictionary field (the `GROUPS` array itself is unchanged — `input_tx` stays listed):

```ts
import type { DictionaryField } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'

export interface FieldGroup {
  title: string
  fields: DictionaryField[]
}
```

`HUMAN_UNIT` keeps its `Partial<Record<keyof EthRecord, string>>` type — no on-demand field has a unit.

In `src/features/dictionary/dictionaryPanelContext.ts`, change lines 2 and 10:

```ts
import type { DictionaryField } from '../../data/dictionary'
```
```ts
  openField: (field: DictionaryField) => void
```

In `src/features/dictionary/DictionaryPanel.tsx`, widen the three field types — line 18, line 103, and line 140:

```ts
type PanelState = { field: DictionaryField } | { field: undefined } | null
```
```tsx
export function DictionaryInfoTrigger({ field, label }: { field: DictionaryField; label: string }) {
```
```ts
  /** Set → single-column mode for this field. Unset → full mode, all 35 fields. */
  field?: DictionaryField
```

and add `DictionaryField` plus `LOADED_COLUMNS` to its import on line 2:

```ts
import { COLUMNS, LOADED_COLUMNS, getColumnMeta, type ColumnMeta, type DictionaryField } from '../../data/dictionary'
```

Update `openField`'s signature on line 50 to `(field: DictionaryField) => {`.

- [ ] **Step 6: Make the dictionary panel honest about on-demand fields**

In `src/features/dictionary/DictionaryPanel.tsx`, replace the `FieldDetail` function (lines 291–334) with a version that never asks `computeColumnStats` for data it does not hold:

```tsx
function FieldDetail({ field, meta, records }: { field: DictionaryField; meta: ColumnMeta; records: EthRecord[] }) {
  return (
    <div className="dictionary-field">
      <div className="dictionary-field__meta-row">
        <SourceBadge source={meta.source} />
        <span className="dictionary-field__kind">{meta.kind}</span>
      </div>
      <p className="dictionary-field__description">{meta.description}</p>
      <code className="dictionary-field__name">{field}</code>
      {meta.availability === 'on-demand' ? (
        // Live stats need the value on every record. This one isn't in memory (it is 97%
        // of the source file's bytes), so say so rather than render a fabricated 0% fill.
        <p className="dictionary-field__unavailable">
          Fetched on demand — not loaded in the browser. Expand a row to load it.
        </p>
      ) : (
        <FieldStats field={field as keyof EthRecord} records={records} />
      )}
    </div>
  )
}

function FieldStats({ field, records }: { field: keyof EthRecord; records: EthRecord[] }) {
  const stats = computeColumnStats(records, field)
  return (
    <dl className="dictionary-stats">
      <div className="dictionary-stat">
        <dt className="dictionary-stat__label">Fill rate</dt>
        <dd className="dictionary-stat__value">
          <FillBar value={stats.fillRate} />
        </dd>
      </div>
      <div className="dictionary-stat">
        <dt className="dictionary-stat__label">Distinct values</dt>
        <dd className="dictionary-stat__value dictionary-stat__value--mono">
          {stats.distinct.toLocaleString('en-US')}
        </dd>
      </div>
      {stats.min != null && (
        <div className="dictionary-stat">
          <dt className="dictionary-stat__label">Min</dt>
          <dd>
            <StatValue field={field} raw={stats.min} />
          </dd>
        </div>
      )}
      {stats.max != null && (
        <div className="dictionary-stat">
          <dt className="dictionary-stat__label">Max</dt>
          <dd>
            <StatValue field={field} raw={stats.max} />
          </dd>
        </div>
      )}
    </dl>
  )
}
```

In `FullDictionary` (lines 340–397), build the memo from `LOADED_COLUMNS` and render the fill bar only for loaded fields. Replace the `statsByField` memo and the `fields.map` body:

```tsx
  // 34 loaded fields × a full-dataset scan each — worth memoizing so re-renders of the open
  // panel (e.g. parent state changes) don't recompute every column's stats from scratch.
  const statsByField = useMemo(
    () => new Map(LOADED_COLUMNS.map((c) => [c.field, computeColumnStats(records, c.field)])),
    [records],
  )
```

```tsx
              {fields.map((c) => {
                const stats = c.availability === 'loaded' ? statsByField.get(c.field as keyof EthRecord) : undefined
                return (
                  <li key={c.field} className="dictionary-entry">
                    <div className="dictionary-entry__row">
                      <span className="dictionary-entry__label">{c.label}</span>
                      <code className="dictionary-entry__field">{c.field}</code>
                    </div>
                    <p className="dictionary-entry__description">{c.description}</p>
                    {stats ? (
                      <FillBar value={stats.fillRate} />
                    ) : (
                      <span className="dictionary-entry__on-demand">On demand</span>
                    )}
                  </li>
                )
              })}
```

- [ ] **Step 7: Add the two new dictionary styles**

Append to `src/features/dictionary/dictionary.css`:

```css
.dictionary-field__unavailable {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.dictionary-entry__on-demand {
  display: inline-block;
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
```

- [ ] **Step 8: Render the on-demand field as a placeholder in RowDetail**

Task 8 makes this a real fetch. For now it must compile and be honest. In `src/features/table/RowDetail.tsx`, inside the `group.fields.map` callback, insert this as the first statement of the body (before `const raw = ...`):

```tsx
              const meta = getColumnMeta(field)
              if (meta?.availability === 'on-demand') {
                return (
                  <div key={String(field)} className="row-detail__field">
                    <span className="row-detail__field-label">{meta.label}</span>
                    <span className="row-detail__field-value row-detail__field-value--empty">
                      Not loaded
                    </span>
                  </div>
                )
              }
              const raw = rawString(record[field as keyof EthRecord])
```

and delete the now-duplicated `const meta = getColumnMeta(field)` line that followed. Change the two remaining `field`-keyed lookups in that callback to cast, since `field` is now a `DictionaryField`:

```tsx
              const humanFn = raw != null ? HUMAN_READABLE[field as keyof EthRecord] : undefined
              const unit = HUMAN_UNIT[field as keyof EthRecord]
```

- [ ] **Step 9: Update the All Records column-count test**

In `src/features/table/columns.test.ts`, change line 5's import to add `LOADED_COLUMNS`, and replace the first test (lines 22–26):

```ts
  it("'all' returns exactly the 34 loaded dictionary columns, in CSV order", () => {
    const defs = getColumnsForTab('all')
    expect(defs).toHaveLength(34)
    expect(fields(defs)).toEqual(LOADED_COLUMNS.map((c) => c.field))
    expect(fields(defs)).not.toContain('input_tx')
  })
```

In the same file, the last test (`'all' tab: every column whose dictionary kind is 'bignum'…`, lines 83–96) iterates `COLUMNS` and asserts a def exists for each. Change its loop to iterate `LOADED_COLUMNS` and its `expectedBignumFields` to derive from `LOADED_COLUMNS`:

```ts
    const expectedBignumFields = new Set(LOADED_COLUMNS.filter((c) => c.kind === 'bignum').map((c) => c.field))

    for (const meta of LOADED_COLUMNS) {
```

- [ ] **Step 10: Confirm the RowDetail test still holds**

`src/features/table/RowDetail.test.ts` asserts `GROUPS` is set-equal to `COLUMNS.map(c => c.field)` — all 35. `GROUPS` still lists `input_tx`, so this test needs **no change**. That is the point: the row-detail panel keeps documenting every field.

- [ ] **Step 11: Run the full suite and type-check**

Run: `npm test && npm run build`
Expected: all suites PASS, type-check clean.

- [ ] **Step 12: Commit**

```bash
git add src/data/types.ts src/data/dictionary.ts src/features src/components
git commit -m "refactor: drop input_tx from EthRecord, route consumers through LOADED_COLUMNS"
```

---

### Task 5: Gzip decompression module

**Files:**
- Create: `src/data/gzip.ts`
- Test: `src/data/gzip.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isGzipped(bytes: Uint8Array): boolean`, `decodeMaybeGzipped(bytes: Uint8Array): Promise<string>`. Tasks 6 and 7 both use `decodeMaybeGzipped`.

- [ ] **Step 1: Write the failing test**

Create `src/data/gzip.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isGzipped, decodeMaybeGzipped } from './gzip'

/** Gzip a string using the same web streams API the app decompresses with. */
async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  void writer.write(new TextEncoder().encode(text))
  void writer.close()
  const buf = await new Response(cs.readable).arrayBuffer()
  return new Uint8Array(buf)
}

describe('isGzipped', () => {
  it('detects the gzip magic bytes 0x1f 0x8b', async () => {
    expect(isGzipped(await gzip('hello'))).toBe(true)
  })

  it('rejects plain text and too-short buffers', () => {
    expect(isGzipped(new TextEncoder().encode('block_hash,block_number'))).toBe(false)
    expect(isGzipped(new Uint8Array([0x1f]))).toBe(false)
    expect(isGzipped(new Uint8Array([]))).toBe(false)
  })
})

describe('decodeMaybeGzipped', () => {
  it('decompresses gzipped input', async () => {
    const text = 'a,b\r\n1,2\r\n'
    expect(await decodeMaybeGzipped(await gzip(text))).toBe(text)
  })

  it('passes through input a host already decompressed', async () => {
    const text = 'a,b\r\n1,2\r\n'
    expect(await decodeMaybeGzipped(new TextEncoder().encode(text))).toBe(text)
  })

  it('round-trips multi-byte UTF-8', async () => {
    const text = 'Ξ 25,534,200 — blocks'
    expect(await decodeMaybeGzipped(await gzip(text))).toBe(text)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/data/gzip.test.ts`
Expected: FAIL — `Failed to resolve import "./gzip"`.

If instead it fails with `CompressionStream is not defined`, the jsdom environment did not inherit the Node global; add this to the top of the test file and re-run:

```ts
import { CompressionStream, DecompressionStream } from 'node:stream/web'
globalThis.CompressionStream ??= CompressionStream as unknown as typeof globalThis.CompressionStream
globalThis.DecompressionStream ??= DecompressionStream as unknown as typeof globalThis.DecompressionStream
```

- [ ] **Step 3: Write the implementation**

Create `src/data/gzip.ts`:

```ts
/** Gzip's two-byte header: 0x1f 0x8b. */
export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Decode a fetched artifact to text, decompressing only if it is still gzipped.
 *
 * The sniff is not optional. Artifacts are committed as `.gz`, but some static hosts
 * serve them with `Content-Encoding: gzip`, in which case the browser has *already*
 * decompressed the body — piping that through `DecompressionStream` would throw. Checking
 * the magic bytes makes the same code correct on either kind of host.
 *
 * Requires `DecompressionStream`: Chrome 80+, Firefox 113+, Safari 16.4+.
 */
export async function decodeMaybeGzipped(bytes: Uint8Array): Promise<string> {
  if (!isGzipped(bytes)) return new TextDecoder().decode(bytes)
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser cannot decompress the dataset (DecompressionStream unavailable). ' +
        'Requires Chrome 80+, Firefox 113+, or Safari 16.4+.',
    )
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/data/gzip.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/gzip.ts src/data/gzip.test.ts
git commit -m "feat: gzip decode with magic-byte sniffing for host-agnostic artifacts"
```

---

### Task 6: Load the gzipped 34-column dataset

**Files:**
- Modify: `src/data/csvProvider.ts`, `src/data/provider.ts`
- Create: `src/data/__fixtures__/multiblock.csv`
- Test: `src/data/csvProvider.test.ts`

**Interfaces:**
- Consumes: `decodeMaybeGzipped` (Task 5), the 34-field `EthRecord` (Task 4).
- Produces: `csvProvider(url?: string, onProgress?: (loaded: number, total: number | null) => void): DataProvider`, still returning `LoadResult`. Task 11 passes `onProgress`.

- [ ] **Step 1: Create the multi-block fixture**

Create `src/data/__fixtures__/multiblock.csv`. It is 34 columns (no `input_tx`) and carries the real export's two quirks: a multi-line quoted `access_list_tx` and `.0`-suffixed integers.

```
block_hash,block_number,block_timestamp,transaction_hash,transaction_index,event_index,batch_index,address,event_type,event_hash,event_signature,operator_address,from_address,to_address,token_id,quantity,removed,nonce_tx,from_address_tx,to_address_tx,value_tx,value_lossless_tx,gas_tx,gas_price_tx,max_fee_per_gas_tx,max_priority_fee_per_gas_tx,type_tx,chain_id_tx,access_list_tx,r_tx,s_tx,v_tx,y_parity_tx,is_token_transfer
0xaaa,25534200,2026-07-14 23:35:11+00:00,0xab11,1,,,,,,,,,,,,,0,0xf1,0xf2,10.0,10,21000,5000,6000.0,100.0,2,1.0,[],0xr1,0xs1,0x1,0x1,False
0xbbb,25534201,2026-07-14 23:35:23+00:00,0xcd22,2,5.0,,0xa0b8,ERC-20,0xddf2,"Transfer(address,address,uint256)",,0x11,0x22,,500,False,3,0x11,0xa0b8,0.0,0,50000,7000,8000.0,200.0,2,1.0,"[{'address': '0xdd', 'storage_keys': array(['0x0018',
       '0x0019'], dtype=object)}]",0xr2,0xs2,0x0,0x0,True
0xccc,25534202,2026-07-14 23:35:35+00:00,0xef33,3,6.0,,0xa0b8,ERC-721,0xddf2,"Transfer(address,address,uint256)",,0x33,0x44,7,1,False,4,0x33,0xa0b8,0.0,0,60000,9000,10000.0,300.0,2,1.0,[],0xr3,0xs3,0x1,0x1,True
```

- [ ] **Step 2: Write the failing test**

Append to `src/data/csvProvider.test.ts` (keep every existing test — but first update its `HEADER` and both row constants to drop the `input_tx` column, since `parseCsv` no longer reads it; remove `input_tx` from `HEADER` and delete the corresponding `0x` / `0x09c5` value from `TX_ROW` and `TRANSFER_ROW`):

```ts
import multiblockCsv from './__fixtures__/multiblock.csv?raw'

describe('parseCsv on the multi-block fixture', () => {
  it('parses every row across three blocks', () => {
    const { records, malformedCount } = parseCsv(multiblockCsv)
    expect(records).toHaveLength(3)
    expect(malformedCount).toBe(0)
    expect(records.map((r) => r.block_number)).toEqual([25534200, 25534201, 25534202])
  })

  it('keeps a quoted, multi-line access list intact as one field', () => {
    const { records } = parseCsv(multiblockCsv)
    expect(records[1].access_list_tx).toContain("'storage_keys'")
    expect(records[1].access_list_tx).toContain('0x0019')
    // The newline survives parsing — the prep script is what normalizes it, not the parser.
    expect(records[1].access_list_tx).toContain('\n')
  })

  it("parses '.0'-suffixed integers as integers", () => {
    const { records } = parseCsv(multiblockCsv)
    expect(records[1].event_index).toBe(5)
    expect(records[1].chain_id_tx).toBe(1)
  })

  it('no longer carries input_tx', () => {
    const { records } = parseCsv(multiblockCsv)
    expect(records[0]).not.toHaveProperty('input_tx')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/data/csvProvider.test.ts`
Expected: FAIL — `records[0]` still has an `input_tx` property (the parser still writes it).

- [ ] **Step 4: Update the provider interface**

In `src/data/provider.ts`, add the progress callback type:

```ts
import type { EthRecord } from './types'

export interface LoadResult {
  records: EthRecord[]
  malformedCount: number
}

/** Download progress. `total` is null when the response has no Content-Length. */
export type ProgressCallback = (loaded: number, total: number | null) => void

/** Seam for the future BigQuery-backed API — UI depends only on this. */
export interface DataProvider {
  load(): Promise<LoadResult>
}
```

- [ ] **Step 5: Update the CSV provider**

In `src/data/csvProvider.ts`, delete the `input_tx: str(row.input_tx),` line from the record literal (line 61), then add interning and replace `csvProvider`:

Add after the `bool` helper (line 19):

```ts
/**
 * Collapses repeated string values to a single allocation. Across the real 74,889-row
 * dataset `block_hash` has 100 distinct values and `event_signature` has 3 — without
 * interning that is ~75k separate strings per column.
 */
function interner(): (v: string | undefined) => string | null {
  const pool = new Map<string, string>()
  return (v) => {
    const s = str(v)
    if (s == null) return null
    const hit = pool.get(s)
    if (hit !== undefined) return hit
    pool.set(s, s)
    return s
  }
}
```

Inside `parseCsv`, immediately before the `for (const row of parsed.data)` loop:

```ts
  // One pool per low-cardinality column — a shared pool would be a single huge map with
  // no benefit, since these columns' value spaces don't overlap.
  const inBlockHash = interner()
  const inTimestamp = interner()
  const inEventType = interner()
  const inEventHash = interner()
  const inEventSig = interner()
  const inAccessList = interner()
```

and change those six assignments in the record literal to use them:

```ts
      block_hash: inBlockHash(row.block_hash) ?? '',
      block_timestamp: inTimestamp(row.block_timestamp) ?? '',
      event_type: inEventType(row.event_type),
      event_hash: inEventHash(row.event_hash),
      event_signature: inEventSig(row.event_signature),
      access_list_tx: inAccessList(row.access_list_tx),
```

Replace `csvProvider` (lines 77–85) with:

```ts
/**
 * Loads the committed dataset artifact. The default URL is the gzipped 34-column payload
 * produced by `scripts/prepare-dataset.mjs` — `input_tx` is not in it (see
 * `calldataProvider.ts`).
 */
export function csvProvider(
  url = '/data/rows.csv.gz',
  onProgress?: ProgressCallback,
): DataProvider {
  return {
    async load(): Promise<LoadResult> {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to fetch dataset: HTTP ${res.status}`)

      const lengthHeader = res.headers.get('Content-Length')
      const total = lengthHeader != null ? Number.parseInt(lengthHeader, 10) : null
      const bytes = res.body
        ? await readWithProgress(res.body, Number.isFinite(total) ? total : null, onProgress)
        : new Uint8Array(await res.arrayBuffer())

      return parseCsv(await decodeMaybeGzipped(bytes))
    },
  }
}

/** Drains a response body, reporting bytes as they arrive so the UI can show real progress. */
async function readWithProgress(
  body: ReadableStream<Uint8Array>,
  total: number | null,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress?.(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
```

Update the imports at the top of the file:

```ts
import Papa from 'papaparse'
import type { EthRecord } from './types'
import type { DataProvider, LoadResult, ProgressCallback } from './provider'
import { decodeMaybeGzipped } from './gzip'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/data/csvProvider.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/data/csvProvider.ts src/data/provider.ts src/data/csvProvider.test.ts src/data/__fixtures__/multiblock.csv
git commit -m "feat: load the gzipped 34-column dataset with progress and string interning"
```

---

### Task 7: Calldata provider

**Files:**
- Create: `src/data/calldataProvider.ts`
- Test: `src/data/calldataProvider.test.ts`

**Interfaces:**
- Consumes: `decodeMaybeGzipped` (Task 5), `shardKey`'s scheme (Task 1 — reimplemented in TypeScript here; the two must agree).
- Produces: `interface CalldataProvider { get(txHash: string): Promise<string> }`, `calldataShard(txHash: string): string | null`, `calldataProvider(base?: string): CalldataProvider`. Task 8 consumes `CalldataProvider`.

- [ ] **Step 1: Write the failing test**

Create `src/data/calldataProvider.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { calldataProvider, calldataShard } from './calldataProvider'

function jsonResponse(body: unknown): Response {
  return new Response(new TextEncoder().encode(JSON.stringify(body)), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('calldataShard', () => {
  it('matches the prep script: first hex byte after 0x, lowercased', () => {
    expect(calldataShard('0xAB12cd')).toBe('ab')
    expect(calldataShard('0x0058db')).toBe('00')
  })

  it('returns null when there is no byte to key on', () => {
    expect(calldataShard('0x')).toBeNull()
    expect(calldataShard('')).toBeNull()
  })
})

describe('calldataProvider', () => {
  it('fetches the shard named by the tx hash and returns the calldata', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ '0xab11': '0xa9059cbb' }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = calldataProvider('/data/calldata')
    await expect(provider.get('0xab11')).resolves.toBe('0xa9059cbb')
    expect(fetchMock).toHaveBeenCalledWith('/data/calldata/ab.json.gz')
  })

  it("returns '0x' for a transaction absent from its shard", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ '0xabff': '0xdead' })))
    const provider = calldataProvider()
    await expect(provider.get('0xab11')).resolves.toBe('0x')
  })

  it("returns '0x' when the shard file does not exist at all", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const provider = calldataProvider()
    await expect(provider.get('0xab11')).resolves.toBe('0x')
  })

  it('fetches each shard at most once, even for concurrent gets', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ '0xab11': '0x11', '0xab22': '0x22' }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = calldataProvider()
    const [a, b] = await Promise.all([provider.get('0xab11'), provider.get('0xab22')])
    expect(a).toBe('0x11')
    expect(b).toBe('0x22')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects on a network failure so the caller can offer a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const provider = calldataProvider()
    await expect(provider.get('0xab11')).rejects.toThrow('offline')
  })

  it('does not cache a failed shard — a later get retries', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ '0xab11': '0xok' }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = calldataProvider()
    await expect(provider.get('0xab11')).rejects.toThrow('offline')
    await expect(provider.get('0xab11')).resolves.toBe('0xok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("returns '0x' for an unusable hash without fetching", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(calldataProvider().get('0x')).resolves.toBe('0x')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/data/calldataProvider.test.ts`
Expected: FAIL — `Failed to resolve import "./calldataProvider"`.

- [ ] **Step 3: Write the implementation**

Create `src/data/calldataProvider.ts`:

```ts
import { decodeMaybeGzipped } from './gzip'

/**
 * Transaction calldata (`input_tx`) is 96.9% of the raw export's bytes and is duplicated
 * on every row of a transaction, so it never enters `EthRecord`. It lives in 256 shard
 * files keyed by transaction-hash prefix and is fetched only when a row is expanded.
 */
export interface CalldataProvider {
  /** Resolves to the transaction's calldata, or `'0x'` when it carried none. */
  get(txHash: string): Promise<string>
}

/**
 * Shard file stem for a transaction hash. Must stay identical to `shardKey` in
 * `scripts/datasetPrep.mjs` — the client derives the filename rather than reading an
 * index, so the two implementations are the contract.
 */
export function calldataShard(txHash: string): string | null {
  const s = String(txHash ?? '')
  const body = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
  if (body.length < 2) return null
  return body.slice(0, 2).toLowerCase()
}

type Shard = Record<string, string>

export function calldataProvider(base = '/data/calldata'): CalldataProvider {
  // One in-flight promise per shard: a second row in the same shard reuses it instead of
  // issuing a duplicate request, and 48 sibling transactions cost one round trip total.
  const shards = new Map<string, Promise<Shard>>()

  function loadShard(key: string): Promise<Shard> {
    const cached = shards.get(key)
    if (cached !== undefined) return cached

    const request = (async (): Promise<Shard> => {
      const res = await fetch(`${base}/${key}.json.gz`)
      // A missing shard means no transaction in it carries calldata — 28,422 of the
      // dataset's 40,642 transactions are plain `0x`, so absence is expected, not an error.
      if (res.status === 404) return {}
      if (!res.ok) throw new Error(`Failed to fetch calldata shard ${key}: HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return JSON.parse(await decodeMaybeGzipped(bytes)) as Shard
    })()

    // Only a *successful* load stays cached — a network blip must not permanently poison
    // every transaction in this shard.
    shards.set(
      key,
      request.catch((err: unknown) => {
        shards.delete(key)
        throw err
      }),
    )
    return shards.get(key) as Promise<Shard>
  }

  return {
    async get(txHash: string): Promise<string> {
      const key = calldataShard(txHash)
      if (key === null) return '0x'
      const shard = await loadShard(key)
      return shard[txHash] ?? '0x'
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/data/calldataProvider.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/calldataProvider.ts src/data/calldataProvider.test.ts
git commit -m "feat: sharded calldata provider with per-shard caching"
```

---

### Task 8: Async calldata field in RowDetail

**Files:**
- Create: `src/features/table/CalldataField.tsx`
- Modify: `src/features/table/RowDetail.tsx`, `src/features/table/table.css`
- Test: `src/features/table/CalldataField.test.tsx`

**Interfaces:**
- Consumes: `CalldataProvider`, `calldataProvider` (Task 7); `getColumnMeta` `availability` (Task 3).
- Produces: `<CalldataField txHash={string} label={string} provider={CalldataProvider} />`.

The provider is a prop with a module-level default so the component is testable without mocking `fetch`.

- [ ] **Step 1: Write the failing test**

Create `src/features/table/CalldataField.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CalldataField } from './CalldataField'
import type { CalldataProvider } from '../../data/calldataProvider'

function providerReturning(value: string): CalldataProvider {
  return { get: vi.fn(async () => value) }
}

describe('CalldataField', () => {
  it('shows a loading state, then the fetched calldata', async () => {
    render(
      <CalldataField txHash="0xab11" label="Input Data" provider={providerReturning('0xa9059cbb1234')} />,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTitle('0xa9059cbb1234')).toBeInTheDocument())
  })

  it("renders '0x' as a plain value, not as an error", async () => {
    render(<CalldataField txHash="0xab11" label="Input Data" provider={providerReturning('0x')} />)
    await waitFor(() => expect(screen.getByTitle('0x')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('offers a retry when the fetch fails', async () => {
    const provider: CalldataProvider = { get: vi.fn(async () => { throw new Error('offline') }) }
    render(<CalldataField txHash="0xab11" label="Input Data" provider={provider} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument())
  })

  it('does not apply a stale response after the tx hash changes', async () => {
    const provider: CalldataProvider = {
      get: vi.fn(async (hash: string) => (hash === '0xab11' ? '0xOLD' : '0xNEW')),
    }
    const { rerender } = render(
      <CalldataField txHash="0xab11" label="Input Data" provider={provider} />,
    )
    rerender(<CalldataField txHash="0xcd22" label="Input Data" provider={provider} />)
    await waitFor(() => expect(screen.getByTitle('0xNEW')).toBeInTheDocument())
    expect(screen.queryByTitle('0xOLD')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/table/CalldataField.test.tsx`
Expected: FAIL — `Failed to resolve import "./CalldataField"`.

- [ ] **Step 3: Write the component**

Create `src/features/table/CalldataField.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { calldataProvider, type CalldataProvider } from '../../data/calldataProvider'
import { truncateMiddle } from '../../data/transform'

const defaultProvider = calldataProvider()

interface CalldataFieldProps {
  txHash: string
  label: string
  /** Injectable so tests don't have to stub `fetch`. */
  provider?: CalldataProvider
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; value: string }
  | { status: 'error'; message: string }

/**
 * The one row-detail field whose value isn't in memory. `input_tx` is fetched per
 * transaction from a sharded side store (see `calldataProvider.ts`) the moment a row is
 * expanded, and rendered with the same truncate + copy affordance as every other long
 * blob in this panel.
 */
export function CalldataField({ txHash, label, provider = defaultProvider }: CalldataFieldProps) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    provider
      .get(txHash)
      .then((value) => {
        // A row expanded, collapsed, and re-expanded on a different tx must not paint the
        // first row's calldata when the slower request finally lands.
        if (!cancelled) setState({ status: 'ready', value })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [txHash, provider, attempt])

  return (
    <div className="row-detail__field">
      <span className="row-detail__field-label">{label}</span>
      {state.status === 'loading' && (
        <span className="row-detail__field-value row-detail__field-value--empty">Loading…</span>
      )}
      {state.status === 'ready' && (
        <span className="row-detail__field-value">
          <span className="row-detail__field-raw" title={state.value}>
            {truncateMiddle(state.value)}
          </span>
          <CopyButton value={state.value} />
        </span>
      )}
      {state.status === 'error' && (
        <span className="row-detail__field-value">
          <span className="row-detail__field-error">Couldn&rsquo;t load</span>
          <button
            type="button"
            className="row-detail__field-retry"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Add the two styles**

Append to `src/features/table/table.css`:

```css
.row-detail__field-error {
  color: var(--negative, #d9534f);
  font-size: 12px;
}

.row-detail__field-retry {
  margin-left: 8px;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.row-detail__field-retry:hover {
  color: var(--text);
}
```

- [ ] **Step 5: Wire it into RowDetail**

In `src/features/table/RowDetail.tsx`, replace the on-demand placeholder branch added in Task 4 Step 8 with the real component:

```tsx
              const meta = getColumnMeta(field)
              if (meta?.availability === 'on-demand') {
                return (
                  <CalldataField
                    key={String(field)}
                    txHash={record.transaction_hash}
                    label={meta.label}
                  />
                )
              }
```

and add the import:

```tsx
import { CalldataField } from './CalldataField'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/features/table/CalldataField.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 7: Run the full suite and type-check**

Run: `npm test && npm run build`
Expected: all PASS, type-check clean.

- [ ] **Step 8: Commit**

```bash
git add src/features/table/CalldataField.tsx src/features/table/CalldataField.test.tsx src/features/table/RowDetail.tsx src/features/table/table.css
git commit -m "feat: fetch input_tx calldata on row expand"
```

---

### Task 9: Block range in stats, header, and export filename

**Files:**
- Modify: `src/features/stats/computeStats.ts`, `src/features/stats/StatsBand.tsx`, `src/components/Header.tsx`, `src/features/export/ExportButton.tsx`
- Test: `src/features/stats/computeStats.test.ts`

**Interfaces:**
- Consumes: the 34-field `EthRecord` (Task 4).
- Produces: `DatasetStats` with `blockCount: number`, `blockMin: number | null`, `blockMax: number | null`, `timeStart: string | null`, `timeEnd: string | null` (replacing `blockNumber` / `blockTimestamp`); `HeaderProps` with `blockCount`/`blockMin`/`blockMax`/`timeRange`; `ExportButtonProps` with `blockMin`/`blockMax`. Task 11 wires all of it in `App.tsx`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/stats/computeStats.test.ts`:

```ts
describe('block range across a multi-block dataset', () => {
  const at = (block: number, ts: string): EthRecord =>
    ({ ...baseRecord, block_number: block, block_timestamp: ts }) as EthRecord

  it('reports distinct block count and min/max, regardless of row order', () => {
    const stats = computeStats([
      at(25534202, '2026-07-14 23:35:35+00:00'),
      at(25534200, '2026-07-14 23:35:11+00:00'),
      at(25534202, '2026-07-14 23:35:35+00:00'),
      at(25534201, '2026-07-14 23:35:23+00:00'),
    ])
    expect(stats.blockCount).toBe(3)
    expect(stats.blockMin).toBe(25534200)
    expect(stats.blockMax).toBe(25534202)
  })

  it('reports the earliest and latest timestamps, not just the last row seen', () => {
    const stats = computeStats([
      at(25534202, '2026-07-14 23:35:35+00:00'),
      at(25534200, '2026-07-14 23:35:11+00:00'),
    ])
    expect(stats.timeStart).toBe('2026-07-14 23:35:11+00:00')
    expect(stats.timeEnd).toBe('2026-07-14 23:35:35+00:00')
  })

  it('is empty-safe', () => {
    const stats = computeStats([])
    expect(stats.blockCount).toBe(0)
    expect(stats.blockMin).toBeNull()
    expect(stats.blockMax).toBeNull()
    expect(stats.timeStart).toBeNull()
  })
})
```

If `computeStats.test.ts` has no reusable `baseRecord`, add one at the top of the file — a full 34-field `EthRecord` with `is_token_transfer: false`, `transaction_hash: '0xab11'`, and every nullable field `null`. Reuse whatever fixture helper the existing tests already define if one is present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/stats/computeStats.test.ts`
Expected: FAIL — `blockCount` is `undefined`.

- [ ] **Step 3: Update `computeStats`**

In `src/features/stats/computeStats.ts`, replace the two block fields in the `DatasetStats` interface (lines 13–14):

```ts
  /** Distinct blocks present — reported rather than `blockMax - blockMin + 1`, so a
   *  dataset with gaps is described honestly. */
  blockCount: number
  blockMin: number | null
  blockMax: number | null
  timeStart: string | null
  timeEnd: string | null
```

Replace the two accumulator declarations (lines 28–29):

```ts
  const blocks = new Set<number>()
  let blockMin: number | null = null
  let blockMax: number | null = null
  let timeStart: string | null = null
  let timeEnd: string | null = null
```

Replace the per-record block branch (lines 63–66):

```ts
    blocks.add(r.block_number)
    if (blockMin === null || r.block_number < blockMin) blockMin = r.block_number
    if (blockMax === null || r.block_number > blockMax) blockMax = r.block_number
    // ISO-8601 with a fixed +00:00 offset sorts correctly as a plain string, so no Date
    // parsing (and no timezone reinterpretation) is needed here.
    if (r.block_timestamp !== '') {
      if (timeStart === null || r.block_timestamp < timeStart) timeStart = r.block_timestamp
      if (timeEnd === null || r.block_timestamp > timeEnd) timeEnd = r.block_timestamp
    }
```

Replace the two return fields (lines 95–96):

```ts
    blockCount: blocks.size,
    blockMin,
    blockMax,
    timeStart,
    timeEnd,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/stats/computeStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the stats tile**

In `src/features/stats/StatsBand.tsx`, replace the sixth tile (lines 88–96):

```tsx
      <div className="stat-tile">
        <span className="stat-tile__label">Blocks</span>
        <span className="stat-tile__value">{fmtInt(stats.blockCount)}</span>
        <span className="stat-tile__sub">
          {stats.blockMin != null && stats.blockMax != null
            ? `${fmtInt(stats.blockMin)}–${fmtInt(stats.blockMax)}`
            : ' '}
        </span>
      </div>
```

- [ ] **Step 6: Update the header badge**

In `src/components/Header.tsx`, replace the props interface and the badge:

```tsx
interface HeaderProps {
  /** Distinct blocks in the loaded dataset. */
  blockCount: number
  blockMin: number | null
  blockMax: number | null
  /** Formatted time span, shown on hover. */
  timeRange: string | null
  children?: ReactNode // right-side slot: global search etc.
}
```

```tsx
export function Header({ blockCount, blockMin, blockMax, timeRange, children }: HeaderProps) {
```

```tsx
      {blockCount > 0 && blockMin != null && blockMax != null && (
        <span className="block-badge" title={timeRange ?? undefined}>
          <span className="block-badge__dot" aria-hidden="true" />
          {/* Reports the block *count* alongside the range: with a gap in the export,
              "100 blocks · 25,534,200–25,534,299" stays true where a bare range wouldn't. */}
          {blockCount === 1
            ? `Block #${blockMin.toLocaleString('en-US')}`
            : `${blockCount.toLocaleString('en-US')} blocks · ${blockMin.toLocaleString('en-US')}–${blockMax.toLocaleString('en-US')}`}
        </span>
      )}
```

- [ ] **Step 7: Update the export filename**

In `src/features/export/ExportButton.tsx`, replace the `blockNumber` prop (lines 12–16):

```tsx
  /** Derived by the caller (App.tsx) from the loaded dataset — never hard-coded here. */
  blockMin: number | null
  blockMax: number | null
}

export function ExportButton({ table, tab, blockMin, blockMax }: ExportButtonProps) {
```

and the filename line (line 62):

```ts
    const blockPart =
      blockMin == null || blockMax == null
        ? 'eth'
        : blockMin === blockMax
          ? `eth-block${blockMin}`
          : `eth-blocks${blockMin}-${blockMax}`
    const filename = `${blockPart}-${tab}-${records.length}rows.csv`
```

- [ ] **Step 8: Type-check**

Run: `npm run build`
Expected: FAIL — `App.tsx` still passes `blockNumber`/`blockTime`. That is Task 11; leave it.

- [ ] **Step 9: Commit**

```bash
git add src/features/stats src/components/Header.tsx src/features/export/ExportButton.tsx
git commit -m "feat: report block range instead of a single block in stats, header, export"
```

---

### Task 10: `block_number` column in the curated tabs

**Files:**
- Modify: `src/features/table/columns.tsx`
- Test: `src/features/table/columns.test.ts`

**Interfaces:**
- Consumes: `header`, `filterFor`, `NumberCell` — all already in `columns.tsx`.
- Produces: transfers tab = 10 columns, transactions tab = 11 columns.

`block_number`'s dictionary `kind` is already `'number'`, so `filterFnForKind` returns `'range'` — the range filter arrives with no new filter code.

- [ ] **Step 1: Write the failing test**

In `src/features/table/columns.test.ts`, update the two curated-tab tests:

```ts
  it("'transfers' returns the 10 curated transfer columns, in the spec'd order", () => {
    const defs = getColumnsForTab('transfers')
    expect(defs).toHaveLength(10)
    expect(fields(defs)).toEqual([
      'block_timestamp',
      'block_number',
      'transaction_hash',
      'event_type',
      'address',
      'from_address',
      'to_address',
      'quantity',
      'token_id',
      'event_index',
    ])
  })

  it("'transactions' returns the 11 curated transaction columns, in the spec'd order", () => {
    const defs = getColumnsForTab('transactions')
    expect(defs).toHaveLength(11)
    expect(fields(defs)).toEqual([
      'block_timestamp',
      'block_number',
      'transaction_index',
      'transaction_hash',
      'from_address_tx',
      'to_address_tx',
      'value_lossless_tx',
      'gas_price_tx',
      'gas_tx',
      'nonce_tx',
      'type_tx',
    ])
  })
```

and add a new test to the same `describe`:

```ts
  it('block_number is range-filterable on both curated tabs and on all', () => {
    for (const tab of ['transfers', 'transactions', 'all'] as const) {
      const def = getColumnsForTab(tab).find(
        (d) => 'accessorKey' in d && d.accessorKey === 'block_number',
      )
      expect(def, `block_number missing from the ${tab} tab`).toBeDefined()
      expect(def?.filterFn).toBe('range')
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/table/columns.test.ts`
Expected: FAIL — transfers has 9 columns, not 10.

- [ ] **Step 3: Add the column to both curated tabs**

In `src/features/table/columns.tsx`, insert immediately after the `block_timestamp` accessor in `transferColumns` (after line 124):

```tsx
  helper.accessor('block_number', {
    header: header('transfers', 'block_number'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('block_number'),
  }),
```

and the equivalent in `transactionColumns` (after line 175):

```tsx
  helper.accessor('block_number', {
    header: header('transactions', 'block_number'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('block_number'),
  }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/table/columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/table/columns.tsx src/features/table/columns.test.ts
git commit -m "feat: block column on the transfers and transactions tabs"
```

---

### Task 11: Debounced search, load progress, App wiring

**Files:**
- Create: `src/hooks/useDebouncedValue.ts`, `src/hooks/useDebouncedValue.test.ts`
- Modify: `src/App.tsx`, `src/components/States.tsx`, `src/components/states.css`

**Interfaces:**
- Consumes: `csvProvider(url, onProgress)` (Task 6); the new `DatasetStats`, `HeaderProps`, `ExportButtonProps` (Task 9).
- Produces: `useDebouncedValue<T>(value: T, delayMs: number): T`; `LoadingState` accepting `{ loaded?: number; total?: number | null }`.

- [ ] **Step 1: Write the failing hook test**

Create `src/hooks/useDebouncedValue.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedValue } from './useDebouncedValue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 200))
    expect(result.current).toBe('a')
  })

  it('holds the old value until the delay elapses', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'b' })
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(199))
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('b')
  })

  it('only emits the last value in a burst', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'ab' })
    act(() => vi.advanceTimersByTime(100))
    rerender({ v: 'abc' })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe('abc')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks/useDebouncedValue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

Create `src/hooks/useDebouncedValue.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * Trailing-edge debounce. Global search runs a substring match across 34 fields of every
 * loaded record — ~2.5M string operations per keystroke on the 74,889-row dataset — so the
 * input keeps its own immediate state and the *table* consumes this delayed value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/hooks/useDebouncedValue.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add progress to LoadingState**

In `src/components/States.tsx`, change the `LoadingState` signature and add a progress bar above the skeleton stats:

```tsx
interface LoadingStateProps {
  /** Bytes downloaded so far, when the provider is reporting progress. */
  loaded?: number
  /** Total bytes, or null when the response had no Content-Length. */
  total?: number | null
}

export function LoadingState({ loaded, total }: LoadingStateProps = {}) {
  const pct = loaded != null && total != null && total > 0 ? Math.min(100, (loaded / total) * 100) : null
  const label =
    loaded == null
      ? 'Loading dataset'
      : pct != null
        ? `Downloading dataset — ${Math.round(pct)}%`
        : `Downloading dataset — ${(loaded / 1_000_000).toFixed(1)} MB`

  return (
    <div className="loading-state" role="status" aria-live="polite" aria-label={label}>
      {loaded != null && (
        <div className="loading-state__progress">
          <div
            className="loading-state__progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct != null ? Math.round(pct) : undefined}
          >
            <span
              className="loading-state__progress-fill"
              style={pct != null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <span className="loading-state__progress-label">{label}</span>
        </div>
      )}
      <section className="loading-state__stats" aria-hidden="true">
```

The rest of the function body is unchanged.

- [ ] **Step 6: Add the progress styles**

Append to `src/components/states.css`:

```css
.loading-state__progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 18px;
}

.loading-state__progress-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--surface-2, rgba(127, 127, 127, 0.18));
  overflow: hidden;
}

.loading-state__progress-fill {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 2px;
  background: var(--accent);
  transition: width 120ms linear;
}

.loading-state__progress-label {
  color: var(--text-muted);
  font-size: 11px;
}
```

- [ ] **Step 7: Wire App.tsx**

In `src/App.tsx`:

Delete the `latestBlock` helper (lines 25–32) and the `latest` memo (lines 167–170) — `stats` now carries the block range, so the extra full-array scan goes away.

Add to the imports:

```tsx
import { useDebouncedValue } from './hooks/useDebouncedValue'
```

Add progress state beside the other state hooks:

```tsx
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
```

Replace the load effect's provider call (line 138) so it reports progress, and reset progress at the start of each attempt (beside the existing `setMalformedNoticeDismissed(false)`):

```tsx
    setProgress(null)
    csvProvider('/data/rows.csv.gz', (loaded, total) => {
      if (!cancelled) setProgress({ loaded, total })
    })
      .load()
```

Add the debounced search value next to the existing `globalFilter` state (line 59):

```tsx
  // The input stays on `globalFilter` (instant feedback while typing); the *table* consumes
  // `debouncedFilter`, so a burst of keystrokes costs one filter pass, not one per character.
  const debouncedFilter = useDebouncedValue(globalFilter, 200)
```

Update the four render sites:

```tsx
        <Header
          blockCount={stats?.blockCount ?? 0}
          blockMin={stats?.blockMin ?? null}
          blockMax={stats?.blockMax ?? null}
          timeRange={
            stats?.timeStart != null && stats.timeEnd != null
              ? `${formatTimestamp(stats.timeStart)} – ${formatTimestamp(stats.timeEnd)}`
              : null
          }
        >
```

```tsx
          {state.status === 'loading' && (
            <LoadingState loaded={progress?.loaded} total={progress?.total} />
          )}
```

```tsx
                {table && (
                  <ExportButton
                    table={table}
                    tab={activeTab}
                    blockMin={stats?.blockMin ?? null}
                    blockMax={stats?.blockMax ?? null}
                  />
                )}
```

```tsx
              <DataTable
                records={tabRecords}
                tab={activeTab}
                onTableReady={handleTableReady}
                globalFilter={debouncedFilter}
                onGlobalFilterChange={setGlobalFilter}
              />
```

`GlobalSearchInput` keeps `value={globalFilter}` — that is what makes typing instant.

- [ ] **Step 8: Fix the DataTable filter-reset guard**

`DataTable` reads `globalFilter` for its `hasActiveFilters` flag. It now receives the debounced value, which is correct — the empty state should describe the view the table is actually showing. No change needed; confirm by reading `src/features/table/DataTable.tsx:180`.

- [ ] **Step 9: Run the full suite and type-check**

Run: `npm test && npm run build`
Expected: all PASS, type-check clean.

- [ ] **Step 10: Commit**

```bash
git add src/App.tsx src/hooks src/components/States.tsx src/components/states.css
git commit -m "feat: debounced global search and real download progress"
```

---

### Task 12: Generate artifacts, remove the old dataset, rewrite the README

**Files:**
- Delete: `analytics_25534300.csv`, `public/data/analytics_25534300.csv`
- Create (generated, committed): `public/data/rows.csv.gz`, `public/data/calldata/*.json.gz`, `public/data/dataset.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a running app on the real dataset.

- [ ] **Step 1: Generate the real artifacts**

```bash
npm run data:prep analytics_25534200_25534299.csv
```

Expected console tail: `rows 74,889 (0 skipped)`, `blocks 25534200–25534299`, `calldata 12,220 tx across 256 shards`. This takes several minutes — the source is 2.19 GB.

- [ ] **Step 2: Verify the artifacts**

```bash
cat public/data/dataset.json
ls public/data/calldata | wc -l
du -sh public/data
```

Expected: `"rows": 74889`, `"columns": 34`, `"blockMin": 25534200`, `"blockMax": 25534299`, `"calldataTransactions": 12220`; 256 shard files; total under ~30 MB.

If `rows` is not 74,889, stop and diagnose before continuing — every downstream number in the README depends on it.

- [ ] **Step 3: Delete the old dataset**

```bash
git rm analytics_25534300.csv public/data/analytics_25534300.csv
```

- [ ] **Step 4: Run the app against the real data**

```bash
npm run dev
```

Check by hand, and fix anything that fails before committing:
1. The header badge reads `100 blocks · 25,534,200–25,534,299`.
2. The Blocks stat tile reads `100` with the range beneath it.
3. Transfers and Transactions tabs both show a **Block** column, sortable, with a working min/max range filter.
4. Expanding a row shows **Input Data** as `Loading…` then a value; a plain-transfer row shows `0x`.
5. The dictionary panel lists 35 fields; `input_tx` shows "Fetched on demand", not a 0% fill bar.
6. Export → "All 34 columns" downloads `eth-blocks25534200-25534299-transfers-<n>rows.csv`.
7. Typing in global search stays responsive.

- [ ] **Step 5: Rewrite the README**

Update `README.md` for the new dataset and pipeline. Replace the intro, "Dataset provenance", and "Architecture" sections, and add a "Data pipeline" section. The facts that must be right:

- 74,889 rows across 100 blocks, 25,534,200–25,534,299, spanning 19m 48s on 2026-07-14 (23:35:11–23:54:59 UTC)
- 43,941 token transfers, 30,948 transactions
- 35 documented fields; **34 loaded in the browser**; `input_tx` fetched per row
- the source export is 2.19 GB, gitignored, and 96.9% of it is `input_tx`
- `npm run data:prep <source.csv>` regenerates `public/data/`
- `access_list_tx` whitespace is collapsed by the prep script (cosmetic normalization of a Python repr)
- `DecompressionStream` requires Chrome 80+ / Firefox 113+ / Safari 16.4+
- the architecture diagram's data-source line becomes:

```
analytics_*.csv (2.19 GB, gitignored)
        │  npm run data:prep
        ▼
public/data/rows.csv.gz          ← 74,889 rows × 34 columns
public/data/calldata/<xx>.json.gz ← input_tx, per transaction
        │
src/data/csvProvider.ts     ← fetch + gunzip + PapaParse + interning
src/data/calldataProvider.ts ← lazy per-row calldata
```

Also update the test-count sentence at the end to match `npm test` output.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build && npm run lint`
Expected: all PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add -A public/data README.md
git add -u
git commit -m "feat: ship the 100-block dataset, retire the single-block export"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: prep script + sharding + `access_list_tx` normalization → Tasks 1–2; `availability` / `LOADED_COLUMNS` / the `input_tx` split → Tasks 3–4; gzip sniffing + interning + loading → Tasks 5–6; `CalldataProvider` → Task 7; async row-detail field → Task 8; block dimension in stats/header/export → Task 9; `block_number` column → Task 10; debounced search + load progress → Task 11; artifact generation, old-dataset removal, README → Task 12. The spec's *contingent* item (memoizing `toBigInt`) is deliberately not a task — it is gated on measurement, per the spec.

**Type consistency.** `DictionaryField`, `LoadedColumnMeta`, `LOADED_COLUMNS`, `ProgressCallback`, `CalldataProvider`, `calldataShard`, `decodeMaybeGzipped`, `isGzipped`, `useDebouncedValue` are each defined once and referenced with the same name and signature everywhere after. `shardKey` (Task 1, `.mjs`) and `calldataShard` (Task 7, `.ts`) are intentionally two implementations of one scheme; both tasks' tests pin the same cases, and each file's comment names the other as its counterpart.

**Known cross-task breakage, by design.** Task 9 Step 8 leaves `npm run build` failing because `App.tsx` still passes the old `Header`/`ExportButton` props; Task 11 Step 7 repairs it. This is called out in both tasks so a reviewer doesn't treat it as a defect.

# Ethereum Dataset Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A design-forward React SPA that presents `analytics_25534300.csv` (600 Ethereum records: transactions + token transfers) with sorting, per-column filtering, CSV export of the current view, and a column data dictionary.

**Architecture:** Vite + React 18 + TypeScript SPA. A `data/` layer (PapaParse CSV provider behind a `DataProvider` seam for the future BigQuery API) feeds TanStack Table (headless) UI. Dual themes via CSS custom properties, dark default.

**Tech Stack:** Vite 5, React 18, TypeScript 5, @tanstack/react-table 8, PapaParse 5, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-07-22-ethereum-dataset-explorer-design.md`

## Global Constraints

- Big numbers (`value_lossless_tx`, `quantity`, wei values) must never go through `parseFloat`/`Number` for logic — BigInt or string compare only. Display rounding is fine.
- CSV must be parsed with PapaParse — records span multiple physical lines; never line-split.
- Empty CSV cells become `null` in `EthRecord`, never `''` or `undefined`.
- Both themes (dark default) must be deliberately styled; monospace (`'JetBrains Mono', ui-monospace, monospace`) for all on-chain data (hashes, addresses, values); `'Inter', system-ui, sans-serif` for UI chrome.
- Malformed CSV rows are counted and surfaced, never silently dropped.
- Block number/timestamp shown in UI must derive from data, never hard-coded.
- UI text is English. App title: **"Ethereum Dataset Explorer"**.
- Executors MUST invoke the `frontend-design` skill before styling tasks (Task 5 onward) and the `dataviz` skill before Task 7 (stats band).
- Commit after every task (messages given per task).

---

### Task 1: Project scaffold

**Files:**
- Create: Vite scaffold at repo root (`package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`)
- Create: `public/data/analytics_25534300.csv` (copy of root CSV)
- Test: `src/smoke.test.ts`

**Interfaces:**
- Produces: running dev server, `npm test` (Vitest), CSV served at `/data/analytics_25534300.csv`.

- [ ] **Step 1: Scaffold Vite app in repo root**

```powershell
npm create vite@latest . -- --template react-ts
npm install
npm install @tanstack/react-table papaparse
npm install -D vitest @types/papaparse jsdom @testing-library/react @testing-library/jest-dom
```

(If `npm create vite` refuses a non-empty dir, scaffold into `tmp-scaffold/`, move contents up, delete `tmp-scaffold/`.)

- [ ] **Step 2: Configure Vitest**

In `vite.config.ts`:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
```

Add to `package.json` scripts: `"test": "vitest run", "test:watch": "vitest"`.

- [ ] **Step 3: Copy the dataset into public assets**

```powershell
New-Item -ItemType Directory -Force public/data
Copy-Item analytics_25534300.csv public/data/analytics_25534300.csv
```

- [ ] **Step 4: Smoke test**

`src/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npm test` → PASS.
Run: `npm run dev` → Vite serves; `npm run build` → succeeds.

- [ ] **Step 5: Clean template cruft**

Delete `src/assets/react.svg`, `public/vite.svg`; empty out `src/App.css` and `src/index.css` (keep files); `src/App.tsx` renders `<h1>Ethereum Dataset Explorer</h1>` only. Set `<title>Ethereum Dataset Explorer</title>` and `<html lang="en">` in `index.html`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite + React + TS app with Vitest and dataset asset"
```

---

### Task 2: Record types + column dictionary

**Files:**
- Create: `src/data/types.ts`, `src/data/dictionary.ts`
- Test: `src/data/dictionary.test.ts`

**Interfaces:**
- Produces:
  - `EthRecord` — 35-field interface (below), `RowKind = 'transfer' | 'transaction'`
  - `COLUMNS: ColumnMeta[]` (ordered as in CSV), `getColumnMeta(field: string): ColumnMeta | undefined`
  - `ColumnMeta = { field: keyof EthRecord; label: string; description: string; source: 'token_transfers' | 'transactions' | 'both' | 'derived'; kind: 'hex' | 'address' | 'number' | 'bignum' | 'timestamp' | 'enum' | 'boolean' | 'text' }`

- [ ] **Step 1: Write `src/data/types.ts`**

```ts
/** One row of the merged BigQuery export (token_transfers ⟕ transactions). */
export interface EthRecord {
  block_hash: string
  block_number: number
  block_timestamp: string
  transaction_hash: string
  transaction_index: number
  // token_transfers fields — null on plain-transaction rows
  event_index: number | null
  batch_index: number | null
  address: string | null
  event_type: string | null
  event_hash: string | null
  event_signature: string | null
  operator_address: string | null
  from_address: string | null
  to_address: string | null
  token_id: string | null
  quantity: string | null // big integer as string
  removed: boolean | null
  // transactions fields — may be null on transfer rows
  nonce_tx: number | null
  from_address_tx: string | null
  to_address_tx: string | null
  value_tx: string | null // wei, may carry trailing ".0"
  value_lossless_tx: string | null // wei, full 256-bit precision, string
  gas_tx: number | null
  gas_price_tx: string | null // wei
  input_tx: string | null
  max_fee_per_gas_tx: string | null
  max_priority_fee_per_gas_tx: string | null
  type_tx: number | null
  chain_id_tx: number | null
  access_list_tx: string | null
  r_tx: string | null
  s_tx: string | null
  v_tx: string | null
  y_parity_tx: string | null
  is_token_transfer: boolean
}

export type RowKind = 'transfer' | 'transaction'

export function rowKind(r: EthRecord): RowKind {
  return r.is_token_transfer ? 'transfer' : 'transaction'
}
```

- [ ] **Step 2: Write failing dictionary test**

`src/data/dictionary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { COLUMNS, getColumnMeta } from './dictionary'

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
})
```

Run: `npm test` → FAIL (`./dictionary` not found).

- [ ] **Step 3: Write `src/data/dictionary.ts`**

Descriptions verbatim from the PDF ("Ethereum Dataset.pdf"). `label` is a short human header (e.g. `block_timestamp` → "Time", `from_address_tx` → "From (tx)").

```ts
import type { EthRecord } from './types'

export interface ColumnMeta {
  field: keyof EthRecord
  label: string
  description: string
  source: 'token_transfers' | 'transactions' | 'both' | 'derived'
  kind: 'hex' | 'address' | 'number' | 'bignum' | 'timestamp' | 'enum' | 'boolean' | 'text'
}

export const COLUMNS: ColumnMeta[] = [
  { field: 'block_hash', label: 'Block Hash', description: 'Hash of the block this event was emitted from.', source: 'both', kind: 'hex' },
  { field: 'block_number', label: 'Block', description: 'Number of the block this event was emitted from.', source: 'both', kind: 'number' },
  { field: 'block_timestamp', label: 'Time', description: 'Unix timestamp when the block was added to the blockchain.', source: 'both', kind: 'timestamp' },
  { field: 'transaction_hash', label: 'Tx Hash', description: 'Hash of the transaction this event was emitted from.', source: 'both', kind: 'hex' },
  { field: 'transaction_index', label: 'Tx Index', description: "The transaction's index position in the block.", source: 'both', kind: 'number' },
  { field: 'event_index', label: 'Event Index', description: "The event's index position in the block.", source: 'token_transfers', kind: 'number' },
  { field: 'batch_index', label: 'Batch Index', description: "The transfer's position in the batch transfer event.", source: 'token_transfers', kind: 'number' },
  { field: 'address', label: 'Token Contract', description: 'Address from which this event originated.', source: 'token_transfers', kind: 'address' },
  { field: 'event_type', label: 'Standard', description: 'Token standard that matches the event.', source: 'token_transfers', kind: 'enum' },
  { field: 'event_hash', label: 'Event Hash', description: 'Keccak hash of the event signature.', source: 'token_transfers', kind: 'hex' },
  { field: 'event_signature', label: 'Event Signature', description: 'Function signature of the event.', source: 'token_transfers', kind: 'text' },
  { field: 'operator_address', label: 'Operator', description: 'Address of the transfer operator.', source: 'token_transfers', kind: 'address' },
  { field: 'from_address', label: 'From', description: 'Address of the previous owner of the token(s).', source: 'token_transfers', kind: 'address' },
  { field: 'to_address', label: 'To', description: 'Address of the new owner of the token(s).', source: 'token_transfers', kind: 'address' },
  { field: 'token_id', label: 'Token ID', description: 'Identifier of the token(s) being transferred.', source: 'token_transfers', kind: 'bignum' },
  { field: 'quantity', label: 'Quantity', description: 'Quantity of tokens being transferred.', source: 'token_transfers', kind: 'bignum' },
  { field: 'removed', label: 'Removed', description: 'Whether or not the event was orphaned off the main chain.', source: 'token_transfers', kind: 'boolean' },
  { field: 'nonce_tx', label: 'Nonce', description: 'Number of transactions made by the sender prior to this one.', source: 'transactions', kind: 'number' },
  { field: 'from_address_tx', label: 'From (tx)', description: 'Address of the sender of the transaction.', source: 'transactions', kind: 'address' },
  { field: 'to_address_tx', label: 'To (tx)', description: 'Address of the receiver of the transaction.', source: 'transactions', kind: 'address' },
  { field: 'value_tx', label: 'Value', description: 'Value transferred in Wei. A decimal number represented as a BIGNUMERIC to preserve up to 128-bit numeric precision.', source: 'transactions', kind: 'bignum' },
  { field: 'value_lossless_tx', label: 'Value (lossless)', description: 'Value transferred in Wei. A decimal number represented in STRING format to preserve full 256-bit numeric precision.', source: 'transactions', kind: 'bignum' },
  { field: 'gas_tx', label: 'Gas Limit', description: 'Quantity of gas units provided by the sender of the transaction.', source: 'transactions', kind: 'number' },
  { field: 'gas_price_tx', label: 'Gas Price', description: 'Price per gas unit provided by the sender of the transaction in Wei.', source: 'transactions', kind: 'bignum' },
  { field: 'input_tx', label: 'Input Data', description: 'Data sent along with the transaction, with a maximum size of 32 bytes.', source: 'transactions', kind: 'hex' },
  { field: 'max_fee_per_gas_tx', label: 'Max Fee/Gas', description: 'Maximum fee per unit of gas for this transaction.', source: 'transactions', kind: 'bignum' },
  { field: 'max_priority_fee_per_gas_tx', label: 'Max Priority Fee/Gas', description: 'Maximum priority fee per unit of gas for this transaction.', source: 'transactions', kind: 'bignum' },
  { field: 'type_tx', label: 'Tx Type', description: 'Type of the transaction.', source: 'transactions', kind: 'enum' },
  { field: 'chain_id_tx', label: 'Chain ID', description: 'Chain ID used in transaction signing.', source: 'transactions', kind: 'number' },
  { field: 'access_list_tx', label: 'Access List', description: 'List of addresses and storage keys that the transaction plans to access and has pre-paid gas for.', source: 'transactions', kind: 'text' },
  { field: 'r_tx', label: 'Sig r', description: 'ECDSA signature r.', source: 'transactions', kind: 'hex' },
  { field: 's_tx', label: 'Sig s', description: 'ECDSA signature s.', source: 'transactions', kind: 'hex' },
  { field: 'v_tx', label: 'Sig v', description: 'ECDSA signature v.', source: 'transactions', kind: 'hex' },
  { field: 'y_parity_tx', label: 'Sig y-parity', description: 'ECDSA signature y_parity.', source: 'transactions', kind: 'hex' },
  { field: 'is_token_transfer', label: 'Token Transfer?', description: 'Indicates whether the row represents a token transfer or a non-token transaction.', source: 'derived', kind: 'boolean' },
]

const byField = new Map(COLUMNS.map((c) => [c.field as string, c]))

export function getColumnMeta(field: string): ColumnMeta | undefined {
  return byField.get(field)
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data
git commit -m "feat: EthRecord type and column dictionary from PDF docs"
```

---

### Task 3: Value transforms (wei/gwei/timestamps/hex/compare)

**Files:**
- Create: `src/data/transform.ts`
- Test: `src/data/transform.test.ts`

**Interfaces:**
- Produces:
  - `weiToEth(wei: string | null): string | null` — 18-dec division, ≤6 fractional digits shown, trailing zeros trimmed
  - `weiToGwei(wei: string | null): string | null` — 9-dec division, ≤2 fractional digits
  - `formatTimestamp(ts: string): string` — `"2026-07-14 23:55:11+00:00"` → `"2026-07-14 23:55:11 UTC"`
  - `truncateHex(hex: string, lead?: number, tail?: number): string` — `0x0058…6fc5` (lead 6 incl. 0x, tail 4, `…`)
  - `formatBigInt(v: string | null): string | null` — thousands separators on integer strings
  - `compareNumericStrings(a: string | null, b: string | null): number` — BigInt-safe, nulls sort last
  - `toBigInt(v: string | null): bigint | null` — strips trailing `.…` decimal part (`"84858226069838.0"` → `84858226069838n`)

- [ ] **Step 1: Write failing tests**

`src/data/transform.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  weiToEth, weiToGwei, formatTimestamp, truncateHex,
  formatBigInt, compareNumericStrings, toBigInt,
} from './transform'

describe('toBigInt', () => {
  it('parses plain integer strings', () => expect(toBigInt('123')).toBe(123n))
  it('strips BigQuery trailing decimals', () => expect(toBigInt('84858226069838.0')).toBe(84858226069838n))
  it('handles 256-bit values losslessly', () =>
    expect(toBigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935'))
      .toBe(2n ** 256n - 1n))
  it('returns null for null/empty', () => {
    expect(toBigInt(null)).toBeNull()
    expect(toBigInt('')).toBeNull()
  })
})

describe('weiToEth', () => {
  it('converts wei to ETH', () => expect(weiToEth('1000000000000000000')).toBe('1'))
  it('shows up to 6 decimals, trimmed', () => expect(weiToEth('84858226069838.0')).toBe('0.000084'))
  it('handles zero', () => expect(weiToEth('0')).toBe('0'))
  it('null passthrough', () => expect(weiToEth(null)).toBeNull())
})

describe('weiToGwei', () => {
  it('converts wei to gwei with ≤2 decimals', () => expect(weiToGwei('2063407496')).toBe('2.06'))
  it('whole gwei has no decimals', () => expect(weiToGwei('2000000000')).toBe('2'))
})

describe('formatTimestamp', () => {
  it('renders UTC human form', () =>
    expect(formatTimestamp('2026-07-14 23:55:11+00:00')).toBe('2026-07-14 23:55:11 UTC'))
})

describe('truncateHex', () => {
  it('truncates long hex', () =>
    expect(truncateHex('0x0058db6926d4d88a6595b82e177bdcb2be8579b96e895ceaa90e7cbfce236fc5'))
      .toBe('0x0058…6fc5'))
  it('leaves short values alone', () => expect(truncateHex('0x1')).toBe('0x1'))
})

describe('formatBigInt', () => {
  it('adds thousands separators', () => expect(formatBigInt('25534300')).toBe('25,534,300'))
  it('null passthrough', () => expect(formatBigInt(null)).toBeNull())
})

describe('compareNumericStrings', () => {
  it('compares as numbers not strings', () =>
    expect(compareNumericStrings('9', '10')).toBeLessThan(0))
  it('handles 256-bit values', () =>
    expect(compareNumericStrings('115792089237316195423570985008687907853269984665640564039457584007913129639935', '1'))
      .toBeGreaterThan(0))
  it('sorts nulls last', () => {
    expect(compareNumericStrings(null, '0')).toBeGreaterThan(0)
    expect(compareNumericStrings('0', null)).toBeLessThan(0)
  })
})
```

Run: `npm test` → FAIL (`./transform` not found).

- [ ] **Step 2: Implement `src/data/transform.ts`**

```ts
const WEI_PER_ETH = 10n ** 18n
const WEI_PER_GWEI = 10n ** 9n

/** Parse a BigQuery numeric string ("123", "123.0") to bigint. Null-safe. */
export function toBigInt(v: string | null): bigint | null {
  if (v == null || v.trim() === '') return null
  const dot = v.indexOf('.')
  const intPart = dot === -1 ? v : v.slice(0, dot)
  try {
    return BigInt(intPart)
  } catch {
    return null
  }
}

function divToDecimal(wei: bigint, divisor: bigint, maxFrac: number): string {
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const whole = abs / divisor
  const fracDigits = divisor.toString().length - 1
  const frac = (abs % divisor).toString().padStart(fracDigits, '0').slice(0, maxFrac).replace(/0+$/, '')
  const s = frac ? `${whole}.${frac}` : whole.toString()
  return neg ? `-${s}` : s
}

export function weiToEth(wei: string | null): string | null {
  const w = toBigInt(wei)
  return w == null ? null : divToDecimal(w, WEI_PER_ETH, 6)
}

export function weiToGwei(wei: string | null): string | null {
  const w = toBigInt(wei)
  return w == null ? null : divToDecimal(w, WEI_PER_GWEI, 2)
}

/** "2026-07-14 23:55:11+00:00" → "2026-07-14 23:55:11 UTC" */
export function formatTimestamp(ts: string): string {
  return ts.replace(/\+00:00$/, ' UTC')
}

export function truncateHex(hex: string, lead = 6, tail = 4): string {
  if (hex.length <= lead + tail + 1) return hex
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`
}

export function formatBigInt(v: string | null): string | null {
  const b = toBigInt(v)
  if (b == null) return null
  return b.toLocaleString('en-US')
}

/** Numeric-aware comparator for BigQuery numeric strings. Nulls sort last. */
export function compareNumericStrings(a: string | null, b: string | null): number {
  const ba = toBigInt(a)
  const bb = toBigInt(b)
  if (ba == null && bb == null) return 0
  if (ba == null) return 1
  if (bb == null) return -1
  return ba < bb ? -1 : ba > bb ? 1 : 0
}
```

- [ ] **Step 3: Run tests** — `npm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/data
git commit -m "feat: BigInt-safe numeric transforms and formatters"
```

---

### Task 4: CSV data provider

**Files:**
- Create: `src/data/provider.ts`, `src/data/csvProvider.ts`
- Test: `src/data/csvProvider.test.ts`

**Interfaces:**
- Consumes: `EthRecord` (Task 2).
- Produces:
  - `DataProvider = { load(): Promise<LoadResult> }`
  - `LoadResult = { records: EthRecord[]; malformedCount: number }`
  - `csvProvider(url?: string): DataProvider` (default url `/data/analytics_25534300.csv`)
  - `parseCsv(csvText: string): LoadResult` — pure, testable core

- [ ] **Step 1: Write failing tests**

`src/data/csvProvider.test.ts` (fixture is a real header + rows trimmed from the dataset):

```ts
import { describe, it, expect } from 'vitest'
import { parseCsv } from './csvProvider'

const HEADER =
  'block_hash,block_number,block_timestamp,transaction_hash,transaction_index,event_index,batch_index,address,event_type,event_hash,event_signature,operator_address,from_address,to_address,token_id,quantity,removed,nonce_tx,from_address_tx,to_address_tx,value_tx,value_lossless_tx,gas_tx,gas_price_tx,input_tx,max_fee_per_gas_tx,max_priority_fee_per_gas_tx,type_tx,chain_id_tx,access_list_tx,r_tx,s_tx,v_tx,y_parity_tx,is_token_transfer'

const TX_ROW =
  '0xc779,25534300,2026-07-14 23:55:11+00:00,0x0058,16,,,,,,,,,,,,,0,0x96c9,0xc21e,84858226069838.0,84858226069838,21165,2063407496,0x,2074059419.0,2004776381.0,2,1,[],0x6a61,0x2a2b,0x1,0x1,False'

const TRANSFER_ROW =
  '0xc779,25534300,2026-07-14 23:55:11+00:00,0xdac1,5,0,0,0xa0b8,ERC-20,0xddf2,"Transfer(address,address,uint256)",,0x5875,0x0000,,146000000,False,84719,0x5875,0x0000,0,0,449891,58631115,0x09c5,123000000.0,0.0,2,1,[],0x7213,0x7e27,0x0,0x0,True'

describe('parseCsv', () => {
  it('parses transaction rows: empty transfer fields → null', () => {
    const { records } = parseCsv(`${HEADER}\n${TX_ROW}`)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.is_token_transfer).toBe(false)
    expect(r.block_number).toBe(25534300)
    expect(r.transaction_index).toBe(16)
    expect(r.event_type).toBeNull()
    expect(r.quantity).toBeNull()
    expect(r.value_lossless_tx).toBe('84858226069838')
    expect(r.gas_tx).toBe(21165)
  })

  it('parses transfer rows incl. quoted signature with commas', () => {
    const { records } = parseCsv(`${HEADER}\n${TRANSFER_ROW}`)
    const r = records[0]
    expect(r.is_token_transfer).toBe(true)
    expect(r.event_type).toBe('ERC-20')
    expect(r.event_signature).toBe('Transfer(address,address,uint256)')
    expect(r.quantity).toBe('146000000')
    expect(r.removed).toBe(false)
  })

  it('skips blank lines between records', () => {
    const { records, malformedCount } = parseCsv(`${HEADER}\n\n${TX_ROW}\n\n${TRANSFER_ROW}\n`)
    expect(records).toHaveLength(2)
    expect(malformedCount).toBe(0)
  })

  it('counts malformed rows instead of dropping silently', () => {
    const bad = 'not,enough,fields'
    const { records, malformedCount } = parseCsv(`${HEADER}\n${TX_ROW}\n${bad}`)
    expect(records).toHaveLength(1)
    expect(malformedCount).toBe(1)
  })
})
```

Run: `npm test` → FAIL.

- [ ] **Step 2: Implement**

`src/data/provider.ts`:

```ts
import type { EthRecord } from './types'

export interface LoadResult {
  records: EthRecord[]
  malformedCount: number
}

/** Seam for the future BigQuery-backed API — UI depends only on this. */
export interface DataProvider {
  load(): Promise<LoadResult>
}
```

`src/data/csvProvider.ts`:

```ts
import Papa from 'papaparse'
import type { EthRecord } from './types'
import type { DataProvider, LoadResult } from './provider'

const str = (v: string | undefined): string | null =>
  v == null || v.trim() === '' ? null : v.trim()

const int = (v: string | undefined): number | null => {
  const s = str(v)
  if (s == null) return null
  const n = Number.parseInt(s, 10)
  return Number.isNaN(n) ? null : n
}

const bool = (v: string | undefined): boolean | null => {
  const s = str(v)
  if (s == null) return null
  return s.toLowerCase() === 'true'
}

export function parseCsv(csvText: string): LoadResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
  })
  const records: EthRecord[] = []
  let malformedCount = 0

  for (const row of parsed.data) {
    const blockNumber = int(row.block_number)
    const txHash = str(row.transaction_hash)
    if (blockNumber == null || txHash == null) {
      malformedCount++
      continue
    }
    records.push({
      block_hash: str(row.block_hash) ?? '',
      block_number: blockNumber,
      block_timestamp: str(row.block_timestamp) ?? '',
      transaction_hash: txHash,
      transaction_index: int(row.transaction_index) ?? 0,
      event_index: int(row.event_index),
      batch_index: int(row.batch_index),
      address: str(row.address),
      event_type: str(row.event_type),
      event_hash: str(row.event_hash),
      event_signature: str(row.event_signature),
      operator_address: str(row.operator_address),
      from_address: str(row.from_address),
      to_address: str(row.to_address),
      token_id: str(row.token_id),
      quantity: str(row.quantity),
      removed: bool(row.removed),
      nonce_tx: int(row.nonce_tx),
      from_address_tx: str(row.from_address_tx),
      to_address_tx: str(row.to_address_tx),
      value_tx: str(row.value_tx),
      value_lossless_tx: str(row.value_lossless_tx),
      gas_tx: int(row.gas_tx),
      gas_price_tx: str(row.gas_price_tx),
      input_tx: str(row.input_tx),
      max_fee_per_gas_tx: str(row.max_fee_per_gas_tx),
      max_priority_fee_per_gas_tx: str(row.max_priority_fee_per_gas_tx),
      type_tx: int(row.type_tx),
      chain_id_tx: int(row.chain_id_tx),
      access_list_tx: str(row.access_list_tx),
      r_tx: str(row.r_tx),
      s_tx: str(row.s_tx),
      v_tx: str(row.v_tx),
      y_parity_tx: str(row.y_parity_tx),
      is_token_transfer: bool(row.is_token_transfer) ?? false,
    })
  }
  return { records, malformedCount }
}

export function csvProvider(url = '/data/analytics_25534300.csv'): DataProvider {
  return {
    async load(): Promise<LoadResult> {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to fetch dataset: HTTP ${res.status}`)
      return parseCsv(await res.text())
    },
  }
}
```

- [ ] **Step 3: Run tests** — `npm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/data
git commit -m "feat: PapaParse CSV provider behind DataProvider seam"
```

---

### Task 5: Theme system + app shell

**Files:**
- Create: `src/theme/tokens.css`, `src/theme/useTheme.ts`, `src/components/ThemeToggle.tsx`, `src/components/Header.tsx`
- Modify: `src/index.css`, `src/App.tsx`, `src/main.tsx`, `index.html`

**Interfaces:**
- Produces:
  - `useTheme(): { theme: 'dark' | 'light'; toggle(): void }` — persists to `localStorage('eth-explorer-theme')`, sets `data-theme` on `<html>`, **default dark**
  - CSS custom properties consumed by all later tasks: `--bg`, `--bg-raised`, `--bg-inset`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--text-faint`, `--accent`, `--accent-muted`, `--positive`, `--negative`, `--font-ui`, `--font-mono`
  - `<Header stats={...}>` slot layout: title, block badge, right-side controls

> **Executor: invoke the `frontend-design` skill before this task.** The tokens below are the starting palette; refine per the skill but keep the variable names.

- [ ] **Step 1: Load fonts**

In `index.html` `<head>`, self-host via Fontsource instead of CDN if offline builds matter later; for now:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

- [ ] **Step 2: Write `src/theme/tokens.css`**

```css
:root {
  --font-ui: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace;
}

:root[data-theme='dark'] {
  --bg: #0b0e14;
  --bg-raised: #11151f;
  --bg-inset: #070a10;
  --border: #1e2532;
  --border-strong: #2c3547;
  --text: #e6eaf2;
  --text-muted: #96a0b5;
  --text-faint: #5c6678;
  --accent: #5b8def;
  --accent-muted: rgba(91, 141, 239, 0.14);
  --positive: #3fb68b;
  --negative: #e5636f;
}

:root[data-theme='light'] {
  --bg: #f7f8fa;
  --bg-raised: #ffffff;
  --bg-inset: #eef0f4;
  --border: #e2e6ec;
  --border-strong: #c9d0da;
  --text: #171c26;
  --text-muted: #5a6478;
  --text-faint: #98a1b3;
  --accent: #2f6bdb;
  --accent-muted: rgba(47, 107, 219, 0.1);
  --positive: #1e8e68;
  --negative: #c9414e;
}
```

- [ ] **Step 3: `src/theme/useTheme.ts`**

```ts
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'
const KEY = 'eth-explorer-theme'

function initial(): Theme {
  const saved = localStorage.getItem(KEY)
  return saved === 'light' ? 'light' : 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(KEY, theme)
  }, [theme])

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])
  return { theme, toggle }
}
```

- [ ] **Step 4: Header + toggle components**

`src/components/ThemeToggle.tsx`: icon button (sun/moon inline SVG), `aria-label="Toggle theme"`, calls `toggle`.

`src/components/Header.tsx`:

```tsx
import { ThemeToggle } from './ThemeToggle'

interface HeaderProps {
  blockNumber: number | null
  blockTime: string | null
  children?: React.ReactNode // right-side slot: global search etc.
}

export function Header({ blockNumber, blockTime, children }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo" aria-hidden>⬨</span>
        <div>
          <h1>Ethereum Dataset Explorer</h1>
          <p className="app-header__sub">BigQuery · blockchain_analytics_ethereum_mainnet_us</p>
        </div>
      </div>
      {blockNumber != null && (
        <span className="block-badge" title={blockTime ?? undefined}>
          Block #{blockNumber.toLocaleString('en-US')}
        </span>
      )}
      <div className="app-header__actions">
        {children}
        <ThemeToggle />
      </div>
    </header>
  )
}
```

`src/App.tsx` wires `useTheme` + `Header` and loads data via `csvProvider` in a `useEffect` into state `{ status: 'loading' | 'error' | 'ready', result?: LoadResult }`. Render skeleton text for loading; full error/empty states come in Task 11.

- [ ] **Step 5: Base styles in `src/index.css`**

Import tokens, set `body { background: var(--bg); color: var(--text); font-family: var(--font-ui); }`, thin custom scrollbars, `.app-header` layout (flex, bottom border, raised bg), `.block-badge` (mono font, accent-muted bg, accent text, pill).

- [ ] **Step 6: Verify manually** — `npm run dev`: dark shell renders, toggle flips theme and persists across reload, header shows Block #25,534,300 from data.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: dual-theme design tokens, header shell, CSV wired into app state"
```

---

### Task 6: Dataset stats computation

**Files:**
- Create: `src/features/stats/computeStats.ts`
- Test: `src/features/stats/computeStats.test.ts`

**Interfaces:**
- Consumes: `EthRecord`, `toBigInt`, `weiToEth`, `weiToGwei`.
- Produces:

```ts
interface DatasetStats {
  totalRecords: number
  txCount: number            // rows with is_token_transfer === false
  transferCount: number
  eventTypeCounts: { type: string; count: number }[] // desc by count
  totalEthMoved: string      // ETH, summed over UNIQUE transaction_hash values
  gasPriceMinGwei: string | null
  gasPriceMaxGwei: string | null
  uniqueAddresses: number    // union of from/to/from_tx/to_tx/address
  blockNumber: number | null
  blockTimestamp: string | null
}
function computeStats(records: EthRecord[]): DatasetStats
```

- [ ] **Step 1: Write failing tests** — build 4 tiny `EthRecord` fixtures via a `mk(partial)` helper (all-null base record). Assert: counts split correctly; `totalEthMoved` deduplicates by `transaction_hash` (two rows sharing a hash count value once); gas min/max in gwei; unique addresses across all five address fields; null gas stats for empty input.

```ts
import { describe, it, expect } from 'vitest'
import { computeStats } from './computeStats'
import type { EthRecord } from '../../data/types'

const BASE: EthRecord = {
  block_hash: '0xb', block_number: 25534300, block_timestamp: '2026-07-14 23:55:11+00:00',
  transaction_hash: '0xt1', transaction_index: 0, event_index: null, batch_index: null,
  address: null, event_type: null, event_hash: null, event_signature: null,
  operator_address: null, from_address: null, to_address: null, token_id: null,
  quantity: null, removed: null, nonce_tx: null, from_address_tx: null, to_address_tx: null,
  value_tx: null, value_lossless_tx: null, gas_tx: null, gas_price_tx: null, input_tx: null,
  max_fee_per_gas_tx: null, max_priority_fee_per_gas_tx: null, type_tx: null,
  chain_id_tx: null, access_list_tx: null, r_tx: null, s_tx: null, v_tx: null,
  y_parity_tx: null, is_token_transfer: false,
}
const mk = (p: Partial<EthRecord>): EthRecord => ({ ...BASE, ...p })

describe('computeStats', () => {
  it('splits row kinds and counts event types', () => {
    const s = computeStats([
      mk({}),
      mk({ transaction_hash: '0xt2', is_token_transfer: true, event_type: 'ERC-20' }),
      mk({ transaction_hash: '0xt3', is_token_transfer: true, event_type: 'ERC-20' }),
      mk({ transaction_hash: '0xt4', is_token_transfer: true, event_type: 'ERC-721' }),
    ])
    expect(s.totalRecords).toBe(4)
    expect(s.txCount).toBe(1)
    expect(s.transferCount).toBe(3)
    expect(s.eventTypeCounts).toEqual([
      { type: 'ERC-20', count: 2 },
      { type: 'ERC-721', count: 1 },
    ])
  })

  it('sums ETH over unique tx hashes only', () => {
    const s = computeStats([
      mk({ transaction_hash: '0xa', value_lossless_tx: '2000000000000000000' }),
      mk({ transaction_hash: '0xa', value_lossless_tx: '2000000000000000000', is_token_transfer: true }),
      mk({ transaction_hash: '0xb2', value_lossless_tx: '500000000000000000' }),
    ])
    expect(s.totalEthMoved).toBe('2.5')
  })

  it('computes gas price range in gwei over unique txs', () => {
    const s = computeStats([
      mk({ transaction_hash: '0xa', gas_price_tx: '2000000000' }),
      mk({ transaction_hash: '0xb2', gas_price_tx: '58631115' }),
    ])
    expect(s.gasPriceMinGwei).toBe('0.05')
    expect(s.gasPriceMaxGwei).toBe('2')
  })

  it('counts unique addresses across all address fields', () => {
    const s = computeStats([
      mk({ from_address_tx: '0x1', to_address_tx: '0x2' }),
      mk({ transaction_hash: '0xt9', is_token_transfer: true, from_address: '0x2', to_address: '0x3', address: '0x4' }),
    ])
    expect(s.uniqueAddresses).toBe(4)
  })

  it('handles empty input', () => {
    const s = computeStats([])
    expect(s.blockNumber).toBeNull()
    expect(s.gasPriceMinGwei).toBeNull()
    expect(s.totalEthMoved).toBe('0')
  })
})
```

Run: `npm test` → FAIL.

- [ ] **Step 2: Implement `computeStats.ts`** — single pass; `Map<txHash, {value, gasPrice}>` for unique-tx aggregates; `Set<string>` for addresses; BigInt sums; convert at the end with `weiToEth`/`weiToGwei`.

- [ ] **Step 3: Run tests** — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/stats
git commit -m "feat: dataset stats computation (unique-tx aggregates, BigInt sums)"
```

---

### Task 7: Stats band UI

**Files:**
- Create: `src/features/stats/StatsBand.tsx`, `src/features/stats/stats.css`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `DatasetStats` (Task 6).
- Produces: `<StatsBand stats={DatasetStats} />` rendered between header and tabs.

> **Executor: invoke the `dataviz` skill before this task** (stat tiles, proportion bar).

- [ ] **Step 1: Build `StatsBand`** — a responsive grid (`repeat(auto-fit, minmax(180px, 1fr))`) of stat tiles:
  1. **Records** — total, with tx/transfer split as a two-segment proportion bar (accent for transfers, muted for txs) + legend
  2. **Token standards** — ERC-20 / ERC-721 (+ any other observed types) counts
  3. **ETH moved** — `totalEthMoved` with "Ξ" prefix, mono
  4. **Gas price** — `min – max Gwei` range, mono
  5. **Unique addresses** — count
  6. **Block** — number + formatted timestamp

Tile: label (uppercase, `--text-muted`, 11px, letter-spaced), value (mono where numeric, 20px, `--text`), optional sub-line (`--text-faint`). Raised bg, 1px border, consistent radius. No decorative icons.

- [ ] **Step 2: Verify in browser** — both themes, resize 360px→1600px; numbers match: 600 records, 96 tx / 504 transfers, 503 ERC-20 + 1 ERC-721.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: stats band with record split, standards, ETH moved, gas range"
```

---

### Task 8: Data table with tabs, sorting, pagination

**Files:**
- Create: `src/features/table/columns.tsx`, `src/features/table/DataTable.tsx`, `src/features/table/CellRenderers.tsx`, `src/features/table/table.css`, `src/features/table/Tabs.tsx`, `src/components/CopyButton.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `EthRecord`, transforms (Task 3), `ColumnMeta`/`COLUMNS` (Task 2).
- Produces:
  - `TabId = 'transfers' | 'transactions' | 'all'`
  - `getColumnsForTab(tab: TabId): ColumnDef<EthRecord>[]`
  - `<DataTable records={EthRecord[]} tab={TabId} />` — owns TanStack instance; exposes its `table` instance upward via `onTableReady?: (t: Table<EthRecord>) => void` (used by export + filters)
  - Custom `sortingFn: 'bignum'` registered for string-numeric columns
  - `<HexCell value full>` / `<AddressCell>` / `<EthValueCell>` / `<GweiCell>` / `<TimeCell>` / `<BadgeCell>` renderers

- [ ] **Step 1: Cell renderers** (`CellRenderers.tsx`)

- `HexCell` — mono, `truncateHex`, `title={full}`, `CopyButton` appears on row hover, copies full value, shows ✓ for 1.2s
- `AddressCell` — same as HexCell (lead 8)
- `EthValueCell` — `weiToEth`; zero rendered as faint `0`
- `GweiCell` — `weiToGwei` + faint unit suffix "Gwei"
- `TimeCell` — `formatTimestamp`
- `BadgeCell` — small pill for `event_type` (accent-muted bg) and `type_tx`
- Null/empty → centered faint "–"

- [ ] **Step 2: Column defs per tab** (`columns.tsx`)

- **transfers**: Time, Tx Hash, Standard (badge), Token Contract, From, To, Quantity (bignum sort), Token ID, Event Index
- **transactions**: Time, Tx Index, Tx Hash, From (tx), To (tx), Value ETH (bignum sort on `value_lossless_tx`), Gas Price Gwei (bignum sort), Gas Limit, Nonce, Tx Type (badge)
- **all**: every one of the 35 `COLUMNS` in CSV order, raw values (mono, truncated hex), horizontal scroll inside the table container
- Header text from `ColumnMeta.label`; each header gets an ⓘ affordance slot (wired in Task 10)
- Register `sortingFn` `'bignum'` using `compareNumericStrings` on raw string fields

- [ ] **Step 3: `DataTable.tsx`** — `useReactTable` with `getCoreRowModel`, `getSortedRowModel`, `getFilteredRowModel`, `getPaginationRowModel` (pageSize 50; selector 25/50/100). Sticky `<thead>` (`position: sticky; top: 0`), sort indicators (▲▼, accent when active), zebra-free rows with hover highlight, 1px row borders, pagination footer: "Showing X–Y of Z" + prev/next + page-size select.

- [ ] **Step 4: `Tabs.tsx`** — three tabs with live counts: `Token Transfers (504)` / `Transactions (96)` / `All Records (600)`. Counts computed from records, not hard-coded. Tab filters records *before* passing to `DataTable` (`transfers` → `is_token_transfer`, `transactions` → `!is_token_transfer`, `all` → everything). Active tab: accent underline + full text color. Tab switch resets pagination, keeps per-tab state (`useState<Record<TabId, ...>>` not required — acceptable to reset sort/filters on switch; document this in code comment).

- [ ] **Step 5: Verify in browser** — sort Value ETH desc on transactions tab: largest values first (BigInt order, not lexicographic); paginate; both themes; All tab scrolls horizontally without body scroll.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: tabbed TanStack data table with BigInt-safe sorting and pagination"
```

---

### Task 9: Filtering (per-column, global search, chips) + CSV export

**Files:**
- Create: `src/features/table/filters.ts`, `src/features/table/FilterControls.tsx`, `src/features/table/FilterChips.tsx`, `src/features/export/exportCsv.ts`, `src/features/export/ExportButton.tsx`
- Test: `src/features/table/filters.test.ts`, `src/features/export/exportCsv.test.ts`
- Modify: `src/features/table/DataTable.tsx`, `src/features/table/columns.tsx`, `src/components/Header.tsx` usage in `App.tsx` (global search input)

**Interfaces:**
- Consumes: table instance (Task 8), `compareNumericStrings`/`toBigInt` (Task 3).
- Produces:
  - Filter fns registered on columns: `textFilter` (case-insensitive substring), `rangeFilter` (`{ min?: string; max?: string }`, BigInt compare), `enumFilter` (`string[]`, empty = no filter)
  - `globalFilterFn(record, query)` — case-insensitive substring across all 35 stringified fields
  - `buildCsv(rows: EthRecord[], fields: (keyof EthRecord)[]): string` — pure; Papa.unparse; booleans back to `True`/`False`, nulls to empty string, raw values (lossless round-trip)
  - `downloadCsv(csv: string, filename: string): void` — Blob + anchor click
  - `<ExportButton table={Table<EthRecord>} tab={TabId}>` — menu: "Visible columns" / "All 35 columns"; filename `eth-block25534300-{tab}-{rowCount}rows.csv`; exports `table.getSortedRowModel().rows` (filtered + sorted order)

- [ ] **Step 1: Write failing filter tests** — `textFilter('0xAbC...', 'abc') === true`; `rangeFilter` respects min-only/max-only/both with 256-bit strings; `enumFilter([], v)` passes everything; `globalFilterFn` matches a hash fragment and rejects a non-match.

- [ ] **Step 2: Implement `filters.ts`; run tests** → PASS.

- [ ] **Step 3: Write failing export tests** — `buildCsv` round-trips: header row from field list; `value_lossless_tx` appears verbatim (no precision loss); `null` → empty; `false` → `False`; quoted `event_signature` containing commas survives `Papa.parse(Papa.unparse(...))`.

- [ ] **Step 4: Implement `exportCsv.ts`; run tests** → PASS.

- [ ] **Step 5: Filter UI** (`FilterControls.tsx`)

Per-column popover opened from a filter icon in the header cell:
- `kind: 'hex' | 'address' | 'text'` → text input ("contains…")
- `kind: 'number' | 'bignum'` → min/max inputs (mono)
- `kind: 'enum' | 'boolean'` → checkbox list of distinct observed values with counts
Apply on change (debounced 250ms for text). Filter icon gets accent dot when active.

- [ ] **Step 6: Chips + global search** — `FilterChips.tsx` renders active column filters + global query as removable chips above the table (`Standard: ERC-20 ×`), plus "Clear all" when ≥2. Global search input lives in the header slot (Task 5 `children`), placeholder `Search hashes, addresses…`, mono, ⌘K/Ctrl-K focuses it.

- [ ] **Step 7: Wire ExportButton** next to the tabs, right-aligned. Verify in browser: filter Standard=ERC-20, sort by Quantity desc, export visible columns → downloaded CSV has only ERC-20 rows in sorted order; export all columns → 35 headers.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: per-column + global filtering with chips, and view-exact CSV export"
```

---

### Task 10: Row detail expansion + data dictionary

**Files:**
- Create: `src/features/table/RowDetail.tsx`, `src/features/dictionary/DictionaryPanel.tsx`, `src/features/dictionary/columnStats.ts`, `src/features/dictionary/dictionary.css`
- Test: `src/features/dictionary/columnStats.test.ts`
- Modify: `src/features/table/DataTable.tsx` (expand), `src/features/table/columns.tsx` (ⓘ wiring), `src/App.tsx`

**Interfaces:**
- Consumes: `COLUMNS`/`getColumnMeta` (Task 2), records.
- Produces:
  - `<RowDetail record={EthRecord} />` — expanded panel under the row listing **all 35 fields** grouped "Block & Transaction" / "Token Transfer" / "Signature & Advanced": label, full raw value (mono, wrap-anywhere, copyable), human-readable rendering beside it where kinds allow (ETH, Gwei, timestamp)
  - `computeColumnStats(records: EthRecord[], field: keyof EthRecord): { fillRate: number; distinct: number; min?: string; max?: string }` (min/max only for number/bignum kinds, BigInt compare)
  - `<DictionaryPanel records field?>` — right-side slide-over: single-column mode (opened from a header ⓘ) shows description, source-table badge, kind, live stats; full mode (opened from header "Data dictionary" button) lists all 35 fields grouped by source table with descriptions + fill rates
  - Esc / backdrop click / × closes; focus returns to opener

- [ ] **Step 1: Failing tests for `computeColumnStats`** — fill rate counts non-null over total; distinct counts; min/max on `value_lossless_tx` uses numeric order (`'9' < '10'`); no min/max for hex kinds.

- [ ] **Step 2: Implement; run tests** → PASS.

- [ ] **Step 3: Build `RowDetail`** — TanStack `getExpandedRowModel`, chevron cell as first column, only one row expanded at a time (`expanded` state replaced on toggle).

- [ ] **Step 4: Build `DictionaryPanel`** — fixed-position panel (max-width 420px, full height, raised bg, left border, subtle shadow), source badge colors: token_transfers → accent, transactions → positive, both/derived → muted. Wire ⓘ in every column header and a "Data dictionary" button in the header actions.

- [ ] **Step 5: Verify in browser** — expand a transfer row: all fields visible, values copyable; ⓘ on Gas Price shows PDF description + min/max gwei-raw stats; full dictionary lists 35 fields; Esc closes; both themes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: row detail expansion and live data dictionary panel"
```

---

### Task 11: Error/empty/loading states + malformed-row notice

**Files:**
- Create: `src/components/States.tsx` (`LoadingState`, `ErrorState`, `EmptyState`, `MalformedNotice`)
- Modify: `src/App.tsx`, `src/features/table/DataTable.tsx`

**Interfaces:**
- Consumes: app load state (Task 5), `malformedCount` (Task 4).
- Produces:
  - `LoadingState` — centered skeleton: shimmering stat-tile placeholders + table-row placeholders (no spinner-only screen)
  - `ErrorState` — icon, "Couldn't load the dataset", error detail line, Retry button re-invoking `provider.load()`
  - `EmptyState` — inside table body when filters yield 0 rows: "No records match your filters" + "Clear filters" action wired to table reset
  - `MalformedNotice` — dismissible banner above stats when `malformedCount > 0`: "N rows could not be parsed and are excluded."

- [ ] **Step 1: Implement the four states and wire them.**
- [ ] **Step 2: Verify** — dev-tools offline → error state + working retry; impossible filter (min value > max observed) → empty state; clear restores rows.
- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: loading, error, empty, and malformed-row states"
```

---

### Task 12: Design polish pass + final verification

**Files:**
- Modify: any CSS/components needing refinement; `README.md` (create)

> **Executor: re-invoke `frontend-design` skill.** This is a dedicated quality gate, not a catch-all.

- [ ] **Step 1: Full-app design review** in both themes at 1440px, 1024px, 390px: consistent spacing scale (4/8/12/16/24/32), aligned numerics (tabular-nums), focus-visible rings on all interactive elements, hover states, no layout shift on tab switch, table never causes body horizontal scroll.
- [ ] **Step 2: Accessibility sweep** — keyboard: tab through header → tabs → table controls → pagination; sortable headers are `<button>`s with `aria-sort`; dialogs/panels get `role="dialog"` + focus trap; contrast ≥ 4.5:1 for text in both themes (check `--text-muted` on `--bg-raised`).
- [ ] **Step 3: Write `README.md`** — what the app is, dataset provenance (BigQuery dataset/tables), `npm install / npm run dev / npm test / npm run build`, data refresh note (future cron replaces `public/data/*.csv` and the DataProvider seam).
- [ ] **Step 4: Full verification** — `npm test` (all green), `npm run build` + `npm run preview` (production bundle works), manual checklist: sort/filter/export/dictionary/expand/theme-toggle on all three tabs.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "polish: design + a11y pass, README, production build verified"
```

---

## Verification (end-to-end)

1. `npm test` — all unit suites pass (dictionary, transforms, csvProvider, stats, filters, export, columnStats).
2. `npm run build && npm run preview` — production build serves; CSV loads; 600 records.
3. Manual: Transfers tab → filter Standard=ERC-20 → sort Quantity desc → export visible columns → open the CSV: 503 rows, sorted, lossless values.
4. Manual: both themes pixel-checked on stats band, table, panels; theme persists on reload.
5. Manual: header block badge reads from data (Block #25,534,300), not hard-coded.

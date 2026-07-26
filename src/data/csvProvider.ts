import Papa from 'papaparse'
import type { EthRecord } from './types'
import type { DataProvider, LoadResult, ProgressCallback } from './provider'
import { decodeMaybeGzipped } from './gzip'

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

export function parseCsv(csvText: string): LoadResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
  })
  const records: EthRecord[] = []
  let malformedCount = 0

  // One pool per low-cardinality column — a shared pool would be a single huge map with
  // no benefit, since these columns' value spaces don't overlap.
  const inBlockHash = interner()
  const inTimestamp = interner()
  const inEventType = interner()
  const inEventHash = interner()
  const inEventSig = interner()
  const inAccessList = interner()

  for (const row of parsed.data) {
    const blockNumber = int(row.block_number)
    const txHash = str(row.transaction_hash)
    if (blockNumber == null || txHash == null) {
      malformedCount++
      continue
    }
    records.push({
      block_hash: inBlockHash(row.block_hash) ?? '',
      block_number: blockNumber,
      block_timestamp: inTimestamp(row.block_timestamp) ?? '',
      transaction_hash: txHash,
      transaction_index: int(row.transaction_index) ?? 0,
      event_index: int(row.event_index),
      batch_index: int(row.batch_index),
      address: str(row.address),
      event_type: inEventType(row.event_type),
      event_hash: inEventHash(row.event_hash),
      event_signature: inEventSig(row.event_signature),
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
      max_fee_per_gas_tx: str(row.max_fee_per_gas_tx),
      max_priority_fee_per_gas_tx: str(row.max_priority_fee_per_gas_tx),
      type_tx: int(row.type_tx),
      chain_id_tx: int(row.chain_id_tx),
      access_list_tx: inAccessList(row.access_list_tx),
      r_tx: str(row.r_tx),
      s_tx: str(row.s_tx),
      v_tx: str(row.v_tx),
      y_parity_tx: str(row.y_parity_tx),
      is_token_transfer: bool(row.is_token_transfer) ?? false,
    })
  }
  return { records, malformedCount }
}

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

/** Reports progress at most this often, so a chunky download doesn't turn into one React
 *  render (and, in States.tsx, one live-region update) per network chunk. */
const PROGRESS_MIN_INTERVAL_MS = 100
const PROGRESS_MIN_STEP_FRACTION = 0.01

/** Drains a response body, reporting bytes as they arrive so the UI can show real progress.
 *  Throttled to roughly every 1% of `total` (or every ~100ms when `total` is unknown), but
 *  the true final value is always reported — even if it doesn't clear the throttle — so the
 *  progress bar reliably reaches 100% instead of freezing a few points short. */
async function readWithProgress(
  body: ReadableStream<Uint8Array>,
  total: number | null,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  const minStepBytes = total != null && total > 0 ? total * PROGRESS_MIN_STEP_FRACTION : Infinity
  let lastReportedLoaded = 0
  let lastReportedAt = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    const now = Date.now()
    if (loaded - lastReportedLoaded >= minStepBytes || now - lastReportedAt >= PROGRESS_MIN_INTERVAL_MS) {
      onProgress?.(loaded, total)
      lastReportedLoaded = loaded
      lastReportedAt = now
    }
  }
  // Guarantee the last tick lands even if it never cleared the throttle above — otherwise a
  // download whose final bytes arrive just after the previous report would leave the bar
  // stuck below 100%.
  if (loaded !== lastReportedLoaded) onProgress?.(loaded, total)
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

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
 *
 * Must stay identical to `calldataShard` in `src/data/calldataProvider.ts` — that file runs
 * in the browser and this one under bare `node`, so the logic is deliberately duplicated
 * rather than shared; keep both in sync when changing either.
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

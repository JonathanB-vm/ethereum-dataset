/**
 * Reference implementations of the research variables in `registry/variables.json`, for
 * the CSV build. Pure — no `fs`/`zlib` — so every rule is unit-testable on a handful of
 * rows, and `prepare-variables.mjs` only does the I/O.
 *
 * Each implementation must agree with its ClickHouse formula
 * (`pipeline/variables/<id>.sql`) on every transaction; the API integration tests check
 * that on the loaded sample. Change both together.
 *
 * Input rows are the flat CSV shape: one row per token transfer, plus one row for each
 * transaction that has none. Transaction-level fields (`from_address_tx`, …) repeat on
 * every row of a transaction. Values are keyed by `(block_number, transaction_index)`,
 * which is the transaction's identity in ClickHouse too.
 */

/** Lookback for `from_high_user`, in blocks: about one day at 12 s per block. */
export const HIGH_USER_WINDOW_BLOCKS = 7200
/** `from_high_user` is 1 when the sender initiated *more than* this many transactions. */
export const HIGH_USER_THRESHOLD = 10

/**
 * Collapses rows to one entry per transaction, in `(block_number, transaction_index)`
 * order, counting the token transfers each one carries.
 *
 * @param {Array<{block_number: number, transaction_index: number, from_address_tx: string | null, is_token_transfer: boolean}>} rows
 * @returns {Array<{block: number, txIndex: number, from: string | null, transfers: number}>}
 */
export function toTransactions(rows) {
  const byKey = new Map()
  for (const r of rows) {
    const key = `${r.block_number}:${r.transaction_index}`
    let tx = byKey.get(key)
    if (tx === undefined) {
      tx = { block: r.block_number, txIndex: r.transaction_index, from: null, transfers: 0 }
      byKey.set(key, tx)
    }
    if (tx.from === null && r.from_address_tx) tx.from = r.from_address_tx.toLowerCase()
    if (r.is_token_transfer) tx.transfers++
  }
  return [...byKey.values()].sort((a, b) => a.block - b.block || a.txIndex - b.txIndex)
}

/** 1 if the transaction has exactly one token transfer; 0 for none or several. */
export function simpleTransaction(transactions) {
  return transactions.map((tx) => (tx.transfers === 1 ? 1 : 0))
}

/**
 * 1 if the sender initiated more than `HIGH_USER_THRESHOLD` transactions in blocks
 * `[B - 7200, B - 1]`, where B is this transaction's block. Transactions earlier in block B
 * are not counted, so every transaction in one block from one sender gets the same value.
 *
 * Only the loaded blocks can be counted: near the start of the data the window is
 * truncated, as the registry description says.
 *
 * Per sender, the blocks they sent in are kept in order with a running total, so each
 * window is two binary searches rather than a scan.
 */
export function fromHighUser(transactions) {
  /** sender -> { blocks: number[] ascending, cumulative: number[] (sent in blocks[0..i]) } */
  const bySender = new Map()
  for (const tx of transactions) {
    if (tx.from === null) continue
    let s = bySender.get(tx.from)
    if (s === undefined) {
      s = { blocks: [], cumulative: [] }
      bySender.set(tx.from, s)
    }
    const last = s.blocks.length - 1
    const total = last >= 0 ? s.cumulative[last] : 0
    if (last >= 0 && s.blocks[last] === tx.block) s.cumulative[last] = total + 1
    else {
      s.blocks.push(tx.block)
      s.cumulative.push(total + 1)
    }
  }

  return transactions.map((tx) => {
    if (tx.from === null) return 0
    const s = bySender.get(tx.from)
    // Sent in blocks <= B - 1, minus sent in blocks <= B - 7201.
    const upTo = (block) => {
      const i = lastIndexAtMost(s.blocks, block)
      return i < 0 ? 0 : s.cumulative[i]
    }
    const prior = upTo(tx.block - 1) - upTo(tx.block - HIGH_USER_WINDOW_BLOCKS - 1)
    return prior > HIGH_USER_THRESHOLD ? 1 : 0
  })
}

/** Index of the last element `<= target` in an ascending array, or -1. */
function lastIndexAtMost(sorted, target) {
  let lo = 0
  let hi = sorted.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= target) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** Variable id -> its implementation. A registered variable missing from here fails the build. */
export const IMPLEMENTATIONS = {
  simple_transaction: simpleTransaction,
  from_high_user: fromHighUser,
}

/**
 * Computes every given variable and packs the result in the columnar shape
 * `public/data/variable-values.json.gz` ships in — parallel arrays, so the payload is a few
 * hundred KB rather than tens of thousands of keyed objects.
 *
 * @param {Array<{id: string, version: number}>} variables registry entries to compute
 */
export function computeVariableValues(rows, variables) {
  const transactions = toTransactions(rows)
  const values = {}
  const versions = {}
  for (const v of variables) {
    const impl = IMPLEMENTATIONS[v.id]
    if (impl === undefined) throw new Error(`no reference implementation for variable ${v.id}`)
    values[v.id] = impl(transactions)
    versions[v.id] = v.version
  }
  return {
    blocks: transactions.map((tx) => tx.block),
    txIndexes: transactions.map((tx) => tx.txIndex),
    versions,
    values,
  }
}

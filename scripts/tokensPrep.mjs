/**
 * Pure helpers shared by `prepare-tokens.mjs` and its tests. Kept free of `fs` so every rule
 * about what reaches the browser is unit-testable without touching the 39 MB tokens export —
 * same split as `datasetPrep.mjs` / `prepare-dataset.mjs`.
 */

/** Widest base-10 decimals a 256-bit unsigned quantity could meaningfully use. */
const MAX_DECIMALS = 77

/**
 * A token's `decimals` from the CSV, or null if unusable. Null is the common case, not an
 * error: NFT contracts (ERC-721/ERC-1155) legitimately carry no decimals, and their
 * quantities are counts rather than divisible amounts.
 */
export function parseTokenDecimals(raw) {
  const s = String(raw ?? '').trim()
  if (s === '' || !/^\d+$/.test(s)) return null
  const n = Number.parseInt(s, 10)
  return n >= 0 && n <= MAX_DECIMALS ? n : null
}

/**
 * Distills the token export down to the contracts this dataset actually references, keeping
 * only those with usable decimals. `datasetAddresses` must already be lowercased.
 *
 * The two counts are emitted so the UI can state its own coverage instead of hard-coding a
 * number that would rot the moment a wider export lands.
 */
export function buildTokensArtifact(datasetAddresses, tokenRows) {
  const tokens = {}
  for (const row of tokenRows) {
    const address = String(row.address ?? '').trim().toLowerCase()
    if (address === '' || !datasetAddresses.has(address)) continue
    const decimals = parseTokenDecimals(row.decimals)
    if (decimals === null) continue
    const symbol = String(row.symbol ?? '').trim()
    // Last row wins. Measured against the real tokens.csv this is a no-op: its only repeated
    // contract carries identical decimals on every row.
    tokens[address] = { symbol: symbol === '' ? null : symbol, decimals }
  }
  return {
    contractsInDataset: datasetAddresses.size,
    contractsWithDecimals: Object.keys(tokens).length,
    tokens,
  }
}

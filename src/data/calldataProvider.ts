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

import type { EthRecord } from './types'
import {
  assertBounded,
  DEFAULT_PAGE_SIZE,
  type Head,
  type Page,
  type QueryProvider,
  type QueryRequest,
  type QueryScope,
  type ScopedStats,
} from './queryProvider'

/**
 * A `QueryProvider` over records already in memory.
 *
 * This is how the CSV build survives the move to a server-side dataset: the existing
 * loader still produces `EthRecord[]`, and this wraps them in the paged interface so the
 * same UI code paths work offline, in tests, and in demos with no API running. It is also
 * the reference implementation the API provider is checked against — both are exercised
 * by the same contract suite.
 *
 * Its cursor is an opaque row offset, which is legitimate precisely because the whole
 * result set is a stable in-memory array. A server cannot do that, which is why the API
 * provider encodes a sort key instead; the contract only requires that a cursor is opaque
 * and yields the next page.
 */
export class MemoryQueryProvider implements QueryProvider {
  // Declared rather than a constructor parameter property: the project builds with
  // erasableSyntaxOnly, which forbids syntax that emits runtime code.
  private readonly records: EthRecord[]

  constructor(records: EthRecord[]) {
    this.records = records
  }

  private matching(req: QueryRequest): EthRecord[] {
    assertBounded(req.scope)
    const scope = req.scope

    const inScope = this.records.filter((r) => {
      switch (scope.kind) {
        case 'range':
          return r.block_number >= scope.blockFrom && r.block_number <= scope.blockTo
        case 'txHash':
          return r.transaction_hash?.toLowerCase() === scope.txHash.toLowerCase()
        case 'address': {
          const a = scope.address.toLowerCase()
          return [
            r.address,
            r.from_address,
            r.to_address,
            r.operator_address,
            r.from_address_tx,
            r.to_address_tx,
          ].some((v) => v?.toLowerCase() === a)
        }
      }
    })

    const byView = inScope.filter((r) => {
      if (req.view === 'transfers') return r.is_token_transfer
      if (req.view === 'transactions') return !r.is_token_transfer
      return true
    })

    // The natural order is the dataset's sort key, matching the server's ORDER BY.
    const sorted = [...byView].sort(
      (a, b) =>
        a.block_number - b.block_number ||
        a.transaction_index - b.transaction_index ||
        (a.event_index ?? 0) - (b.event_index ?? 0) ||
        (a.batch_index ?? 0) - (b.batch_index ?? 0),
    )
    return req.sort?.dir === 'desc' ? sorted.reverse() : sorted
  }

  async query(req: QueryRequest): Promise<Page<EthRecord>> {
    const all = this.matching(req)
    const limit = req.limit ?? DEFAULT_PAGE_SIZE
    const start = req.cursor ? decodeOffset(req.cursor) : 0
    const rows = all.slice(start, start + limit)
    const next = start + rows.length
    return {
      rows,
      nextCursor: next < all.length ? encodeOffset(next) : null,
      // Cheap here, so it is reported; the API omits it when it is not.
      total: all.length,
    }
  }

  async stats(scope: QueryScope): Promise<ScopedStats> {
    const rows = await this.matching({ view: 'all', scope })
    const blocks = new Set<number>()
    const addresses = new Set<string>()
    const seenTx = new Set<string>()
    let txCount = 0
    let transferCount = 0
    let erc20 = 0
    let erc721 = 0
    let erc1155 = 0
    let eth = 0n
    let gasMin: bigint | null = null
    let gasMax: bigint | null = null

    for (const r of rows) {
      blocks.add(r.block_number)
      if (r.is_token_transfer) {
        transferCount++
        if (r.event_type === 'ERC-20') erc20++
        else if (r.event_type === 'ERC-721') erc721++
        else if (r.event_type === 'ERC-1155') erc1155++
      }
      for (const a of [
        r.address,
        r.from_address,
        r.to_address,
        r.operator_address,
        r.from_address_tx,
        r.to_address_tx,
      ]) {
        if (a) addresses.add(a.toLowerCase())
      }
      // Value and gas price belong to the transaction, so count each one once even
      // though the flat join repeats it on every transfer row.
      if (r.transaction_hash && !seenTx.has(r.transaction_hash)) {
        seenTx.add(r.transaction_hash)
        txCount++
        if (r.value_lossless_tx) eth += BigInt(stripFloatSuffix(r.value_lossless_tx))
        if (r.gas_price_tx) {
          const g = BigInt(stripFloatSuffix(r.gas_price_tx))
          gasMin = gasMin === null || g < gasMin ? g : gasMin
          gasMax = gasMax === null || g > gasMax ? g : gasMax
        }
      }
    }

    return {
      blocks: blocks.size,
      txCount,
      transferCount,
      erc20Count: erc20,
      erc721Count: erc721,
      erc1155Count: erc1155,
      totalEthMovedWei: eth.toString(),
      gasPriceMinWei: gasMin?.toString() ?? null,
      gasPriceMaxWei: gasMax?.toString() ?? null,
      uniqueAddresses: addresses.size,
    }
  }

  async head(): Promise<Head> {
    let block = 0
    let timestamp = ''
    for (const r of this.records) {
      if (r.block_number > block) {
        block = r.block_number
        timestamp = r.block_timestamp
      }
    }
    return { block, timestamp }
  }
}

/** The source CSV writes some integers with a trailing `.0`; BigInt will not parse it. */
function stripFloatSuffix(value: string): string {
  return value.replace(/\.0+$/, '')
}

function encodeOffset(n: number): string {
  return btoa(`offset:${n}`)
}

function decodeOffset(cursor: string): number {
  try {
    const decoded = atob(cursor)
    const match = /^offset:(\d+)$/.exec(decoded)
    if (match) return Number(match[1])
  } catch {
    // fall through
  }
  throw new Error('malformed cursor')
}

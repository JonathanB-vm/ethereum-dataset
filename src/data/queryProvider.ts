import type { EthRecord } from './types'

/**
 * The paged data seam.
 *
 * The existing `DataProvider.load()` hands the browser every record and lets the client
 * sort, filter and aggregate. That stops working at roughly 50,000 rows, and one year of
 * mainnet is ~2 billion. This interface replaces "give me everything" with "give me one
 * page", so the same UI can be served from a server-side dataset of any size.
 *
 * Every request is bounded. There is deliberately no way to express "all rows": the scope
 * is a block range, an address, or a transaction hash, and a provider is entitled to
 * reject anything else.
 *
 * Spec: docs/superpowers/specs/2026-09-08-api-and-frontend.md
 */

export type QueryView = 'transfers' | 'transactions' | 'all'

export type QueryScope =
  | { kind: 'range'; blockFrom: number; blockTo: number }
  | { kind: 'address'; address: string }
  | { kind: 'txHash'; txHash: string }

export interface QuerySort {
  field: string
  dir: 'asc' | 'desc'
}

export interface QueryRequest {
  view: QueryView
  scope: QueryScope
  /** Opaque; only ever obtained from a previous page's `nextCursor`. */
  cursor?: string | null
  limit?: number
  sort?: QuerySort | null
}

export interface Page<T> {
  rows: T[]
  /** Null on the last page. */
  nextCursor: string | null
  /** Present only when counting is cheap; Blockscout dropped counts for good reason. */
  total?: number
}

/**
 * Aggregates for a scope.
 *
 * Deliberately narrower than the client-side `DatasetStats`: it omits `blockAxis`, the
 * per-block list that drives the range control, because materializing one entry per block
 * does not survive the jump to 2.63 M blocks a year. The range control needs its own
 * bounded endpoint rather than the full axis.
 *
 * Wei values stay decimal strings, as everywhere else in this app.
 */
export interface ScopedStats {
  blocks: number
  txCount: number
  transferCount: number
  erc20Count: number
  erc721Count: number
  erc1155Count: number
  totalEthMovedWei: string
  gasPriceMinWei: string | null
  gasPriceMaxWei: string | null
  uniqueAddresses: number
}

export interface Head {
  block: number
  timestamp: string
  release?: string
}

export interface QueryProvider {
  query(req: QueryRequest): Promise<Page<EthRecord>>
  stats(scope: QueryScope): Promise<ScopedStats>
  head(): Promise<Head>
}

/** The widest span one request may cover; mirrors the API's own cap. */
export const MAX_BLOCK_SPAN = 100_000

export const DEFAULT_PAGE_SIZE = 50

export class UnboundedQueryError extends Error {
  constructor(message = 'a query needs a block range, an address or a transaction hash') {
    super(message)
    this.name = 'UnboundedQueryError'
  }
}

/** Shared validation, so both implementations reject the same things. */
export function assertBounded(scope: QueryScope): void {
  if (scope.kind !== 'range') return
  if (!Number.isInteger(scope.blockFrom) || !Number.isInteger(scope.blockTo)) {
    throw new UnboundedQueryError('block bounds must be integers')
  }
  if (scope.blockTo < scope.blockFrom) {
    throw new UnboundedQueryError('blockTo must be greater than or equal to blockFrom')
  }
  if (scope.blockTo - scope.blockFrom + 1 > MAX_BLOCK_SPAN) {
    throw new UnboundedQueryError(
      `block range is wider than the ${MAX_BLOCK_SPAN}-block maximum`,
    )
  }
}

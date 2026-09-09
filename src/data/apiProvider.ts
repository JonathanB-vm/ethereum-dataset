import type { EthRecord } from './types'
import {
  assertBounded,
  DEFAULT_PAGE_SIZE,
  UnboundedQueryError,
  type Head,
  type Page,
  type QueryProvider,
  type QueryRequest,
  type QueryScope,
  type QueryView,
  type ScopedStats,
} from './queryProvider'

/**
 * A `QueryProvider` backed by the /v1 API.
 *
 * View routing:
 *
 *   all          -> /v1/records, the flat 35-column join, which reproduces the CSV shape
 *                   exactly (column names and all) so no mapping is needed
 *   transactions -> /v1/transactions
 *   transfers    -> /v1/transfers
 *
 * The two normalized endpoints return one table's columns only, so a row from them has
 * the *other* table's fields null. That is a real difference from the CSV build, where
 * every row carried both sides of the join. Views that need both should ask for `all`.
 */
export interface ApiProviderOptions {
  baseUrl?: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

export class ApiQueryProvider implements QueryProvider {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly doFetch: typeof fetch

  constructor(options: ApiProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api').replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString()
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['x-api-key'] = this.apiKey

    const res = await this.doFetch(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
      headers,
    })
    if (!res.ok) {
      let message = `request failed with ${res.status}`
      try {
        const body = (await res.json()) as { message?: string; error?: string }
        if (body.message) message = body.message
        // A 400 here is the API refusing an unbounded or over-wide scope; surface it as
        // the same error the local provider throws so callers handle one type.
        if (res.status === 400) throw new UnboundedQueryError(message)
      } catch (err) {
        if (err instanceof UnboundedQueryError) throw err
      }
      throw new Error(message)
    }
    return (await res.json()) as T
  }

  private scopeParams(scope: QueryScope): Record<string, string> {
    assertBounded(scope)
    switch (scope.kind) {
      case 'range':
        return {
          block_from: String(scope.blockFrom),
          block_to: String(scope.blockTo),
        }
      case 'address':
        return { address: scope.address }
      case 'txHash':
        return { hash: scope.txHash }
    }
  }

  async query(req: QueryRequest): Promise<Page<EthRecord>> {
    const params: Record<string, string> = {
      ...this.scopeParams(req.scope),
      limit: String(req.limit ?? DEFAULT_PAGE_SIZE),
    }
    if (req.cursor) params.cursor = req.cursor
    if (req.sort?.dir) params.sort = req.sort.dir

    const path =
      req.view === 'all'
        ? '/v1/records'
        : req.view === 'transactions'
          ? '/v1/transactions'
          : '/v1/transfers'

    const body = await this.get<{
      rows: Record<string, unknown>[]
      nextCursor: string | null
    }>(path, params)

    return {
      rows: body.rows.map((r) => toEthRecord(r, req.view)),
      nextCursor: body.nextCursor,
    }
  }

  async stats(scope: QueryScope): Promise<ScopedStats> {
    if (scope.kind !== 'range') {
      throw new UnboundedQueryError('stats require a block range')
    }
    const row = await this.get<Record<string, unknown>>('/v1/stats', this.scopeParams(scope))
    return {
      blocks: Number(row.blocks ?? 0),
      txCount: Number(row.tx_count ?? 0),
      transferCount: Number(row.transfer_count ?? 0),
      erc20Count: Number(row.erc20_count ?? 0),
      erc721Count: Number(row.erc721_count ?? 0),
      erc1155Count: Number(row.erc1155_count ?? 0),
      totalEthMovedWei: String(row.eth_moved ?? '0'),
      gasPriceMinWei: row.gas_price_min == null ? null : String(row.gas_price_min),
      gasPriceMaxWei: row.gas_price_max == null ? null : String(row.gas_price_max),
      uniqueAddresses: Number(row.unique_addresses ?? 0),
    }
  }

  async head(): Promise<Head> {
    const row = await this.get<{ block: number; timestamp: string; release?: string }>(
      '/v1/head',
      {},
    )
    return { block: Number(row.block), timestamp: row.timestamp, release: row.release }
  }
}

const str = (v: unknown): string | null => (v == null ? null : String(v))
const num = (v: unknown): number | null => (v == null ? null : Number(v))

/**
 * Map an API row into the record shape the UI already renders.
 *
 * `/v1/records` already uses the CSV's own column names, so that path is close to
 * identity. The normalized endpoints need their single table spread into the flat shape,
 * with the other table's columns left null.
 */
export function toEthRecord(row: Record<string, unknown>, view: QueryView): EthRecord {
  const isTransfer =
    view === 'transfers' ? true : view === 'transactions' ? false : Boolean(row.is_token_transfer)

  return {
    block_hash: String(row.block_hash ?? ''),
    block_number: Number(row.block_number ?? 0),
    block_timestamp: String(row.block_timestamp ?? ''),
    transaction_hash: String(row.transaction_hash ?? ''),
    transaction_index: Number(row.transaction_index ?? 0),

    event_index: num(row.event_index),
    batch_index: num(row.batch_index),
    address: str(row.address),
    event_type: str(row.event_type),
    event_hash: str(row.event_hash),
    event_signature: str(row.event_signature),
    operator_address: str(row.operator_address),
    from_address: str(row.from_address),
    to_address: str(row.to_address),
    token_id: str(row.token_id),
    quantity: str(row.quantity),
    removed: row.removed == null ? null : Boolean(row.removed),

    // The normalized transactions endpoint returns unsuffixed names; /v1/records returns
    // the CSV's _tx suffixes. Accept either.
    nonce_tx: num(row.nonce_tx ?? row.nonce),
    from_address_tx: str(row.from_address_tx ?? (view === 'transactions' ? row.from_address : null)),
    to_address_tx: str(row.to_address_tx ?? (view === 'transactions' ? row.to_address : null)),
    // Dropped from the data model as a pure duplicate of the lossless column.
    value_tx: null,
    value_lossless_tx: str(row.value_lossless_tx ?? row.value),
    gas_tx: num(row.gas_tx ?? row.gas),
    gas_price_tx: str(row.gas_price_tx ?? row.gas_price),
    max_fee_per_gas_tx: str(row.max_fee_per_gas_tx ?? row.max_fee_per_gas),
    max_priority_fee_per_gas_tx: str(
      row.max_priority_fee_per_gas_tx ?? row.max_priority_fee_per_gas,
    ),
    type_tx: num(row.type_tx ?? row.transaction_type),
    chain_id_tx: num(row.chain_id_tx ?? row.chain_id),
    access_list_tx: str(row.access_list_tx ?? row.access_list),
    r_tx: str(row.r_tx ?? row.r),
    s_tx: str(row.s_tx ?? row.s),
    v_tx: str(row.v_tx ?? row.v),
    y_parity_tx: str(row.y_parity_tx ?? row.y_parity),

    is_token_transfer: isTransfer,
  }
}

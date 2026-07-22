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

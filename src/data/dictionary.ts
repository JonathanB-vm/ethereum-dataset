import type { EthRecord } from './types'

/**
 * Every field the *dataset* has — which is one more than `EthRecord` carries. `input_tx`
 * is documented here but never held in memory (see `availability` below), so it is not a
 * key of `EthRecord`.
 */
export type DictionaryField = keyof EthRecord | 'input_tx'

export interface ColumnMeta {
  field: DictionaryField
  label: string
  description: string
  source: 'token_transfers' | 'transactions' | 'both' | 'derived'
  kind: 'hex' | 'address' | 'number' | 'bignum' | 'timestamp' | 'enum' | 'boolean' | 'text'
  /**
   * `'loaded'` — the value is on every `EthRecord` in memory.
   * `'on-demand'` — documented, but fetched per row through `CalldataProvider`. Anything
   * that reads a value off a live record must iterate `LOADED_COLUMNS`, not `COLUMNS`.
   */
  availability: 'loaded' | 'on-demand'
}

/** A dictionary entry whose field really is present on `EthRecord`. */
export interface LoadedColumnMeta extends ColumnMeta {
  field: keyof EthRecord
  availability: 'loaded'
}

export const COLUMNS: ColumnMeta[] = [
  { field: 'block_hash', label: 'Block Hash', description: 'Hash of the block this event was emitted from.', source: 'both', kind: 'hex', availability: 'loaded' },
  { field: 'block_number', label: 'Block', description: 'Number of the block this event was emitted from.', source: 'both', kind: 'number', availability: 'loaded' },
  { field: 'block_timestamp', label: 'Time', description: 'Unix timestamp when the block was added to the blockchain.', source: 'both', kind: 'timestamp', availability: 'loaded' },
  { field: 'transaction_hash', label: 'Tx Hash', description: 'Hash of the transaction this event was emitted from.', source: 'both', kind: 'hex', availability: 'loaded' },
  { field: 'transaction_index', label: 'Tx Index', description: "The transaction's index position in the block.", source: 'both', kind: 'number', availability: 'loaded' },
  { field: 'event_index', label: 'Event Index', description: "The event's index position in the block.", source: 'token_transfers', kind: 'number', availability: 'loaded' },
  { field: 'batch_index', label: 'Batch Index', description: "The transfer's position in the batch transfer event.", source: 'token_transfers', kind: 'number', availability: 'loaded' },
  { field: 'address', label: 'Token Contract', description: 'Address from which this event originated.', source: 'token_transfers', kind: 'address', availability: 'loaded' },
  { field: 'event_type', label: 'Standard', description: 'Token standard that matches the event.', source: 'token_transfers', kind: 'enum', availability: 'loaded' },
  { field: 'event_hash', label: 'Event Hash', description: 'Keccak hash of the event signature.', source: 'token_transfers', kind: 'hex', availability: 'loaded' },
  { field: 'event_signature', label: 'Event Signature', description: 'Function signature of the event.', source: 'token_transfers', kind: 'text', availability: 'loaded' },
  { field: 'operator_address', label: 'Operator', description: 'Address of the transfer operator.', source: 'token_transfers', kind: 'address', availability: 'loaded' },
  { field: 'from_address', label: 'From', description: 'Address of the previous owner of the token(s).', source: 'token_transfers', kind: 'address', availability: 'loaded' },
  { field: 'to_address', label: 'To', description: 'Address of the new owner of the token(s).', source: 'token_transfers', kind: 'address', availability: 'loaded' },
  { field: 'token_id', label: 'Token ID', description: 'Identifier of the token(s) being transferred.', source: 'token_transfers', kind: 'bignum', availability: 'loaded' },
  { field: 'quantity', label: 'Quantity', description: 'Quantity of tokens being transferred.', source: 'token_transfers', kind: 'bignum', availability: 'loaded' },
  { field: 'removed', label: 'Removed', description: 'Whether or not the event was orphaned off the main chain.', source: 'token_transfers', kind: 'boolean', availability: 'loaded' },
  { field: 'nonce_tx', label: 'Nonce', description: 'Number of transactions made by the sender prior to this one.', source: 'transactions', kind: 'number', availability: 'loaded' },
  { field: 'from_address_tx', label: 'From (tx)', description: 'Address of the sender of the transaction.', source: 'transactions', kind: 'address', availability: 'loaded' },
  { field: 'to_address_tx', label: 'To (tx)', description: 'Address of the receiver of the transaction.', source: 'transactions', kind: 'address', availability: 'loaded' },
  { field: 'value_tx', label: 'Value', description: 'Value transferred in Wei. A decimal number represented as a BIGNUMERIC to preserve up to 128-bit numeric precision.', source: 'transactions', kind: 'bignum', availability: 'loaded' },
  { field: 'value_lossless_tx', label: 'Value (lossless)', description: 'Value transferred in Wei. A decimal number represented in STRING format to preserve full 256-bit numeric precision.', source: 'transactions', kind: 'bignum', availability: 'loaded' },
  { field: 'gas_tx', label: 'Gas Limit', description: 'Quantity of gas units provided by the sender of the transaction.', source: 'transactions', kind: 'number', availability: 'loaded' },
  { field: 'gas_price_tx', label: 'Gas Price', description: 'Price per gas unit provided by the sender of the transaction in Wei.', source: 'transactions', kind: 'bignum', availability: 'loaded' },
  { field: 'input_tx', label: 'Input Data', description: 'Data sent along with the transaction (contract calldata). Stored per transaction and fetched on demand — expand a row to load it.', source: 'transactions', kind: 'hex', availability: 'on-demand' },
  { field: 'max_fee_per_gas_tx', label: 'Max Fee/Gas', description: 'Maximum fee per unit of gas for this transaction.', source: 'transactions', kind: 'bignum', availability: 'loaded' },
  { field: 'max_priority_fee_per_gas_tx', label: 'Max Priority Fee/Gas', description: 'Maximum priority fee per unit of gas for this transaction.', source: 'transactions', kind: 'bignum', availability: 'loaded' },
  { field: 'type_tx', label: 'Tx Type', description: 'Type of the transaction.', source: 'transactions', kind: 'enum', availability: 'loaded' },
  { field: 'chain_id_tx', label: 'Chain ID', description: 'Chain ID used in transaction signing.', source: 'transactions', kind: 'number', availability: 'loaded' },
  { field: 'access_list_tx', label: 'Access List', description: 'List of addresses and storage keys that the transaction plans to access and has pre-paid gas for.', source: 'transactions', kind: 'text', availability: 'loaded' },
  { field: 'r_tx', label: 'Sig r', description: 'ECDSA signature r.', source: 'transactions', kind: 'hex', availability: 'loaded' },
  { field: 's_tx', label: 'Sig s', description: 'ECDSA signature s.', source: 'transactions', kind: 'hex', availability: 'loaded' },
  { field: 'v_tx', label: 'Sig v', description: 'ECDSA signature v.', source: 'transactions', kind: 'hex', availability: 'loaded' },
  { field: 'y_parity_tx', label: 'Sig y-parity', description: 'ECDSA signature y_parity.', source: 'transactions', kind: 'hex', availability: 'loaded' },
  { field: 'is_token_transfer', label: 'Token Transfer?', description: 'Indicates whether the row represents a token transfer or a non-token transaction.', source: 'derived', kind: 'boolean', availability: 'loaded' },
]

/**
 * The 34 columns actually present on an `EthRecord`. This — not `COLUMNS` — is what the
 * table, global search, and CSV export iterate: `COLUMNS` documents the dataset, and one
 * of its entries (`input_tx`) has no value to read off a record.
 */
export const LOADED_COLUMNS: LoadedColumnMeta[] = COLUMNS.filter(
  (c): c is LoadedColumnMeta => c.availability === 'loaded',
)

const byField = new Map(COLUMNS.map((c) => [c.field as string, c]))

export function getColumnMeta(field: string): ColumnMeta | undefined {
  return byField.get(field)
}

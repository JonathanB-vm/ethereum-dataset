import type { EthRecord } from './types'

export interface ColumnMeta {
  field: keyof EthRecord
  label: string
  description: string
  source: 'token_transfers' | 'transactions' | 'both' | 'derived'
  kind: 'hex' | 'address' | 'number' | 'bignum' | 'timestamp' | 'enum' | 'boolean' | 'text'
}

export const COLUMNS: ColumnMeta[] = [
  { field: 'block_hash', label: 'Block Hash', description: 'Hash of the block this event was emitted from.', source: 'both', kind: 'hex' },
  { field: 'block_number', label: 'Block', description: 'Number of the block this event was emitted from.', source: 'both', kind: 'number' },
  { field: 'block_timestamp', label: 'Time', description: 'Unix timestamp when the block was added to the blockchain.', source: 'both', kind: 'timestamp' },
  { field: 'transaction_hash', label: 'Tx Hash', description: 'Hash of the transaction this event was emitted from.', source: 'both', kind: 'hex' },
  { field: 'transaction_index', label: 'Tx Index', description: "The transaction's index position in the block.", source: 'both', kind: 'number' },
  { field: 'event_index', label: 'Event Index', description: "The event's index position in the block.", source: 'token_transfers', kind: 'number' },
  { field: 'batch_index', label: 'Batch Index', description: "The transfer's position in the batch transfer event.", source: 'token_transfers', kind: 'number' },
  { field: 'address', label: 'Token Contract', description: 'Address from which this event originated.', source: 'token_transfers', kind: 'address' },
  { field: 'event_type', label: 'Standard', description: 'Token standard that matches the event.', source: 'token_transfers', kind: 'enum' },
  { field: 'event_hash', label: 'Event Hash', description: 'Keccak hash of the event signature.', source: 'token_transfers', kind: 'hex' },
  { field: 'event_signature', label: 'Event Signature', description: 'Function signature of the event.', source: 'token_transfers', kind: 'text' },
  { field: 'operator_address', label: 'Operator', description: 'Address of the transfer operator.', source: 'token_transfers', kind: 'address' },
  { field: 'from_address', label: 'From', description: 'Address of the previous owner of the token(s).', source: 'token_transfers', kind: 'address' },
  { field: 'to_address', label: 'To', description: 'Address of the new owner of the token(s).', source: 'token_transfers', kind: 'address' },
  { field: 'token_id', label: 'Token ID', description: 'Identifier of the token(s) being transferred.', source: 'token_transfers', kind: 'bignum' },
  { field: 'quantity', label: 'Quantity', description: 'Quantity of tokens being transferred.', source: 'token_transfers', kind: 'bignum' },
  { field: 'removed', label: 'Removed', description: 'Whether or not the event was orphaned off the main chain.', source: 'token_transfers', kind: 'boolean' },
  { field: 'nonce_tx', label: 'Nonce', description: 'Number of transactions made by the sender prior to this one.', source: 'transactions', kind: 'number' },
  { field: 'from_address_tx', label: 'From (tx)', description: 'Address of the sender of the transaction.', source: 'transactions', kind: 'address' },
  { field: 'to_address_tx', label: 'To (tx)', description: 'Address of the receiver of the transaction.', source: 'transactions', kind: 'address' },
  { field: 'value_tx', label: 'Value', description: 'Value transferred in Wei. A decimal number represented as a BIGNUMERIC to preserve up to 128-bit numeric precision.', source: 'transactions', kind: 'bignum' },
  { field: 'value_lossless_tx', label: 'Value (lossless)', description: 'Value transferred in Wei. A decimal number represented in STRING format to preserve full 256-bit numeric precision.', source: 'transactions', kind: 'bignum' },
  { field: 'gas_tx', label: 'Gas Limit', description: 'Quantity of gas units provided by the sender of the transaction.', source: 'transactions', kind: 'number' },
  { field: 'gas_price_tx', label: 'Gas Price', description: 'Price per gas unit provided by the sender of the transaction in Wei.', source: 'transactions', kind: 'bignum' },
  { field: 'input_tx', label: 'Input Data', description: 'Data sent along with the transaction, with a maximum size of 32 bytes.', source: 'transactions', kind: 'hex' },
  { field: 'max_fee_per_gas_tx', label: 'Max Fee/Gas', description: 'Maximum fee per unit of gas for this transaction.', source: 'transactions', kind: 'bignum' },
  { field: 'max_priority_fee_per_gas_tx', label: 'Max Priority Fee/Gas', description: 'Maximum priority fee per unit of gas for this transaction.', source: 'transactions', kind: 'bignum' },
  { field: 'type_tx', label: 'Tx Type', description: 'Type of the transaction.', source: 'transactions', kind: 'enum' },
  { field: 'chain_id_tx', label: 'Chain ID', description: 'Chain ID used in transaction signing.', source: 'transactions', kind: 'number' },
  { field: 'access_list_tx', label: 'Access List', description: 'List of addresses and storage keys that the transaction plans to access and has pre-paid gas for.', source: 'transactions', kind: 'text' },
  { field: 'r_tx', label: 'Sig r', description: 'ECDSA signature r.', source: 'transactions', kind: 'hex' },
  { field: 's_tx', label: 'Sig s', description: 'ECDSA signature s.', source: 'transactions', kind: 'hex' },
  { field: 'v_tx', label: 'Sig v', description: 'ECDSA signature v.', source: 'transactions', kind: 'hex' },
  { field: 'y_parity_tx', label: 'Sig y-parity', description: 'ECDSA signature y_parity.', source: 'transactions', kind: 'hex' },
  { field: 'is_token_transfer', label: 'Token Transfer?', description: 'Indicates whether the row represents a token transfer or a non-token transaction.', source: 'derived', kind: 'boolean' },
]

const byField = new Map(COLUMNS.map((c) => [c.field as string, c]))

export function getColumnMeta(field: string): ColumnMeta | undefined {
  return byField.get(field)
}

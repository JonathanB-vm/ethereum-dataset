import type { EthRecord } from './types'
import { resolveCreator, VARIABLES, type User } from '../../registry/registry'

/**
 * A research variable's column id (its registry id). Branded so a plain string literal
 * still has to be a real dataset field: only `variableField()` mints one.
 */
export type VariableField = string & { readonly __variableField: true }

export function variableField(id: string): VariableField {
  return id as VariableField
}

/**
 * Every field the *dataset* has — which is more than `EthRecord` carries. `input_tx`
 * is documented here but never held in memory (see `availability` below),
 * `normalized_quantity` is never on the wire at all — it's computed in the browser — and
 * research variables are precomputed per transaction and joined on from their own
 * artifact, so none of them is a key of `EthRecord`.
 */
export type DictionaryField = keyof EthRecord | 'input_tx' | 'normalized_quantity' | VariableField

/** Provenance shown for a research variable: who defined it, when, and how it is computed. */
export interface VariableInfo {
  createdBy: User
  createdAt: string
  tags: string[]
  formula: string
  version: number
}

export interface ColumnMeta {
  field: DictionaryField
  label: string
  description: string
  source: 'token_transfers' | 'transactions' | 'both' | 'derived' | 'variable'
  kind: 'hex' | 'address' | 'number' | 'bignum' | 'timestamp' | 'enum' | 'boolean' | 'text'
  /**
   * `'loaded'` — the value is on every `EthRecord` in memory.
   * `'on-demand'` — documented, but fetched per row through `CalldataProvider`.
   * `'derived'` — not in the dataset at all; computed in the browser from other fields.
   * `'variable'` — a research variable: precomputed per transaction, read through the
   * `VariableValues` lookup (src/data/variableValues.ts).
   * Anything that reads a value off a live record must iterate `LOADED_COLUMNS`, not
   * `COLUMNS` — none of the latter three has a value to read.
   */
  availability: 'loaded' | 'on-demand' | 'derived' | 'variable'
  /** Research variables only. */
  variable?: VariableInfo
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
  { field: 'normalized_quantity', label: 'Normalized Quantity', description: 'Quantity divided by the token contract’s decimals (quantity ÷ 10^decimals) — the amount in the units people actually use, e.g. 80 USDT rather than the stored 80000000. Computed in the browser from a token-decimals lookup; contracts absent from that lookup show no value.', source: 'derived', kind: 'bignum', availability: 'derived' },
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
  ...VARIABLES.map((v): ColumnMeta => ({
    field: variableField(v.id),
    label: v.label,
    description: v.description ?? '',
    source: 'variable',
    // A 0/1 flag filters as a two-option checkbox list, like the boolean columns.
    kind: 'enum',
    availability: 'variable',
    variable: {
      createdBy: resolveCreator(v),
      createdAt: v.created_at,
      tags: v.tags ?? [],
      formula: v.formula.summary,
      version: v.version,
    },
  })),
]

/**
 * The 34 columns actually present on an `EthRecord`. This — not `COLUMNS` — is what the
 * table, global search, and CSV export iterate: `COLUMNS` documents the dataset, and one
 * of its entries (`input_tx`) has no value to read off a record.
 */
export const LOADED_COLUMNS: LoadedColumnMeta[] = COLUMNS.filter(
  (c): c is LoadedColumnMeta => c.availability === 'loaded',
)

/** Every research variable's dictionary entry, in registry order. */
export const VARIABLE_COLUMNS: ColumnMeta[] = COLUMNS.filter((c) => c.availability === 'variable')

const byField = new Map(COLUMNS.map((c) => [c.field as string, c]))

export function getColumnMeta(field: string): ColumnMeta | undefined {
  return byField.get(field)
}

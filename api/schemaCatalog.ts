/**
 * The tables and columns a researcher can build a variable from, for the query builder
 * and column browser in the "Propose a variable" form.
 *
 * Types come live from system.columns, so the browser can never disagree with the
 * database; the descriptions and units here are the human layer on top. Only tables the
 * restricted research user can read are listed (pipeline/clickhouse/research_user.ts),
 * minus the index tables, which hold nothing a researcher needs beyond the fact tables.
 */

import type { ClickHouseClient } from './clickhouse.ts'

/** How the builder treats a column: which operators it offers and how it writes a literal. */
export type ColumnKind = 'number' | 'bignum' | 'address' | 'hash' | 'enum' | 'text' | 'bool' | 'datetime'

export interface SchemaColumn {
  name: string
  type: string
  kind: ColumnKind
  nullable: boolean
  description: string
  /** Wei-denominated amounts, which the builder lets you enter in ETH or Gwei. */
  unit?: 'wei'
}

export interface SchemaTable {
  name: string
  label: string
  description: string
  columns: SchemaColumn[]
}

interface CuratedTable {
  label: string
  description: string
  columns: Record<string, { description: string; unit?: 'wei' }>
}

const CURATED: Record<string, CuratedTable> = {
  transactions: {
    label: 'Transactions',
    description: 'One row per transaction.',
    columns: {
      block_number: { description: 'Block the transaction is in.' },
      block_timestamp: { description: 'When that block was mined (UTC).' },
      block_hash: { description: 'Hash of that block.' },
      transaction_index: { description: 'Position of the transaction within its block.' },
      transaction_hash: { description: 'Hash identifying the transaction.' },
      nonce: { description: 'Number of transactions the sender had sent before this one.' },
      from_address: { description: 'Sender of the transaction.' },
      to_address: { description: 'Recipient. Empty for contract creations.' },
      value: { description: 'ETH sent with the transaction.', unit: 'wei' },
      gas: { description: 'Gas limit the sender set.' },
      gas_price: { description: 'Price paid per unit of gas.', unit: 'wei' },
      input: { description: 'Calldata sent to a contract (hex). Large.' },
      max_fee_per_gas: { description: 'EIP-1559 fee cap per unit of gas.', unit: 'wei' },
      max_priority_fee_per_gas: { description: 'EIP-1559 tip cap per unit of gas.', unit: 'wei' },
      transaction_type: { description: '0 legacy, 1 EIP-2930, 2 EIP-1559, 3 blob, 4 set-code.' },
      chain_id: { description: 'Chain id used when signing.' },
      access_list: { description: 'Addresses and storage keys the transaction pre-declared.' },
      r: { description: 'Signature r.' },
      s: { description: 'Signature s.' },
      v: { description: 'Signature v.' },
      y_parity: { description: 'Signature y-parity.' },
    },
  },
  token_transfers: {
    label: 'Token transfers',
    description: 'One row per ERC-20, ERC-721 or ERC-1155 transfer. A transaction can have many, or none.',
    columns: {
      block_number: { description: 'Block the transfer is in.' },
      block_timestamp: { description: 'When that block was mined (UTC).' },
      block_hash: { description: 'Hash of that block.' },
      transaction_index: { description: 'Position of the enclosing transaction within its block.' },
      transaction_hash: { description: 'Hash of the enclosing transaction.' },
      event_index: { description: 'Position of the transfer event within the block.' },
      batch_index: { description: 'Position within an ERC-1155 batch transfer.' },
      address: { description: 'Token contract that emitted the transfer.' },
      event_type: { description: 'Token standard: ERC-20, ERC-721 or ERC-1155.' },
      event_hash: { description: 'Keccak hash of the event signature.' },
      event_signature: { description: 'The event signature, e.g. Transfer(address,address,uint256).' },
      operator_address: { description: 'Operator of an ERC-1155 transfer. Often empty.' },
      from_address: { description: 'Previous owner of the tokens.' },
      to_address: { description: 'New owner of the tokens.' },
      token_id: { description: 'Token id, for NFTs. Empty for ERC-20.' },
      quantity: { description: 'Amount transferred, in the token’s smallest unit.' },
      removed: { description: 'Whether the event was later orphaned off the main chain.' },
    },
  },
  blocks: {
    label: 'Blocks',
    description: 'One row per block.',
    columns: {
      block_number: { description: 'Block number.' },
      block_timestamp: { description: 'When the block was mined (UTC).' },
      block_hash: { description: 'Hash of the block.' },
      transaction_count: { description: 'Transactions in the block.' },
      transfer_count: { description: 'Token transfers in the block.' },
    },
  },
  tx_variable_values: {
    label: 'Other variables',
    description: 'Values of every computed research variable, one row per variable and transaction. Filter on variable_id.',
    columns: {
      variable_id: { description: 'Which variable, e.g. simple_transaction.' },
      block_number: { description: 'Block of the transaction.' },
      transaction_index: { description: 'Position of the transaction within its block.' },
      value: { description: 'The variable’s value for that transaction.' },
      version: { description: 'Formula version that produced the value.' },
      computed_at: { description: 'When the value was computed.' },
    },
  },
}

/** Tables shown, in display order. */
export const SCHEMA_TABLES = Object.keys(CURATED)

/** The builder's view of a ClickHouse type. */
export function kindOf(type: string): { kind: ColumnKind; nullable: boolean } {
  const nullable = /^Nullable\(/.test(type)
  const base = type.replace(/^Nullable\((.*)\)$/, '$1').replace(/^LowCardinality\((.*)\)$/, 'LC:$1')
  if (base === 'FixedString(20)') return { kind: 'address', nullable }
  if (/^FixedString\(\d+\)$/.test(base)) return { kind: 'hash', nullable }
  if (/^U?Int(128|256)$/.test(base)) return { kind: 'bignum', nullable }
  if (/^(U?Int\d+|Float\d+|Decimal)/.test(base)) return { kind: 'number', nullable }
  if (base === 'Bool') return { kind: 'bool', nullable }
  if (/^DateTime/.test(base) || base === 'Date') return { kind: 'datetime', nullable }
  if (base.startsWith('LC:')) return { kind: 'enum', nullable }
  return { kind: 'text', nullable }
}

/** Live column types merged with the curated descriptions. */
export function buildSchema(rows: { table: string; name: string; type: string }[]): SchemaTable[] {
  return SCHEMA_TABLES.map((name) => {
    const curated = CURATED[name]
    return {
      name,
      label: curated.label,
      description: curated.description,
      columns: rows
        .filter((r) => r.table === name)
        .map((r) => ({
          name: r.name,
          type: r.type,
          ...kindOf(r.type),
          description: curated.columns[r.name]?.description ?? '',
          ...(curated.columns[r.name]?.unit ? { unit: curated.columns[r.name].unit } : {}),
        })),
    }
  }).filter((t) => t.columns.length > 0)
}

export async function loadSchema(client: ClickHouseClient): Promise<SchemaTable[]> {
  const rows = await client.query<{ table: string; name: string; type: string }>({
    sql:
      'SELECT table, name, type FROM system.columns ' +
      'WHERE database = currentDatabase() AND table IN {tables:Array(String)} ORDER BY table, position',
    params: { tables: `[${SCHEMA_TABLES.map((t) => `'${t}'`).join(',')}]` },
  })
  return buildSchema(rows)
}

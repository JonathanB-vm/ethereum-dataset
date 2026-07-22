import { createColumnHelper, type Column, type ColumnDef, type SortingFn } from '@tanstack/react-table'
import { getColumnMeta, COLUMNS } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { compareNumericStrings } from '../../data/transform'
import { SortableHeader } from './SortableHeader'
import type { TabId } from './Tabs'
import {
  AddressCell,
  BadgeCell,
  BigNumCell,
  EthValueCell,
  GweiCell,
  NumberCell,
  RawCell,
  TimeCell,
} from './CellRenderers'

// TanStack Table's sorting-fn registry is an empty interface consumers augment by
// declaration merging. Adding `bignum` here is what lets column defs below reference it
// by the string key `'bignum'` instead of passing the function around by reference.
declare module '@tanstack/table-core' {
  interface SortingFns {
    bignum: SortingFn<EthRecord>
  }
}

/** BigInt-aware sort for BigQuery numeric strings (wei, gas price, quantity, …). Nulls sort last. */
const bignumSortingFn: SortingFn<EthRecord> = (rowA, rowB, columnId) => {
  const a = rowA.getValue<string | null>(columnId)
  const b = rowB.getValue<string | null>(columnId)
  return compareNumericStrings(a, b)
}

/** Passed to `useReactTable({ sortingFns })` in DataTable.tsx. */
export const customSortingFns = { bignum: bignumSortingFn }

function metaLabel(field: keyof EthRecord): string {
  return getColumnMeta(field)?.label ?? String(field)
}

const TX_TYPE_LABELS: Record<number, string> = { 0: 'Legacy', 1: 'EIP-2930', 2: 'EIP-1559' }
function txTypeLabel(v: number | null): string | null {
  if (v == null) return null
  return TX_TYPE_LABELS[v] ?? `Type ${v}`
}

const helper = createColumnHelper<EthRecord>()

function header(label: string) {
  return ({ column }: { column: Column<EthRecord, unknown> }) => (
    <SortableHeader label={label} column={column} />
  )
}

// ---------- transfers tab ----------

const transferColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header(metaLabel('block_timestamp')),
    cell: (info) => <TimeCell value={info.getValue()} />,
  }),
  helper.accessor('transaction_hash', {
    header: header(metaLabel('transaction_hash')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('event_type', {
    header: header(metaLabel('event_type')),
    cell: (info) => <BadgeCell label={info.getValue()} />,
  }),
  helper.accessor('address', {
    header: header(metaLabel('address')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('from_address', {
    header: header(metaLabel('from_address')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('to_address', {
    header: header(metaLabel('to_address')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('quantity', {
    header: header(metaLabel('quantity')),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    sortingFn: 'bignum',
  }),
  helper.accessor('token_id', {
    header: header(metaLabel('token_id')),
    cell: (info) => <BigNumCell value={info.getValue()} />,
  }),
  helper.accessor('event_index', {
    header: header(metaLabel('event_index')),
    cell: (info) => <NumberCell value={info.getValue()} />,
  }),
] as ColumnDef<EthRecord>[]

// ---------- transactions tab ----------

const transactionColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header(metaLabel('block_timestamp')),
    cell: (info) => <TimeCell value={info.getValue()} />,
  }),
  helper.accessor('transaction_index', {
    header: header(metaLabel('transaction_index')),
    cell: (info) => <NumberCell value={info.getValue()} />,
  }),
  helper.accessor('transaction_hash', {
    header: header(metaLabel('transaction_hash')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('from_address_tx', {
    header: header(metaLabel('from_address_tx')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('to_address_tx', {
    header: header(metaLabel('to_address_tx')),
    cell: (info) => <AddressCell value={info.getValue()} />,
  }),
  helper.accessor('value_lossless_tx', {
    // "Value ETH" (not the dictionary's "Value (lossless)"): this column renders the
    // wei value converted to ETH, so the header should say what's actually on screen.
    header: header('Value ETH'),
    cell: (info) => <EthValueCell value={info.getValue()} />,
    sortingFn: 'bignum',
  }),
  helper.accessor('gas_price_tx', {
    // Same reasoning as above — displayed in Gwei, not the dictionary's raw "Gas Price" (wei).
    header: header('Gas Price Gwei'),
    cell: (info) => <GweiCell value={info.getValue()} />,
    sortingFn: 'bignum',
  }),
  helper.accessor('gas_tx', {
    header: header(metaLabel('gas_tx')),
    cell: (info) => <NumberCell value={info.getValue()} />,
  }),
  helper.accessor('nonce_tx', {
    header: header(metaLabel('nonce_tx')),
    cell: (info) => <NumberCell value={info.getValue()} />,
  }),
  helper.accessor('type_tx', {
    header: header(metaLabel('type_tx')),
    cell: (info) => <BadgeCell label={txTypeLabel(info.getValue())} />,
  }),
] as ColumnDef<EthRecord>[]

// ---------- all-records tab ----------
// Every one of the 35 dictionary columns, in CSV order, shown as raw (mono, truncated)
// values — this tab is the "inspect the export as-is" escape hatch, so it deliberately
// skips unit conversion and the curated tabs' friendly labels.

const allColumns: ColumnDef<EthRecord>[] = COLUMNS.map((meta) =>
  helper.accessor(meta.field, {
    header: header(meta.label),
    cell: (info) => <RawCell value={info.getValue()} />,
  }),
) as ColumnDef<EthRecord>[]

export function getColumnsForTab(tab: TabId): ColumnDef<EthRecord>[] {
  switch (tab) {
    case 'transfers':
      return transferColumns
    case 'transactions':
      return transactionColumns
    case 'all':
      return allColumns
  }
}

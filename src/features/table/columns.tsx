import { createColumnHelper, type Column, type ColumnDef, type SortingFn } from '@tanstack/react-table'
import { getColumnMeta, COLUMNS, type ColumnMeta } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { compareNumericStrings } from '../../data/transform'
import { SortableHeader } from './SortableHeader'
import { FilterControls } from './FilterControls'
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

// The transactions tab renders two columns under a friendlier, unit-specific label than
// the dictionary's own (see transactionColumns below) — this is the single place both the
// header cell and FilterChips.tsx read from, so a chip for `value_lossless_tx` says
// "Value ETH" (what's actually on screen) rather than the dictionary's "Value (lossless)".
const DISPLAY_LABEL_OVERRIDES: Partial<Record<keyof EthRecord, string>> = {
  value_lossless_tx: 'Value ETH',
  gas_price_tx: 'Gas Price Gwei',
}

export function columnDisplayLabel(field: keyof EthRecord): string {
  return DISPLAY_LABEL_OVERRIDES[field] ?? metaLabel(field)
}

const TX_TYPE_LABELS: Record<number, string> = { 0: 'Legacy', 1: 'EIP-2930', 2: 'EIP-1559' }
function txTypeLabel(v: number | null): string | null {
  if (v == null) return null
  return TX_TYPE_LABELS[v] ?? `Type ${v}`
}

// Which registered TanStack filterFn (see filters.ts) a column kind gets, if any.
// `timestamp` columns get no filter icon at all — the brief's Step 5 kind mapping doesn't
// cover it, and sorting already gives time-range access without a redundant control.
function filterFnForKind(kind: ColumnMeta['kind']): 'text' | 'range' | 'enumMulti' | undefined {
  switch (kind) {
    case 'hex':
    case 'address':
    case 'text':
      return 'text'
    case 'number':
    case 'bignum':
      return 'range'
    case 'enum':
    case 'boolean':
      return 'enumMulti'
    case 'timestamp':
      return undefined
  }
}

const helper = createColumnHelper<EthRecord>()

/**
 * Builds a header cell: sort control (SortableHeader) + filter popover (FilterControls),
 * driven by the field's dictionary `kind`. `rangeUnit` is only passed for the two
 * transactions-tab columns whose registered filterFn is the display-unit-aware
 * `'rangeEth'`/`'rangeGwei'` (see columns below) — it tells FilterControls to label its
 * Min/Max inputs "(ETH)"/"(Gwei)" so the unit a bound is compared in is never a guess.
 */
function header(field: keyof EthRecord, label?: string, rangeUnit?: string) {
  const displayLabel = label ?? columnDisplayLabel(field)
  const meta = getColumnMeta(field)
  const filterFn = meta ? filterFnForKind(meta.kind) : undefined
  return ({ column }: { column: Column<EthRecord, unknown> }) => (
    <div className="col-header-cell">
      <SortableHeader label={displayLabel} column={column} />
      {meta && filterFn && (
        <FilterControls column={column} kind={meta.kind} label={displayLabel} rangeUnit={rangeUnit} />
      )}
    </div>
  )
}

/** The registered filterFn (string key into filters.ts's `customFilterFns`) for a field's dictionary `kind`, or undefined for `timestamp`. */
function filterFor(field: keyof EthRecord) {
  const meta = getColumnMeta(field)
  return meta ? filterFnForKind(meta.kind) : undefined
}

// ---------- transfers tab ----------

const transferColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header('block_timestamp'),
    cell: (info) => <TimeCell value={info.getValue()} />,
  }),
  helper.accessor('transaction_hash', {
    header: header('transaction_hash'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('transaction_hash'),
  }),
  helper.accessor('event_type', {
    header: header('event_type'),
    cell: (info) => <BadgeCell label={info.getValue()} />,
    filterFn: filterFor('event_type'),
  }),
  helper.accessor('address', {
    header: header('address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('address'),
  }),
  helper.accessor('from_address', {
    header: header('from_address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('from_address'),
  }),
  helper.accessor('to_address', {
    header: header('to_address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('to_address'),
  }),
  helper.accessor('quantity', {
    header: header('quantity'),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: filterFor('quantity'),
  }),
  helper.accessor('token_id', {
    header: header('token_id'),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    filterFn: filterFor('token_id'),
  }),
  helper.accessor('event_index', {
    header: header('event_index'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('event_index'),
  }),
] as ColumnDef<EthRecord>[]

// ---------- transactions tab ----------

const transactionColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header('block_timestamp'),
    cell: (info) => <TimeCell value={info.getValue()} />,
  }),
  helper.accessor('transaction_index', {
    header: header('transaction_index'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('transaction_index'),
  }),
  helper.accessor('transaction_hash', {
    header: header('transaction_hash'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('transaction_hash'),
  }),
  helper.accessor('from_address_tx', {
    header: header('from_address_tx'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('from_address_tx'),
  }),
  helper.accessor('to_address_tx', {
    header: header('to_address_tx'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('to_address_tx'),
  }),
  helper.accessor('value_lossless_tx', {
    // Uses the DISPLAY_LABEL_OVERRIDES entry ("Value ETH", not the dictionary's "Value
    // (lossless)") — this column renders the wei value converted to ETH, so the header
    // should say what's actually on screen. The filter has to match: 'rangeEth' (not the
    // generic 'range' `filterFor` would give a bignum column) converts a typed ETH bound
    // to wei before comparing, so "≥ 1" here means ≥ 1 ETH, matching what's displayed —
    // not ≥ 1 wei, which off by 10^18 would make almost every bound a no-op.
    header: header('value_lossless_tx', undefined, 'ETH'),
    cell: (info) => <EthValueCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: 'rangeEth',
  }),
  helper.accessor('gas_price_tx', {
    // Same reasoning as above — displayed in Gwei, not the dictionary's raw "Gas Price"
    // (wei), so its filter ('rangeGwei') converts a typed Gwei bound to wei (off by 10^9
    // if left as the generic 'range').
    header: header('gas_price_tx', undefined, 'Gwei'),
    cell: (info) => <GweiCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: 'rangeGwei',
  }),
  helper.accessor('gas_tx', {
    header: header('gas_tx'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('gas_tx'),
  }),
  helper.accessor('nonce_tx', {
    header: header('nonce_tx'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('nonce_tx'),
  }),
  helper.accessor('type_tx', {
    header: header('type_tx'),
    cell: (info) => <BadgeCell label={txTypeLabel(info.getValue())} />,
    filterFn: filterFor('type_tx'),
  }),
] as ColumnDef<EthRecord>[]

// ---------- all-records tab ----------
// Every one of the 35 dictionary columns, in CSV order, shown as raw (mono, truncated)
// values — this tab is the "inspect the export as-is" escape hatch, so it deliberately
// skips unit conversion and the curated tabs' friendly labels.

const allColumns: ColumnDef<EthRecord>[] = COLUMNS.map((meta) =>
  helper.accessor(meta.field, {
    header: header(meta.field),
    cell: (info) => <RawCell value={info.getValue()} />,
    filterFn: filterFor(meta.field),
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

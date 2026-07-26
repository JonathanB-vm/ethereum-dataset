import { createColumnHelper, type Column, type ColumnDef, type SortingFn } from '@tanstack/react-table'
import { getColumnMeta, LOADED_COLUMNS, type ColumnMeta, type DictionaryField } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { compareNumericStrings } from '../../data/transform'
import { DictionaryInfoTrigger } from '../dictionary/DictionaryPanel'
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
  TxHashCell,
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

function metaLabel(field: DictionaryField): string {
  return getColumnMeta(field)?.label ?? String(field)
}

// The transactions tab renders two columns under a friendlier, unit-specific label than
// the dictionary's own (see transactionColumns below) — this is the single place both the
// header cell and FilterChips.tsx read from, so a chip for `value_lossless_tx` says
// "Value ETH" (what's actually on screen) rather than the dictionary's "Value (lossless)".
// The overrides are tab-scoped: the All Records tab shows those same fields as raw wei
// (RawCell, no unit conversion), so there the header/chip keeps the dictionary's own label.
const DISPLAY_LABEL_OVERRIDES: Partial<Record<keyof EthRecord, string>> = {
  value_lossless_tx: 'Value ETH',
  gas_price_tx: 'Gas Price Gwei',
}

export function columnDisplayLabel(field: DictionaryField, tab: TabId): string {
  if (tab === 'all') return metaLabel(field)
  return DISPLAY_LABEL_OVERRIDES[field as keyof EthRecord] ?? metaLabel(field)
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
 * driven by the field's dictionary `kind`. The label always routes through
 * `columnDisplayLabel(field, tab)` — the single source of truth FilterChips also reads —
 * so a header and its filter chip can never disagree. `rangeUnit` is only passed for the
 * two transactions-tab columns whose registered filterFn is the display-unit-aware
 * `'rangeEth'`/`'rangeGwei'` (see columns below) — it tells FilterControls to label its
 * Min/Max inputs "(ETH)"/"(Gwei)" so the unit a bound is compared in is never a guess.
 */
function header(tab: TabId, field: DictionaryField, rangeUnit?: string) {
  const displayLabel = columnDisplayLabel(field, tab)
  const meta = getColumnMeta(field)
  const filterFn = meta ? filterFnForKind(meta.kind) : undefined
  return ({ column }: { column: Column<EthRecord, unknown> }) => (
    <div className="col-header-cell">
      <DictionaryInfoTrigger field={field} label={displayLabel} />
      <SortableHeader label={displayLabel} column={column} />
      {meta && filterFn && (
        <FilterControls column={column} kind={meta.kind} label={displayLabel} rangeUnit={rangeUnit} />
      )}
    </div>
  )
}

/** The registered filterFn (string key into filters.ts's `customFilterFns`) for a field's dictionary `kind`, or undefined for `timestamp`. */
function filterFor(field: DictionaryField) {
  const meta = getColumnMeta(field)
  return meta ? filterFnForKind(meta.kind) : undefined
}

// ---------- transfers tab ----------

const transferColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header('transfers', 'block_timestamp'),
    cell: (info) => <TimeCell value={info.getValue()} />,
  }),
  helper.accessor('block_number', {
    header: header('transfers', 'block_number'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('block_number'),
  }),
  helper.accessor('transaction_hash', {
    header: header('transfers', 'transaction_hash'),
    cell: (info) => <TxHashCell value={info.getValue()} />,
    filterFn: filterFor('transaction_hash'),
  }),
  helper.accessor('event_type', {
    header: header('transfers', 'event_type'),
    cell: (info) => <BadgeCell label={info.getValue()} />,
    filterFn: filterFor('event_type'),
  }),
  helper.accessor('address', {
    header: header('transfers', 'address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('address'),
  }),
  helper.accessor('from_address', {
    header: header('transfers', 'from_address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('from_address'),
  }),
  helper.accessor('to_address', {
    header: header('transfers', 'to_address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('to_address'),
  }),
  helper.accessor('quantity', {
    header: header('transfers', 'quantity'),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: filterFor('quantity'),
  }),
  helper.accessor('token_id', {
    header: header('transfers', 'token_id'),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: filterFor('token_id'),
  }),
  helper.accessor('event_index', {
    header: header('transfers', 'event_index'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('event_index'),
  }),
] as ColumnDef<EthRecord>[]

// ---------- transactions tab ----------

const transactionColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header('transactions', 'block_timestamp'),
    cell: (info) => <TimeCell value={info.getValue()} />,
  }),
  helper.accessor('block_number', {
    header: header('transactions', 'block_number'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('block_number'),
  }),
  helper.accessor('transaction_index', {
    header: header('transactions', 'transaction_index'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('transaction_index'),
  }),
  helper.accessor('transaction_hash', {
    header: header('transactions', 'transaction_hash'),
    cell: (info) => <TxHashCell value={info.getValue()} />,
    filterFn: filterFor('transaction_hash'),
  }),
  helper.accessor('from_address_tx', {
    header: header('transactions', 'from_address_tx'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('from_address_tx'),
  }),
  helper.accessor('to_address_tx', {
    header: header('transactions', 'to_address_tx'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    filterFn: filterFor('to_address_tx'),
  }),
  helper.accessor('value_lossless_tx', {
    // columnDisplayLabel resolves this to the DISPLAY_LABEL_OVERRIDES entry ("Value ETH",
    // not the dictionary's "Value (lossless)") — this column renders the wei value
    // converted to ETH, so the header should say what's actually on screen. The filter
    // has to match: 'rangeEth' (not the generic 'range' `filterFor` would give a bignum
    // column) converts a typed ETH bound to wei before comparing, so "≥ 1" here means
    // ≥ 1 ETH, matching what's displayed — not ≥ 1 wei, which off by 10^18 would make
    // almost every bound a no-op.
    header: header('transactions', 'value_lossless_tx', 'ETH'),
    cell: (info) => <EthValueCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: 'rangeEth',
  }),
  helper.accessor('gas_price_tx', {
    // Same reasoning as above — displayed in Gwei, not the dictionary's raw "Gas Price"
    // (wei), so its filter ('rangeGwei') converts a typed Gwei bound to wei (off by 10^9
    // if left as the generic 'range').
    header: header('transactions', 'gas_price_tx', 'Gwei'),
    cell: (info) => <GweiCell value={info.getValue()} />,
    sortingFn: 'bignum',
    filterFn: 'rangeGwei',
  }),
  helper.accessor('gas_tx', {
    header: header('transactions', 'gas_tx'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('gas_tx'),
  }),
  helper.accessor('nonce_tx', {
    header: header('transactions', 'nonce_tx'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    filterFn: filterFor('nonce_tx'),
  }),
  helper.accessor('type_tx', {
    header: header('transactions', 'type_tx'),
    cell: (info) => <BadgeCell label={txTypeLabel(info.getValue())} />,
    filterFn: filterFor('type_tx'),
  }),
] as ColumnDef<EthRecord>[]

// ---------- all-records tab ----------
// Every one of the 34 loaded dictionary columns (`input_tx` is fetched per row — see
// RowDetail), in CSV order, shown as raw (mono, truncated) values — this tab is the
// "inspect the export as-is" escape hatch, so it deliberately skips unit conversion and the
// curated tabs' friendly labels: columnDisplayLabel('all') never applies
// DISPLAY_LABEL_OVERRIDES (a "Value ETH" header over raw-wei cells would misstate the unit
// by 10^18).

const allColumns: ColumnDef<EthRecord>[] = LOADED_COLUMNS.map((meta) =>
  helper.accessor(meta.field, {
    header: header('all', meta.field),
    cell: (info) => <RawCell value={info.getValue()} />,
    sortingFn: meta.kind === 'bignum' ? 'bignum' : undefined,
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

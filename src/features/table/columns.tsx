import {
  createColumnHelper,
  type ColumnDef,
  type HeaderContext,
  type RowData,
  type SortingFn,
} from '@tanstack/react-table'
import { initials } from '../../../registry/registry'
import {
  getColumnMeta,
  LOADED_COLUMNS,
  type ColumnMeta,
  type DictionaryField,
} from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { compareNormalizedQuantity, compareNumericStrings } from '../../data/transform'
import { lookupToken, tokenDecimals, type TokenRegistry } from '../../data/tokenRegistry'
import { EMPTY_VARIABLE_VALUES, type VariableValues } from '../../data/variableValues'
import { DictionaryInfoTrigger } from '../dictionary/DictionaryPanel'
import { SortableHeader } from './SortableHeader'
import { FilterControls, type RangeUnit } from './FilterControls'
import { BlockTimeFilterControl } from './BlockTimeFilterControl'
import { normalizedRangeFilter, type RangeFilterValue } from './filters'
import type { TabId } from './Tabs'
import {
  AddressCell,
  BadgeCell,
  BigNumCell,
  EthValueCell,
  GweiCell,
  NormalizedQuantityCell,
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
  // Per-column presentation hints DataTable reads when it renders <th>/<td>.
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Added to the column's header and body cells. */
    className?: string
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

// Columns where "biggest" is the interesting end, so the first header click should descend.
// Deliberately an explicit list rather than derived from `kind`: `kind: 'number' | 'bignum'`
// also covers block_number, transaction_index, event_index, batch_index, nonce_tx and
// chain_id_tx — positions and counters, where ascending is the natural first read — and
// token_id, which is a bignum but an identifier, not a magnitude.
const DESC_FIRST_FIELDS = new Set<DictionaryField>([
  'quantity',
  'value_tx',
  'value_lossless_tx',
  'gas_tx',
  'gas_price_tx',
  'max_fee_per_gas_tx',
  'max_priority_fee_per_gas_tx',
])

function descFirst(field: DictionaryField): boolean {
  return DESC_FIRST_FIELDS.has(field)
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
// `timestamp` columns get none of their own — `block_timestamp` is 1:1 with `block_number`,
// so its header renders BlockTimeFilterControl (see `header` below), which writes
// `block_number`'s range filter instead.
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

/** Block and time are one constraint in this dataset, so both headers render the same control — see BlockTimeFilterControl. */
const BLOCK_AXIS_FIELDS = new Set<DictionaryField>(['block_number', 'block_timestamp'])

/**
 * Builds a header cell: sort control (SortableHeader) + filter popover (FilterControls) —
 * except for `block_number`/`block_timestamp` (see `BLOCK_AXIS_FIELDS`), where the filter
 * side renders the shared `BlockTimeFilterControl` instead, since those two columns are one
 * constraint rather than two independently-filterable ones. Driven by the field's dictionary
 * `kind`. The label always routes through
 * `columnDisplayLabel(field, tab)` — the single source of truth FilterChips also reads —
 * so a header and its filter chip can never disagree. `rangeUnit` is only passed for the
 * two transactions-tab columns whose registered filterFn is the display-unit-aware
 * `'rangeEth'`/`'rangeGwei'` (see columns below) — it tells FilterControls to label its
 * Min/Max inputs "(ETH)"/"(Gwei)" so the unit a bound is compared in is never a guess.
 */
function header(tab: TabId, field: DictionaryField, rangeUnit?: RangeUnit) {
  const displayLabel = columnDisplayLabel(field, tab)
  const meta = getColumnMeta(field)
  const filterFn = meta ? filterFnForKind(meta.kind) : undefined
  const isBlockAxis = BLOCK_AXIS_FIELDS.has(field)
  return ({ column, table }: HeaderContext<EthRecord, unknown>) => (
    <div className="col-header-cell">
      <DictionaryInfoTrigger field={field} label={displayLabel} />
      <SortableHeader label={displayLabel} column={column} sortCount={table.getState().sorting.length} />
      {meta?.variable && (
        <span
          className="col-header__creator"
          title={`Created by ${meta.variable.createdBy.name}`}
          aria-label={`Created by ${meta.variable.createdBy.name}`}
          role="img"
        >
          {initials(meta.variable.createdBy.name)}
        </span>
      )}
      {isBlockAxis ? (
        <BlockTimeFilterControl table={table} label={displayLabel} />
      ) : (
        meta &&
        filterFn && (
          <FilterControls column={column} kind={meta.kind} label={displayLabel} rangeUnit={rangeUnit} />
        )
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

/**
 * The derived Normalized Quantity column. Its sort and filter close over the registry rather
 * than being registered by string key (the `bignum`/`rangeEth` pattern) because they need
 * per-row metadata that isn't on the record — TanStack accepts a function directly, so no
 * module augmentation is needed.
 *
 * The cell/filter read the raw `quantity` and `row.original.address` (looked up against
 * `tokens`) directly off the row, not off the accessor's own value. The accessor itself
 * returns `undefined` for a row with no normalizable value (unknown decimals, or no
 * quantity) instead of the raw quantity — paired with `sortUndefined: 'last'`, that's what
 * pins those rows to the bottom *regardless of sort direction*. TanStack applies
 * `sortUndefined` before it negates the comparator's result for a descending sort (see
 * `getSortedRowModel`), so it isn't subject to that negation the way a plain
 * "return 1 to sort last" from `sortingFn` would be — a magnitude column here is
 * `sortDescFirst`, so the very first click already sorts descending, and a comparator that
 * only knows how to sort unknowns last in *ascending* order (as `compareNormalizedQuantity`
 * does, matching `compareNumericStrings`) would put them first on that first click instead.
 *
 * Known limitation (reviewed, accepted): in `@tanstack/table-core@8.21.3`, `sortUndefined`'s
 * generated comparator returns a constant `1` — not `0` — when *both* rows' values are
 * undefined, so it is inconsistent over that group and skips both `sortingFn` and TanStack's
 * stable row-index tie-break for it. In a multi-sort with this column primary, the
 * unknown-decimals rows are therefore not ordered by the secondary sort column — their
 * relative order is left to V8's sort. The numeric `sortUndefined` alternative was rejected:
 * it reintroduces unknowns sorting *first* on a descending sort.
 */
function normalizedQuantityColumn(tokens: TokenRegistry): ColumnDef<EthRecord> {
  return helper.accessor(
    (r) => {
      const decimals = tokenDecimals(tokens, r.address)
      return decimals == null || r.quantity == null ? undefined : r.quantity
    },
    {
      id: 'normalized_quantity',
      // Note on the `header(...)` unit argument: `RangeUnit.decimals` drives only the popover's
      // own bound *validation* (`FilterControls.boundToComparable`) and its `inputMode`, not
      // the row comparison — the real per-row scaling happens in `normalizedRangeFilter` above.
      // 18 is passed because it is the widest scale in this dataset, so no realistic bound is
      // rejected as unparseable. The label makes the unit explicit: the inputs read
      // "Min (token units)".
      header: header('transfers', 'normalized_quantity', { label: 'token units', decimals: 18 }),
      cell: (info) => (
        <NormalizedQuantityCell
          quantity={info.row.original.quantity}
          token={lookupToken(tokens, info.row.original.address)}
        />
      ),
      // A magnitude, like the `quantity` column it mirrors — biggest first is the interesting
      // read. Not added to DESC_FIRST_FIELDS, which is keyed to the raw dictionary fields.
      sortDescFirst: true,
      sortUndefined: 'last',
      sortingFn: (rowA, rowB) =>
        compareNormalizedQuantity(
          rowA.original.quantity,
          tokenDecimals(tokens, rowA.original.address),
          rowB.original.quantity,
          tokenDecimals(tokens, rowB.original.address),
        ),
      filterFn: (row, _columnId, filterValue: RangeFilterValue | undefined) =>
        normalizedRangeFilter(
          row.original.quantity,
          tokenDecimals(tokens, row.original.address),
          filterValue ?? {},
        ),
    },
  ) as ColumnDef<EthRecord>
}

function transferColumns(tokens: TokenRegistry): ColumnDef<EthRecord>[] {
  return [
  helper.accessor('block_timestamp', {
    header: header('transfers', 'block_timestamp'),
    cell: (info) => <TimeCell value={info.getValue()} />,
    sortDescFirst: descFirst('block_timestamp'),
  }),
  helper.accessor('block_number', {
    header: header('transfers', 'block_number'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    // Without this, TanStack's own auto-heuristic (getAutoSortDir: numeric values sort desc
    // first, string values asc first) overrides the "positions ascend first" intent below —
    // block_number's value is a JS number, so it would silently default to desc-first despite
    // not being in DESC_FIRST_FIELDS. Every accessor below now sets this explicitly for the
    // same reason (not just the ones that happen to be numbers): DESC_FIRST_FIELDS is the
    // single authority for first-click direction, on every tab, and no column is left for
    // the heuristic to guess at. Matches the 'all' tab, which already did this for every
    // field via the same descFirst() helper.
    sortDescFirst: descFirst('block_number'),
    filterFn: filterFor('block_number'),
  }),
  helper.accessor('transaction_hash', {
    header: header('transfers', 'transaction_hash'),
    cell: (info) => <TxHashCell value={info.getValue()} />,
    sortDescFirst: descFirst('transaction_hash'),
    filterFn: filterFor('transaction_hash'),
  }),
  helper.accessor('event_type', {
    header: header('transfers', 'event_type'),
    cell: (info) => <BadgeCell label={info.getValue()} />,
    sortDescFirst: descFirst('event_type'),
    filterFn: filterFor('event_type'),
  }),
  helper.accessor('address', {
    header: header('transfers', 'address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    sortDescFirst: descFirst('address'),
    filterFn: filterFor('address'),
  }),
  helper.accessor('from_address', {
    header: header('transfers', 'from_address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    sortDescFirst: descFirst('from_address'),
    filterFn: filterFor('from_address'),
  }),
  helper.accessor('to_address', {
    header: header('transfers', 'to_address'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    sortDescFirst: descFirst('to_address'),
    filterFn: filterFor('to_address'),
  }),
  helper.accessor('quantity', {
    header: header('transfers', 'quantity'),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    sortingFn: 'bignum',
    sortDescFirst: descFirst('quantity'),
    filterFn: filterFor('quantity'),
  }),
  normalizedQuantityColumn(tokens),
  helper.accessor('token_id', {
    header: header('transfers', 'token_id'),
    cell: (info) => <BigNumCell value={info.getValue()} />,
    sortingFn: 'bignum',
    sortDescFirst: descFirst('token_id'),
    filterFn: filterFor('token_id'),
  }),
  helper.accessor('event_index', {
    header: header('transfers', 'event_index'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    sortDescFirst: descFirst('event_index'),
    filterFn: filterFor('event_index'),
  }),
  ] as ColumnDef<EthRecord>[]
}

// ---------- transactions tab ----------

const transactionColumns: ColumnDef<EthRecord>[] = [
  helper.accessor('block_timestamp', {
    header: header('transactions', 'block_timestamp'),
    cell: (info) => <TimeCell value={info.getValue()} />,
    sortDescFirst: descFirst('block_timestamp'),
  }),
  helper.accessor('block_number', {
    header: header('transactions', 'block_number'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    // See the same field in transferColumns above for why this is needed.
    sortDescFirst: descFirst('block_number'),
    filterFn: filterFor('block_number'),
  }),
  helper.accessor('transaction_index', {
    header: header('transactions', 'transaction_index'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    sortDescFirst: descFirst('transaction_index'),
    filterFn: filterFor('transaction_index'),
  }),
  helper.accessor('transaction_hash', {
    header: header('transactions', 'transaction_hash'),
    cell: (info) => <TxHashCell value={info.getValue()} />,
    sortDescFirst: descFirst('transaction_hash'),
    filterFn: filterFor('transaction_hash'),
  }),
  helper.accessor('from_address_tx', {
    header: header('transactions', 'from_address_tx'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    sortDescFirst: descFirst('from_address_tx'),
    filterFn: filterFor('from_address_tx'),
  }),
  helper.accessor('to_address_tx', {
    header: header('transactions', 'to_address_tx'),
    cell: (info) => <AddressCell value={info.getValue()} />,
    sortDescFirst: descFirst('to_address_tx'),
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
    header: header('transactions', 'value_lossless_tx', { label: 'ETH', decimals: 18 }),
    cell: (info) => <EthValueCell value={info.getValue()} />,
    sortingFn: 'bignum',
    sortDescFirst: descFirst('value_lossless_tx'),
    filterFn: 'rangeEth',
  }),
  helper.accessor('gas_price_tx', {
    // Same reasoning as above — displayed in Gwei, not the dictionary's raw "Gas Price"
    // (wei), so its filter ('rangeGwei') converts a typed Gwei bound to wei (off by 10^9
    // if left as the generic 'range').
    header: header('transactions', 'gas_price_tx', { label: 'Gwei', decimals: 9 }),
    cell: (info) => <GweiCell value={info.getValue()} />,
    sortingFn: 'bignum',
    sortDescFirst: descFirst('gas_price_tx'),
    filterFn: 'rangeGwei',
  }),
  helper.accessor('gas_tx', {
    header: header('transactions', 'gas_tx'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    sortDescFirst: descFirst('gas_tx'),
    filterFn: filterFor('gas_tx'),
  }),
  helper.accessor('nonce_tx', {
    header: header('transactions', 'nonce_tx'),
    cell: (info) => <NumberCell value={info.getValue()} />,
    sortDescFirst: descFirst('nonce_tx'),
    filterFn: filterFor('nonce_tx'),
  }),
  helper.accessor('type_tx', {
    header: header('transactions', 'type_tx'),
    cell: (info) => <BadgeCell label={txTypeLabel(info.getValue())} />,
    sortDescFirst: descFirst('type_tx'),
    filterFn: filterFor('type_tx'),
  }),
] as ColumnDef<EthRecord>[]

// ---------- research variables (every tab) ----------

/**
 * One column per registered research variable, appended to every tab. Values are per
 * transaction and live in the `values` lookup rather than on the record, so — like
 * Normalized Quantity — the accessor closes over it.
 *
 * The accessor returns `undefined` for a transaction the variable wasn't computed for,
 * which with `sortUndefined: 'last'` keeps those rows at the bottom in either direction
 * (see normalizedQuantityColumn for why that can't be done in the comparator). The 0/1
 * value is shown as-is, so the cell, the filter's checkbox labels and the CSV export all
 * read the same.
 *
 * `meta.className` tints the whole column (header and cells, see table.css) so derived
 * research columns read as distinct from the dataset's own; the header also carries the
 * creator's initials (see `header()`).
 */
function variableColumns(tab: TabId, values: VariableValues): ColumnDef<EthRecord>[] {
  return values.columns.map((meta) =>
    helper.accessor((r) => values.get(meta.field, r) ?? undefined, {
      id: meta.field,
      header: header(tab, meta.field),
      cell: (info) => {
        const v = info.getValue()
        if (tab === 'all') return <RawCell value={v} />
        return <BadgeCell label={v == null ? null : String(v)} />
      },
      // A flag's interesting end is 1, so the first click puts flagged rows on top.
      sortDescFirst: true,
      sortUndefined: 'last',
      filterFn: 'enumMulti',
      meta: { className: 'col--variable' },
    }),
  ) as ColumnDef<EthRecord>[]
}

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
    sortDescFirst: descFirst(meta.field),
    filterFn: filterFor(meta.field),
  }),
) as ColumnDef<EthRecord>[]

/**
 * `tokens` is only consumed by the transfers tab's derived Normalized Quantity column.
 * `values` feeds the research-variable columns every tab ends with, so each call builds a
 * fresh array — DataTable memoizes it on (tab, tokens, values).
 */
export function getColumnsForTab(
  tab: TabId,
  tokens: TokenRegistry,
  values: VariableValues = EMPTY_VARIABLE_VALUES,
): ColumnDef<EthRecord>[] {
  switch (tab) {
    case 'transfers':
      return [...transferColumns(tokens), ...variableColumns(tab, values)]
    case 'transactions':
      return [...transactionColumns, ...variableColumns(tab, values)]
    case 'all':
      return [...allColumns, ...variableColumns(tab, values)]
  }
}

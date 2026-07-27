import type { DictionaryField } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'

/**
 * Field metadata shared between `RowDetail.tsx` (the table feature) and `DictionaryPanel`
 * (the dictionary feature, `../dictionary/DictionaryPanel.tsx`) — split into its own module,
 * rather than living inside `RowDetail.tsx`, for two reasons: (1) it lets `RowDetail.tsx`
 * export only the `RowDetail` component, satisfying the `react(only-export-components)`
 * fast-refresh lint rule (the same reasoning `dictionaryPanelContext.ts` was split out for
 * `DictionaryPanel.tsx`), and (2) once `DictionaryPanel` also consumes `HUMAN_UNIT`, this
 * data is no longer really "RowDetail-only" — it's field-display metadata both features
 * share.
 */

export interface FieldGroup {
  title: string
  fields: DictionaryField[]
}

// All 36 dictionary fields, partitioned into the brief's three groups. Order within each
// group follows COLUMNS' own CSV order. Every field in `dictionary.ts` appears exactly
// once across the three arrays — enforced by `RowDetail.test.ts`, which asserts
// `GROUPS.flatMap(g => g.fields)` is length- and set-equal to `COLUMNS.map(c => c.field)`
// (catches both an omitted field and an accidental duplicate/foreign field).
export const GROUPS: FieldGroup[] = [
  {
    title: 'Block & Transaction',
    fields: [
      'block_hash', 'block_number', 'block_timestamp', 'transaction_hash', 'transaction_index',
      'nonce_tx', 'from_address_tx', 'to_address_tx', 'value_tx', 'value_lossless_tx',
      'gas_tx', 'gas_price_tx', 'type_tx', 'chain_id_tx', 'is_token_transfer',
    ],
  },
  {
    title: 'Token Transfer',
    fields: [
      'event_index', 'batch_index', 'address', 'event_type', 'event_hash', 'event_signature',
      'operator_address', 'from_address', 'to_address', 'token_id', 'quantity',
      'normalized_quantity', 'removed',
    ],
  },
  {
    title: 'Signature & Advanced',
    fields: [
      'input_tx', 'max_fee_per_gas_tx', 'max_priority_fee_per_gas_tx', 'access_list_tx',
      'r_tx', 's_tx', 'v_tx', 'y_parity_tx',
    ],
  },
]

// Human-readable/display-unit conversion, keyed by field — only the fields the brief calls
// out (ETH for value_lossless_tx, Gwei for gas_price_tx/max fees). `value_tx` shares
// value_lossless_tx's unit (also raw wei) so it gets the same treatment for consistency.
// Consumed by both `RowDetail` (raw value + "≈ human unit" secondary line) and
// `DictionaryPanel`'s `StatValue` (converts `computeColumnStats`' raw wei min/max
// display-side) — see that file's `convertStatValue` for why this is shared, not duplicated.
export const HUMAN_UNIT: Partial<Record<keyof EthRecord, string>> = {
  value_tx: 'ETH',
  value_lossless_tx: 'ETH',
  gas_price_tx: 'Gwei',
  max_fee_per_gas_tx: 'Gwei',
  max_priority_fee_per_gas_tx: 'Gwei',
}

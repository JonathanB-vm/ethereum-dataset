import { CopyButton } from '../../components/CopyButton'
import { getColumnMeta } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { formatTimestamp, weiToEth, weiToGwei } from '../../data/transform'

interface RowDetailProps {
  record: EthRecord
}

interface FieldGroup {
  title: string
  fields: (keyof EthRecord)[]
}

// All 35 dictionary fields, partitioned into the brief's three groups. Order within each
// group follows COLUMNS' own CSV order. Every field in `dictionary.ts` appears exactly
// once across the three arrays (verified by a RowDetail test, see RowDetail.test.tsx —
// none exists yet, this is enforced by inspection since the groups are a fixed constant).
const GROUPS: FieldGroup[] = [
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
      'operator_address', 'from_address', 'to_address', 'token_id', 'quantity', 'removed',
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

// Human-readable conversion, keyed by field — only the fields the brief calls out (ETH for
// value_lossless_tx, Gwei for gas_price_tx/max fees, timestamp). `value_tx` shares
// value_lossless_tx's unit (also raw wei) so it gets the same treatment for consistency.
const HUMAN_READABLE: Partial<Record<keyof EthRecord, (raw: string) => string | null>> = {
  value_tx: weiToEth,
  value_lossless_tx: weiToEth,
  gas_price_tx: weiToGwei,
  max_fee_per_gas_tx: weiToGwei,
  max_priority_fee_per_gas_tx: weiToGwei,
  block_timestamp: (raw) => formatTimestamp(raw),
}
const HUMAN_UNIT: Partial<Record<keyof EthRecord, string>> = {
  value_tx: 'ETH',
  value_lossless_tx: 'ETH',
  gas_price_tx: 'Gwei',
  max_fee_per_gas_tx: 'Gwei',
  max_priority_fee_per_gas_tx: 'Gwei',
}

function rawString(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/**
 * Expanded panel rendered under a table row (see DataTable.tsx) listing every one of the
 * 35 dictionary fields for that record, grouped into three sections. Each field shows its
 * full raw value (mono, wrap-anywhere, copyable) and, where the field's kind allows, a
 * human-readable rendering beside it (ETH/Gwei/formatted timestamp).
 */
export function RowDetail({ record }: RowDetailProps) {
  return (
    <div className="row-detail">
      {GROUPS.map((group) => (
        <section key={group.title} className="row-detail__group">
          <h3 className="row-detail__group-title">{group.title}</h3>
          <div className="row-detail__grid">
            {group.fields.map((field) => {
              const meta = getColumnMeta(field)
              const raw = rawString(record[field])
              const humanFn = raw != null ? HUMAN_READABLE[field] : undefined
              const human = humanFn ? humanFn(raw as string) : null
              const unit = HUMAN_UNIT[field]
              return (
                <div key={String(field)} className="row-detail__field">
                  <span className="row-detail__field-label">{meta?.label ?? String(field)}</span>
                  {raw == null ? (
                    <span className="row-detail__field-value row-detail__field-value--empty">–</span>
                  ) : (
                    <span className="row-detail__field-value">
                      <span className="row-detail__field-raw">{raw}</span>
                      <CopyButton value={raw} />
                    </span>
                  )}
                  {human != null && (
                    <span className="row-detail__field-human">
                      ≈ {human}
                      {unit ? ` ${unit}` : ''}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

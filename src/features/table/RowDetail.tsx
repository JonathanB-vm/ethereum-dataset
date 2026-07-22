import { CopyButton } from '../../components/CopyButton'
import { getColumnMeta } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { formatTimestamp, weiToEth, weiToGwei } from '../../data/transform'
import { GROUPS, HUMAN_UNIT } from './rowDetailFields'

interface RowDetailProps {
  record: EthRecord
}

// Human-readable conversion, keyed by field — only the fields the brief calls out (ETH for
// value_lossless_tx, Gwei for gas_price_tx/max fees, timestamp). `value_tx` shares
// value_lossless_tx's unit (also raw wei) so it gets the same treatment for consistency.
// `HUMAN_UNIT` (the field→unit label half of this) lives in `./rowDetailFields` — shared
// with `DictionaryPanel`, see that module's doc comment — but the conversion *functions*
// stay local here since only `RowDetail` needs the timestamp one too.
const HUMAN_READABLE: Partial<Record<keyof EthRecord, (raw: string) => string | null>> = {
  value_tx: weiToEth,
  value_lossless_tx: weiToEth,
  gas_price_tx: weiToGwei,
  max_fee_per_gas_tx: weiToGwei,
  max_priority_fee_per_gas_tx: weiToGwei,
  block_timestamp: (raw) => formatTimestamp(raw),
}

function rawString(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/**
 * Expanded panel rendered under a table row (see DataTable.tsx) listing every one of the
 * 35 dictionary fields for that record, grouped into three sections (`GROUPS`, in
 * `./rowDetailFields`). Each field shows its full raw value (mono, wrap-anywhere, copyable)
 * and, where the field's kind allows, a human-readable rendering beside it (ETH/Gwei/
 * formatted timestamp).
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

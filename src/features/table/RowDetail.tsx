import { CopyButton } from '../../components/CopyButton'
import { getColumnMeta } from '../../data/dictionary'
import type { EthRecord } from '../../data/types'
import { formatNormalizedQuantity, formatTimestamp, truncateMiddle, weiToEth, weiToGwei } from '../../data/transform'
import { lookupToken, type TokenRegistry } from '../../data/tokenRegistry'
import { CalldataField } from './CalldataField'
import { GROUPS, HUMAN_UNIT } from './rowDetailFields'

interface RowDetailProps {
  record: EthRecord
  tokens: TokenRegistry
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
  // 'True'/'False' (not JS's lowercase toString) to match the CSV, export, and enum filter
  // labels' capitalization — one convention across every surface that shows the stored value.
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/**
 * Expanded panel rendered under a table row (see DataTable.tsx) listing every one of the
 * 36 dictionary fields for that record, grouped into three sections (`GROUPS`, in
 * `./rowDetailFields`). Each loaded field shows its full raw value (mono, wrap-anywhere,
 * copyable) and, where the field's kind allows, a human-readable rendering beside it (ETH/
 * Gwei/formatted timestamp). The one on-demand field (`input_tx`) isn't held in memory —
 * see `getColumnMeta`'s `availability` — so it renders via `CalldataField`, which fetches
 * the value per row the moment it's expanded, instead of reading off `record`. The one
 * derived field (`normalized_quantity`) is likewise absent from `record`; it's computed
 * from `tokens`, the registry passed down from `DataTable`/`RowFullscreen`.
 */
export function RowDetail({ record, tokens }: RowDetailProps) {
  return (
    <div className="row-detail">
      {GROUPS.map((group) => (
        <section key={group.title} className="row-detail__group">
          <h3 className="row-detail__group-title">{group.title}</h3>
          <div className="row-detail__grid">
            {group.fields.map((field) => {
              const meta = getColumnMeta(field)
              if (meta?.availability === 'on-demand') {
                return (
                  <CalldataField
                    key={String(field)}
                    txHash={record.transaction_hash}
                    label={meta.label}
                  />
                )
              }
              // Derived fields have no value on the record — `record[field]` would be
              // undefined and render as a dash. This one is computed the same way the
              // table cell computes it, so an expanded row can't disagree with the row
              // above it.
              if (field === 'normalized_quantity') {
                const token = lookupToken(tokens, record.address)
                const text =
                  token == null ? null : formatNormalizedQuantity(record.quantity, token.decimals)
                return (
                  <div key={String(field)} className="row-detail__field">
                    <span className="row-detail__field-label">{meta?.label ?? String(field)}</span>
                    {text == null ? (
                      <span className="row-detail__field-value row-detail__field-value--empty">–</span>
                    ) : (
                      <span className="row-detail__field-value">
                        <span className="row-detail__field-raw">{text}</span>
                        {token?.symbol && (
                          <span className="row-detail__field-human">{token.symbol}</span>
                        )}
                      </span>
                    )}
                  </div>
                )
              }
              const raw = rawString(record[field as keyof EthRecord])
              const humanFn = raw != null ? HUMAN_READABLE[field as keyof EthRecord] : undefined
              const human = humanFn ? humanFn(raw as string) : null
              const unit = HUMAN_UNIT[field as keyof EthRecord]
              return (
                <div key={String(field)} className="row-detail__field">
                  <span className="row-detail__field-label">{meta?.label ?? String(field)}</span>
                  {raw == null ? (
                    <span className="row-detail__field-value row-detail__field-value--empty">–</span>
                  ) : (
                    <span className="row-detail__field-value">
                      {/* Long blobs (access lists, r/s signatures) render head…tail so one
                          field can't blow the panel up vertically. The full value stays
                          reachable two ways: hover (`title`) and copy — the CopyButton
                          always receives the untruncated raw string. */}
                      <span className="row-detail__field-raw" title={raw}>
                        {truncateMiddle(raw)}
                      </span>
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

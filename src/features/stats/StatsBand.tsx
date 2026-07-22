import { formatCount as fmtInt, formatTimestamp } from '../../data/transform'
import type { DatasetStats } from './computeStats'
import './stats.css'

interface StatsBandProps {
  stats: DatasetStats
}

/** Two-segment proportion bar: tx (muted) vs transfers (accent). */
function RecordsSplitBar({ txCount, transferCount }: { txCount: number; transferCount: number }) {
  const total = txCount + transferCount
  const txPct = total > 0 ? (txCount / total) * 100 : 0
  const transferPct = total > 0 ? 100 - txPct : 0

  return (
    <>
      <div
        className="stat-tile__bar"
        role="img"
        aria-label={`${fmtInt(txCount)} transactions, ${fmtInt(transferCount)} token transfers`}
      >
        <span className="stat-tile__bar-seg stat-tile__bar-seg--tx" style={{ width: `${txPct}%` }} />
        <span
          className="stat-tile__bar-seg stat-tile__bar-seg--transfer"
          style={{ width: `${transferPct}%` }}
        />
      </div>
      <ul className="stat-tile__legend">
        <li>
          <span className="stat-tile__swatch stat-tile__swatch--tx" aria-hidden="true" />
          Tx <span className="stat-tile__legend-count">{fmtInt(txCount)}</span>
        </li>
        <li>
          <span className="stat-tile__swatch stat-tile__swatch--transfer" aria-hidden="true" />
          Transfers <span className="stat-tile__legend-count">{fmtInt(transferCount)}</span>
        </li>
      </ul>
    </>
  )
}

export function StatsBand({ stats }: StatsBandProps) {
  const gasRange =
    stats.gasPriceMinGwei != null && stats.gasPriceMaxGwei != null
      ? `${stats.gasPriceMinGwei} – ${stats.gasPriceMaxGwei}`
      : '—'

  return (
    <section className="stats-band" aria-label="Dataset statistics">
      <div className="stat-tile">
        <span className="stat-tile__label">Records</span>
        <span className="stat-tile__value">{fmtInt(stats.totalRecords)}</span>
        <RecordsSplitBar txCount={stats.txCount} transferCount={stats.transferCount} />
      </div>

      <div className="stat-tile">
        <span className="stat-tile__label">Token Standards</span>
        {stats.eventTypeCounts.length === 0 ? (
          <span className="stat-tile__value stat-tile__value--muted">—</span>
        ) : (
          <ul className="stat-tile__breakdown">
            {stats.eventTypeCounts.map((e) => (
              <li key={e.type}>
                <span className="stat-tile__breakdown-type">{e.type}</span>
                <span className="stat-tile__breakdown-count">{fmtInt(e.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="stat-tile">
        <span className="stat-tile__label">ETH Moved</span>
        <span className="stat-tile__value">Ξ{stats.totalEthMoved}</span>
      </div>

      <div className="stat-tile">
        <span className="stat-tile__label">Gas Price</span>
        <span className="stat-tile__value">{gasRange}</span>
        <span className="stat-tile__sub">Gwei</span>
      </div>

      <div className="stat-tile">
        <span className="stat-tile__label">Unique Addresses</span>
        <span className="stat-tile__value">{fmtInt(stats.uniqueAddresses)}</span>
      </div>

      <div className="stat-tile">
        <span className="stat-tile__label">Block</span>
        <span className="stat-tile__value">
          {stats.blockNumber != null ? `#${fmtInt(stats.blockNumber)}` : '—'}
        </span>
        <span className="stat-tile__sub">
          {stats.blockTimestamp != null ? formatTimestamp(stats.blockTimestamp) : ' '}
        </span>
      </div>
    </section>
  )
}

import { formatBytes, formatCount, formatDuration, type Estimate } from './accountApi'

const TIER_LABEL: Record<Estimate['tier'], string> = {
  light: 'Light — a year computes in under a minute',
  moderate: 'Moderate — minutes for a year',
  heavy: 'Heavy — needs scheduling on the server',
}

/** The cost of computing a variable, measured on two sample runs and projected. */
export function EstimateView({ estimate }: { estimate: Estimate }) {
  const largest = estimate.samples[estimate.samples.length - 1]
  const runs = largest?.runs ?? 1
  const spread =
    largest?.elapsedMinMs != null && largest.elapsedMaxMs != null
      ? `${formatDuration(largest.elapsedMinMs)}–${formatDuration(largest.elapsedMaxMs)}`
      : formatDuration(largest?.elapsedMs ?? 0)
  const rows: [string, (p: Estimate['loaded']) => string][] = [
    ['Time', (p) => formatDuration(p.elapsedMs)],
    ['Rows read', (p) => formatCount(p.readRows)],
    ['Data read', (p) => formatBytes(p.readBytes)],
    ['Peak memory', (p) => formatBytes(p.memoryBytes)],
    ['Values produced', (p) => formatCount(p.resultRows)],
    ['Storage', (p) => formatBytes(p.storageBytes)],
  ]
  return (
    <div className="acct-estimate">
      <p className={`acct-tier acct-tier--${estimate.tier}`}>{TIER_LABEL[estimate.tier]}</p>
      <table className="acct-estimate__table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Loaded data ({formatCount(estimate.loaded.blocks)} blocks)</th>
            <th scope="col">One year ({formatCount(estimate.year.blocks)} blocks)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{f(estimate.loaded)}</td>
              <td>{f(estimate.year)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="acct-estimate__basis">
        Measured on {estimate.samples.map((s) => `${s.blocks}`).join(' and ')} blocks
        {runs > 1 && `, ${runs} runs each, averaged (the ${largest.blocks}-block run took ${spread})`}
        {estimate.planner.length > 0 &&
          ` · planner: reads ${estimate.planner.map((p) => `${formatCount(p.rows)} rows of ${p.table}`).join(', ')} for the loaded range`}
      </p>
      {estimate.notes.map((n) => (
        <p key={n} className="acct-estimate__note">
          {n}
        </p>
      ))}
    </div>
  )
}

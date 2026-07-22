import { CopyButton } from '../../components/CopyButton'
import { formatBigInt, formatTimestamp, truncateHex, weiToEth, weiToGwei } from '../../data/transform'

/** Shared null/empty rendering — centered, faint, never blank (keeps row height + scan-ability). */
export function NullCell() {
  return (
    <span className="cell-null" aria-hidden="true">
      –
    </span>
  )
}

interface HexCellProps {
  value: string | null
  lead?: number
  tail?: number
  /** Render a deterministic identity swatch before the text (addresses only). */
  swatch?: boolean
}

/**
 * Deterministic hue (0–359) from a hex string's digits — the same address always yields
 * the same hue, so a recurring party gets a recurring color. Fixed saturation/lightness
 * keep every swatch in one family (and legible on both themes); only hue varies.
 */
function hexHue(value: string): number {
  let h = 0
  // Skip the constant '0x' prefix — it carries no identity.
  for (let i = 2; i < value.length; i++) h = (h * 33 + value.charCodeAt(i)) >>> 0
  return h % 360
}

/**
 * Mono hex value, truncated with full value in `title`; reveals a copy button on row
 * hover. The constant `0x` prefix renders faint — every value in a hex column shares it,
 * so de-emphasizing it puts the eye straight on the digits that actually differ.
 */
export function HexCell({ value, lead = 6, tail = 4, swatch = false }: HexCellProps) {
  if (value == null || value === '') return <NullCell />
  const display = truncateHex(value, lead, tail)
  const body = display.startsWith('0x') ? display.slice(2) : display
  return (
    <span className="hex-cell">
      {swatch && (
        <span
          className="hex-cell__swatch"
          aria-hidden="true"
          style={{ background: `hsl(${hexHue(value)} 60% 56%)` }}
        />
      )}
      <span className="hex-cell__text" title={value}>
        {display.startsWith('0x') && <span className="hex-cell__prefix">0x</span>}
        {body}
      </span>
      <CopyButton value={value} />
    </span>
  )
}

/**
 * Addresses use a longer lead (8 chars) so common prefixes stay distinguishable, plus an
 * identity swatch (color derived from the address itself) — repeated addresses become
 * visually trackable across rows without reading the hex. Tx hashes deliberately get no
 * swatch: they're unique per row, so color there would be noise, not signal.
 */
export function AddressCell({ value }: { value: string | null }) {
  return <HexCell value={value} lead={8} swatch />
}

/** Tx hashes share the address treatment minus the swatch — see AddressCell's docstring. */
export function TxHashCell({ value }: { value: string | null }) {
  return <HexCell value={value} lead={8} />
}

/** Wei → ETH. Zero is a real, meaningful value here (not "missing") so it renders faint, not as a dash. */
export function EthValueCell({ value }: { value: string | null }) {
  if (value == null) return <NullCell />
  const eth = weiToEth(value)
  if (eth == null) return <NullCell />
  const isZero = eth === '0'
  return <span className={`num-cell${isZero ? ' num-cell--faint' : ''}`}>{eth}</span>
}

/** Wei → Gwei, with a faint unit suffix so the column stays scannable without a header re-check. */
export function GweiCell({ value }: { value: string | null }) {
  if (value == null) return <NullCell />
  const gwei = weiToGwei(value)
  if (gwei == null) return <NullCell />
  return (
    <span className="num-cell">
      {gwei}
      <span className="num-cell__unit"> Gwei</span>
    </span>
  )
}

export function TimeCell({ value }: { value: string | null }) {
  if (value == null || value === '') return <NullCell />
  return <span className="time-cell">{formatTimestamp(value)}</span>
}

/** Plain integer column (block/tx indexes, gas limit, nonce) — thousands-separated, tabular. */
export function NumberCell({ value }: { value: number | null }) {
  if (value == null) return <NullCell />
  return <span className="num-cell">{value.toLocaleString('en-US')}</span>
}

/** Big-integer string column (quantity, token id) rendered with thousands separators. */
export function BigNumCell({ value }: { value: string | null }) {
  if (value == null) return <NullCell />
  const formatted = formatBigInt(value)
  if (formatted == null) return <NullCell />
  return <span className="num-cell">{formatted}</span>
}

interface BadgeCellProps {
  label: string | number | null
}

/** Small accent-muted pill — used for token standard (event_type) and tx type. */
export function BadgeCell({ label }: BadgeCellProps) {
  if (label == null || label === '') return <NullCell />
  return <span className="badge">{label}</span>
}

/**
 * The "All Records" tab shows every raw CSV value verbatim. It doesn't know a column's
 * `kind`, so it never unit-converts — it truncates long strings the same way hex gets
 * truncated elsewhere, without the copy affordance (35 columns of copy buttons would be
 * more noise than signal; the curated tabs are where copy earns its keep).
 */
export function RawCell({ value }: { value: unknown }) {
  if (value == null || value === '') return <NullCell />
  // Booleans render as 'True'/'False' (not JS's lowercase toString) to match the CSV,
  // export, and enum filter labels' capitalization — one convention across every surface
  // that shows the stored value.
  const str = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)
  const display = str.length > 24 ? truncateHex(str, 10, 6) : str
  return (
    <span className="raw-cell" title={str}>
      {display}
    </span>
  )
}

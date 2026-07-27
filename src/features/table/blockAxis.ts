import type { BlockAxisEntry } from '../../data/types'

/**
 * Position of `raw` on the block axis, snapping to the nearest block when it isn't one of
 * the axis's own values.
 *
 * Positional, not arithmetic: index 1 is "the second distinct block in the dataset", which
 * for a gapped export is not `blockMin + 1`. Indexing by raw numeric span would let a
 * slider handle land in a gap where no rows exist.
 *
 * `Number.parseInt` is safe here — block numbers are small integers, unlike the 256-bit
 * numeric strings elsewhere in this codebase that require `toBigInt`.
 */
export function axisIndexForBlock(axis: BlockAxisEntry[], raw: string): number | null {
  if (axis.length === 0) return null
  const n = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(n)) return null

  let best = 0
  let bestDistance = Math.abs(axis[0].block - n)
  for (let i = 1; i < axis.length; i++) {
    const distance = Math.abs(axis[i].block - n)
    // Strict `<` so a tie keeps the lower index — deterministic, and it matches the
    // left-to-right reading of the axis.
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/** "2026-07-14 23:35:11+00:00" → "23:35:11 UTC". The date is constant across this dataset, so the handle labels show only the clock. */
export function blockTimeLabel(time: string | undefined): string {
  if (!time) return '—'
  return `${time.slice(11, 19)} UTC`
}

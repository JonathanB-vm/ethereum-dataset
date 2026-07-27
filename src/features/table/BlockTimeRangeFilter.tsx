import { useEffect, useState } from 'react'
import type { BlockAxisEntry } from '../../data/types'
import { formatCount } from '../../data/transform'
import { axisIndexForBlock, blockTimeLabel } from './blockAxis'
import type { RangeFilterValue } from './filters'

/** Matches FilterControls.tsx's DEBOUNCE_MS — one filter pass per burst of dragging or typing. */
const DEBOUNCE_MS = 250

interface BlockTimeRangeFilterProps {
  axis: BlockAxisEntry[]
  value: RangeFilterValue | undefined
  onChange: (next: RangeFilterValue | undefined) => void
  /** Rows currently passing every active filter — the footer says the same thing, 50 rows away. */
  matchCount: number
}

/**
 * The one control for both "which blocks" and "which time window". They are the same
 * constraint in this dataset (100 blocks, one timestamp each, ~12s apart), so this writes a
 * plain `block_number` range and labels every handle in both units.
 *
 * State is the two block numbers *as strings*, not as axis indices. That is what lets the
 * text boxes accept a partially-typed number without the slider snapping it mid-keystroke:
 * the sliders read their position back out through `axisIndexForBlock` and write a whole
 * block number in, so there is exactly one source of truth.
 */
export function BlockTimeRangeFilter({ axis, value, onChange, matchCount }: BlockTimeRangeFilterProps) {
  const firstBlock = axis.length > 0 ? String(axis[0].block) : ''
  const lastBlock = axis.length > 0 ? String(axis[axis.length - 1].block) : ''

  const [min, setMin] = useState(() => value?.min ?? firstBlock)
  const [max, setMax] = useState(() => value?.max ?? lastBlock)

  useEffect(() => {
    const t = window.setTimeout(() => {
      // Both handles at the ends means "no constraint" — emitting a full-span range instead
      // would light the funnel and add a chip for a filter that excludes nothing.
      if (min === firstBlock && max === lastBlock) {
        onChange(undefined)
        return
      }
      const next: RangeFilterValue = {}
      if (min.trim() !== '') next.min = min.trim()
      if (max.trim() !== '') next.max = max.trim()
      onChange(next.min == null && next.max == null ? undefined : next)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // `onChange` is deliberately absent: a parent that passes an inline arrow would otherwise
    // restart the debounce on every render. Same pattern as FilterControls.tsx's panels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, firstBlock, lastBlock])

  if (axis.length === 0) {
    return <p className="filter-popover__empty">No blocks loaded</p>
  }

  const lastIndex = axis.length - 1
  const minIndex = axisIndexForBlock(axis, min) ?? 0
  const maxIndex = axisIndexForBlock(axis, max) ?? lastIndex

  return (
    <div className="block-range">
      <p className="block-range__title">Block &amp; time range</p>

      <div className="block-range__sliders">
        <input
          type="range"
          className="block-range__slider block-range__slider--min"
          aria-label="Range start"
          min={0}
          max={lastIndex}
          step={1}
          value={minIndex}
          onChange={(e) => setMin(String(axis[Math.min(Number(e.target.value), maxIndex)].block))}
        />
        <input
          type="range"
          className="block-range__slider block-range__slider--max"
          aria-label="Range end"
          min={0}
          max={lastIndex}
          step={1}
          value={maxIndex}
          onChange={(e) => setMax(String(axis[Math.max(Number(e.target.value), minIndex)].block))}
        />
      </div>

      <div className="block-range__readout">
        <span className="block-range__endpoint">
          <span className="block-range__block" data-testid="block-range-min-block">
            {formatCount(axis[minIndex].block)}
          </span>
          <span className="block-range__time" data-testid="block-range-min-time">
            {blockTimeLabel(axis[minIndex].time)}
          </span>
        </span>
        <span className="block-range__endpoint block-range__endpoint--right">
          <span className="block-range__block" data-testid="block-range-max-block">
            {formatCount(axis[maxIndex].block)}
          </span>
          <span className="block-range__time" data-testid="block-range-max-time">
            {blockTimeLabel(axis[maxIndex].time)}
          </span>
        </span>
      </div>

      <div className="filter-popover__range">
        <label className="filter-popover__field">
          <span className="filter-popover__label">Min block</span>
          <input
            type="text"
            inputMode="numeric"
            className="filter-popover__input filter-popover__input--mono"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label className="filter-popover__field">
          <span className="filter-popover__label">Max block</span>
          <input
            type="text"
            inputMode="numeric"
            className="filter-popover__input filter-popover__input--mono"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
      </div>

      <p className="block-range__count" data-testid="block-range-count">
        {formatCount(matchCount)} rows
      </p>
    </div>
  )
}

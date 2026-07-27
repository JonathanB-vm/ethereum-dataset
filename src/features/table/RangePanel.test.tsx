import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Column } from '@tanstack/react-table'
import { FilterControls, type RangeUnit } from './FilterControls'
import type { EthRecord } from '../../data/types'

/** RangePanel only ever calls getFilterValue/setFilterValue on its column. */
function stubColumn() {
  let value: unknown = undefined
  const setFilterValue = vi.fn((next: unknown) => {
    value = next
  })
  const column = {
    getFilterValue: () => value,
    setFilterValue,
  } as unknown as Column<EthRecord, unknown>
  return { column, setFilterValue }
}

function openPanel(unit?: RangeUnit) {
  const { column, setFilterValue } = stubColumn()
  render(<FilterControls column={column} kind="bignum" label="Gas Price" rangeUnit={unit} />)
  fireEvent.click(screen.getByRole('button', { name: 'Filter Gas Price' }))
  return { setFilterValue }
}

describe('RangePanel validation', () => {
  it('reports an unparseable bound and keeps it out of the filter value', async () => {
    const { setFilterValue } = openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByText('Not a number')).toBeInTheDocument())
    expect(setFilterValue).toHaveBeenLastCalledWith(undefined)
  })

  it('marks the offending input invalid for assistive tech', async () => {
    openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByLabelText('Min')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByLabelText('Max')).not.toHaveAttribute('aria-invalid')
  })

  it('accepts a valid bound and applies it', async () => {
    const { setFilterValue } = openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '25' } })
    await waitFor(() => expect(setFilterValue).toHaveBeenLastCalledWith({ min: '25' }))
    expect(screen.queryByText('Not a number')).not.toBeInTheDocument()
  })

  it('validates a Gwei bound at 9 decimals, so a decimal is legal there', async () => {
    const { setFilterValue } = openPanel({ label: 'Gwei', decimals: 9 })
    fireEvent.change(screen.getByLabelText('Min (Gwei)'), { target: { value: '12.5' } })
    await waitFor(() => expect(setFilterValue).toHaveBeenLastCalledWith({ min: '12.5' }))
    expect(screen.queryByText('Not a number')).not.toBeInTheDocument()
  })

  // Only the Gwei/9 pairing above had coverage; columns.tsx's `{ label: 'ETH', decimals: 18 }`
  // (value_lossless_tx) and filters.ts's `rangeEth: decimalRangeFilterFn(18)` are two literals
  // that must independently agree, so add the ETH/18 sibling directly. A value with more than
  // 9 decimal places is what tells the two pairings apart — this bound is only meaningful
  // (non-truncated) when the panel really is validating at 18 decimals, not 9.
  it('validates an ETH bound at 18 decimals, so a value past 9 decimal places is legal there', async () => {
    const { setFilterValue } = openPanel({ label: 'ETH', decimals: 18 })
    fireEvent.change(screen.getByLabelText('Min (ETH)'), { target: { value: '0.000000000000000001' } })
    await waitFor(() => expect(setFilterValue).toHaveBeenLastCalledWith({ min: '0.000000000000000001' }))
    expect(screen.queryByText('Not a number')).not.toBeInTheDocument()
  })

  it('calls out a reversed range rather than silently emptying the table', async () => {
    openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Max'), { target: { value: '10' } })
    await waitFor(() => expect(screen.getByText('Min is greater than Max')).toBeInTheDocument())
  })

  it('clears the message once the input becomes valid again', async () => {
    openPanel()
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: 'abc' } })
    await waitFor(() => expect(screen.getByText('Not a number')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '5' } })
    await waitFor(() => expect(screen.queryByText('Not a number')).not.toBeInTheDocument())
  })
})

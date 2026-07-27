import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BlockTimeRangeFilter } from './BlockTimeRangeFilter'
import type { BlockAxisEntry } from '../../data/types'

const AXIS: BlockAxisEntry[] = [
  { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
  { block: 25534201, time: '2026-07-14 23:35:23+00:00' },
  { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
  { block: 25534203, time: '2026-07-14 23:35:47+00:00' },
]

function setup(value?: { min?: string; max?: string }) {
  const onChange = vi.fn()
  render(<BlockTimeRangeFilter axis={AXIS} value={value} onChange={onChange} matchCount={1234} />)
  return { onChange }
}

describe('BlockTimeRangeFilter', () => {
  it('labels each handle with its block number and that block\'s clock time', () => {
    setup({ min: '25534201', max: '25534203' })
    expect(screen.getByTestId('block-range-min-block')).toHaveTextContent('25,534,201')
    expect(screen.getByTestId('block-range-min-time')).toHaveTextContent('23:35:23 UTC')
    expect(screen.getByTestId('block-range-max-block')).toHaveTextContent('25,534,203')
    expect(screen.getByTestId('block-range-max-time')).toHaveTextContent('23:35:47 UTC')
  })

  it('shows the resulting match count', () => {
    setup()
    expect(screen.getByTestId('block-range-count')).toHaveTextContent('1,234')
  })

  it('emits the block number at the slider index it was moved to', async () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ min: '25534202', max: '25534203' }))
  })

  it('emits undefined when both handles sit at the axis ends, so no dead chip appears', async () => {
    const { onChange } = setup({ min: '25534202' })
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '0' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined))
  })

  it('will not let the start handle pass the end handle', async () => {
    const { onChange } = setup({ min: '25534200', max: '25534201' })
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '3' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ min: '25534201', max: '25534201' }))
  })

  it('updates the time label when a block is typed into the Min box', async () => {
    setup()
    fireEvent.change(screen.getByLabelText('Min block'), { target: { value: '25534202' } })
    await waitFor(() =>
      expect(screen.getByTestId('block-range-min-time')).toHaveTextContent('23:35:35 UTC'),
    )
  })

  it('renders a message instead of a broken slider when no blocks are loaded', () => {
    render(<BlockTimeRangeFilter axis={[]} value={undefined} onChange={vi.fn()} matchCount={0} />)
    expect(screen.getByText('No blocks loaded')).toBeInTheDocument()
  })

  it('treats a zero-padded or space-padded full range as no constraint', async () => {
    const { onChange } = setup({ min: '25534201' })
    fireEvent.change(screen.getByLabelText('Min block'), { target: { value: ' 025534200 ' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined))
  })

  it('orders a typed range that would otherwise invert', async () => {
    const { onChange } = setup({ min: '25534200', max: '25534201' })
    fireEvent.change(screen.getByLabelText('Min block'), { target: { value: '25534203' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ min: '25534201', max: '25534203' }))
    expect(screen.getByTestId('block-range-min-block')).toHaveTextContent('25,534,201')
    expect(screen.getByTestId('block-range-max-block')).toHaveTextContent('25,534,203')
  })
})

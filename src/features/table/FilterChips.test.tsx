import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DataTable } from './DataTable'
import { DictionaryPanelProvider } from '../dictionary/DictionaryPanel'
import { BASE, TEST_AXIS, renderTransfersTable } from './__fixtures__/tableHarness'
import type { EthRecord } from '../../data/types'

function renderTransactionsTable() {
  const records: EthRecord[] = [BASE]
  render(
    <DictionaryPanelProvider records={records}>
      <DataTable
        records={records}
        tab="transactions"
        blockAxis={TEST_AXIS}
        globalFilter=""
        onGlobalFilterChange={vi.fn()}
      />
    </DictionaryPanelProvider>,
  )
}

describe('FilterChips — numeric bound formatting', () => {
  it('formats an integer block-range chip with thousands separators, matching the readout above it', async () => {
    renderTransfersTable()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    // Exact axis values (TEST_AXIS in tableHarness.tsx), so this lands on a real, non-degenerate
    // range rather than snapping to the axis's nearest/last entry.
    fireEvent.change(screen.getByLabelText('Min block'), { target: { value: '25534200' } })
    fireEvent.change(screen.getByLabelText('Max block'), { target: { value: '25534201' } })
    await waitFor(() =>
      expect(screen.getByText('Block: 25,534,200 – 25,534,201')).toBeInTheDocument(),
    )
  })

  it('leaves a decimal ETH/Gwei bound exactly as typed, not run through formatCount', async () => {
    renderTransactionsTable()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Gas Price Gwei' }))
    fireEvent.change(screen.getByLabelText('Min (Gwei)'), { target: { value: '0.5' } })
    await waitFor(() => expect(screen.getByText('Gas Price Gwei: ≥ 0.5')).toBeInTheDocument())
  })
})

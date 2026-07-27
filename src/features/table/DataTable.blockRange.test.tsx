import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderTransfersTable } from './__fixtures__/tableHarness'

const renderTable = renderTransfersTable

describe('DataTable — block & time range', () => {
  it('gives the Time column a filter funnel, which it never had before', () => {
    renderTable()
    expect(screen.getByRole('button', { name: 'Filter Time' })).toBeInTheDocument()
  })

  it('opens both funnels left-anchored and wide, so the panel stays inside the table', () => {
    // Block and Time are the leftmost columns, so the default right-anchored panel would
    // grow off the table's left edge and be clipped by .table-scroll's `overflow: auto`.
    renderTable()
    for (const name of ['Filter Time', 'Filter Block']) {
      fireEvent.click(screen.getByRole('button', { name }))
      const panel = screen.getByRole('dialog')
      expect(panel).toHaveClass('filter-popover--align-start')
      expect(panel).toHaveClass('filter-popover--wide')
      fireEvent.keyDown(document, { key: 'Escape' })
    }
  })

  it('opens the same "Block & time range" panel from either funnel', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Time' }))
    expect(screen.getByText('Block & time range')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    expect(screen.getByText('Block & time range')).toBeInTheDocument()
  })

  it('filters rows when the range is narrowed, and lights both funnels at once', async () => {
    renderTable()
    expect(screen.getByText('Showing 1–3 of 3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filter Time' }))
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2' } })

    await waitFor(() => expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Filter Time' })).toHaveClass(
      'filter-control__trigger--active',
    )
    expect(screen.getByRole('button', { name: 'Filter Block' })).toHaveClass(
      'filter-control__trigger--active',
    )
  })
})

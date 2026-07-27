import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderTransfersTable, sortHeader } from './__fixtures__/tableHarness'

const renderTable = renderTransfersTable

describe('SortableHeader', () => {
  it('announces direction but no priority while a single column is sorted', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    expect(screen.getByRole('button', { name: 'Quantity, sorted descending' })).toBeInTheDocument()
  })

  it('announces the priority once two columns are stacked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    expect(
      screen.getByRole('button', { name: 'Quantity, sorted descending, sort priority 1' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Block, sorted ascending, sort priority 2' }),
    ).toBeInTheDocument()
  })

  it('renders a visible ordinal beside the arrow only when stacked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    expect(screen.queryByTestId('sort-ordinal-quantity')).not.toBeInTheDocument()
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    expect(screen.getByTestId('sort-ordinal-quantity')).toHaveTextContent('1')
  })

  it('leaves an unsorted header named by its plain label', () => {
    renderTable()
    expect(screen.getByRole('button', { name: 'Quantity' })).toBeInTheDocument()
  })

  it('ascends first on a position column and descends first on a magnitude column', () => {
    renderTable()
    fireEvent.click(sortHeader('Block'))
    expect(screen.getByRole('button', { name: 'Block, sorted ascending' })).toBeInTheDocument()

    fireEvent.click(sortHeader('Event Index'))
    expect(screen.getByRole('button', { name: 'Event Index, sorted ascending' })).toBeInTheDocument()

    fireEvent.click(sortHeader('Quantity'))
    expect(screen.getByRole('button', { name: 'Quantity, sorted descending' })).toBeInTheDocument()
  })
})

import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderTransfersTable, sortHeader } from './__fixtures__/tableHarness'

const renderTable = renderTransfersTable

describe('SortChips', () => {
  it('shows nothing until something is sorted', () => {
    renderTable()
    expect(screen.queryByTestId('sort-chips')).not.toBeInTheDocument()
  })

  it('shows an un-numbered chip and the shift-click hint for a single sort', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    const chips = screen.getByTestId('sort-chips')
    expect(chips).toHaveTextContent('Quantity')
    expect(chips).not.toHaveTextContent('1.')
    expect(screen.getByText('Shift-click another header to add')).toBeInTheDocument()
  })

  it('numbers the chips and drops the hint once a second sort is stacked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    const chips = screen.getByTestId('sort-chips')
    expect(chips).toHaveTextContent('1.')
    expect(chips).toHaveTextContent('2.')
    expect(screen.queryByText('Shift-click another header to add')).not.toBeInTheDocument()
  })

  it('reverses that column when the chip body is clicked', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity')) // quantity is descending-first (Task 5)
    expect(screen.getByTestId('sort-chip-quantity')).toHaveTextContent('▼')
    // Matched on the chip's "Activate to reverse." tail: once Task 7 lands, the *header*
    // button is also named "Quantity, sorted descending", and a prefix match would find both.
    fireEvent.click(screen.getByRole('button', { name: /^Quantity,.*Activate to reverse/ }))
    expect(screen.getByTestId('sort-chip-quantity')).toHaveTextContent('▲')
  })

  it('removes only its own column and preserves the order of the rest', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Quantity sort' }))
    expect(screen.queryByTestId('sort-chip-quantity')).not.toBeInTheDocument()
    expect(screen.getByTestId('sort-chip-block_number')).toBeInTheDocument()
  })

  it('clears every sort at once', () => {
    renderTable()
    fireEvent.click(sortHeader('Quantity'))
    fireEvent.click(sortHeader('Block'), { shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Clear all sorts' }))
    expect(screen.queryByTestId('sort-chips')).not.toBeInTheDocument()
  })
})

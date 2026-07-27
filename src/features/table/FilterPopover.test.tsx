import '@testing-library/jest-dom'
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FilterPopover } from './FilterPopover'

describe('FilterPopover', () => {
  it('is closed until the funnel is clicked', () => {
    render(<FilterPopover label="Block" isActive={false}><p>panel body</p></FilterPopover>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    expect(screen.getByRole('dialog', { name: 'Filter Block' })).toBeInTheDocument()
    expect(screen.getByText('panel body')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    render(<FilterPopover label="Block" isActive={false}><p>panel body</p></FilterPopover>)
    const trigger = screen.getByRole('button', { name: 'Filter Block' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on an outside pointer press without stealing focus back', () => {
    render(
      <div>
        <FilterPopover label="Block" isActive={false}><p>panel body</p></FilterPopover>
        <button type="button">elsewhere</button>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Filter Block' }))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter Block' })).not.toHaveFocus()
  })

  it('marks the trigger active when a filter is set', () => {
    const { rerender } = render(<FilterPopover label="Block" isActive={false}><p>x</p></FilterPopover>)
    expect(screen.getByRole('button', { name: 'Filter Block' })).not.toHaveClass(
      'filter-control__trigger--active',
    )
    rerender(<FilterPopover label="Block" isActive><p>x</p></FilterPopover>)
    expect(screen.getByRole('button', { name: 'Filter Block' })).toHaveClass(
      'filter-control__trigger--active',
    )
  })
})

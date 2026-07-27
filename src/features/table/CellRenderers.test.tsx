import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NormalizedQuantityCell } from './CellRenderers'

const USDT = { symbol: 'USDT', decimals: 6 }
const WETH = { symbol: 'WETH', decimals: 18 }

describe('NormalizedQuantityCell', () => {
  it('renders the normalized value with its symbol', () => {
    render(<NormalizedQuantityCell quantity="80000000" token={USDT} />)
    expect(screen.getByText('80')).toBeInTheDocument()
    expect(screen.getByText('USDT')).toBeInTheDocument()
  })

  it('marks dust rather than showing a bare zero', () => {
    render(<NormalizedQuantityCell quantity="5" token={WETH} />)
    expect(screen.getByText('<0.000001')).toBeInTheDocument()
  })

  it('explains itself when the contract has no known decimals', () => {
    const { container } = render(<NormalizedQuantityCell quantity="80000000" token={null} />)
    expect(container.querySelector('.cell-null-explained')).toHaveAttribute(
      'title',
      'Token decimals unknown — this contract is not in the token registry',
    )
  })

  it('renders a plain null cell when there is no quantity at all', () => {
    // Transaction rows carry no quantity; that is missing data, not missing metadata.
    const { container } = render(<NormalizedQuantityCell quantity={null} token={USDT} />)
    expect(container.querySelector('.cell-null')).toBeInTheDocument()
    expect(container.querySelector('.cell-null-explained')).toBeNull()
  })

  it('renders a token with no symbol as just the number', () => {
    render(<NormalizedQuantityCell quantity="4200" token={{ symbol: null, decimals: 2 }} />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })
})

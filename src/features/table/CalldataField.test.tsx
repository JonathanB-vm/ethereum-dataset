import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CalldataField } from './CalldataField'
import type { CalldataProvider } from '../../data/calldataProvider'

function providerReturning(value: string): CalldataProvider {
  return { get: vi.fn(async () => value) }
}

describe('CalldataField', () => {
  it('shows a loading state, then the fetched calldata', async () => {
    render(
      <CalldataField txHash="0xab11" label="Input Data" provider={providerReturning('0xa9059cbb1234')} />,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTitle('0xa9059cbb1234')).toBeInTheDocument())
  })

  it("renders '0x' as a plain value, not as an error", async () => {
    render(<CalldataField txHash="0xab11" label="Input Data" provider={providerReturning('0x')} />)
    await waitFor(() => expect(screen.getByTitle('0x')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('offers a retry when the fetch fails', async () => {
    const provider: CalldataProvider = { get: vi.fn(async () => { throw new Error('offline') }) }
    render(<CalldataField txHash="0xab11" label="Input Data" provider={provider} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument())
  })

  it('does not apply a stale response after the tx hash changes', async () => {
    const provider: CalldataProvider = {
      get: vi.fn(async (hash: string) => (hash === '0xab11' ? '0xOLD' : '0xNEW')),
    }
    const { rerender } = render(
      <CalldataField txHash="0xab11" label="Input Data" provider={provider} />,
    )
    rerender(<CalldataField txHash="0xcd22" label="Input Data" provider={provider} />)
    await waitFor(() => expect(screen.getByTitle('0xNEW')).toBeInTheDocument())
    expect(screen.queryByTitle('0xOLD')).not.toBeInTheDocument()
  })
})

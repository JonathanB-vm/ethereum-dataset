import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('retries the fetch when Retry is clicked, and renders the value on success', async () => {
    let calls = 0
    const provider: CalldataProvider = {
      get: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return '0xa9059cbb1234'
      }),
    }
    render(<CalldataField txHash="0xab11" label="Input Data" provider={provider} />)
    const retryButton = await screen.findByRole('button', { name: /retry/i })

    fireEvent.click(retryButton)

    // The click must actually re-invoke the provider (not just re-render the same failed
    // state) — a test that only asserted the button renders would pass even if Retry did
    // nothing at all.
    expect(provider.get).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByTitle('0xa9059cbb1234')).toBeInTheDocument())
  })

  it('does not apply a stale response after the tx hash changes', async () => {
    // Deliberately controlled promises, resolved out of call order: '0xab11' (the *older*
    // request, issued by the first render) is only released *after* '0xcd22' (the newer
    // one, issued by the rerender) has already resolved and been painted. That ordering is
    // what actually exercises the `cancelled` guard in CalldataField's effect — a version of
    // this test where both mocks resolve immediately (e.g. `async () => value`) settles the
    // *older* promise first regardless of the guard (it was created first, with nothing
    // else awaited in between), so "last write wins" lands on the newer value even with
    // `cancelled` deleted entirely. See task-8-report.md for the empirical repro.
    let resolveOld!: (value: string) => void
    let resolveNew!: (value: string) => void
    const oldPromise = new Promise<string>((resolve) => { resolveOld = resolve })
    const newPromise = new Promise<string>((resolve) => { resolveNew = resolve })
    const provider: CalldataProvider = {
      get: vi.fn((hash: string) => (hash === '0xab11' ? oldPromise : newPromise)),
    }

    const { rerender } = render(
      <CalldataField txHash="0xab11" label="Input Data" provider={provider} />,
    )
    rerender(<CalldataField txHash="0xcd22" label="Input Data" provider={provider} />)

    // Newer request resolves and is applied first.
    await act(async () => {
      resolveNew('0xNEW')
      await newPromise
    })
    expect(screen.getByTitle('0xNEW')).toBeInTheDocument()

    // Now the stale, already-cancelled request resolves. With the guard in place this must
    // be a no-op; without it, this `setState` would overwrite '0xNEW' with '0xOLD'.
    await act(async () => {
      resolveOld('0xOLD')
      await oldPromise
    })
    expect(screen.getByTitle('0xNEW')).toBeInTheDocument()
    expect(screen.queryByTitle('0xOLD')).not.toBeInTheDocument()
  })
})

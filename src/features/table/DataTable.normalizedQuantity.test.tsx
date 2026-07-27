import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import { DictionaryPanelProvider } from '../dictionary/DictionaryPanel'
import { parseTokenRegistry } from '../../data/tokenRegistry'
import { mk } from './__fixtures__/tableHarness'
import type { BlockAxisEntry } from '../../data/types'

const REGISTRY = parseTokenRegistry({
  tokens: {
    '0xusdt': { symbol: 'USDT', decimals: 6 },
    '0xweth': { symbol: 'WETH', decimals: 18 },
  },
})

// 80 USDT, 0.5 WETH, and a contract absent from the registry (the USDC case). `mk`'s base
// fixture holds a single fixed `block_timestamp`, so each row overrides it here too (not
// just `block_number`) — otherwise every row would carry the same timestamp and the sort
// assertions below (which key off block_timestamp) couldn't tell the rows apart.
//
// Deliberately NOT in the post-sort order the tests below assert: the unknown-decimals row
// comes first here, and USDT/WETH are reversed relative to their expected sorted positions.
// If clicking the Normalized Quantity header did nothing at all, the table would still show
// this natural array order — which the sort assertions below would then fail to match. That
// is what makes those assertions actually exercise the click rather than passing vacuously.
const RECORDS = [
  mk({
    transaction_hash: '0x3',
    address: '0xunknown',
    quantity: '12345',
    block_number: 25534202,
    block_timestamp: '2026-07-14 23:35:35+00:00',
  }),
  mk({
    transaction_hash: '0x2',
    address: '0xweth',
    quantity: '500000000000000000',
    block_number: 25534201,
    block_timestamp: '2026-07-14 23:35:23+00:00',
  }),
  mk({
    transaction_hash: '0x1',
    address: '0xusdt',
    quantity: '80000000',
    block_number: 25534200,
    block_timestamp: '2026-07-14 23:35:11+00:00',
  }),
]

const AXIS: BlockAxisEntry[] = [
  { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
  { block: 25534201, time: '2026-07-14 23:35:23+00:00' },
  { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
]

function renderTable(tab: 'transfers' | 'transactions' | 'all' = 'transfers') {
  render(
    <DictionaryPanelProvider records={RECORDS}>
      <DataTable
        records={RECORDS}
        tab={tab}
        tokens={REGISTRY}
        blockAxis={AXIS}
        globalFilter=""
        onGlobalFilterChange={vi.fn()}
      />
    </DictionaryPanelProvider>,
  )
}

function headerTexts() {
  const head = document.querySelector('thead')
  return Array.from(head!.querySelectorAll('th')).map((th) => th.textContent ?? '')
}

describe('Normalized Quantity column', () => {
  it('sits immediately right of Quantity on the transfers tab', () => {
    renderTable()
    const headers = headerTexts()
    const q = headers.findIndex((h) => h.includes('Quantity') && !h.includes('Normalized'))
    expect(headers[q + 1]).toContain('Normalized Quantity')
  })

  it('is absent from the transactions and all-records tabs', () => {
    renderTable('transactions')
    expect(headerTexts().join(' ')).not.toContain('Normalized Quantity')

    cleanup()
    renderTable('all')
    expect(headerTexts().join(' ')).not.toContain('Normalized Quantity')
  })

  it('shows the normalized value with its symbol, and a dash for unknown contracts', () => {
    renderTable()
    expect(screen.getByText('80')).toBeInTheDocument()
    expect(screen.getByText('USDT')).toBeInTheDocument()
    expect(screen.getByText('0.5')).toBeInTheDocument()
    expect(document.querySelector('.cell-null-explained')).toBeInTheDocument()
  })

  it('sorts across token scales, not by the raw integer', () => {
    renderTable()
    const thead = document.querySelector('thead')!
    fireEvent.click(within(thead).getByRole('button', { name: /^Normalized Quantity(,|$)/ }))

    // First click descends (it is a magnitude): 80 USDT before 0.5 WETH, even though
    // WETH's raw quantity (5e17) is the larger integer. The unknown-decimals row sorts last.
    // td[0] is the row-expander/preview cell (chevron + fullscreen buttons, no text) that
    // DataTable renders ahead of every TanStack column — td[1] is the first real column
    // (block_timestamp), which is what these assertions read.
    const firstCol = Array.from(document.querySelectorAll('tbody tr'))
      .map((tr) => tr.querySelectorAll('td')[1]?.textContent ?? '')
    expect(firstCol[0]).toContain('23:35:11') // the USDT row
    expect(firstCol[1]).toContain('23:35:23') // the WETH row
    expect(firstCol[2]).toContain('23:35:35') // the unknown row, last
  })
})

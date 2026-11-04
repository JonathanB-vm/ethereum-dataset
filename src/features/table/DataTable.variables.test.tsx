import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import { DictionaryPanelProvider } from '../dictionary/DictionaryPanel'
import { EMPTY_TOKEN_REGISTRY } from '../../data/tokenRegistry'
import { parseVariableValues } from '../../data/variableValues'
import { mk } from './__fixtures__/tableHarness'
import type { BlockAxisEntry } from '../../data/types'

// Three transactions. 0x1 has one transfer (simple); 0x2 has two transfer rows (not simple,
// and both rows must show the same value); 0x3 was never computed, so it must show a dash
// rather than a 0.
const RECORDS = [
  mk({ transaction_hash: '0x1', block_number: 25534200, transaction_index: 0 }),
  mk({ transaction_hash: '0x2', block_number: 25534200, transaction_index: 1, event_index: 1 }),
  mk({ transaction_hash: '0x2', block_number: 25534200, transaction_index: 1, event_index: 2 }),
  mk({ transaction_hash: '0x3', block_number: 25534200, transaction_index: 2, event_index: 3 }),
]

const VALUES = parseVariableValues({
  blocks: [25534200, 25534200],
  txIndexes: [0, 1],
  versions: { simple_transaction: 1, from_high_user: 1 },
  values: { simple_transaction: [1, 0], from_high_user: [0, 1] },
})

const AXIS: BlockAxisEntry[] = [{ block: 25534200, time: '2026-07-14 23:35:11+00:00' }]

function renderTable() {
  render(
    <DictionaryPanelProvider records={RECORDS} variableValues={VALUES}>
      <DataTable
        records={RECORDS}
        tab="transfers"
        tokens={EMPTY_TOKEN_REGISTRY}
        variableValues={VALUES}
        blockAxis={AXIS}
        globalFilter=""
        onGlobalFilterChange={vi.fn()}
      />
    </DictionaryPanelProvider>,
  )
}

/** The text of one column's cells, in row order. */
function columnCells(label: string): string[] {
  const headers = Array.from(document.querySelectorAll('thead th'))
  const index = headers.findIndex((th) => th.textContent?.includes(label))
  if (index < 0) throw new Error(`no column ${label}`)
  return Array.from(document.querySelectorAll('tbody tr')).map(
    (tr) => tr.querySelectorAll('td')[index]?.textContent ?? '',
  )
}

describe('research variable columns', () => {
  it('render one value per transaction on every row, and a dash when not computed', () => {
    renderTable()
    expect(columnCells('Simple Transaction')).toEqual(['1', '0', '0', '–'])
    expect(columnCells('High-Activity Sender')).toEqual(['0', '1', '1', '–'])
  })

  it('tint every header and body cell, and badge the header with the creator initials', () => {
    renderTable()
    const headers = Array.from(document.querySelectorAll('thead th'))
    const tinted = headers.filter((th) => th.classList.contains('col--variable'))
    expect(tinted.map((th) => th.querySelector('.col-header__creator')?.textContent)).toEqual(['NC', 'NC'])
    expect(screen.getAllByRole('img', { name: 'Created by Nir Chemaya' })).toHaveLength(2)
    // 4 rows x 2 variable columns, and nothing else tinted.
    expect(document.querySelectorAll('tbody td.col--variable')).toHaveLength(8)
    expect(headers.filter((th) => !th.classList.contains('col--variable')).some((th) => th.querySelector('.col-header__creator'))).toBe(false)
  })

  it('filter on the 0/1 value through the checkbox list', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Simple Transaction' }))
    const dialog = screen.getByRole('dialog', { name: 'Filter Simple Transaction' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^1/ }))
    expect(columnCells('Simple Transaction')).toEqual(['1'])
  })

  it('open the dictionary entry with the creator and tags', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'About Simple Transaction' }))
    const panel = screen.getByRole('dialog', { name: 'Simple Transaction' })
    expect(within(panel).getByText('Nir Chemaya')).toBeInTheDocument()
    expect(within(panel).getByText('transaction-structure')).toBeInTheDocument()
  })
})

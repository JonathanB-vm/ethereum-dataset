import '@testing-library/jest-dom'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DictionaryPanel } from './DictionaryPanel'

const LINK_NAME = /download data dictionary/i

describe('DictionaryPanel — download PDF link', () => {
  it('offers the PDF in full mode, pointing at the static asset', () => {
    render(<DictionaryPanel records={[]} onClose={vi.fn()} closing={false} />)
    const link = screen.getByRole('link', { name: LINK_NAME })
    expect(link).toHaveAttribute('href', '/ethereum-dataset.pdf')
    // The saved filename is pinned to the human-readable title, not the on-disk asset name.
    expect(link).toHaveAttribute('download', 'Ethereum Dataset.pdf')
  })

  it('omits the PDF in single-field mode, which documents one column rather than all of them', () => {
    render(
      <DictionaryPanel records={[]} field="block_number" onClose={vi.fn()} closing={false} />,
    )
    expect(screen.queryByRole('link', { name: LINK_NAME })).not.toBeInTheDocument()
  })
})

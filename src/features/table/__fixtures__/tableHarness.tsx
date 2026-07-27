import { render, within } from '@testing-library/react'
import { vi } from 'vitest'
import { DataTable } from '../DataTable'
import { DictionaryPanelProvider } from '../../dictionary/DictionaryPanel'
import { EMPTY_TOKEN_REGISTRY } from '../../../data/tokenRegistry'
import type { BlockAxisEntry, EthRecord } from '../../../data/types'

/** All 34 loaded fields, so a test can override just the ones it cares about via `mk`. */
export const BASE: EthRecord = {
  block_hash: '0xb', block_number: 25534200, block_timestamp: '2026-07-14 23:35:11+00:00',
  transaction_hash: '0xt1', transaction_index: 0, event_index: 0, batch_index: null,
  address: '0xtoken', event_type: 'ERC-20', event_hash: null, event_signature: null,
  operator_address: null, from_address: '0xf', to_address: '0xt', token_id: null,
  quantity: '1', removed: false, nonce_tx: null, from_address_tx: null, to_address_tx: null,
  value_tx: null, value_lossless_tx: null, gas_tx: null, gas_price_tx: null,
  max_fee_per_gas_tx: null, max_priority_fee_per_gas_tx: null, type_tx: null,
  chain_id_tx: null, access_list_tx: null, r_tx: null, s_tx: null, v_tx: null,
  y_parity_tx: null, is_token_transfer: true,
}

export const mk = (p: Partial<EthRecord>): EthRecord => ({ ...BASE, ...p })

/** Three transfer rows across three consecutive blocks, with distinct quantities so a sort is observable. */
export const TEST_RECORDS: EthRecord[] = [
  mk({ block_number: 25534200, block_timestamp: '2026-07-14 23:35:11+00:00', transaction_hash: '0xa', quantity: '1' }),
  mk({ block_number: 25534201, block_timestamp: '2026-07-14 23:35:23+00:00', transaction_hash: '0xb', quantity: '3' }),
  mk({ block_number: 25534202, block_timestamp: '2026-07-14 23:35:35+00:00', transaction_hash: '0xc', quantity: '2' }),
]

export const TEST_AXIS: BlockAxisEntry[] = [
  { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
  { block: 25534201, time: '2026-07-14 23:35:23+00:00' },
  { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
]

export function renderTransfersTable() {
  render(
    // DataTable's header cells render DictionaryInfoTrigger (the ⓘ trigger) unconditionally,
    // which calls useDictionaryPanel() and throws outside a provider — App.tsx always wraps
    // DataTable this way, so the harness has to as well for the real DataTable to render at all.
    <DictionaryPanelProvider records={TEST_RECORDS}>
      <DataTable
        records={TEST_RECORDS}
        tab="transfers"
        blockAxis={TEST_AXIS}
        globalFilter=""
        onGlobalFilterChange={vi.fn()}
        tokens={EMPTY_TOKEN_REGISTRY}
      />
    </DictionaryPanelProvider>,
  )
}

/**
 * The sort *toggle* button in a header. Scoped to `<thead>` on purpose: a header cell holds
 * three buttons (ⓘ, sort, funnel), and once Task 7 puts the direction into the sort button's
 * accessible name it reads "Quantity, sorted descending" — which a page-wide query would
 * find alongside the sort *chip* of the same column. Scoping is what keeps this unambiguous.
 */
export function sortHeader(name: string) {
  const thead = document.querySelector('thead')
  if (!thead) throw new Error('no thead rendered')
  return within(thead).getByRole('button', { name: new RegExp(`^${name}(,|$)`) })
}

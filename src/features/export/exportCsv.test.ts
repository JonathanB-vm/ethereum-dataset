import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'
import { buildCsv } from './exportCsv'
import type { EthRecord } from '../../data/types'

const LOSSLESS_VALUE = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

function makeRecord(overrides: Partial<EthRecord> = {}): EthRecord {
  return {
    block_hash: '0xblockhash',
    block_number: 25534300,
    block_timestamp: '2026-07-14 23:55:11+00:00',
    transaction_hash: '0xabc123',
    transaction_index: 1,
    event_index: null,
    batch_index: null,
    address: null,
    event_type: 'ERC-20',
    event_hash: null,
    event_signature: null,
    operator_address: null,
    from_address: null,
    to_address: null,
    token_id: null,
    quantity: '42',
    removed: false,
    nonce_tx: null,
    from_address_tx: null,
    to_address_tx: null,
    value_tx: null,
    value_lossless_tx: LOSSLESS_VALUE,
    gas_tx: null,
    gas_price_tx: null,
    input_tx: null,
    max_fee_per_gas_tx: null,
    max_priority_fee_per_gas_tx: null,
    type_tx: null,
    chain_id_tx: null,
    access_list_tx: null,
    r_tx: null,
    s_tx: null,
    v_tx: null,
    y_parity_tx: null,
    is_token_transfer: true,
    ...overrides,
  }
}

describe('buildCsv', () => {
  it('the header row is exactly the given field list, in order', () => {
    const csv = buildCsv([], ['transaction_hash', 'quantity', 'event_type'])
    const [headerLine] = csv.trim().split(/\r?\n/)
    expect(headerLine).toBe('transaction_hash,quantity,event_type')
  })

  it('a 256-bit value_lossless_tx string survives verbatim, with no precision loss', () => {
    const csv = buildCsv([makeRecord()], ['value_lossless_tx'])
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
    expect(parsed.data[0].value_lossless_tx).toBe(LOSSLESS_VALUE)
  })

  it('null becomes an empty string', () => {
    // Two columns so the data row isn't an entirely-blank line — Papa's `skipEmptyLines`
    // would otherwise treat a lone empty-string field as a blank line and drop the row,
    // which is a parser quirk of round-tripping through `Papa.parse`, not something
    // `buildCsv` needs to account for.
    const csv = buildCsv([makeRecord({ address: null, quantity: '7' })], ['address', 'quantity'])
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
    expect(parsed.data[0].address).toBe('')
    expect(parsed.data[0].quantity).toBe('7')
  })

  it('false becomes the string "False" (and true "True")', () => {
    const csv = buildCsv(
      [makeRecord({ removed: false, is_token_transfer: true })],
      ['removed', 'is_token_transfer'],
    )
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
    expect(parsed.data[0].removed).toBe('False')
    expect(parsed.data[0].is_token_transfer).toBe('True')
  })

  it('a value containing commas (event_signature) round-trips through Papa.parse(Papa.unparse(...))', () => {
    const signature = 'Transfer(address,address,uint256)'
    const csv = buildCsv([makeRecord({ event_signature: signature })], ['event_signature'])
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
    expect(parsed.data[0].event_signature).toBe(signature)
  })

  it('one row per record, values in field-list order', () => {
    const csv = buildCsv(
      [makeRecord({ transaction_hash: '0xaaa', quantity: '1' }), makeRecord({ transaction_hash: '0xbbb', quantity: '2' })],
      ['transaction_hash', 'quantity'],
    )
    const lines = csv.trim().split(/\r?\n/)
    expect(lines).toHaveLength(3) // header + 2 rows
    expect(lines[1]).toBe('0xaaa,1')
    expect(lines[2]).toBe('0xbbb,2')
  })

  it('is pure — does not mutate the input rows', () => {
    const record = makeRecord()
    const snapshot = JSON.stringify(record)
    buildCsv([record], ['transaction_hash', 'quantity', 'removed'])
    expect(JSON.stringify(record)).toBe(snapshot)
  })
})

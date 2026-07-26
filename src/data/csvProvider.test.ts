import { describe, it, expect } from 'vitest'
import { parseCsv } from './csvProvider'
import multiblockCsv from './__fixtures__/multiblock.csv?raw'

const HEADER =
  'block_hash,block_number,block_timestamp,transaction_hash,transaction_index,event_index,batch_index,address,event_type,event_hash,event_signature,operator_address,from_address,to_address,token_id,quantity,removed,nonce_tx,from_address_tx,to_address_tx,value_tx,value_lossless_tx,gas_tx,gas_price_tx,max_fee_per_gas_tx,max_priority_fee_per_gas_tx,type_tx,chain_id_tx,access_list_tx,r_tx,s_tx,v_tx,y_parity_tx,is_token_transfer'

const TX_ROW =
  '0xc779,25534300,2026-07-14 23:55:11+00:00,0x0058,16,,,,,,,,,,,,,0,0x96c9,0xc21e,84858226069838.0,84858226069838,21165,2063407496,2074059419.0,2004776381.0,2,1,[],0x6a61,0x2a2b,0x1,0x1,False'

const TRANSFER_ROW =
  '0xc779,25534300,2026-07-14 23:55:11+00:00,0xdac1,5,0,0,0xa0b8,ERC-20,0xddf2,"Transfer(address,address,uint256)",,0x5875,0x0000,,146000000,False,84719,0x5875,0x0000,0,0,449891,58631115,123000000.0,0.0,2,1,[],0x7213,0x7e27,0x0,0x0,True'

describe('parseCsv', () => {
  it('parses transaction rows: empty transfer fields → null', () => {
    const { records } = parseCsv(`${HEADER}\n${TX_ROW}`)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.is_token_transfer).toBe(false)
    expect(r.block_number).toBe(25534300)
    expect(r.transaction_index).toBe(16)
    expect(r.event_type).toBeNull()
    expect(r.quantity).toBeNull()
    expect(r.value_lossless_tx).toBe('84858226069838')
    expect(r.gas_tx).toBe(21165)
  })

  it('parses transfer rows incl. quoted signature with commas', () => {
    const { records } = parseCsv(`${HEADER}\n${TRANSFER_ROW}`)
    const r = records[0]
    expect(r.is_token_transfer).toBe(true)
    expect(r.event_type).toBe('ERC-20')
    expect(r.event_signature).toBe('Transfer(address,address,uint256)')
    expect(r.quantity).toBe('146000000')
    expect(r.removed).toBe(false)
    // Value assertions for the interned fields that aren't otherwise checked anywhere —
    // guards against a wrong-source-field wiring bug (e.g. event_hash reading event_signature).
    expect(r.block_hash).toBe('0xc779')
    expect(r.block_timestamp).toBe('2026-07-14 23:55:11+00:00')
    expect(r.event_hash).toBe('0xddf2')
  })

  it('skips blank lines between records', () => {
    const { records, malformedCount } = parseCsv(`${HEADER}\n\n${TX_ROW}\n\n${TRANSFER_ROW}\n`)
    expect(records).toHaveLength(2)
    expect(malformedCount).toBe(0)
  })

  it('counts malformed rows instead of dropping silently', () => {
    const bad = 'not,enough,fields'
    const { records, malformedCount } = parseCsv(`${HEADER}\n${TX_ROW}\n${bad}`)
    expect(records).toHaveLength(1)
    expect(malformedCount).toBe(1)
  })
})

describe('parseCsv on the multi-block fixture', () => {
  it('parses every row across three blocks', () => {
    const { records, malformedCount } = parseCsv(multiblockCsv)
    expect(records).toHaveLength(3)
    expect(malformedCount).toBe(0)
    expect(records.map((r) => r.block_number)).toEqual([25534200, 25534201, 25534202])
  })

  it('keeps a quoted, multi-line access list intact as one field', () => {
    const { records } = parseCsv(multiblockCsv)
    expect(records[1].access_list_tx).toContain("'storage_keys'")
    expect(records[1].access_list_tx).toContain('0x0019')
    // The newline survives parsing — the prep script is what normalizes it, not the parser.
    expect(records[1].access_list_tx).toContain('\n')
  })

  it("parses '.0'-suffixed integers as integers", () => {
    const { records } = parseCsv(multiblockCsv)
    expect(records[1].event_index).toBe(5)
    expect(records[1].chain_id_tx).toBe(1)
  })

  it('no longer carries input_tx', () => {
    const { records } = parseCsv(multiblockCsv)
    expect(records[0]).not.toHaveProperty('input_tx')
  })
})

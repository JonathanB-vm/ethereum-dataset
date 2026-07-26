import { describe, it, expect } from 'vitest'
import {
  LOADED_FIELDS,
  shardKey,
  collapseWhitespace,
  hasCalldata,
  projectRow,
} from './datasetPrep.mjs'
import { LOADED_COLUMNS } from '../src/data/dictionary.ts'

describe('LOADED_FIELDS', () => {
  it('is the 34 shipped columns and excludes input_tx', () => {
    expect(LOADED_FIELDS).toHaveLength(34)
    expect(LOADED_FIELDS).not.toContain('input_tx')
    expect(LOADED_FIELDS[0]).toBe('block_hash')
    expect(LOADED_FIELDS[33]).toBe('is_token_transfer')
  })

  // The prep script (this file) and the app's dictionary (src/data/dictionary.ts) each
  // hard-code their own 34-column list, and `parseCsv` reads CSV columns by *name*
  // (`header: true`) — so if one side renames a field and the other doesn't, that column
  // silently parses as all-null across all 74,889 rows with no error and no malformed-row
  // count to flag it. This test is the only thing that would catch that drift.
  it('matches src/data/dictionary.ts LOADED_COLUMNS exactly, same names and same order', () => {
    expect(LOADED_FIELDS).toEqual(LOADED_COLUMNS.map((c) => c.field))
  })
})

describe('shardKey', () => {
  it('is the first hex byte after the 0x prefix, lowercased', () => {
    expect(shardKey('0xAB12cd34')).toBe('ab')
    expect(shardKey('0x0058db6926d4d88a')).toBe('00')
  })

  // Pinned to agree with calldataShard's own test in src/data/calldataProvider.test.ts —
  // the two implementations are the contract, so every case pinned there is pinned here too.
  it('tolerates an uppercase 0X prefix', () => {
    expect(shardKey('0XAB12cd')).toBe('ab')
  })

  it('tolerates a missing 0x prefix', () => {
    expect(shardKey('ff9900')).toBe('ff')
  })

  it('returns null when there is no byte to key on', () => {
    expect(shardKey('0x')).toBeNull()
    expect(shardKey('')).toBeNull()
    expect(shardKey(null)).toBeNull()
    expect(shardKey(undefined)).toBeNull()
  })
})

describe('collapseWhitespace', () => {
  it("flattens BigQuery's multi-line Python-repr access lists to one line", () => {
    const raw = "[{'address': '0xabc', 'storage_keys': array(['0x0018',\n       '0x0019'], dtype=object)}]"
    expect(collapseWhitespace(raw)).toBe(
      "[{'address': '0xabc', 'storage_keys': array(['0x0018', '0x0019'], dtype=object)}]",
    )
  })

  it('trims and returns empty string for nullish input', () => {
    expect(collapseWhitespace('  [] ')).toBe('[]')
    expect(collapseWhitespace(null)).toBe('')
    expect(collapseWhitespace(undefined)).toBe('')
  })
})

describe('hasCalldata', () => {
  it('treats 0x and empty as no calldata', () => {
    expect(hasCalldata('0x')).toBe(false)
    expect(hasCalldata('0X')).toBe(false)
    expect(hasCalldata('')).toBe(false)
    expect(hasCalldata('   ')).toBe(false)
    expect(hasCalldata(null)).toBe(false)
    expect(hasCalldata(undefined)).toBe(false)
  })

  it('treats a real selector as calldata', () => {
    expect(hasCalldata('0xa9059cbb0000')).toBe(true)
  })
})

describe('projectRow', () => {
  const row = {
    block_hash: '0xc779',
    block_number: '25534300',
    transaction_hash: '0x0058',
    input_tx: '0xa9059cbb',
    access_list_tx: "[{'a': 1,\n   'b': 2}]",
    is_token_transfer: 'True',
  }

  it('drops input_tx and emits exactly the 34 shipped fields', () => {
    const out = projectRow(row)
    expect(Object.keys(out)).toEqual(LOADED_FIELDS)
    expect(out).not.toHaveProperty('input_tx')
  })

  it('collapses whitespace in access_list_tx only', () => {
    const out = projectRow(row)
    expect(out.access_list_tx).toBe("[{'a': 1, 'b': 2}]")
    expect(out.block_hash).toBe('0xc779')
  })

  it('emits empty string for fields missing from the source row', () => {
    expect(projectRow({}).quantity).toBe('')
  })
})

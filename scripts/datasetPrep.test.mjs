import { describe, it, expect } from 'vitest'
import {
  LOADED_FIELDS,
  shardKey,
  collapseWhitespace,
  hasCalldata,
  projectRow,
} from './datasetPrep.mjs'

describe('LOADED_FIELDS', () => {
  it('is the 34 shipped columns and excludes input_tx', () => {
    expect(LOADED_FIELDS).toHaveLength(34)
    expect(LOADED_FIELDS).not.toContain('input_tx')
    expect(LOADED_FIELDS[0]).toBe('block_hash')
    expect(LOADED_FIELDS[33]).toBe('is_token_transfer')
  })
})

describe('shardKey', () => {
  it('is the first hex byte after the 0x prefix, lowercased', () => {
    expect(shardKey('0xAB12cd34')).toBe('ab')
    expect(shardKey('0x0058db6926d4d88a')).toBe('00')
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

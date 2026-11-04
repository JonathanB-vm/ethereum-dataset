import { describe, it, expect } from 'vitest'
import {
  computeVariableValues,
  fromHighUser,
  IMPLEMENTATIONS,
  simpleTransaction,
  toTransactions,
} from './variablesPrep.mjs'
import { VARIABLES } from '../registry/registry.ts'

const SENDER = '0xaaaa'
const OTHER = '0xbbbb'

/** One flat row; `transfer` marks a token-transfer row. */
function row(block, txIndex, from = SENDER, transfer = false) {
  return { block_number: block, transaction_index: txIndex, from_address_tx: from, is_token_transfer: transfer }
}

/** `n` plain transactions from `from` in `block`, starting at index `startIndex`. */
function txsIn(block, n, from = SENDER, startIndex = 0) {
  return Array.from({ length: n }, (_, i) => row(block, startIndex + i, from))
}

/** from_high_user for the single transaction at (block, txIndex). */
function highUserAt(rows, block, txIndex) {
  const txs = toTransactions(rows)
  const values = fromHighUser(txs)
  return values[txs.findIndex((t) => t.block === block && t.txIndex === txIndex)]
}

describe('registry coverage', () => {
  it('has a reference implementation for every registered variable', () => {
    for (const v of VARIABLES) expect(IMPLEMENTATIONS[v.id], v.id).toBeTypeOf('function')
  })
})

describe('toTransactions', () => {
  it('collapses transfer rows to one transaction and counts them', () => {
    const txs = toTransactions([row(2, 0, SENDER, true), row(1, 5), row(2, 0, SENDER, true)])
    expect(txs).toEqual([
      { block: 1, txIndex: 5, from: SENDER, transfers: 0 },
      { block: 2, txIndex: 0, from: SENDER, transfers: 2 },
    ])
  })

  it('lowercases the sender so mixed-case rows of one address count together', () => {
    expect(toTransactions([row(1, 0, '0xAbCd')])[0].from).toBe('0xabcd')
  })
})

describe('simple_transaction', () => {
  it('is 1 for exactly one transfer and 0 for none or several', () => {
    const txs = toTransactions([
      row(1, 0), // no transfers
      row(1, 1, SENDER, true), // one
      row(1, 2, SENDER, true),
      row(1, 2, SENDER, true), // two
    ])
    expect(simpleTransaction(txs)).toEqual([0, 1, 0])
  })
})

describe('from_high_user', () => {
  const B = 100_000

  it('is 0 at exactly 10 prior transactions and 1 at 11 ("more than 10")', () => {
    expect(highUserAt([...txsIn(B - 1, 10), row(B, 0)], B, 0)).toBe(0)
    expect(highUserAt([...txsIn(B - 1, 11), row(B, 0)], B, 0)).toBe(1)
  })

  it('counts block B - 7200 and excludes block B - 7201', () => {
    expect(highUserAt([...txsIn(B - 7200, 11), row(B, 0)], B, 0)).toBe(1)
    expect(highUserAt([...txsIn(B - 7201, 11), row(B, 0)], B, 0)).toBe(0)
  })

  it('does not count earlier transactions in the same block', () => {
    const rows = txsIn(B, 20)
    expect(highUserAt(rows, B, 19)).toBe(0)
  })

  it('counts each prior transaction once however many transfer rows it has', () => {
    const rows = [...Array.from({ length: 11 }, () => row(B - 1, 0, SENDER, true)), row(B, 0)]
    expect(highUserAt(rows, B, 0)).toBe(0)
  })

  it('only counts transactions sent by the same address', () => {
    expect(highUserAt([...txsIn(B - 1, 11, OTHER), row(B, 0)], B, 0)).toBe(0)
  })

  it('sums the window across several blocks with gaps', () => {
    const rows = [...txsIn(B - 5000, 4), ...txsIn(B - 300, 4), ...txsIn(B - 1, 3), row(B, 0)]
    expect(highUserAt(rows, B, 0)).toBe(1)
  })

  it('gives every same-block transaction of a sender the same value', () => {
    const txs = toTransactions([...txsIn(B - 1, 11), ...txsIn(B, 3)])
    expect(fromHighUser(txs).slice(11)).toEqual([1, 1, 1])
  })
})

describe('computeVariableValues', () => {
  it('packs parallel arrays in transaction order', () => {
    const out = computeVariableValues([row(2, 0, SENDER, true), row(1, 0)], VARIABLES)
    expect(out.blocks).toEqual([1, 2])
    expect(out.txIndexes).toEqual([0, 0])
    expect(out.values.simple_transaction).toEqual([0, 1])
    expect(out.values.from_high_user).toEqual([0, 0])
    expect(out.versions).toEqual({ simple_transaction: 1, from_high_user: 1 })
  })

  it('refuses a registered variable that has no implementation', () => {
    expect(() => computeVariableValues([], [{ id: 'nope', version: 1 }])).toThrow(/nope/)
  })
})

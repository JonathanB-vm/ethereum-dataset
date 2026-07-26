import Papa from 'papaparse'
import type { EthRecord } from './types'
import type { DataProvider, LoadResult } from './provider'

const str = (v: string | undefined): string | null =>
  v == null || v.trim() === '' ? null : v.trim()

const int = (v: string | undefined): number | null => {
  const s = str(v)
  if (s == null) return null
  const n = Number.parseInt(s, 10)
  return Number.isNaN(n) ? null : n
}

const bool = (v: string | undefined): boolean | null => {
  const s = str(v)
  if (s == null) return null
  return s.toLowerCase() === 'true'
}

export function parseCsv(csvText: string): LoadResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
  })
  const records: EthRecord[] = []
  let malformedCount = 0

  for (const row of parsed.data) {
    const blockNumber = int(row.block_number)
    const txHash = str(row.transaction_hash)
    if (blockNumber == null || txHash == null) {
      malformedCount++
      continue
    }
    records.push({
      block_hash: str(row.block_hash) ?? '',
      block_number: blockNumber,
      block_timestamp: str(row.block_timestamp) ?? '',
      transaction_hash: txHash,
      transaction_index: int(row.transaction_index) ?? 0,
      event_index: int(row.event_index),
      batch_index: int(row.batch_index),
      address: str(row.address),
      event_type: str(row.event_type),
      event_hash: str(row.event_hash),
      event_signature: str(row.event_signature),
      operator_address: str(row.operator_address),
      from_address: str(row.from_address),
      to_address: str(row.to_address),
      token_id: str(row.token_id),
      quantity: str(row.quantity),
      removed: bool(row.removed),
      nonce_tx: int(row.nonce_tx),
      from_address_tx: str(row.from_address_tx),
      to_address_tx: str(row.to_address_tx),
      value_tx: str(row.value_tx),
      value_lossless_tx: str(row.value_lossless_tx),
      gas_tx: int(row.gas_tx),
      gas_price_tx: str(row.gas_price_tx),
      max_fee_per_gas_tx: str(row.max_fee_per_gas_tx),
      max_priority_fee_per_gas_tx: str(row.max_priority_fee_per_gas_tx),
      type_tx: int(row.type_tx),
      chain_id_tx: int(row.chain_id_tx),
      access_list_tx: str(row.access_list_tx),
      r_tx: str(row.r_tx),
      s_tx: str(row.s_tx),
      v_tx: str(row.v_tx),
      y_parity_tx: str(row.y_parity_tx),
      is_token_transfer: bool(row.is_token_transfer) ?? false,
    })
  }
  return { records, malformedCount }
}

export function csvProvider(url = '/data/analytics_25534300.csv'): DataProvider {
  return {
    async load(): Promise<LoadResult> {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to fetch dataset: HTTP ${res.status}`)
      return parseCsv(await res.text())
    },
  }
}

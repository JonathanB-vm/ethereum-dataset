import type { EthRecord } from '../../data/types'
import { toBigInt, weiToEth, weiToGwei } from '../../data/transform'

export interface DatasetStats {
  totalRecords: number
  txCount: number // rows with is_token_transfer === false
  transferCount: number
  eventTypeCounts: { type: string; count: number }[] // desc by count
  totalEthMoved: string // ETH, summed over UNIQUE transaction_hash values
  gasPriceMinGwei: string | null
  gasPriceMaxGwei: string | null
  uniqueAddresses: number // union of from/to/from_tx/to_tx/address
  blockNumber: number | null
  blockTimestamp: string | null
}

interface TxAggregate {
  value: bigint | null
  gasPrice: bigint | null
}

export function computeStats(records: EthRecord[]): DatasetStats {
  let txCount = 0
  let transferCount = 0
  const eventTypeCountMap = new Map<string, number>()
  const txMap = new Map<string, TxAggregate>()
  const addresses = new Set<string>()
  let latestBlockNumber: number | null = null
  let latestBlockTimestamp: string | null = null

  for (const r of records) {
    if (r.is_token_transfer) {
      transferCount++
      // event_type is only ever populated on transfer rows (null on plain
      // tx rows), so this only accumulates transfer-row counts.
      if (r.event_type != null) {
        eventTypeCountMap.set(r.event_type, (eventTypeCountMap.get(r.event_type) ?? 0) + 1)
      }
    } else {
      txCount++
    }

    const existing = txMap.get(r.transaction_hash)
    if (!existing) {
      txMap.set(r.transaction_hash, {
        value: toBigInt(r.value_lossless_tx),
        gasPrice: toBigInt(r.gas_price_tx),
      })
    } else {
      // Coalesce: tx fields "may be null on transfer rows" (types.ts), and
      // row order isn't guaranteed, so backfill nulls from later rows rather
      // than locking in a null seen before the parent transaction row.
      if (existing.value == null) existing.value = toBigInt(r.value_lossless_tx)
      if (existing.gasPrice == null) existing.gasPrice = toBigInt(r.gas_price_tx)
    }

    if (r.address != null) addresses.add(r.address)
    if (r.from_address != null) addresses.add(r.from_address)
    if (r.to_address != null) addresses.add(r.to_address)
    if (r.from_address_tx != null) addresses.add(r.from_address_tx)
    if (r.to_address_tx != null) addresses.add(r.to_address_tx)

    if (latestBlockNumber === null || r.block_number > latestBlockNumber) {
      latestBlockNumber = r.block_number
      latestBlockTimestamp = r.block_timestamp
    }
  }

  let totalEthWei = 0n
  let gasPriceMin: bigint | null = null
  let gasPriceMax: bigint | null = null
  for (const agg of txMap.values()) {
    if (agg.value != null) totalEthWei += agg.value
    if (agg.gasPrice != null) {
      if (gasPriceMin === null || agg.gasPrice < gasPriceMin) gasPriceMin = agg.gasPrice
      if (gasPriceMax === null || agg.gasPrice > gasPriceMax) gasPriceMax = agg.gasPrice
    }
  }

  // Array.prototype.sort is stable, so ties preserve first-seen insertion
  // order from eventTypeCountMap rather than being arbitrarily reordered.
  const eventTypeCounts = Array.from(eventTypeCountMap, ([type, count]) => ({ type, count })).sort(
    (a, b) => b.count - a.count,
  )

  return {
    totalRecords: records.length,
    txCount,
    transferCount,
    eventTypeCounts,
    totalEthMoved: weiToEth(totalEthWei.toString()) ?? '0',
    gasPriceMinGwei: gasPriceMin === null ? null : weiToGwei(gasPriceMin.toString()),
    gasPriceMaxGwei: gasPriceMax === null ? null : weiToGwei(gasPriceMax.toString()),
    uniqueAddresses: addresses.size,
    blockNumber: latestBlockNumber,
    blockTimestamp: latestBlockTimestamp,
  }
}

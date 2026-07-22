import type { EthRecord } from './types'

export interface LoadResult {
  records: EthRecord[]
  malformedCount: number
}

/** Seam for the future BigQuery-backed API — UI depends only on this. */
export interface DataProvider {
  load(): Promise<LoadResult>
}

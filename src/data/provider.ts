import type { EthRecord } from './types'

export interface LoadResult {
  records: EthRecord[]
  malformedCount: number
}

/** Download progress. `total` is null when the response has no Content-Length. */
export type ProgressCallback = (loaded: number, total: number | null) => void

/** Seam for the future BigQuery-backed API — UI depends only on this. */
export interface DataProvider {
  load(): Promise<LoadResult>
}

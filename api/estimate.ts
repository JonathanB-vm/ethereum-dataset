/**
 * How long and how much compute will a variable take?
 *
 * Measured, not guessed. The query runs on two small sample ranges — read-only and capped,
 * each one several times and averaged — and ClickHouse reports what each run read, how long it took and how much memory
 * it used. A straight line through the two points separates a fixed cost (a lookback
 * window, a join's build side) from a per-block cost, and that line is extrapolated to the
 * loaded range and to a full year. EXPLAIN ESTIMATE adds what the full range would read
 * according to the planner, without executing anything.
 *
 * Small samples finish in milliseconds, so wall time on them is noisy; rows and bytes read
 * are the robust signal, and time is reported as an order of magnitude.
 */

import type { ClickHouseClient, QuerySummary } from './clickhouse.ts'

/** Blocks in a year at 12 s per block — the scale the explorer is heading for. */
export const BLOCKS_PER_YEAR = 2_628_000

/** Settings for every execution of a researcher's query before approval. */
export const SAMPLE_SETTINGS = {
  readonly: 2,
  max_execution_time: 20,
  max_rows_to_read: 500_000_000,
  max_memory_usage: 2_000_000_000,
} as const

/** Fallback when no variable values are stored yet to measure from. */
const DEFAULT_BYTES_PER_ROW = 4

/**
 * Times each sample size is run; every figure in a `SampleRun` is the mean of these runs.
 * Rows and bytes read are the same every time, but wall time on a millisecond query
 * swings with caches, scheduling and the first run's cold start, so one run is a noisy
 * basis for a projection.
 */
export const RUNS_PER_SAMPLE = 3

export interface SampleRun {
  blocks: number
  readRows: number
  readBytes: number
  resultRows: number
  /** Mean over the runs. */
  elapsedMs: number
  memoryBytes: number
  /** How many runs were averaged, and the fastest and slowest of them. */
  runs?: number
  elapsedMinMs?: number
  elapsedMaxMs?: number
}

/** The mean of several runs of one sample size, keeping the spread of their wall times. */
export function averageRuns(runs: SampleRun[]): SampleRun {
  if (runs.length === 0) throw new Error('no runs to average')
  const mean = (k: 'readRows' | 'readBytes' | 'resultRows' | 'elapsedMs' | 'memoryBytes') =>
    runs.reduce((sum, r) => sum + r[k], 0) / runs.length
  const times = runs.map((r) => r.elapsedMs)
  return {
    blocks: runs[0].blocks,
    readRows: Math.round(mean('readRows')),
    readBytes: Math.round(mean('readBytes')),
    resultRows: Math.round(mean('resultRows')),
    elapsedMs: mean('elapsedMs'),
    memoryBytes: Math.round(mean('memoryBytes')),
    runs: runs.length,
    elapsedMinMs: Math.min(...times),
    elapsedMaxMs: Math.max(...times),
  }
}

export interface Projection {
  blocks: number
  readRows: number
  readBytes: number
  resultRows: number
  elapsedMs: number
  /** Peak memory does not add up across blocks; this is the larger sample's peak, scaled by the fit. */
  memoryBytes: number
  storageBytes: number
}

export type CostTier = 'light' | 'moderate' | 'heavy'

export interface Estimate {
  samples: SampleRun[]
  /** Planner's view of the full loaded range: rows and parts it would read per table. */
  planner: { table: string; rows: number; parts: number; marks: number }[]
  loaded: Projection
  year: Projection
  bytesPerOutputRow: number
  tier: CostTier
  notes: string[]
  measuredAt: string
}

export interface Line {
  fixed: number
  perBlock: number
}

/**
 * Line through two (blocks, value) points, `b` being the larger sample. A negative term is
 * noise: a negative slope means no growth (all fixed cost), and a negative intercept means
 * no fixed cost — then the line goes through the origin and the larger sample, so the
 * projection still reproduces what was actually measured.
 */
export function fitLine(a: { x: number; y: number }, b: { x: number; y: number }): Line {
  const throughB = () => ({ fixed: 0, perBlock: b.x === 0 ? 0 : Math.max(0, b.y / b.x) })
  if (b.x === a.x) return throughB()
  const perBlock = (b.y - a.y) / (b.x - a.x)
  if (perBlock < 0) return { fixed: Math.max(0, b.y), perBlock: 0 }
  const fixed = a.y - perBlock * a.x
  return fixed < 0 ? throughB() : { fixed, perBlock }
}

export const atBlocks = (line: Line, blocks: number) => line.fixed + line.perBlock * blocks

/** Pure projection from two sample runs, so the arithmetic is testable without ClickHouse. */
export function project(samples: [SampleRun, SampleRun], blocks: number, bytesPerRow: number): Projection {
  const [s1, s2] = samples
  const at = (k: 'readRows' | 'readBytes' | 'resultRows' | 'elapsedMs' | 'memoryBytes') => atBlocks(fitLine({ x: s1.blocks, y: s1[k] }, { x: s2.blocks, y: s2[k] }), blocks)
  const resultRows = at('resultRows')
  const readBytes = at('readBytes')
  // Millisecond samples are mostly fixed overhead, so their time slope understates a long
  // run. Reading the projected bytes at the throughput the larger sample achieved is a
  // floor that does scale; that sample's throughput is itself overhead-depressed, which
  // keeps the floor on the conservative side.
  const bytesPerMs = s2.elapsedMs > 0 ? s2.readBytes / s2.elapsedMs : 0
  const elapsedMs = Math.max(at('elapsedMs'), bytesPerMs > 0 ? readBytes / bytesPerMs : 0)
  return {
    blocks,
    readRows: Math.round(at('readRows')),
    readBytes: Math.round(readBytes),
    resultRows: Math.round(resultRows),
    elapsedMs,
    memoryBytes: Math.round(Math.max(s1.memoryBytes, s2.memoryBytes, at('memoryBytes'))),
    storageBytes: Math.round(resultRows * bytesPerRow),
  }
}

/**
 * Light: a year computes in under a minute. Heavy: over half an hour, or a peak above
 * 8 GB — the point where it needs scheduling on the server rather than a click.
 */
export function tierOf(year: Projection): CostTier {
  if (year.elapsedMs > 30 * 60_000 || year.memoryBytes > 8e9) return 'heavy'
  if (year.elapsedMs > 60_000 || year.memoryBytes > 2e9) return 'moderate'
  return 'light'
}

export function notesFor(samples: [SampleRun, SampleRun], loaded: Projection): string[] {
  const notes: string[] = []
  const line = fitLine({ x: samples[0].blocks, y: samples[0].readRows }, { x: samples[1].blocks, y: samples[1].readRows })
  const total = atBlocks(line, samples[1].blocks)
  if (total > 0 && line.fixed / total > 0.5) {
    notes.push(
      'Most of the read cost does not grow with the range (a lookback window or a join), so ' +
        'extrapolation is approximate; the planner figures are the safer guide.',
    )
  }
  if (loaded.resultRows === 0) notes.push('The query returned no rows on the sample.')
  notes.push(
    `Times are the average of ${samples[1].runs ?? 1} runs per sample size. The samples still finish in milliseconds, ` +
      'so treat time as an order of magnitude; rows and bytes read are the reliable measure.',
  )
  return notes
}

/** Blocks currently loaded: the default range a variable is computed over. */
export async function loadedRange(client: ClickHouseClient): Promise<{ from: number; to: number }> {
  const row = await client.queryOne<{ lo: number; hi: number }>({
    sql: 'SELECT min(block_number) AS lo, max(block_number) AS hi FROM blocks',
  })
  if (!row || Number(row.hi) === 0) throw new Error('no blocks are loaded')
  return { from: Number(row.lo), to: Number(row.hi) }
}

/** Compressed bytes per stored value, measured from the values table; read with the API's own user. */
export async function bytesPerStoredRow(client: ClickHouseClient): Promise<number> {
  const row = await client
    .queryOne<{ bytes: string; rows: string }>({
      sql:
        "SELECT sum(data_compressed_bytes) AS bytes, sum(rows) AS rows FROM system.parts " +
        "WHERE database = currentDatabase() AND table = 'tx_variable_values' AND active",
    })
    .catch(() => null)
  const rows = Number(row?.rows ?? 0)
  return rows > 0 ? Number(row?.bytes ?? 0) / rows : DEFAULT_BYTES_PER_ROW
}

/** Runs one sample size `RUNS_PER_SAMPLE` times, one after another, and averages them. */
async function sampleRuns(client: ClickHouseClient, query: string, from: number, to: number): Promise<SampleRun> {
  const runs: SampleRun[] = []
  // Sequential on purpose: concurrent runs would compete for the same cores and inflate
  // each other's times.
  for (let i = 0; i < RUNS_PER_SAMPLE; i++) runs.push(await sampleRun(client, query, from, to))
  return averageRuns(runs)
}

async function sampleRun(client: ClickHouseClient, query: string, from: number, to: number): Promise<SampleRun> {
  // FORMAT Null: the server executes the query fully and discards the result, so the cost
  // measured is the query's, not the cost of shipping rows to us.
  const { summary } = await client.queryWithSummary({
    sql: `SELECT * FROM (\n${query}\n) FORMAT Null`,
    params: { block_from: from, block_to: to },
    settings: SAMPLE_SETTINGS,
  })
  return toSample(summary, to - from + 1)
}

function toSample(s: QuerySummary, blocks: number): SampleRun {
  return {
    blocks,
    readRows: s.readRows,
    readBytes: s.readBytes,
    resultRows: s.resultRows,
    elapsedMs: s.elapsedMs,
    memoryBytes: s.memoryBytes,
  }
}

/**
 * Estimates `query` over `range`. Samples are the newest blocks of the range, at half and
 * full sample size (capped at 50 and 100 blocks). `client` runs the researcher's SQL, so it
 * must be the restricted research user's connection; `bytesPerRow` comes from
 * `bytesPerStoredRow`, which reads system tables that user cannot see.
 */
export async function estimateQuery(
  client: ClickHouseClient,
  query: string,
  range: { from: number; to: number },
  bytesPerRow = DEFAULT_BYTES_PER_ROW,
): Promise<Estimate> {
  const span = range.to - range.from + 1
  const big = Math.min(100, span)
  const small = Math.max(1, Math.min(50, Math.floor(big / 2)))
  const s1 = await sampleRuns(client, query, range.to - small + 1, range.to)
  const s2 = await sampleRuns(client, query, range.to - big + 1, range.to)
  const samples: [SampleRun, SampleRun] = [s1, s2]

  const planner = await client
    .query<{ table: string; rows: string; parts: string; marks: string }>({
      sql: `EXPLAIN ESTIMATE SELECT * FROM (\n${query}\n)`,
      params: { block_from: range.from, block_to: range.to },
      settings: SAMPLE_SETTINGS,
    })
    .then((rows) => rows.map((r) => ({ table: r.table, rows: Number(r.rows), parts: Number(r.parts), marks: Number(r.marks) })))
    .catch(() => [])

  const loaded = project(samples, span, bytesPerRow)
  const year = project(samples, BLOCKS_PER_YEAR, bytesPerRow)
  return {
    samples,
    planner,
    loaded,
    year,
    bytesPerOutputRow: bytesPerRow,
    tier: tierOf(year),
    notes: notesFor(samples, loaded),
    measuredAt: new Date().toISOString(),
  }
}

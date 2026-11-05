import { describe, expect, it } from 'vitest'
import { atBlocks, averageRuns, BLOCKS_PER_YEAR, fitLine, notesFor, project, tierOf, type SampleRun } from './estimate.ts'
import { parseSummaryHeader } from './clickhouse.ts'

const sample = (blocks: number, k: number, fixed = 0): SampleRun => ({
  blocks,
  readRows: fixed + 400 * k * blocks,
  readBytes: fixed * 10 + 16_000 * k * blocks,
  resultRows: 400 * blocks,
  elapsedMs: 1 + 0.2 * blocks,
  memoryBytes: 3_000_000,
})

describe('averageRuns', () => {
  it('averages every figure and keeps the spread of wall times', () => {
    const run = (elapsedMs: number, memoryBytes: number): SampleRun => ({
      blocks: 100, readRows: 40_642, readBytes: 1_500_000, resultRows: 40_642, elapsedMs, memoryBytes,
    })
    const avg = averageRuns([run(30, 6e6), run(9, 5e6), run(12, 7e6)])
    expect(avg).toMatchObject({ blocks: 100, readRows: 40_642, resultRows: 40_642, memoryBytes: 6e6, runs: 3, elapsedMinMs: 9, elapsedMaxMs: 30 })
    expect(avg.elapsedMs).toBeCloseTo(17)
  })

  it('refuses an empty list rather than inventing a measurement', () => {
    expect(() => averageRuns([])).toThrow()
  })
})

describe('fitLine', () => {
  it('separates the fixed cost from the per-block cost', () => {
    expect(fitLine({ x: 50, y: 1_500 }, { x: 100, y: 2_500 })).toEqual({ fixed: 500, perBlock: 20 })
  })

  it('treats a negative slope as pure fixed cost', () => {
    expect(fitLine({ x: 50, y: 10 }, { x: 100, y: 5 })).toEqual({ fixed: 5, perBlock: 0 })
  })

  it('with a negative intercept, goes through the origin and the larger sample', () => {
    // The measured 100-block run must be reproduced exactly, not overshot.
    const line = fitLine({ x: 50, y: 20_000 }, { x: 100, y: 40_642 })
    expect(line.fixed).toBe(0)
    expect(atBlocks(line, 100)).toBeCloseTo(40_642)
  })

  it('handles two samples of the same size as a pure per-block rate', () => {
    expect(fitLine({ x: 100, y: 500 }, { x: 100, y: 500 })).toEqual({ fixed: 0, perBlock: 5 })
    expect(atBlocks({ fixed: 0, perBlock: 5 }, 10)).toBe(50)
  })
})

describe('project', () => {
  it('extrapolates rows, bytes, output and storage linearly', () => {
    const p = project([sample(50, 1), sample(100, 1)], 1_000, 4)
    expect(p.readRows).toBe(400_000)
    expect(p.resultRows).toBe(400_000)
    expect(p.storageBytes).toBe(1_600_000)
    // Linear time would say 201 ms; reading 16 MB at the sample's 76 KB/ms says 210 ms.
    expect(p.elapsedMs).toBeCloseTo(210)
  })

  it('reproduces the larger sample exactly when projecting to its own size', () => {
    const p = project([sample(50, 1), sample(100, 1)], 100, 4)
    expect(p.readRows).toBe(40_000)
    expect(p.resultRows).toBe(40_000)
  })

  it('never reports less memory than either sample used', () => {
    expect(project([sample(50, 1), sample(100, 1)], 10, 4).memoryBytes).toBe(3_000_000)
  })
})

describe('tierOf', () => {
  const base = project([sample(50, 1), sample(100, 1)], BLOCKS_PER_YEAR, 4)
  it('grades a year by time and peak memory', () => {
    expect(tierOf({ ...base, elapsedMs: 30_000 })).toBe('light')
    expect(tierOf({ ...base, elapsedMs: 5 * 60_000 })).toBe('moderate')
    expect(tierOf({ ...base, elapsedMs: 2 * 3600_000 })).toBe('heavy')
    expect(tierOf({ ...base, elapsedMs: 1, memoryBytes: 9e9 })).toBe('heavy')
  })
})

describe('notesFor', () => {
  it('flags a cost dominated by a fixed part, such as a lookback window', () => {
    const lookback: [SampleRun, SampleRun] = [sample(50, 1, 1_000_000), sample(100, 1, 1_000_000)]
    const loaded = project(lookback, 100, 4)
    expect(notesFor(lookback, loaded).join(' ')).toMatch(/lookback/)
    const linear: [SampleRun, SampleRun] = [sample(50, 1), sample(100, 1)]
    expect(notesFor(linear, project(linear, 100, 4)).join(' ')).not.toMatch(/lookback/)
  })
})

describe('parseSummaryHeader', () => {
  it('reads ClickHouse summary numbers, tolerating a missing or malformed header', () => {
    expect(
      parseSummaryHeader(
        '{"read_rows":"24258","read_bytes":"921804","written_rows":"0","result_rows":"20121","elapsed_ns":"22126700","memory_usage":"3442429"}',
      ),
    ).toEqual({ readRows: 24258, readBytes: 921804, writtenRows: 0, resultRows: 20121, elapsedMs: 22.1267, memoryBytes: 3442429 })
    expect(parseSummaryHeader(null).readRows).toBe(0)
    expect(parseSummaryHeader('not json').readRows).toBe(0)
  })
})

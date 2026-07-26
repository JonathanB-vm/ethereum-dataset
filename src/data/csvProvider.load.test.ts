import { describe, it, expect, afterEach, vi } from 'vitest'
import { csvProvider } from './csvProvider'
import multiblockCsv from './__fixtures__/multiblock.csv?raw'
import { CompressionStream } from 'node:stream/web'

// jsdom (the test environment) doesn't implement CompressionStream — same polyfill
// gzip.test.ts uses, needed here to build a real gzipped body for one of the tests below.
globalThis.CompressionStream ??= CompressionStream as unknown as typeof globalThis.CompressionStream

/** Gzip a string using the same web streams API the app decompresses with. */
async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  void writer.write(new TextEncoder().encode(text))
  void writer.close()
  const buf = await new Response(cs.readable as any).arrayBuffer()
  return new Uint8Array(buf)
}

/** A ReadableStream that yields the given chunks one at a time — lets tests force >1 read(). */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
  })
}

/** Minimal fetch Response stand-in — only the members csvProvider().load() actually touches. */
function mockResponse(params: {
  body?: ReadableStream<Uint8Array>
  contentLength?: string | null
  arrayBuffer?: () => Promise<ArrayBuffer>
}): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name === 'Content-Length' ? (params.contentLength ?? null) : null),
    },
    body: params.body,
    arrayBuffer: params.arrayBuffer ?? (async () => new ArrayBuffer(0)),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('csvProvider().load()', () => {
  it('reports monotonically increasing progress and total for a chunked, gzipped body with Content-Length', async () => {
    const gzipped = await gzip(multiblockCsv)
    const mid = Math.floor(gzipped.length / 2)
    const stream = streamFromChunks([gzipped.slice(0, mid), gzipped.slice(mid)])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({ body: stream, contentLength: String(gzipped.length) }),
      ),
    )

    const progressCalls: Array<[number, number | null]> = []
    const { records, malformedCount } = await csvProvider('/fake-url', (loaded, total) => {
      progressCalls.push([loaded, total])
    }).load()

    // >1 read() confirms the chunk-reassembly offset arithmetic actually ran across chunks.
    expect(progressCalls.length).toBeGreaterThanOrEqual(2)
    expect(progressCalls.every(([, total]) => total === gzipped.length)).toBe(true)
    const loadedValues = progressCalls.map(([loaded]) => loaded)
    for (let i = 1; i < loadedValues.length; i++) {
      expect(loadedValues[i]).toBeGreaterThan(loadedValues[i - 1])
    }
    expect(loadedValues.at(-1)).toBe(gzipped.length)

    expect(malformedCount).toBe(0)
    expect(records.map((r) => r.block_number)).toEqual([25534200, 25534201, 25534202])
  })

  it('reports total as null when Content-Length is absent', async () => {
    const bytes = new TextEncoder().encode(multiblockCsv)
    const mid = Math.floor(bytes.length / 2)
    const stream = streamFromChunks([bytes.slice(0, mid), bytes.slice(mid)])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ body: stream, contentLength: null })))

    const progressCalls: Array<[number, number | null]> = []
    const { records } = await csvProvider('/fake-url', (loaded, total) => {
      progressCalls.push([loaded, total])
    }).load()

    expect(progressCalls.length).toBeGreaterThan(0)
    expect(progressCalls.every(([, total]) => total === null)).toBe(true)
    expect(records).toHaveLength(3)
  })

  it('reports total as null — never NaN — when Content-Length is non-numeric', async () => {
    const bytes = new TextEncoder().encode(multiblockCsv)
    const stream = streamFromChunks([bytes])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ body: stream, contentLength: 'not-a-number' })),
    )

    const progressCalls: Array<[number, number | null]> = []
    await csvProvider('/fake-url', (loaded, total) => {
      progressCalls.push([loaded, total])
    }).load()

    expect(progressCalls.length).toBeGreaterThan(0)
    for (const [, total] of progressCalls) {
      expect(total).not.toBeNaN()
      expect(total).toBeNull()
    }
  })

  it('falls back to arrayBuffer() and never calls onProgress when the body has no stream', async () => {
    const bytes = new TextEncoder().encode(multiblockCsv)
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({
          body: undefined,
          contentLength: String(bytes.length),
          arrayBuffer: async () => arrayBuffer,
        }),
      ),
    )

    const progressCalls: Array<[number, number | null]> = []
    const { records, malformedCount } = await csvProvider('/fake-url', (loaded, total) => {
      progressCalls.push([loaded, total])
    }).load()

    expect(progressCalls).toHaveLength(0)
    expect(malformedCount).toBe(0)
    expect(records.map((r) => r.block_number)).toEqual([25534200, 25534201, 25534202])
  })
})

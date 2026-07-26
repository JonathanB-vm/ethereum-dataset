import { describe, it, expect } from 'vitest'
import { isGzipped, decodeMaybeGzipped } from './gzip'
import { CompressionStream, DecompressionStream } from 'node:stream/web'

globalThis.CompressionStream ??= CompressionStream as unknown as typeof globalThis.CompressionStream
globalThis.DecompressionStream ??= DecompressionStream as unknown as typeof globalThis.DecompressionStream

/** Gzip a string using the same web streams API the app decompresses with. */
async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  void writer.write(new TextEncoder().encode(text))
  void writer.close()
  const buf = await new Response(cs.readable as any).arrayBuffer()
  return new Uint8Array(buf)
}

describe('isGzipped', () => {
  it('detects the gzip magic bytes 0x1f 0x8b', async () => {
    expect(isGzipped(await gzip('hello'))).toBe(true)
  })

  it('rejects plain text and too-short buffers', () => {
    expect(isGzipped(new TextEncoder().encode('block_hash,block_number'))).toBe(false)
    expect(isGzipped(new Uint8Array([0x1f]))).toBe(false)
    expect(isGzipped(new Uint8Array([]))).toBe(false)
  })
})

describe('decodeMaybeGzipped', () => {
  it('decompresses gzipped input', async () => {
    const text = 'a,b\r\n1,2\r\n'
    expect(await decodeMaybeGzipped(await gzip(text))).toBe(text)
  })

  it('passes through input a host already decompressed', async () => {
    const text = 'a,b\r\n1,2\r\n'
    expect(await decodeMaybeGzipped(new TextEncoder().encode(text))).toBe(text)
  })

  it('round-trips multi-byte UTF-8', async () => {
    const text = 'Ξ 25,534,200 — blocks'
    expect(await decodeMaybeGzipped(await gzip(text))).toBe(text)
  })
})

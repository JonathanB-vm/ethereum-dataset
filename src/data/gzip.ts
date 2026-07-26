/** Gzip's two-byte header: 0x1f 0x8b. */
export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Decode a fetched artifact to text, decompressing only if it is still gzipped.
 *
 * The sniff is not optional. Artifacts are committed as `.gz`, but some static hosts
 * serve them with `Content-Encoding: gzip`, in which case the browser has *already*
 * decompressed the body — piping that through `DecompressionStream` would throw. Checking
 * the magic bytes makes the same code correct on either kind of host.
 *
 * Requires `DecompressionStream`: Chrome 80+, Firefox 113+, Safari 16.4+.
 */
export async function decodeMaybeGzipped(bytes: Uint8Array): Promise<string> {
  if (!isGzipped(bytes)) return new TextDecoder().decode(bytes)
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser cannot decompress the dataset (DecompressionStream unavailable). ' +
        'Requires Chrome 80+, Firefox 113+, or Safari 16.4+.',
    )
  }
  const response = new Response(bytes as any)
  const stream = response.body!.pipeThrough(new DecompressionStream('gzip') as any)
  return new Response(stream).text()
}

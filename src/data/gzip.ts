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
  // Both Blob.stream() and Response.body produce ReadableStream and are available in all browsers
  // that support DecompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+). However, jsdom's
  // Blob lacks the .stream() method and binary-handling capabilities, making this code untestable
  // under jsdom with Blob.stream(). Response.body is equally valid for this task and is testable,
  // so it is used here to keep both production correctness and test coverage working.
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

// Small byte helpers. The workers-types + TS lib model `Uint8Array` as generic
// over `ArrayBufferLike`, which is NOT assignable to APIs wanting a concrete
// `ArrayBuffer` (`crypto.subtle.digest`, `Response` body). Copying into a fresh
// `ArrayBuffer` sidesteps the mismatch without an `any` cast.

/** Copy `u` into a fresh, exactly-sized `ArrayBuffer`. */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

/** Chunk size for `btoa` conversion: `String.fromCharCode(...)` on a whole
 *  large array overflows the argument stack, so bytes are folded in slices. */
const B64_CHUNK = 0x8000;

/** Base64-encode raw bytes (binary-safe, no line breaks). */
export function toBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += B64_CHUNK) {
    s += String.fromCharCode(...u.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

/** Decode base64 back to raw bytes. Throws on invalid input (via `atob`). */
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

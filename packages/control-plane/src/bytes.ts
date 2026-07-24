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

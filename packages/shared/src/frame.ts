// 4-byte big-endian length-prefixed framing, mirroring
// `crates/mari-proto::frame`. Pure `Uint8Array`/`DataView`; no Node `Buffer`,
// so it runs unchanged in the browser and in Cloudflare Workers.

import { decodeCbor, encodeCbor } from './cbor';

/** Maximum accepted frame body length: 64 MiB. Matches the Rust constant. */
export const MAX_FRAME_LEN = 64 * 1024 * 1024;

/** Prepend a 4-byte big-endian length prefix to a CBOR body. */
export function writeFrame(body: Uint8Array): Uint8Array {
  if (body.length > MAX_FRAME_LEN) {
    throw new RangeError(
      `frame length ${body.length} exceeds maximum ${MAX_FRAME_LEN}`,
    );
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** Encode a value as one length-prefixed frame. */
export function encodeFrame(value: unknown): Uint8Array {
  return writeFrame(encodeCbor(value));
}

/** Decode exactly one complete length-prefixed frame into `T`. */
export function decodeFrame<T = unknown>(frame: Uint8Array): T {
  if (frame.length < 4) {
    throw new RangeError(`truncated frame: need 4 bytes, have ${frame.length}`);
  }
  const len = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (len > MAX_FRAME_LEN) {
    throw new RangeError(`frame length ${len} exceeds maximum ${MAX_FRAME_LEN}`);
  }
  const total = 4 + len;
  if (frame.length < total) {
    throw new RangeError(`truncated frame: need ${total} bytes, have ${frame.length}`);
  }
  return decodeCbor(frame.subarray(4, total)) as T;
}

/**
 * Incremental reader for a byte stream of back-to-back length-prefixed frames.
 * Feed bytes with {@link push}; drain complete frames with {@link nextBody} or
 * {@link next}. Mirrors `mari_proto::FrameReader`.
 */
export class FrameReader {
  #buf = new Uint8Array(0);

  /** Append newly received bytes. */
  push(data: Uint8Array): void {
    if (this.#buf.length === 0) {
      this.#buf = data.slice();
      return;
    }
    const next = new Uint8Array(this.#buf.length + data.length);
    next.set(this.#buf, 0);
    next.set(data, this.#buf.length);
    this.#buf = next;
  }

  /**
   * Return the next complete CBOR body (without its length prefix), or `null`
   * if a full frame has not yet arrived. Consumes the frame.
   */
  nextBody(): Uint8Array | null {
    if (this.#buf.length < 4) return null;
    const len = new DataView(
      this.#buf.buffer,
      this.#buf.byteOffset,
      this.#buf.byteLength,
    ).getUint32(0, false);
    if (len > MAX_FRAME_LEN) {
      throw new RangeError(`frame length ${len} exceeds maximum ${MAX_FRAME_LEN}`);
    }
    const total = 4 + len;
    if (this.#buf.length < total) return null;
    const body = this.#buf.slice(4, total);
    this.#buf = this.#buf.slice(total);
    return body;
  }

  /** Decode the next complete frame into `T`, or `null` if incomplete. */
  next<T = unknown>(): T | null {
    const body = this.nextBody();
    return body === null ? null : (decodeCbor(body) as T);
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get buffered(): number {
    return this.#buf.length;
  }
}

// Framing behaviour, and cross-language framing against the Rust-produced
// `.frame` fixtures.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FrameReader,
  MAX_FRAME_LEN,
  decodeFrame,
  encodeFrame,
  writeFrame,
} from '../src/frame';
import { decodeCbor } from '../src/cbor';
import type { SupervisorMessage } from '../src/messages';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

describe('cross-language framing', () => {
  for (const name of ['sup_hello', 'sup_journal_frame']) {
    it(`Rust ${name}.frame = 4-byte BE length + ${name}.cbor body`, () => {
      const frame = read(`${name}.frame`);
      const body = read(`${name}.cbor`);

      const declared = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
        0,
        false,
      );
      expect(declared).toBe(body.length);

      // Our reader extracts exactly the Rust body.
      const reader = new FrameReader();
      reader.push(frame);
      const extracted = reader.nextBody();
      expect(extracted).not.toBeNull();
      expect(Array.from(extracted as Uint8Array)).toEqual(Array.from(body));
      expect(reader.buffered).toBe(0);

      // And our writer reproduces the Rust frame byte-for-byte.
      expect(Array.from(writeFrame(body))).toEqual(Array.from(frame));

      // And decodeFrame yields a usable message.
      const msg = decodeFrame<SupervisorMessage>(frame);
      expect(msg.t).toBe(name === 'sup_hello' ? 'hello' : 'journal_frame');
    });
  }
});

describe('FrameReader', () => {
  it('reassembles frames fed one byte at a time', () => {
    const messages: SupervisorMessage[] = [
      { t: 'run_heartbeat', c: { run: 'a' } },
      { t: 'run_heartbeat', c: { run: 'bb' } },
      { t: 'run_heartbeat', c: { run: 'ccc' } },
    ];
    const stream = messages.reduce<number[]>((acc, m) => {
      acc.push(...encodeFrame(m));
      return acc;
    }, []);

    const reader = new FrameReader();
    const out: SupervisorMessage[] = [];
    for (const byte of stream) {
      reader.push(new Uint8Array([byte]));
      let msg: SupervisorMessage | null;
      while ((msg = reader.next<SupervisorMessage>()) !== null) out.push(msg);
    }
    expect(out).toEqual(messages);
    expect(reader.buffered).toBe(0);
  });

  it('returns null until a full frame has arrived', () => {
    const frame = encodeFrame({ t: 'prepare_for_cold' });
    const reader = new FrameReader();
    reader.push(frame.subarray(0, frame.length - 1));
    expect(reader.next()).toBeNull();
    reader.push(frame.subarray(frame.length - 1));
    expect(reader.next()).toEqual({ t: 'prepare_for_cold' });
  });

  it('rejects an oversized declared length before allocating', () => {
    const bogus = new Uint8Array(4);
    new DataView(bogus.buffer).setUint32(0, MAX_FRAME_LEN + 1, false);
    const reader = new FrameReader();
    reader.push(bogus);
    expect(() => reader.nextBody()).toThrow(/exceeds maximum/);
    expect(() => decodeFrame(bogus)).toThrow(/exceeds maximum/);
  });

  it('round-trips a value through encodeFrame/decodeFrame', () => {
    const msg: SupervisorMessage = {
      t: 'journal_frame',
      c: { run: 'run-1', offset: 42, bytes: new Uint8Array([0, 27, 255]) },
    };
    const decoded = decodeFrame<SupervisorMessage>(encodeFrame(msg));
    expect(decoded.t).toBe('journal_frame');
    if (decoded.t === 'journal_frame') {
      expect(decoded.c.offset).toBe(42);
      expect(Array.from(decoded.c.bytes)).toEqual([0, 27, 255]);
    }
  });
});

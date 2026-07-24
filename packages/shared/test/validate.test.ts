// Runtime validation teeth: valid fixtures pass; malformed inputs throw.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeCbor } from '../src/cbor';
import {
  ValidationError,
  decodeControlMessage,
  decodeManifest,
  decodeSupervisorMessage,
} from '../src/validate';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');
const read = (name: string) => new Uint8Array(readFileSync(join(fixturesDir, `${name}.cbor`)));

describe('validation accepts real fixtures', () => {
  it('supervisor messages', () => {
    const hello = decodeSupervisorMessage(read('sup_hello'));
    expect(hello.t).toBe('hello');
    const jf = decodeSupervisorMessage(read('sup_journal_frame'));
    expect(jf.t).toBe('journal_frame');
    if (jf.t === 'journal_frame') expect(ArrayBuffer.isView(jf.c.bytes)).toBe(true);
  });

  it('control messages incl. payload-free variant', () => {
    expect(decodeControlMessage(read('ctl_prepare_for_cold')).t).toBe('prepare_for_cold');
    expect(decodeControlMessage(read('ctl_start_run')).t).toBe('start_run');
  });

  it('manifest', () => {
    const m = decodeManifest(read('manifest'));
    expect(m.version).toBe(1);
    expect(m.entries).toHaveLength(4);
    expect(m.entries[1]?.symlink_target).toBe('bash');
    expect(m.entries[2]?.chunks[0]?.len).toBe(12);
  });
});

describe('validation rejects malformed input', () => {
  it('unknown supervisor variant', () => {
    const bytes = encodeCbor({ t: 'nope', c: {} });
    expect(() => decodeSupervisorMessage(bytes)).toThrow(ValidationError);
  });

  it('journal_frame with non-bytes payload', () => {
    const bytes = encodeCbor({ t: 'journal_frame', c: { run: 'r', offset: 0, bytes: 'nope' } });
    expect(() => decodeSupervisorMessage(bytes)).toThrow(/bytes/);
  });

  it('control message missing payload', () => {
    const bytes = encodeCbor({ t: 'start_run' });
    expect(() => decodeControlMessage(bytes)).toThrow(ValidationError);
  });

  it('manifest entry with unknown kind', () => {
    const bytes = encodeCbor({
      version: 1,
      parent: null,
      created_at: 0,
      entries: [{ path: '/x', kind: 'device', mode: 0, size: 0, symlink_target: null, chunks: [] }],
    });
    expect(() => decodeManifest(bytes)).toThrow(/kind/);
  });

  it('rejects a top-level non-object', () => {
    expect(() => decodeSupervisorMessage(encodeCbor(42))).toThrow(ValidationError);
  });
});

// REVIEW REPRO (now closed): validate.ts used to check only the discriminant tag
// and that a payload object was present — it did NOT validate payload FIELD
// types, despite the module docstring promising it "narrows it to the mirrored
// types, throwing ValidationError on any shape that does not match".
//
// Concretely: the "BigInt leaked?" u53 guard (whose stated purpose is to stop a
// decoded BigInt from silently breaking structural equality — the fencing epoch
// comparison in ComputerDO) was applied to exactly ONE of the six u64 wire
// fields (journal_frame.offset). hello.epoch, head_advance_request.epoch,
// snapshot_written.epoch, head_advance_result.current_epoch and the hello_ack
// RunOffset.offset were all unguarded, as was every non-u64 field on every
// non-journal_frame variant.
//
// These `it`s assert the CORRECT behavior. They failed before validate.ts was
// rewritten to validate payload fields; the block is no longer skipped.

import { describe, it, expect } from 'vitest';
import { encodeCbor, decodeCbor } from '../src/cbor';
import { MAX_SAFE_INTEGER } from '../src/ids';
import {
  ValidationError,
  asClientToDo,
  asControlMessage,
  asDoToClient,
  asSupervisorMessage,
  decodeClientToDo,
  decodeControlMessage,
  decodeDoToClient,
  decodeSupervisorMessage,
} from '../src/validate';

type Rec = Record<string, unknown>;

/** A decoder under test, keyed by the envelope a case belongs to. */
type Decoder = (bytes: Uint8Array) => unknown;
/** The same validator applied to an already-decoded value. */
type Narrower = (value: unknown) => unknown;

const decoders = {
  supervisor: decodeSupervisorMessage as Decoder,
  control: decodeControlMessage as Decoder,
  client: decodeClientToDo as Decoder,
  do: decodeDoToClient as Decoder,
} as const;

const narrowers = {
  supervisor: asSupervisorMessage as Narrower,
  control: asControlMessage as Narrower,
  client: asClientToDo as Narrower,
  do: asDoToClient as Narrower,
} as const;

/** A u64 value one JS-safe step past the ceiling. Only a BigInt can carry it
 *  onto the wire: `encodeCbor` refuses an out-of-range Number outright. */
const PAST_U53 = 9_007_199_254_740_995n;

const M = (ch: string) => ch.repeat(64);
const DIFF = { added: 1, modified: 2, removed: 3 };

/** One valid exemplar per wire variant, plus the corruptions that must be
 *  rejected. `path` is dotted, indexing into the decoded message. */
interface Case {
  readonly envelope: keyof typeof decoders;
  readonly valid: Rec;
  readonly bad: ReadonlyArray<readonly [path: string, value: unknown, expected: RegExp]>;
}

const CASES: Readonly<Record<string, Case>> = {
  // ---- SupervisorMessage (contracts.md §5.1) ----
  hello: {
    envelope: 'supervisor',
    valid: { t: 'hello', c: { computer: 'c1', epoch: 7, token: 'tok', proto_version: 1 } },
    bad: [
      ['c.computer', 42, /hello\.computer: expected string/],
      ['c.epoch', 'seven', /hello\.epoch: expected a non-negative integer/],
      ['c.token', ['tok'], /hello\.token: expected string/],
      ['c.proto_version', 'one', /hello\.proto_version/],
    ],
  },
  journal_frame: {
    envelope: 'supervisor',
    valid: { t: 'journal_frame', c: { run: 'r1', offset: 4096, bytes: new Uint8Array([1, 2, 3]) } },
    bad: [
      ['c.run', 7, /journal_frame\.run: expected string/],
      ['c.offset', -1, /journal_frame\.offset: expected a non-negative integer/],
      ['c.bytes', 'nope', /journal_frame\.bytes: expected a CBOR byte string/],
    ],
  },
  run_started: {
    envelope: 'supervisor',
    valid: { t: 'run_started', c: { run: 'r1', pre_run_manifest: M('a') } },
    bad: [
      ['c.run', null, /run_started\.run: expected string/],
      ['c.pre_run_manifest', { nested: true }, /run_started\.pre_run_manifest: expected string/],
    ],
  },
  run_completed: {
    envelope: 'supervisor',
    valid: {
      t: 'run_completed',
      c: { run: 'r1', exit: { t: 'exited', c: { code: 0 } }, post_run_manifest: M('b'), diff: DIFF },
    },
    bad: [
      ['c.exit', 'exited', /run_completed\.exit: expected object/],
      ['c.exit.t', 'vanished', /run_completed\.exit\.t: unknown ExitStatus variant/],
      ['c.exit.c.code', '0', /run_completed\.exit\.c\.code: expected an integer/],
      ['c.post_run_manifest', 3, /run_completed\.post_run_manifest: expected string/],
      ['c.diff.added', '1', /run_completed\.diff\.added/],
    ],
  },
  snapshot_written: {
    envelope: 'supervisor',
    valid: { t: 'snapshot_written', c: { manifest: M('c'), epoch: 9, reason: 'pre_run' } },
    bad: [
      ['c.manifest', 12, /snapshot_written\.manifest: expected string/],
      ['c.epoch', 'nine', /snapshot_written\.epoch: expected a non-negative integer/],
      ['c.reason', 'whenever', /snapshot_written\.reason: unknown value "whenever"/],
    ],
  },
  head_advance_request: {
    envelope: 'supervisor',
    valid: { t: 'head_advance_request', c: { manifest: M('d'), epoch: 9 } },
    bad: [
      ['c.manifest', { nested: true }, /head_advance_request\.manifest: expected string/],
      ['c.epoch', true, /head_advance_request\.epoch: expected a non-negative integer/],
    ],
  },
  attention: {
    envelope: 'supervisor',
    valid: { t: 'attention', c: { run: 'r1', kind: 'bell' } },
    bad: [
      ['c.run', 1, /attention\.run: expected string/],
      ['c.kind', 'panic', /attention\.kind: unknown value "panic"/],
    ],
  },
  run_heartbeat: {
    envelope: 'supervisor',
    valid: { t: 'run_heartbeat', c: { run: 'r1' } },
    bad: [['c.run', 7, /run_heartbeat\.run: expected string/]],
  },
  rollback_detected: {
    envelope: 'supervisor',
    valid: {
      t: 'rollback_detected',
      c: {
        disk_manifest: M('e'),
        recorded_manifest: M('f'),
        diff: DIFF,
        runs: [{ run: 'r1', control_offset: 4096, disk_offset: 1024, replayed: false }],
      },
    },
    bad: [
      ['c.disk_manifest', 0, /rollback_detected\.disk_manifest: expected string/],
      ['c.recorded_manifest', 5, /rollback_detected\.recorded_manifest: expected string or null/],
      ['c.runs', 'none', /rollback_detected\.runs: expected array/],
      ['c.runs.0.replayed', 'yes', /rollback_detected\.runs\[0\]\.replayed: expected boolean/],
      ['c.runs.0.control_offset', '4096', /rollback_detected\.runs\[0\]\.control_offset/],
    ],
  },

  // ---- ControlMessage (contracts.md §5.2) ----
  hello_ack: {
    envelope: 'control',
    valid: { t: 'hello_ack', c: { acked: [{ run: 'r1', offset: 12 }] } },
    bad: [
      ['c.acked', { r1: 12 }, /hello_ack\.acked: expected array/],
      ['c.acked.0.run', 1, /hello_ack\.acked\[0\]\.run: expected string/],
      ['c.acked.0.offset', '12', /hello_ack\.acked\[0\]\.offset/],
    ],
  },
  journal_ack: {
    envelope: 'control',
    valid: { t: 'journal_ack', c: { run: 'r1', offset: 12 } },
    bad: [
      ['c.run', 1, /journal_ack\.run: expected string/],
      ['c.offset', -1, /journal_ack\.offset: expected a non-negative integer/],
    ],
  },
  start_run: {
    envelope: 'control',
    valid: {
      t: 'start_run',
      c: { run: 'r1', argv: ['/bin/sh', '-c', 'true'], env_names: ['ANTHROPIC_API_KEY'], cwd: '/home/agent' },
    },
    bad: [
      ['c.argv', 'ls', /start_run\.argv: expected array/],
      ['c.argv.1', 7, /start_run\.argv\[1\]: expected string/],
      ['c.env_names', 3, /start_run\.env_names: expected array/],
      ['c.cwd', 7, /start_run\.cwd: expected string/],
    ],
  },
  stop_run: {
    envelope: 'control',
    valid: { t: 'stop_run', c: { run: 'r1' } },
    bad: [['c.run', null, /stop_run\.run: expected string/]],
  },
  input: {
    envelope: 'control',
    valid: { t: 'input', c: { run: 'r1', bytes: new Uint8Array([27, 91]) } },
    bad: [
      ['c.run', 1, /input\.run: expected string/],
      ['c.bytes', [1, 2, 3], /input\.bytes: expected a CBOR byte string/],
    ],
  },
  resize: {
    envelope: 'control',
    valid: { t: 'resize', c: { run: 'r1', cols: 80, rows: 24 } },
    bad: [
      ['c.cols', '80', /resize\.cols/],
      // u16 on the Rust side: a larger value is a frame ciborium cannot decode.
      ['c.cols', 100_000, /resize\.cols: 100000 exceeds this field's maximum of 65535/],
      ['c.rows', -1, /resize\.rows: expected a non-negative integer/],
    ],
  },
  snapshot_now: {
    envelope: 'control',
    valid: { t: 'snapshot_now', c: { reason: 'command' } },
    bad: [
      ['c.reason', 3, /snapshot_now\.reason: expected string/],
      ['c.reason', 'because', /snapshot_now\.reason: unknown value "because"/],
    ],
  },
  head_advance_result: {
    envelope: 'control',
    valid: { t: 'head_advance_result', c: { accepted: true, current_epoch: 9 } },
    bad: [
      ['c.accepted', 'yes', /head_advance_result\.accepted: expected boolean/],
      ['c.current_epoch', '9999', /head_advance_result\.current_epoch/],
    ],
  },
  restore_to_manifest: {
    envelope: 'control',
    valid: { t: 'restore_to_manifest', c: { manifest: M('a') } },
    bad: [['c.manifest', 7, /restore_to_manifest\.manifest: expected string/]],
  },

  // ---- ClientToDo attach protocol (contracts.md §7.1) ----
  client_attach: {
    envelope: 'client',
    valid: { t: 'attach', run: 'r1', cols: 80, rows: 24 },
    bad: [
      ['run', 5, /ClientToDo\(attach\)\.run: expected string/],
      ['cols', '80', /ClientToDo\(attach\)\.cols/],
      // The DO re-frames this as ControlMessage::Resize { cols: u16, rows: u16 }.
      ['rows', 70_000, /ClientToDo\(attach\)\.rows: 70000 exceeds this field's maximum of 65535/],
    ],
  },
  client_input: {
    envelope: 'client',
    valid: { t: 'input', run: 'r1', bytes: new Uint8Array([104, 105]) },
    bad: [
      ['run', null, /ClientToDo\(input\)\.run: expected string/],
      ['bytes', 'hi', /ClientToDo\(input\)\.bytes: expected a CBOR byte string/],
    ],
  },
  client_resize: {
    envelope: 'client',
    valid: { t: 'resize', run: 'r1', cols: 120, rows: 40 },
    bad: [
      ['cols', 1e6, /ClientToDo\(resize\)\.cols/],
      ['rows', -1, /ClientToDo\(resize\)\.rows: expected a non-negative integer/],
    ],
  },
  client_detach: {
    envelope: 'client',
    valid: { t: 'detach', run: 'r1' },
    bad: [['run', 5, /ClientToDo\(detach\)\.run: expected string/]],
  },

  // ---- DoToClient attach protocol (contracts.md §7.2) ----
  do_grid: {
    envelope: 'do',
    valid: {
      t: 'grid',
      run: 'r1',
      grid: {
        cols: 2,
        rows: 1,
        cells: [
          [
            { ch: 'x', attrs: 0, fg: -1, bg: -1 },
            { ch: 'y', attrs: 1, fg: 0xff_00_00, bg: 0 },
          ],
        ],
        cursorCol: 0,
        cursorRow: 0,
        cursorVisible: true,
      },
      baseOffset: 0,
    },
    bad: [
      ['grid', 'empty', /DoToClient\(grid\)\.grid: expected object/],
      ['grid.cursorVisible', 1, /DoToClient\(grid\)\.grid\.cursorVisible: expected boolean/],
      ['grid.cells.0.1.fg', 'red', /DoToClient\(grid\)\.grid\.cells\[0\]\[1\]\.fg: expected an integer/],
      ['grid.cells.0.1.ch', 120, /DoToClient\(grid\)\.grid\.cells\[0\]\[1\]\.ch: expected string/],
      ['baseOffset', '0', /DoToClient\(grid\)\.baseOffset/],
    ],
  },
  do_frame: {
    envelope: 'do',
    valid: { t: 'frame', run: 'r1', offset: 5, bytes: new Uint8Array([7]) },
    bad: [
      ['offset', -5, /DoToClient\(frame\)\.offset: expected a non-negative integer/],
      ['bytes', 7, /DoToClient\(frame\)\.bytes: expected a CBOR byte string/],
    ],
  },
  do_run_status: {
    envelope: 'do',
    valid: { t: 'run_status', run: 'r1', alive: false, exitCode: 0 },
    bad: [
      ['alive', 1, /DoToClient\(run_status\)\.alive: expected boolean/],
      ['exitCode', 'ok', /DoToClient\(run_status\)\.exitCode: expected an integer/],
    ],
  },
};

/** Set a dotted path (array indices included) on a deep clone of `base`. */
function withField(base: Rec, path: string, value: unknown): Rec {
  const clone = structuredClone(base);
  const parts = path.split('.');
  let cursor = clone as Rec;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor[parts[i]!] as Rec;
  }
  cursor[parts[parts.length - 1]!] = value;
  return clone;
}

/** Delete a dotted path on a deep clone of `base`. */
function withoutField(base: Rec, path: string): Rec {
  const clone = structuredClone(base);
  const parts = path.split('.');
  let cursor = clone as Rec;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor[parts[i]!] as Rec;
  }
  delete cursor[parts[parts.length - 1]!];
  return clone;
}

const names = Object.keys(CASES);

describe('every message variant is structurally validated', () => {
  it('covers every variant of both wire envelopes and both attach directions', () => {
    // If a variant is added to messages.ts or attach.ts without a case here,
    // this count is the thing that notices.
    const supervisor = names.filter((n) => CASES[n]!.envelope === 'supervisor');
    const control = names.filter((n) => CASES[n]!.envelope === 'control');
    // SupervisorMessage has 9 variants; ControlMessage has 10, of which
    // `prepare_for_cold` is payload-free and so has no field to corrupt.
    expect(supervisor).toHaveLength(9);
    expect(control).toHaveLength(9);
    expect(names.filter((n) => CASES[n]!.envelope === 'client')).toHaveLength(4);
    expect(names.filter((n) => CASES[n]!.envelope === 'do')).toHaveLength(3);
  });

  for (const name of names) {
    const testCase = CASES[name]!;
    const decode = decoders[testCase.envelope];

    it(`${name}: accepts the valid exemplar and returns it unchanged`, () => {
      const bytes = encodeCbor(testCase.valid);
      const decoded = decodeCbor(bytes) as Rec;
      const before = structuredClone(decoded);
      const narrowed = narrowers[testCase.envelope](decoded);
      // No reallocation: the validator narrows in place, which is what keeps it
      // affordable on the per-frame journal path.
      expect(narrowed).toBe(decoded);
      // Same shape in, same shape out: validation neither drops nor rewrites a
      // field of a conformant message.
      expect(decoded).toEqual(before);
      expect(decode(bytes)).toEqual(before);
    });

    for (const [path, value, expected] of testCase.bad) {
      it(`${name}: rejects a wrong-typed ${path} with a useful error`, () => {
        const bytes = encodeCbor(withField(testCase.valid, path, value));
        expect(() => decode(bytes)).toThrow(ValidationError);
        expect(() => decode(bytes)).toThrow(expected);
      });
    }
  }

  it('run_status carries a null exitCode while the run is alive', () => {
    const msg = decodeDoToClient(
      encodeCbor({ t: 'run_status', run: 'r1', alive: true, exitCode: null }),
    );
    expect(msg).toEqual({ t: 'run_status', run: 'r1', alive: true, exitCode: null });
  });

  it('prepare_for_cold (payload-free) is accepted, and an unknown tag is not', () => {
    expect(decodeControlMessage(encodeCbor({ t: 'prepare_for_cold' }))).toEqual({
      t: 'prepare_for_cold',
    });
    expect(() => decodeControlMessage(encodeCbor({ t: 'prepare_for_warm' }))).toThrow(
      /ControlMessage\.t: unknown variant "prepare_for_warm"/,
    );
    expect(() => decodeControlMessage(encodeCbor({ t: 7, c: {} }))).toThrow(
      /ControlMessage\.t: expected string/,
    );
    expect(() => decodeSupervisorMessage(encodeCbor({ t: 'goodbye', c: {} }))).toThrow(
      /SupervisorMessage\.t: unknown variant "goodbye"/,
    );
  });
});

describe('required fields must be present, not merely well-typed when present', () => {
  const missing: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['hello', 'c.epoch', /hello\.epoch/],
    ['hello', 'c.token', /hello\.token/],
    ['journal_frame', 'c.bytes', /journal_frame\.bytes/],
    ['head_advance_request', 'c.epoch', /head_advance_request\.epoch/],
    ['run_completed', 'c.diff', /run_completed\.diff/],
    ['head_advance_result', 'c.current_epoch', /head_advance_result\.current_epoch/],
    ['start_run', 'c.cwd', /start_run\.cwd/],
    ['client_attach', 'rows', /ClientToDo\(attach\)\.rows/],
  ];

  for (const [name, path, expected] of missing) {
    it(`${name} without ${path} is rejected`, () => {
      const testCase = CASES[name]!;
      const bytes = encodeCbor(withoutField(testCase.valid, path));
      expect(() => decoders[testCase.envelope](bytes)).toThrow(expected);
      expect(() => decoders[testCase.envelope](bytes)).toThrow(/nothing \(field missing\)/);
    });
  }

  it('a payload object is still required where the contract has one', () => {
    expect(() => decodeControlMessage(encodeCbor({ t: 'start_run' }))).toThrow(
      /start_run\.c: expected payload object/,
    );
    expect(() => decodeSupervisorMessage(encodeCbor({ t: 'hello', c: 'c1' }))).toThrow(
      /hello\.c: expected payload object/,
    );
  });
});

// ---------------------------------------------------------------------------
// The fencing-critical u64 guard, on EVERY u64 field
// ---------------------------------------------------------------------------

describe('u64 fields: a 2^53-crossing value is rejected loudly on every variant', () => {
  const u64Fields: ReadonlyArray<readonly [string, string]> = [
    ['hello', 'c.epoch'],
    ['journal_frame', 'c.offset'],
    ['snapshot_written', 'c.epoch'],
    ['head_advance_request', 'c.epoch'],
    ['rollback_detected', 'c.runs.0.control_offset'],
    ['hello_ack', 'c.acked.0.offset'],
    ['journal_ack', 'c.offset'],
    ['head_advance_result', 'c.current_epoch'],
    ['do_frame', 'offset'],
    ['do_grid', 'baseOffset'],
  ];

  for (const [name, path] of u64Fields) {
    it(`${name}.${path} past 2^53 throws instead of silently rounding`, () => {
      const testCase = CASES[name]!;
      // Only a BigInt can put this on the wire: cbor.ts's encode-side
      // `assertJsSafe` already refuses an out-of-range Number.
      const bytes = encodeCbor(withField(testCase.valid, path, PAST_U53));
      // Proof the value really does arrive corrupted if nobody looks: cbor-x's
      // `int64AsNumber` hands back a ROUNDED number, not the value sent.
      const raw = decodeCbor(bytes);
      expect(JSON.stringify(raw)).toContain('9007199254740996');
      expect(() => decoders[testCase.envelope](bytes)).toThrow(ValidationError);
      expect(() => decoders[testCase.envelope](bytes)).toThrow(/2\^53|safe-integer/);
    });
  }

  it('the largest legal u64 (2^53 - 1) is still accepted', () => {
    const bytes = encodeCbor(withField(CASES['hello']!.valid, 'c.epoch', MAX_SAFE_INTEGER));
    const msg = decodeSupervisorMessage(bytes);
    expect(msg.t).toBe('hello');
    if (msg.t === 'hello') expect(msg.c.epoch).toBe(MAX_SAFE_INTEGER);
  });

  it('an in-range BigInt epoch is normalized to a Number, restoring `===`', () => {
    // This is the fencing failure the guard exists to prevent: `epoch ===
    // meta.epoch` in ComputerDO#onHeadAdvance is bigint-vs-number, i.e. always
    // false, so a legitimate supervisor is fenced out of its own computer.
    const raw: Rec = { t: 'head_advance_request', c: { manifest: 'm', epoch: 5n } };
    expect((raw['c'] as Rec)['epoch'] === 5).toBe(false);
    const msg = asSupervisorMessage(raw);
    expect(msg.t).toBe('head_advance_request');
    if (msg.t === 'head_advance_request') {
      expect(typeof msg.c.epoch).toBe('number');
      expect(msg.c.epoch === 5).toBe(true);
    }
  });

  it('an out-of-range BigInt epoch is rejected, never coerced', () => {
    const raw: Rec = { t: 'hello', c: { computer: 'c', epoch: PAST_U53, token: 't', proto_version: 1 } };
    expect(() => asSupervisorMessage(raw)).toThrow(/hello\.epoch: u64 .*outside the JS safe-integer/);
  });
});

// ---------------------------------------------------------------------------
// Documented leniency (see the validate.ts header)
// ---------------------------------------------------------------------------

describe('unknown map keys follow the Rust side', () => {
  it('an extra key is ignored, because mari-proto does not deny_unknown_fields', () => {
    // ciborium accepts extra keys on every wire struct (no
    // `serde(deny_unknown_fields)` on any of them), so the TS mirror must not be
    // stricter than the format it mirrors. The known fields are still checked.
    const bytes = encodeCbor({
      t: 'head_advance_request',
      c: { manifest: M('a'), epoch: 3, future_field: 'from a newer marid' },
    });
    const msg = decodeSupervisorMessage(bytes);
    expect(msg.t).toBe('head_advance_request');
    if (msg.t === 'head_advance_request') expect(msg.c.epoch).toBe(3);

    const bad = encodeCbor({
      t: 'head_advance_request',
      c: { manifest: 7, epoch: 3, future_field: 'from a newer marid' },
    });
    expect(() => decodeSupervisorMessage(bad)).toThrow(ValidationError);
  });
});

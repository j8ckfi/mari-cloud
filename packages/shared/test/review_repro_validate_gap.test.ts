// REVIEW REPRO (skipped): validate.ts only checks the discriminant tag and that
// a payload object is present — it does NOT validate payload FIELD types, despite
// the module docstring promising it "narrows it to the mirrored types, throwing
// ValidationError on any shape that does not match."
//
// Concretely: the "BigInt leaked?" u53 guard (whose stated purpose is to stop a
// decoded BigInt from silently breaking structural equality — the fencing epoch
// comparison in ComputerDO) is applied to exactly ONE of the six u64 wire fields
// (journal_frame.offset). hello.epoch, head_advance_request.epoch,
// snapshot_written.epoch, and hello_ack RunOffset.offset are all unguarded, as
// are every non-u64 field on every non-journal_frame variant.
//
// These `it`s assert the CORRECT (desired) behavior and therefore FAIL today, so
// the whole block is `describe.skip` to keep the main suite green. Un-skip after
// validate.ts validates payload fields to see them pass.

import { describe, it, expect } from 'vitest';
import { encodeCbor } from '../src/cbor';
import {
  ValidationError,
  decodeControlMessage,
  decodeSupervisorMessage,
} from '../src/validate';

describe.skip('validate.ts payload field-type gaps (currently NOT enforced)', () => {
  it('rejects head_advance_result with a string `accepted` and string `current_epoch`', () => {
    const bytes = encodeCbor({
      t: 'head_advance_result',
      c: { accepted: 'yes', current_epoch: '9999' },
    });
    // Today: accepted (no throw). Desired: throws.
    expect(() => decodeControlMessage(bytes)).toThrow(ValidationError);
  });

  it('rejects head_advance_request whose epoch leaked as a BigInt > 2^53', () => {
    // The fencing-critical field. A BigInt here makes `epoch === meta.epoch`
    // (bigint === number) always false in ComputerDO#onHeadAdvance — exactly the
    // silent-equality break the u53 guard exists to prevent, but it is not applied
    // to this field.
    const bytes = encodeCbor({
      t: 'head_advance_request',
      c: { manifest: 'm', epoch: 9_007_199_254_740_995n },
    });
    expect(() => decodeSupervisorMessage(bytes)).toThrow(ValidationError);
  });

  it('rejects head_advance_request whose manifest is an object, not a string', () => {
    const bytes = encodeCbor({
      t: 'head_advance_request',
      c: { manifest: { nested: true }, epoch: 5 },
    });
    // Today this passes, and ComputerDO#onHeadAdvance would set the manifest head
    // to `{nested:true}` and persist it.
    expect(() => decodeSupervisorMessage(bytes)).toThrow(ValidationError);
  });

  it('rejects start_run with a non-array argv and numeric cwd', () => {
    const bytes = encodeCbor({
      t: 'start_run',
      c: { run: 'r', argv: 'ls', env_names: 3, cwd: 7 },
    });
    expect(() => decodeControlMessage(bytes)).toThrow(ValidationError);
  });
});

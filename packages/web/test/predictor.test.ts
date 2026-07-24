import { describe, it, expect } from 'vitest';
import { EchoPredictor } from '../src/terminal/predictor';

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);
const DEL = new Uint8Array([0x7f]);

describe('EchoPredictor — prediction', () => {
  it('predicts printable echo at the cursor and advances it', () => {
    const p = new EchoPredictor();
    const ov = p.input(bytes('a'));
    expect(ov.cursor).toBe(1);
    expect(ov.marks).toEqual([0]);
    expect(p.predictedText()).toBe('a');
    expect(p.pendingCount).toBe(1);
  });

  it('predicts type-ahead of several characters', () => {
    const p = new EchoPredictor();
    p.input(bytes('abc'));
    expect(p.predictedText()).toBe('abc');
    expect(p.predictedCursor()).toBe(3);
    expect(p.pendingCount).toBe(3);
    expect(p.overlay().marks).toEqual([0, 1, 2]);
  });

  it('predicts backspace as erase + cursor retreat', () => {
    const p = new EchoPredictor();
    p.input(bytes('ab'));
    p.input(DEL);
    expect(p.predictedText()).toBe('a');
    expect(p.predictedCursor()).toBe(1);
    expect(p.pendingCount).toBe(3); // char a, char b, backspace
  });

  it('predicts nothing for a backspace at column 0', () => {
    const p = new EchoPredictor();
    p.input(DEL);
    expect(p.pendingCount).toBe(0);
    expect(p.predictedCursor()).toBe(0);
  });

  it('does not predict escape sequences (arrow keys, etc.)', () => {
    const p = new EchoPredictor();
    p.input(new Uint8Array([0x1b, 0x5b, 0x41])); // ESC [ A  (up arrow), one CSI seq
    expect(p.pendingCount).toBe(0);
    // A printable byte after the sequence terminates is predicted normally.
    p.input(new Uint8Array([0x78])); // 'x'
    expect(p.pendingCount).toBe(1);
  });
});

describe('EchoPredictor — reconciliation (confirm)', () => {
  it('confirms a single correct echo and clears the mark', () => {
    const p = new EchoPredictor();
    p.input(bytes('a'));
    const r = p.reconcile(bytes('a'));
    expect(r.confirmed).toBe(1);
    expect(r.corrected).toBe(false);
    expect(p.pendingCount).toBe(0);
    expect(r.overlay.marks).toEqual([]);
    expect(p.authoritativeText()).toBe('a');
    expect(p.predictedText()).toBe('a');
  });

  it('confirms type-ahead incrementally as echoes arrive', () => {
    const p = new EchoPredictor();
    p.input(bytes('abc'));
    const r1 = p.reconcile(bytes('a'));
    expect(r1.confirmed).toBe(1);
    expect(p.pendingCount).toBe(2);
    expect(p.overlay().marks).toEqual([1, 2]);
    const r2 = p.reconcile(bytes('bc'));
    expect(r2.confirmed).toBe(2);
    expect(p.pendingCount).toBe(0);
    expect(p.authoritativeText()).toBe('abc');
  });

  it('round-trips a backspace edit against verbatim echoes', () => {
    const p = new EchoPredictor();
    p.input(bytes('ab'));
    p.input(DEL); // predicted line: "a"
    expect(p.predictedText()).toBe('a');
    // Server echoes the same three keystrokes verbatim: 'a', 'b', DEL.
    p.reconcile(bytes('ab'));
    const r = p.reconcile(DEL);
    expect(r.corrected).toBe(false);
    expect(p.pendingCount).toBe(0);
    expect(p.authoritativeText()).toBe('a');
    expect(p.predictedText()).toBe('a');
  });

  it('treats server output with no pending predictions as spontaneous', () => {
    const p = new EchoPredictor();
    const r = p.reconcile(bytes('hello'));
    expect(r.confirmed).toBe(0);
    expect(r.corrected).toBe(false);
    expect(p.pendingCount).toBe(0);
    expect(p.authoritativeText()).toBe('hello');
  });
});

describe('EchoPredictor — reconciliation (correct)', () => {
  it('corrects a wrong single prediction and shows the authoritative byte', () => {
    const p = new EchoPredictor();
    p.input(bytes('a')); // predicted 'a'
    const r = p.reconcile(bytes('b')); // server actually echoed 'b'
    expect(r.corrected).toBe(true);
    expect(r.confirmed).toBe(0);
    expect(p.pendingCount).toBe(0);
    expect(p.authoritativeText()).toBe('b');
    expect(p.predictedText()).toBe('b');
    expect(r.overlay.marks).toEqual([]);
  });

  it('flushes the whole queue when a mid-stream prediction is wrong', () => {
    const p = new EchoPredictor();
    p.input(bytes('abc')); // predicted 'abc'
    p.reconcile(bytes('a')); // 'a' confirmed
    const r = p.reconcile(bytes('x')); // expected 'b', got 'x'
    expect(r.corrected).toBe(true);
    expect(p.pendingCount).toBe(0);
    expect(p.authoritativeText()).toBe('ax');
    expect(p.predictedText()).toBe('ax');
  });

  it('corrects on a structural mismatch (predicted char, got backspace)', () => {
    const p = new EchoPredictor();
    p.input(bytes('a')); // predicted a printable
    const r = p.reconcile(DEL); // server sent a backspace instead
    expect(r.corrected).toBe(true);
    expect(p.pendingCount).toBe(0);
  });
});

describe('EchoPredictor — control bytes', () => {
  it('does not consume predictions on carriage return', () => {
    const p = new EchoPredictor();
    p.input(bytes('a'));
    const r = p.reconcile(new Uint8Array([0x0d])); // CR
    expect(r.confirmed).toBe(0);
    expect(r.corrected).toBe(false);
    expect(p.pendingCount).toBe(1); // still waiting for the 'a' echo
    expect(p.authoritativeCursor).toBe(0);
  });

  it('resets the row and clears predictions on a line feed', () => {
    const p = new EchoPredictor();
    p.input(bytes('a'));
    p.reconcile(new Uint8Array([0x0a])); // LF
    expect(p.pendingCount).toBe(0);
    expect(p.authoritativeText()).toBe('');
  });
});

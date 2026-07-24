export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until true, or throw. Every wait in these suites is bounded. */
export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  label = 'condition',
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(pollMs);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Index of the first differing byte, or -1. Used in failure messages. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

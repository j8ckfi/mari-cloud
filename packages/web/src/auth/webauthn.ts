// Browser WebAuthn capability probes, and the classification of a ceremony
// failure into the gate's error codes.
//
// Kept away from the Better Auth client so the sign-in screen's error states
// (unsupported browser, cancelled ceremony) are testable without a WebAuthn
// implementation in jsdom — which has none.

import type { AuthError } from './machine';

/** The slice of `PublicKeyCredential` this module reads, so tests can inject it. */
export interface WebAuthnGlobals {
  PublicKeyCredential?: {
    isConditionalMediationAvailable?: () => Promise<boolean>;
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  };
  credentials?: unknown;
}

export interface Capabilities {
  /** WebAuthn exists: `navigator.credentials` and `PublicKeyCredential`. */
  supported: boolean;
  /** Conditional mediation ("passkey autofill") is available. */
  conditional: boolean;
}

function globalsFrom(win: unknown, nav: unknown): WebAuthnGlobals {
  const w = win as { PublicKeyCredential?: WebAuthnGlobals['PublicKeyCredential'] } | undefined;
  const n = nav as { credentials?: unknown } | undefined;
  return { PublicKeyCredential: w?.PublicKeyCredential, credentials: n?.credentials };
}

/**
 * Probe the browser. Never throws and never rejects: a browser that implements
 * `isConditionalMediationAvailable` badly must degrade to "no autofill", not to
 * a broken sign-in screen.
 */
export async function probeCapabilities(
  win: unknown = typeof window === 'undefined' ? undefined : window,
  nav: unknown = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<Capabilities> {
  const g = globalsFrom(win, nav);
  const supported = g.PublicKeyCredential !== undefined && g.credentials !== undefined;
  if (!supported) return { supported: false, conditional: false };
  let conditional = false;
  try {
    conditional = (await g.PublicKeyCredential?.isConditionalMediationAvailable?.()) === true;
  } catch {
    conditional = false;
  }
  return { supported, conditional };
}

/**
 * WebAuthn abort/cancel signatures. `NotAllowedError` is what a browser reports
 * for a dismissed prompt AND for "no credential matched" — the specification is
 * deliberately vague there so a page cannot probe which credentials a user
 * holds. Both are "the ceremony produced nothing", which is exactly one state
 * for the gate.
 */
const CANCEL_CODES = new Set([
  'cancelled',
  'AUTH_CANCELLED',
  'REGISTRATION_CANCELLED',
  'ERROR_CEREMONY_ABORTED',
  'NotAllowedError',
  'AbortError',
]);

/** A Better Auth client error, as the passkey plugin shapes it. */
export interface ClientError {
  code?: string;
  message?: string;
  status?: number;
}

/** True when this failure was an abort rather than a rejection. */
export function isCancellation(err: ClientError | null | undefined): boolean {
  if (!err) return false;
  if (err.code !== undefined && CANCEL_CODES.has(err.code)) return true;
  return /cancel|abort|not allowed|timed out/i.test(err.message ?? '');
}

/**
 * Turn a Better Auth client error into a gate error. A server-side refusal keeps
 * the server's message — "an account with that email already exists" is exactly
 * what the user needs to read, and inventing our own wording here would mean
 * maintaining two copies of it.
 */
export function toAuthError(err: ClientError | null | undefined, fallback: string): AuthError {
  const message = (err?.message ?? '').trim();
  if (isCancellation(err)) {
    return { code: 'cancelled', message: message || 'Passkey prompt dismissed.' };
  }
  const status = err?.status ?? 0;
  if (status >= 400 && status < 500) {
    return { code: 'rejected', message: message || fallback };
  }
  return { code: 'unknown', message: message || fallback };
}

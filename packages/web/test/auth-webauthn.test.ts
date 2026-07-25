import { describe, it, expect } from 'vitest';
import { isCancellation, probeCapabilities, toAuthError } from '../src/auth/webauthn';

// Capability probing and failure classification. These are the two places the
// sign-in screen's error states come from, and jsdom implements neither
// `PublicKeyCredential` nor `navigator.credentials` — which is why they are pure
// functions over injected globals rather than reads of the ambient ones.

describe('probeCapabilities', () => {
  it('reports unsupported when WebAuthn is absent (this is jsdom, and Safari-in-http)', async () => {
    expect(await probeCapabilities({}, {})).toEqual({ supported: false, conditional: false });
    // `PublicKeyCredential` without `navigator.credentials` is not usable either.
    expect(await probeCapabilities({ PublicKeyCredential: {} }, {})).toEqual({
      supported: false,
      conditional: false,
    });
  });

  it('reports supported without autofill when conditional mediation is missing', async () => {
    const caps = await probeCapabilities({ PublicKeyCredential: {} }, { credentials: {} });
    expect(caps).toEqual({ supported: true, conditional: false });
  });

  it('reports autofill when conditional mediation is available', async () => {
    const caps = await probeCapabilities(
      { PublicKeyCredential: { isConditionalMediationAvailable: async () => true } },
      { credentials: {} },
    );
    expect(caps).toEqual({ supported: true, conditional: true });
  });

  it('degrades to no-autofill when the probe itself throws', async () => {
    // A browser that implements the check badly must not break the screen.
    const caps = await probeCapabilities(
      {
        PublicKeyCredential: {
          isConditionalMediationAvailable: () => {
            throw new Error('nope');
          },
        },
      },
      { credentials: {} },
    );
    expect(caps).toEqual({ supported: true, conditional: false });
  });

  it('treats a non-boolean answer as no', async () => {
    const caps = await probeCapabilities(
      {
        PublicKeyCredential: {
          isConditionalMediationAvailable: async () => undefined as unknown as boolean,
        },
      },
      { credentials: {} },
    );
    expect(caps.conditional).toBe(false);
  });
});

describe('isCancellation', () => {
  it('recognizes every abort signature a browser or the plugin can produce', () => {
    // `NotAllowedError` covers BOTH "the user dismissed the prompt" and "no
    // credential matched" — the spec keeps them indistinguishable on purpose, so
    // a page cannot enumerate which credentials a user holds.
    for (const code of [
      'NotAllowedError',
      'AbortError',
      'AUTH_CANCELLED',
      'REGISTRATION_CANCELLED',
      'ERROR_CEREMONY_ABORTED',
    ]) {
      expect(isCancellation({ code }), code).toBe(true);
    }
    expect(isCancellation({ message: 'The operation was aborted.' })).toBe(true);
    expect(isCancellation({ message: 'The request timed out.' })).toBe(true);
  });

  it('does not mistake a server refusal for a cancellation', () => {
    expect(isCancellation({ code: 'ACCOUNT_EXISTS', message: 'already exists' })).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
  });
});

describe('toAuthError', () => {
  it('maps an abort to `cancelled`', () => {
    const e = toAuthError({ code: 'NotAllowedError', message: '', status: 400 }, 'fallback');
    expect(e.code).toBe('cancelled');
    expect(e.message).not.toBe('');
  });

  it('keeps the SERVER’s message for a 4xx refusal', () => {
    const e = toAuthError(
      { code: 'ACCOUNT_EXISTS', message: 'An account with that email already exists.', status: 400 },
      'fallback',
    );
    expect(e.code).toBe('rejected');
    expect(e.message).toBe('An account with that email already exists.');
  });

  it('falls back for a 5xx or a transport fault, and never renders an empty error', () => {
    expect(toAuthError({ status: 500 }, 'Could not sign in.')).toEqual({
      code: 'unknown',
      message: 'Could not sign in.',
    });
    expect(toAuthError({ status: 0 }, 'Could not sign in.').message).toBe('Could not sign in.');
    expect(toAuthError(null, 'Could not sign in.').message).toBe('Could not sign in.');
  });
});

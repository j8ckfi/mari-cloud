import { describe, it, expect } from 'vitest';
import {
  authReducer,
  gateView,
  initialAuthState,
  CANCELLED,
  EXPIRED,
  UNSUPPORTED,
  type Account,
  type AuthEvent,
  type AuthState,
} from '../src/auth/machine';

// The auth gate's state machine, on its own. Every rule here is a rule the
// interface depends on:
//   - `unknown` renders neither view, so the session round trip cannot flash the
//     wrong one (and is not a spinner — spec 8.3).
//   - a cancelled ceremony returns to signed-out with a message, never to a
//     half-signed-in state.
//   - a session that expires mid-session lands the user on the sign-in screen
//     with the reason, and a stale 401 afterwards cannot overwrite it.

const ACCOUNT: Account = { id: 'u1', email: 'user@mari.test', name: 'User' };
const OTHER: Account = { id: 'u2', email: 'other@mari.test', name: null };

function fold(state: AuthState, ...events: AuthEvent[]): AuthState {
  return events.reduce(authReducer, state);
}

describe('auth machine — bootstrap (unknown)', () => {
  it('starts unknown, with no account and no error', () => {
    const s = initialAuthState();
    expect(s.status).toBe('unknown');
    expect(s.account).toBeNull();
    expect(s.error).toBeNull();
    expect(gateView(s)).toBe('bootstrap');
  });

  it('assumes WebAuthn is present until the probe says otherwise', () => {
    // The opposite default would render the unsupported error for one frame in
    // every capable browser.
    expect(initialAuthState().supported).toBe(true);
    const probed = fold(initialAuthState(), {
      t: 'capabilities',
      supported: false,
      conditional: false,
    });
    expect(probed.supported).toBe(false);
    // A capability probe alone must not resolve the gate.
    expect(gateView(probed)).toBe('bootstrap');
  });

  it('resolves unknown → signed-out when there is no session', () => {
    const s = fold(initialAuthState(), { t: 'session', account: null });
    expect(s.status).toBe('signed-out');
    expect(gateView(s)).toBe('sign-in');
    expect(s.error).toBeNull();
  });

  it('resolves unknown → signed-in when a session already exists', () => {
    const s = fold(initialAuthState(), { t: 'session', account: ACCOUNT });
    expect(s.status).toBe('signed-in');
    expect(s.account).toEqual(ACCOUNT);
    expect(gateView(s)).toBe('app');
  });
});

describe('auth machine — ceremonies (signing-in)', () => {
  const out = fold(initialAuthState(), { t: 'session', account: null });

  it('enters signing-in and clears the previous error', () => {
    const withError = fold(out, { t: 'ceremony_start', kind: 'authenticate' }, {
      t: 'ceremony_cancelled',
    });
    expect(withError.error).toEqual(CANCELLED);
    const again = fold(withError, { t: 'ceremony_start', kind: 'register' });
    expect(again.status).toBe('signing-in');
    expect(again.ceremony).toBe('register');
    expect(again.error).toBeNull();
    // Signing in is NOT the app view: the sign-in screen stays on screen while
    // the browser owns the prompt (spec 8.3 — nothing covers the interface).
    expect(gateView(again)).toBe('sign-in');
  });

  it('a CANCELLED ceremony returns to signed-out with the cancellation message', () => {
    const s = fold(out, { t: 'ceremony_start', kind: 'authenticate' }, { t: 'ceremony_cancelled' });
    expect(s.status).toBe('signed-out');
    expect(s.ceremony).toBe('none');
    expect(s.account).toBeNull();
    expect(s.error).toEqual(CANCELLED);
    expect(s.error?.code).toBe('cancelled');
  });

  it('a cancellation that arrives when no ceremony is running is ignored', () => {
    // The conditional-mediation request is aborted whenever the explicit button
    // starts a ceremony; that abort must not blank a state it does not own.
    const signedIn = fold(out, { t: 'signed_in', account: ACCOUNT });
    expect(fold(signedIn, { t: 'ceremony_cancelled' })).toEqual(signedIn);
    expect(fold(out, { t: 'ceremony_cancelled' })).toEqual(out);
  });

  it('a server refusal keeps the server’s own message', () => {
    const error = { code: 'rejected' as const, message: 'An account with that email exists.' };
    const s = fold(out, { t: 'ceremony_start', kind: 'register' }, { t: 'ceremony_failed', error });
    expect(s.status).toBe('signed-out');
    expect(s.error).toEqual(error);
  });

  it('a successful ceremony signs in and clears the error', () => {
    const s = fold(
      out,
      { t: 'ceremony_start', kind: 'authenticate' },
      { t: 'ceremony_cancelled' },
      { t: 'ceremony_start', kind: 'authenticate' },
      { t: 'signed_in', account: ACCOUNT },
    );
    expect(s.status).toBe('signed-in');
    expect(s.account).toEqual(ACCOUNT);
    expect(s.error).toBeNull();
    expect(s.ceremony).toBe('none');
    expect(gateView(s)).toBe('app');
  });

  it('a ceremony in an incapable browser becomes the unsupported error, not a call', () => {
    const incapable = fold(out, { t: 'capabilities', supported: false, conditional: false });
    const s = fold(incapable, { t: 'ceremony_start', kind: 'register' });
    expect(s.status).toBe('signed-out');
    expect(s.ceremony).toBe('none');
    expect(s.error).toEqual(UNSUPPORTED);
  });

  it('a ceremony cannot start from signed-in, or while still bootstrapping', () => {
    // Registering another passkey while signed in is management, not a gate
    // transition; letting it in would leave `signing-in` holding an account.
    const signedIn = fold(out, { t: 'signed_in', account: ACCOUNT });
    expect(fold(signedIn, { t: 'ceremony_start', kind: 'register' })).toEqual(signedIn);
    const boot = initialAuthState();
    expect(fold(boot, { t: 'ceremony_start', kind: 'authenticate' })).toEqual(boot);
  });

  it('a session read that lands DURING a ceremony cannot cancel it', () => {
    // The passkey client refetches the session as part of signing in, so a
    // `get-session` started before the ceremony can resolve after it with null.
    const signing = fold(out, { t: 'ceremony_start', kind: 'authenticate' });
    expect(fold(signing, { t: 'session', account: null })).toEqual(signing);
    expect(fold(signing, { t: 'session', account: OTHER })).toEqual(signing);
    // …and the ceremony's own outcome still wins.
    const done = fold(signing, { t: 'session', account: null }, { t: 'signed_in', account: ACCOUNT });
    expect(done.status).toBe('signed-in');
    expect(done.account).toEqual(ACCOUNT);
  });
});

describe('auth machine — a session that ends', () => {
  const signedIn = fold(initialAuthState(), { t: 'session', account: ACCOUNT });

  it('EXPIRES mid-session: signed-in → signed-out with the reason', () => {
    const s = fold(signedIn, { t: 'session_expired' });
    expect(s.status).toBe('signed-out');
    expect(s.account).toBeNull();
    expect(s.error).toEqual(EXPIRED);
    expect(s.error?.code).toBe('session_expired');
    expect(gateView(s)).toBe('sign-in');
  });

  it('a second 401 after the expiry does not overwrite the message being read', () => {
    const expired = fold(signedIn, { t: 'session_expired' });
    expect(fold(expired, { t: 'session_expired' })).toEqual(expired);
  });

  it('a `session: null` refresh does NOT silently blank a signed-in account', () => {
    // Expiry has its own event and its own message; a plain "no session" read
    // (a dropped request, a race) must not log the user out wordlessly.
    expect(fold(signedIn, { t: 'session', account: null })).toEqual(signedIn);
  });

  it('a deliberate sign-out clears the account and shows no error', () => {
    const s = fold(signedIn, { t: 'signed_out' });
    expect(s.status).toBe('signed-out');
    expect(s.account).toBeNull();
    expect(s.error).toBeNull();
  });

  it('signing in again after an expiry clears the expiry message', () => {
    const s = fold(
      signedIn,
      { t: 'session_expired' },
      { t: 'ceremony_start', kind: 'authenticate' },
      { t: 'signed_in', account: ACCOUNT },
    );
    expect(s.status).toBe('signed-in');
    expect(s.error).toBeNull();
  });

  it('the capability flags survive every transition', () => {
    const probed = fold(initialAuthState(), {
      t: 'capabilities',
      supported: true,
      conditional: true,
    });
    const s = fold(
      probed,
      { t: 'session', account: ACCOUNT },
      { t: 'session_expired' },
      { t: 'ceremony_start', kind: 'authenticate' },
      { t: 'ceremony_cancelled' },
    );
    expect(s.supported).toBe(true);
    expect(s.conditional).toBe(true);
  });
});

describe('auth machine — totality', () => {
  it('never produces a state that renders both views, and never throws', () => {
    const events: AuthEvent[] = [
      { t: 'capabilities', supported: true, conditional: true },
      { t: 'capabilities', supported: false, conditional: false },
      { t: 'session', account: null },
      { t: 'session', account: ACCOUNT },
      { t: 'ceremony_start', kind: 'register' },
      { t: 'ceremony_start', kind: 'authenticate' },
      { t: 'ceremony_cancelled' },
      { t: 'ceremony_failed', error: { code: 'unknown', message: 'boom' } },
      { t: 'signed_in', account: OTHER },
      { t: 'signed_out' },
      { t: 'session_expired' },
    ];
    // Every ordered pair and triple of events, from a fresh state.
    for (const a of events) {
      for (const b of events) {
        for (const c of events) {
          const s = fold(initialAuthState(), a, b, c);
          const view = gateView(s);
          expect(['bootstrap', 'sign-in', 'app']).toContain(view);
          // The account and the view can never disagree.
          if (view === 'app') expect(s.account).not.toBeNull();
          else expect(s.account).toBeNull();
          // A ceremony is only ever in flight while signing in.
          if (s.status !== 'signing-in') expect(s.ceremony).toBe('none');
        }
      }
    }
  });
});

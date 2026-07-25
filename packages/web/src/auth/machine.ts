// The auth gate's state machine (spec 8.3, spec 11.3).
//
// This is a PURE reducer, deliberately separate from React and from Better
// Auth. Two of its rules are the whole reason it exists as a machine rather than
// a pile of booleans:
//
//  1. `unknown` is a real state. Session bootstrapping takes a round trip, and
//     during it neither the fleet nor the sign-in screen may be shown — showing
//     one and then swapping it is the "flash of the wrong view" the brief
//     forbids. It is also NOT a loading state: spec 8.3 bans a spinner in front
//     of the interface, so the gate renders the app's chrome immediately and
//     only the content region waits.
//  2. A session read that resolves DURING a ceremony must not clobber it. The
//     passkey client fires its own `$sessionSignal` refetch as part of signing
//     in, and an in-flight `get-session` started before the ceremony can land
//     after it with `null`. Letting that reach the state machine would drop the
//     user back to the sign-in screen a beat after they signed in.

/** The signed-in account, as much of it as the interface ever shows. */
export interface Account {
  id: string;
  email: string;
  name: string | null;
}

/** A ceremony or session failure, in a shape the screen can render verbatim. */
export interface AuthError {
  code: AuthErrorCode;
  message: string;
}

export type AuthErrorCode =
  /** The user (or the platform) aborted the WebAuthn ceremony. */
  | 'cancelled'
  /** This browser has no WebAuthn / no platform authenticator. */
  | 'unsupported'
  /** The server refused: email taken, invalid email, unknown credential, … */
  | 'rejected'
  /** A previously valid session stopped being valid while the app was open. */
  | 'session_expired'
  /** Network or anything else we cannot classify. */
  | 'unknown';

export type AuthStatus = 'unknown' | 'signed-out' | 'signing-in' | 'signed-in';

/** Which ceremony is in flight; `none` whenever `status !== 'signing-in'`. */
export type Ceremony = 'none' | 'register' | 'authenticate';

export interface AuthState {
  status: AuthStatus;
  account: Account | null;
  error: AuthError | null;
  ceremony: Ceremony;
  /** Whether WebAuthn exists at all in this browser. */
  supported: boolean;
  /** Whether conditional mediation (passkey autofill) is available. */
  conditional: boolean;
}

export type AuthEvent =
  /** Browser capability probe finished (see ./webauthn). */
  | { t: 'capabilities'; supported: boolean; conditional: boolean }
  /** A session read resolved: an account, or `null` for "no session". */
  | { t: 'session'; account: Account | null }
  /** A WebAuthn ceremony started (user pressed a button, or autofill matched). */
  | { t: 'ceremony_start'; kind: Exclude<Ceremony, 'none'> }
  /** The ceremony was aborted — by the user, or by the platform. */
  | { t: 'ceremony_cancelled' }
  /** The ceremony ran but did not produce a session. */
  | { t: 'ceremony_failed'; error: AuthError }
  /** A ceremony (or a bootstrap) produced a session. */
  | { t: 'signed_in'; account: Account }
  /** The user signed out deliberately. */
  | { t: 'signed_out' }
  /** The control plane answered 401 to an authenticated request. */
  | { t: 'session_expired' };

export const CANCELLED: AuthError = {
  code: 'cancelled',
  message: 'Passkey prompt dismissed. Nothing was changed.',
};

export const EXPIRED: AuthError = {
  code: 'session_expired',
  message: 'Your session expired. Sign in again to continue.',
};

export const UNSUPPORTED: AuthError = {
  code: 'unsupported',
  message: 'This browser cannot use passkeys. Open Mari in a browser with WebAuthn support.',
};

export function initialAuthState(): AuthState {
  return {
    status: 'unknown',
    account: null,
    error: null,
    ceremony: 'none',
    // Assumed present until the probe says otherwise: assuming ABSENT would
    // render the unsupported error for one frame in every capable browser.
    supported: true,
    conditional: false,
  };
}

const signedOut = (s: AuthState, error: AuthError | null): AuthState => ({
  ...s,
  status: 'signed-out',
  account: null,
  error,
  ceremony: 'none',
});

/** Fold one event into the gate's state. Total, pure, and never throws. */
export function authReducer(s: AuthState, e: AuthEvent): AuthState {
  switch (e.t) {
    case 'capabilities':
      return { ...s, supported: e.supported, conditional: e.conditional };

    case 'session': {
      // A ceremony in flight OWNS the outcome; a session read that lands in the
      // middle of one is stale by construction (see the header note).
      if (s.status === 'signing-in') return s;
      if (e.account !== null) {
        return { ...s, status: 'signed-in', account: e.account, error: null, ceremony: 'none' };
      }
      // "No session" is only news while bootstrapping. For an already signed-in
      // app it is an expiry, which has its own event and its own message — a
      // plain `session: null` must not silently blank the account.
      if (s.status === 'signed-in') return s;
      return signedOut(s, s.error);
    }

    case 'ceremony_start':
      // A sign-in ceremony belongs to the sign-out state alone. A signed-in user
      // registering another passkey is MANAGEMENT, not a gate transition — and
      // letting it through here would produce `signing-in` while an account is
      // still set, i.e. a state whose view and whose account disagree.
      if (s.status !== 'signed-out') return s;
      if (!s.supported) return { ...s, error: UNSUPPORTED, ceremony: 'none' };
      return { ...s, status: 'signing-in', ceremony: e.kind, error: null };

    case 'ceremony_cancelled':
      if (s.status !== 'signing-in') return s;
      return signedOut(s, CANCELLED);

    case 'ceremony_failed':
      if (s.status !== 'signing-in') return s;
      return signedOut(s, e.error);

    case 'signed_in':
      return { ...s, status: 'signed-in', account: e.account, error: null, ceremony: 'none' };

    case 'signed_out':
      return signedOut(s, null);

    case 'session_expired':
      // Only a live session can expire. Firing this at the sign-in screen (a
      // 401 from a request that was already in flight when the user signed out)
      // must not replace the message the user is reading.
      if (s.status !== 'signed-in') return s;
      return signedOut(s, EXPIRED);
  }
}

/** What the gate should render. Derived, so the decision is testable alone. */
export type GateView = 'bootstrap' | 'sign-in' | 'app';

export function gateView(s: AuthState): GateView {
  if (s.status === 'unknown') return 'bootstrap';
  return s.status === 'signed-in' ? 'app' : 'sign-in';
}

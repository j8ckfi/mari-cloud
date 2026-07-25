// The hook that drives the auth machine: capability probe, session bootstrap,
// the two ceremonies, sign-out, and the 401 that means a session died while the
// app was open.
//
// All of the decisions live in ./machine.ts (pure). This file is only effects.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { onUnauthorized } from '../api/client';
import type { AuthApi } from './api';
import { authReducer, gateView, initialAuthState, type AuthState, type GateView } from './machine';
import { probeCapabilities, toAuthError, type Capabilities } from './webauthn';

export interface AuthGateController {
  state: AuthState;
  view: GateView;
  /** Create an account and its first passkey (one ceremony, no password). */
  createAccount(email: string): Promise<void>;
  /** Sign in with an existing passkey (modal prompt). */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export interface UseAuthGateOptions {
  /** Injectable for tests; defaults to the real browser probe. */
  probe?: () => Promise<Capabilities>;
  /** Injectable for tests; defaults to `onUnauthorized` on the API client. */
  subscribeUnauthorized?: (fn: () => void) => () => void;
  /** Called on every signed-in → signed-out transition (cache teardown). */
  onSessionEnd?: () => void;
}

export function useAuthGate(api: AuthApi, opts: UseAuthGateOptions = {}): AuthGateController {
  const [state, dispatch] = useReducer(authReducer, undefined, initialAuthState);
  const probe = opts.probe ?? probeCapabilities;
  const subscribe = opts.subscribeUnauthorized ?? onUnauthorized;

  // Keep the latest state readable from callbacks without making every callback
  // depend on it (a changing `signIn` identity would restart the autofill
  // effect on every keystroke).
  const live = useRef(state);
  live.current = state;

  const onSessionEnd = opts.onSessionEnd;
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (state.status === 'signed-in') {
      wasSignedIn.current = true;
      return;
    }
    if (state.status === 'signed-out' && wasSignedIn.current) {
      wasSignedIn.current = false;
      onSessionEnd?.();
    }
  }, [state.status, onSessionEnd]);

  // --- bootstrap: capabilities, then the session ---------------------------
  useEffect(() => {
    let live = true;
    void (async () => {
      const caps = await probe();
      if (!live) return;
      dispatch({ t: 'capabilities', supported: caps.supported, conditional: caps.conditional });
      const account = await api.getSession();
      if (!live) return;
      dispatch({ t: 'session', account });
    })();
    return () => {
      live = false;
    };
    // `api` and `probe` are stable for the app's lifetime; a changing identity
    // here would re-run the bootstrap and re-flash the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- a session that dies while the app is open ---------------------------
  useEffect(() => subscribe(() => dispatch({ t: 'session_expired' })), [subscribe]);

  // --- conditional UI (passkey autofill) ----------------------------------
  //
  // Passive by construction: it does NOT enter `signing-in` (that would disable
  // the buttons while merely waiting), and its failures are never surfaced —
  // pressing the explicit button aborts the conditional request, and reporting
  // that abort would flash "prompt dismissed" at a user who did the opposite.
  const signedOut = state.status === 'signed-out';
  const conditional = state.conditional && state.supported;
  useEffect(() => {
    if (!signedOut || !conditional) return;
    let live = true;
    void (async () => {
      const res = await api.signInWithPasskey({ autoFill: true });
      if (!live || !res.ok) return;
      dispatch({ t: 'signed_in', account: res.value });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedOut, conditional]);

  const createAccount = useCallback(
    async (email: string): Promise<void> => {
      if (live.current.status === 'signing-in') return;
      const supported = live.current.supported;
      // The reducer turns a ceremony start in an incapable browser into the
      // unsupported error state; there is nothing to call.
      dispatch({ t: 'ceremony_start', kind: 'register' });
      if (!supported) return;
      const res = await api.createAccountWithPasskey(email);
      if (res.ok) {
        dispatch({ t: 'signed_in', account: res.value });
        return;
      }
      const error = toAuthError(res.error, 'Could not create the account.');
      if (error.code === 'cancelled') dispatch({ t: 'ceremony_cancelled' });
      else dispatch({ t: 'ceremony_failed', error });
    },
    [api],
  );

  const signIn = useCallback(async (): Promise<void> => {
    if (live.current.status === 'signing-in') return;
    const supported = live.current.supported;
    dispatch({ t: 'ceremony_start', kind: 'authenticate' });
    if (!supported) return;
    const res = await api.signInWithPasskey();
    if (res.ok) {
      dispatch({ t: 'signed_in', account: res.value });
      return;
    }
    const error = toAuthError(res.error, 'Could not sign in with that passkey.');
    if (error.code === 'cancelled') dispatch({ t: 'ceremony_cancelled' });
    else dispatch({ t: 'ceremony_failed', error });
  }, [api]);

  const signOut = useCallback(async (): Promise<void> => {
    // Local state first: the interface must not wait on the network to stop
    // showing a fleet the user just left (spec 8.3).
    dispatch({ t: 'signed_out' });
    await api.signOut();
  }, [api]);

  return useMemo(
    () => ({ state, view: gateView(state), createAccount, signIn, signOut }),
    [state, createAccount, signIn, signOut],
  );
}

// The hook that drives the auth machine: capability probe, session bootstrap,
// the two ceremonies, sign-out, and the 401 that means a session died while the
// app was open.
//
// All of the decisions live in ./machine.ts (pure). This file is only effects.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { onUnauthorized } from '../api/client';
import type { AuthApi, AuthResult } from './api';
import {
  authReducer,
  gateView,
  initialAuthState,
  TIMED_OUT,
  type Account,
  type AuthState,
  type Ceremony,
  type GateView,
} from './machine';
import { probeCapabilities, toAuthError, type Capabilities } from './webauthn';

/**
 * How long a modal ceremony may sit unanswered before the gate gives up on it.
 * Platform passkey prompts can stall without ever rejecting (observed on
 * Chrome + some credential managers); without a deadline the buttons stay
 * disabled forever and only a page reload recovers.
 */
const CEREMONY_TIMEOUT_MS = 60_000;

export interface AuthGateController {
  state: AuthState;
  view: GateView;
  /** Create an account and its first passkey (one ceremony, no password). */
  createAccount(email: string): Promise<void>;
  /** Sign in with an existing passkey (modal prompt). */
  signIn(): Promise<void>;
  /** Abandon the in-flight ceremony and give the buttons back. */
  cancelCeremony(): void;
  signOut(): Promise<void>;
}

export interface UseAuthGateOptions {
  /** Injectable for tests; defaults to the real browser probe. */
  probe?: () => Promise<Capabilities>;
  /** Injectable for tests; defaults to `onUnauthorized` on the API client. */
  subscribeUnauthorized?: (fn: () => void) => () => void;
  /** Called on every signed-in → signed-out transition (cache teardown). */
  onSessionEnd?: () => void;
  /** Injectable for tests; defaults to {@link CEREMONY_TIMEOUT_MS}. */
  ceremonyTimeoutMs?: number;
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

  // Each ceremony gets a generation number. A ceremony that was cancelled or
  // timed out is STALE: when its promise finally settles, its failure must not
  // clobber whatever the user is doing by then (typically a fresh ceremony).
  // A late SUCCESS still applies — the server minted a session either way, and
  // showing the sign-in screen over a live session would just be a lie until
  // the next reload.
  const ceremonyGen = useRef(0);
  const timeoutMs = opts.ceremonyTimeoutMs ?? CEREMONY_TIMEOUT_MS;

  const runCeremony = useCallback(
    async (
      kind: Exclude<Ceremony, 'none'>,
      exec: () => Promise<AuthResult<Account>>,
      fallback: string,
    ): Promise<void> => {
      if (live.current.status === 'signing-in') return;
      const supported = live.current.supported;
      // The reducer turns a ceremony start in an incapable browser into the
      // unsupported error state; there is nothing to call.
      dispatch({ t: 'ceremony_start', kind });
      if (!supported) return;
      const gen = ++ceremonyGen.current;
      const timer = window.setTimeout(() => {
        if (ceremonyGen.current !== gen) return;
        ceremonyGen.current += 1; // mark the ceremony stale
        dispatch({ t: 'ceremony_failed', error: TIMED_OUT });
      }, timeoutMs);
      const res = await exec();
      window.clearTimeout(timer);
      if (res.ok) {
        dispatch({ t: 'signed_in', account: res.value });
        return;
      }
      if (ceremonyGen.current !== gen) return; // stale: cancelled or timed out
      const error = toAuthError(res.error, fallback);
      if (error.code === 'cancelled') dispatch({ t: 'ceremony_cancelled' });
      else dispatch({ t: 'ceremony_failed', error });
    },
    [timeoutMs],
  );

  const createAccount = useCallback(
    (email: string): Promise<void> =>
      runCeremony(
        'register',
        () => api.createAccountWithPasskey(email),
        'Could not create the account.',
      ),
    [api, runCeremony],
  );

  const signIn = useCallback(
    (): Promise<void> =>
      runCeremony('authenticate', () => api.signInWithPasskey(), 'Could not sign in with that passkey.'),
    [api, runCeremony],
  );

  const cancelCeremony = useCallback((): void => {
    if (live.current.status !== 'signing-in') return;
    ceremonyGen.current += 1; // the in-flight ceremony is now stale
    dispatch({ t: 'ceremony_cancelled' });
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    // Local state first: the interface must not wait on the network to stop
    // showing a fleet the user just left (spec 8.3).
    dispatch({ t: 'signed_out' });
    await api.signOut();
  }, [api]);

  return useMemo(
    () => ({ state, view: gateView(state), createAccount, signIn, cancelCeremony, signOut }),
    [state, createAccount, signIn, cancelCeremony, signOut],
  );
}

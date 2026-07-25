import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../src/components/AuthGate';
import type { AuthApi, AuthResult, PasskeyRecord } from '../src/auth/api';
import type { Account } from '../src/auth/machine';
import type { Capabilities } from '../src/auth/webauthn';

// The auth gate as the user meets it: which view is on screen in each state of
// the machine, and what a cancelled ceremony or an expiring session look like.
//
// jsdom has no WebAuthn at all, which is exactly why `AuthApi` is an interface:
// the ceremonies are driven here by a fake, and the REAL ones are driven by a
// Chrome DevTools Protocol virtual authenticator in e2e/passkey.spec.ts.

const ACCOUNT: Account = { id: 'u1', email: 'user@mari.test', name: 'User' };

/** A promise plus its resolver, for pinning the app in a transient state. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Fake {
  api: AuthApi;
  session: { promise: Promise<Account | null>; resolve(v: Account | null): void };
  create: { promise: Promise<AuthResult<Account>>; resolve(v: AuthResult<Account>): void };
  signIn: { promise: Promise<AuthResult<Account>>; resolve(v: AuthResult<Account>): void };
  calls: string[];
  signInArgs: Array<{ autoFill?: boolean } | undefined>;
}

function fakeApi(): Fake {
  const session = deferred<Account | null>();
  const create = deferred<AuthResult<Account>>();
  const signIn = deferred<AuthResult<Account>>();
  const calls: string[] = [];
  const signInArgs: Array<{ autoFill?: boolean } | undefined> = [];
  const api: AuthApi = {
    getSession: () => {
      calls.push('getSession');
      return session.promise;
    },
    createAccountWithPasskey: (email) => {
      calls.push(`create:${email}`);
      return create.promise;
    },
    signInWithPasskey: (opts) => {
      calls.push(`signIn:${opts?.autoFill === true ? 'autofill' : 'modal'}`);
      signInArgs.push(opts);
      return signIn.promise;
    },
    signOut: async () => {
      calls.push('signOut');
    },
    listPasskeys: async (): Promise<AuthResult<PasskeyRecord[]>> => ({ ok: true, value: [] }),
    addPasskey: async () => ({ ok: true, value: undefined }),
    renamePasskey: async () => ({ ok: true, value: undefined }),
    removePasskey: async () => ({ ok: true, value: undefined }),
  };
  return { api, session, create, signIn, calls, signInArgs };
}

const CAPABLE: Capabilities = { supported: true, conditional: false };

interface Harness {
  fake: Fake;
  unauthorized: () => void;
  onSessionEnd: ReturnType<typeof vi.fn>;
}

function renderGate(caps: Capabilities = CAPABLE): Harness {
  const fake = fakeApi();
  const onSessionEnd = vi.fn();
  let fire: () => void = () => {};
  render(
    <AuthGate
      api={fake.api}
      options={{
        probe: async () => caps,
        subscribeUnauthorized: (fn) => {
          fire = fn;
          return () => {};
        },
        onSessionEnd,
      }}
    >
      {({ account, signOut }) => (
        <div data-testid="app-shell">
          <span data-testid="shell-email">{account.email}</span>
          <button type="button" data-testid="shell-signout" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
    </AuthGate>,
  );
  return { fake, unauthorized: () => fire(), onSessionEnd };
}

/** The exact selector the e2e spinner watchdog uses (e2e/helpers.ts). */
const SPINNER =
  '.spinner,[role="progressbar"],[aria-busy="true"],[data-testid*="spinner"],[data-testid*="loading"],[data-testid*="skeleton"]';

function noSpinner(): void {
  expect(document.querySelector(SPINNER)).toBeNull();
}

/** `disabled` on a button, without pulling in jest-dom's matchers. */
function isDisabled(testId: string): boolean {
  return (screen.getByTestId(testId) as HTMLButtonElement).disabled;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AuthGate — unknown (session bootstrap)', () => {
  it('renders the shell chrome and NEITHER view while the session resolves', () => {
    renderGate();
    // The chrome is on screen on the first frame…
    expect(screen.getByText('MARI')).toBeTruthy();
    expect(screen.getByTestId('auth-bootstrap')).toBeTruthy();
    // …and neither the sign-in screen nor the app has been guessed at.
    expect(screen.queryByTestId('sign-in-screen')).toBeNull();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    // Spec 8.3: bootstrapping is not a spinner.
    noSpinner();
  });

  it('does not touch the control plane before the session is known', async () => {
    const { fake } = renderGate();
    // Only the session read; no ceremony, no fleet (the app subtree is unmounted).
    await waitFor(() => expect(fake.calls).toEqual(['getSession']));
    expect(screen.getByTestId('auth-bootstrap')).toBeTruthy();
  });
});

describe('AuthGate — signed-out', () => {
  it('shows the sign-in screen when there is no session', async () => {
    const { fake } = renderGate();
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(screen.getByTestId('auth-create')).toBeTruthy();
    expect(screen.getByTestId('auth-signin')).toBeTruthy();
    expect(screen.queryByTestId('auth-error')).toBeNull();
    noSpinner();
  });

  it('reports an unsupported browser and disables both ceremonies', async () => {
    const { fake } = renderGate({ supported: false, conditional: false });
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('auth-unsupported')).toBeTruthy());
    expect(isDisabled('auth-create')).toBe(true);
    expect(isDisabled('auth-signin')).toBe(true);
  });

  it('starts a PASSIVE conditional-UI request when autofill is available', async () => {
    const { fake } = renderGate({ supported: true, conditional: true });
    fake.session.resolve(null);
    await waitFor(() => expect(fake.calls).toContain('signIn:autofill'));
    // Passive: the buttons stay live and nothing claims a ceremony is running,
    // because conditional mediation waits on the browser's own autofill list.
    expect(isDisabled('auth-create')).toBe(false);
    expect(isDisabled('auth-signin')).toBe(false);
    expect(screen.queryByTestId('auth-pending')).toBeNull();
    expect(screen.getByTestId('auth-conditional')).toBeTruthy();
  });

  it('signs in when the user picks a credential out of the autofill list', async () => {
    const { fake } = renderGate({ supported: true, conditional: true });
    fake.session.resolve(null);
    await waitFor(() => expect(fake.calls).toContain('signIn:autofill'));
    fake.signIn.resolve({ ok: true, value: ACCOUNT });
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());
  });
});

describe('AuthGate — signing-in', () => {
  it('keeps the sign-in screen on screen, with no spinner, during the ceremony', async () => {
    const user = userEvent.setup();
    const { fake } = renderGate();
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());

    await user.type(screen.getByTestId('auth-email'), 'new@mari.test');
    await user.click(screen.getByTestId('auth-create'));

    // The ceremony is in flight: the screen is unchanged except that the button
    // says what it is waiting for. Nothing covers the interface (spec 8.3).
    await waitFor(() => expect(isDisabled('auth-create')).toBe(true));
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-create').textContent).toContain('Waiting for your passkey');
    expect(screen.getByTestId('auth-pending')).toBeTruthy();
    noSpinner();
    expect(fake.calls).toContain('create:new@mari.test');
  });

  it('cannot start a second ceremony while one is running', async () => {
    const user = userEvent.setup();
    const { fake } = renderGate();
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());
    await user.click(screen.getByTestId('auth-signin'));
    await waitFor(() => expect(isDisabled('auth-signin')).toBe(true));
    // A raw click event past the disabled attribute still finds the guard in the
    // hook, so two overlapping WebAuthn requests cannot be issued.
    fireEvent.click(screen.getByTestId('auth-signin'));
    fireEvent.submit(screen.getByTestId('auth-create').closest('form') as HTMLFormElement);
    expect(fake.calls.filter((c) => c === 'signIn:modal')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.startsWith('create:'))).toHaveLength(0);
  });

  it('submits the form with Enter (keyboard-only account creation, spec 8.1)', async () => {
    const user = userEvent.setup();
    const { fake } = renderGate();
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());
    // The email field is focused on arrival, so this is the whole keyboard path.
    await user.keyboard('kbd@mari.test{Enter}');
    await waitFor(() => expect(fake.calls).toContain('create:kbd@mari.test'));
  });
});

describe('AuthGate — a cancelled ceremony', () => {
  it('returns to the sign-in screen with the cancellation message', async () => {
    const user = userEvent.setup();
    const { fake } = renderGate();
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());
    await user.click(screen.getByTestId('auth-signin'));
    await waitFor(() => expect(isDisabled('auth-signin')).toBe(true));

    // What a browser reports for a dismissed prompt.
    fake.signIn.resolve({
      ok: false,
      error: { code: 'NotAllowedError', message: 'The operation was not allowed.', status: 400 },
    });

    const err = await waitFor(() => screen.getByTestId('auth-error'));
    expect(err.getAttribute('data-code')).toBe('cancelled');
    // Still signed out, and both ceremonies are available again.
    expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(isDisabled('auth-signin')).toBe(false);
    expect(isDisabled('auth-create')).toBe(false);
    noSpinner();
  });

  it('shows the server’s own words when the server refuses', async () => {
    const user = userEvent.setup();
    const { fake } = renderGate();
    fake.session.resolve(null);
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());
    await user.type(screen.getByTestId('auth-email'), 'taken@mari.test');
    await user.click(screen.getByTestId('auth-create'));
    fake.create.resolve({
      ok: false,
      error: {
        code: 'ACCOUNT_EXISTS',
        message: 'An account with that email already exists — sign in instead.',
        status: 400,
      },
    });
    const err = await waitFor(() => screen.getByTestId('auth-error'));
    expect(err.getAttribute('data-code')).toBe('rejected');
    expect(err.textContent).toContain('already exists');
  });
});

describe('AuthGate — signed-in', () => {
  it('renders the app with the account once a session exists', async () => {
    const { fake } = renderGate();
    fake.session.resolve(ACCOUNT);
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());
    expect(screen.getByTestId('shell-email').textContent).toBe(ACCOUNT.email);
    expect(screen.queryByTestId('sign-in-screen')).toBeNull();
    expect(screen.queryByTestId('auth-bootstrap')).toBeNull();
    noSpinner();
  });

  it('signs out to the sign-in screen and tears the session’s data down', async () => {
    const user = userEvent.setup();
    const { fake, onSessionEnd } = renderGate();
    fake.session.resolve(ACCOUNT);
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());

    await user.click(screen.getByTestId('shell-signout'));
    await waitFor(() => expect(screen.getByTestId('sign-in-screen')).toBeTruthy());
    expect(fake.calls).toContain('signOut');
    // The next account must not paint the previous fleet from cache.
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    // A deliberate sign-out is not an error.
    expect(screen.queryByTestId('auth-error')).toBeNull();
  });
});

describe('AuthGate — a session that expires mid-session', () => {
  it('a 401 from the control plane moves the app to the sign-in screen, with the reason', async () => {
    const { fake, unauthorized, onSessionEnd } = renderGate();
    fake.session.resolve(ACCOUNT);
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());

    // The control plane refuses an authenticated request: the session is gone.
    unauthorized();

    const err = await waitFor(() => screen.getByTestId('auth-error'));
    expect(err.getAttribute('data-code')).toBe('session_expired');
    expect(err.textContent).toContain('expired');
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    noSpinner();
  });

  it('a further 401 does not replace the message, and signing in again clears it', async () => {
    const { fake, unauthorized } = renderGate();
    fake.session.resolve(ACCOUNT);
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());
    unauthorized();
    await waitFor(() => expect(screen.getByTestId('auth-error')).toBeTruthy());
    unauthorized();
    expect(screen.getByTestId('auth-error').getAttribute('data-code')).toBe('session_expired');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('auth-signin'));
    fake.signIn.resolve({ ok: true, value: ACCOUNT });
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeTruthy());
    expect(screen.queryByTestId('auth-error')).toBeNull();
  });
});

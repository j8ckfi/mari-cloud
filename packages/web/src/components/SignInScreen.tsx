import { useEffect, useId, useRef, useState } from 'react';
import type { AuthState } from '../auth/machine';

/**
 * The sign-in / sign-up screen. Two ceremonies, no password field, no spinner.
 *
 * Spec 8.1 (full keyboard operation): the email field is a real form field, so
 * Enter creates the account; every other action is a button in tab order.
 *
 * Spec 8.3 (no spinner in front of the interface): while a ceremony is in flight
 * the screen stays exactly where it is — the buttons report their own state in
 * words and the OS shows the passkey prompt. Nothing is covered and nothing
 * spins, because the ceremony belongs to the browser, not to this page.
 */
export function SignInScreen({
  state,
  onCreate,
  onSignIn,
  onCancel,
}: {
  state: AuthState;
  onCreate(email: string): void;
  onSignIn(): void;
  /** Abandon the in-flight ceremony (the escape hatch for a stalled prompt). */
  onCancel(): void;
}) {
  const [email, setEmail] = useState('');
  const emailId = useId();
  const emailRef = useRef<HTMLInputElement | null>(null);
  const busy = state.status === 'signing-in';
  const registering = busy && state.ceremony === 'register';
  const authenticating = busy && state.ceremony === 'authenticate';

  // Focus the identity field on arrival: the keyboard path to a new account is
  // then type-email, Enter (spec 8.1).
  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    const trimmed = email.trim();
    if (trimmed === '') {
      emailRef.current?.focus();
      return;
    }
    onCreate(trimmed);
  };

  return (
    <div className="auth" data-testid="sign-in-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-head">
          <span className="auth-brand">MARI</span>
          <span className="hint">Persistent computers. Your agents keep working.</span>
        </div>

        {!state.supported && (
          <p className="auth-error" role="alert" data-testid="auth-unsupported">
            This browser cannot use passkeys. Open Mari in a browser with WebAuthn support.
          </p>
        )}

        <label className="auth-label" htmlFor={emailId}>
          Email
        </label>
        <input
          id={emailId}
          ref={emailRef}
          className="auth-input"
          data-testid="auth-email"
          type="email"
          inputMode="email"
          // `webauthn` is what opts this field into conditional mediation: the
          // browser offers the account's passkeys in the field's own autofill
          // list, and the gate's passive request (auth/gate.ts) is what such a
          // pick resolves. Without this token there is no autofill path at all.
          autoComplete="username webauthn"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="you@example.com"
          required
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />

        <button
          type="submit"
          className="auth-primary"
          data-testid="auth-create"
          disabled={busy || !state.supported}
        >
          {registering ? 'Waiting for your passkey…' : 'Create account with a passkey'}
        </button>

        <div className="auth-or">
          <span>already have an account</span>
        </div>

        <button
          type="button"
          className="auth-secondary"
          data-testid="auth-signin"
          disabled={busy || !state.supported}
          onClick={onSignIn}
        >
          {authenticating ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>

        {/* One live region for every outcome, so a screen reader hears the
            cancellation and the expiry the same way it hears a refusal. */}
        <p className="auth-status" role="status" aria-live="polite">
          {state.error !== null && (
            <span className="auth-error" data-testid="auth-error" data-code={state.error.code}>
              {state.error.message}
            </span>
          )}
          {busy && state.error === null && (
            <span className="hint" data-testid="auth-pending">
              Confirm with your device to continue.
            </span>
          )}
        </p>

        {/* The escape hatch: a passkey prompt that stalls (or was dismissed in
            a way the browser never reports) must not hold the page hostage. */}
        {busy && (
          <button
            type="button"
            className="auth-secondary"
            data-testid="auth-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}

        {state.conditional && (
          <p className="hint" data-testid="auth-conditional">
            Your saved passkeys appear in the email field.
          </p>
        )}
      </form>
    </div>
  );
}

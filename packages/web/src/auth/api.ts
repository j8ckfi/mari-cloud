// The auth surface the interface codes against.
//
// Deliberately narrow, and deliberately an interface: the sign-in screen, the
// gate and the passkey manager are all tested in jsdom, which has no WebAuthn
// implementation at all. Everything above this line talks to `AuthApi`; exactly
// one implementation (./better-auth.ts) talks to Better Auth and to
// `navigator.credentials`.

import type { Account } from './machine';
import type { ClientError } from './webauthn';

/** One registered credential, as the management UI shows it. */
export interface PasskeyRecord {
  id: string;
  /** User-chosen label; `null` when the credential was never named. */
  name: string | null;
  /** Unix ms, or `null` when the server did not record one. */
  createdAt: number | null;
  /** `singleDevice` | `multiDevice` from the ceremony. */
  deviceType: string | null;
  /** Synced to a credential manager (so it survives losing the device). */
  backedUp: boolean;
  /** Authenticator MODEL identifier — never a device or person identifier. */
  aaguid: string | null;
}

export type AuthResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: ClientError };

export interface AuthApi {
  /** Read the current session. `null` means "no session", not "failed". */
  getSession(): Promise<Account | null>;

  /**
   * Create an account and its first passkey in one ceremony (no password ever
   * exists). `email` is the identity the credential is bound to; the server
   * writes no user row until the credential verifies.
   */
  createAccountWithPasskey(email: string): Promise<AuthResult<Account>>;

  /**
   * Sign in with a discoverable passkey. `autoFill` requests conditional
   * mediation, which resolves only when the user picks a credential out of the
   * browser's own autofill UI — so it must never be awaited by a render path.
   */
  signInWithPasskey(opts?: { autoFill?: boolean }): Promise<AuthResult<Account>>;

  signOut(): Promise<void>;

  listPasskeys(): Promise<AuthResult<PasskeyRecord[]>>;
  /** Register an additional passkey for the signed-in account. */
  addPasskey(name: string): Promise<AuthResult<undefined>>;
  renamePasskey(id: string, name: string): Promise<AuthResult<undefined>>;
  removePasskey(id: string): Promise<AuthResult<undefined>>;
}

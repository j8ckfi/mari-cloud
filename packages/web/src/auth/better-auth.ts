// The one module that talks to Better Auth and to `navigator.credentials`.
//
// Everything above it uses `AuthApi` (./api.ts). The client is created LAZILY:
// `createAuthClient` reads `window.location` and installs nanostores listeners,
// and the component tests must be able to import the sign-in screen without any
// of that happening.

import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import type { AuthApi, AuthResult, PasskeyRecord } from './api';
import type { Account } from './machine';
import type { ClientError } from './webauthn';

/** Better Auth is mounted under the control-plane API prefix (contracts.md). */
const BASE_PATH = '/api/auth';

type Client = ReturnType<typeof makeClient>;

function makeClient() {
  return createAuthClient({
    // Same origin: ONE Worker serves the app and the API (see worker.ts's asset
    // fallthrough), and the Vite dev server proxies `/api` to the control plane.
    basePath: BASE_PATH,
    plugins: [passkeyClient()],
  });
}

let client: Client | null = null;

function auth(): Client {
  if (client === null) client = makeClient();
  return client;
}

const NETWORK_ERROR: ClientError = {
  code: 'NETWORK',
  message: 'Could not reach the control plane.',
  status: 0,
};

function asClientError(err: unknown): ClientError {
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; status?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      status: typeof e.status === 'number' ? e.status : undefined,
    };
  }
  return NETWORK_ERROR;
}

/** Better Auth returns `{ data, error }`; a thrown value is a transport fault. */
function unwrap<T>(res: { data?: T | null; error?: unknown }): AuthResult<T> {
  if (res.error) return { ok: false, error: asClientError(res.error) };
  if (res.data === null || res.data === undefined) {
    return { ok: false, error: NETWORK_ERROR };
  }
  return { ok: true, value: res.data };
}

interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
}

function toAccount(user: SessionUser): Account {
  return { id: user.id, email: user.email, name: user.name ?? null };
}

/** The passkey rows the plugin returns, before normalization. */
interface RawPasskey {
  id: string;
  name?: string | null;
  createdAt?: string | number | Date | null;
  deviceType?: string | null;
  backedUp?: boolean | number | null;
  aaguid?: string | null;
}

function toRecord(p: RawPasskey): PasskeyRecord {
  const at = p.createdAt == null ? NaN : new Date(p.createdAt).getTime();
  return {
    id: p.id,
    name: p.name != null && p.name !== '' ? p.name : null,
    createdAt: Number.isFinite(at) ? at : null,
    deviceType: p.deviceType ?? null,
    backedUp: p.backedUp === true || p.backedUp === 1,
    aaguid: p.aaguid ?? null,
  };
}

/**
 * `addPasskey` verifies a credential; it does NOT mint a session — by design,
 * because a registration ceremony is not an authentication ceremony. So a
 * passkey-first sign-up is two ceremonies: register the credential, then use it.
 * Both are real, and the account exists only after the first one verifies.
 */
async function createAccountWithPasskey(email: string): Promise<AuthResult<Account>> {
  const a = auth();
  let registered: Awaited<ReturnType<typeof a.passkey.addPasskey>>;
  try {
    registered = await a.passkey.addPasskey({
      // `context` is how the passkey-first flow carries the identity the user
      // typed to the server's `resolveUser` (see control-plane auth.ts).
      context: email,
      name: defaultPasskeyName(),
    });
  } catch (err) {
    return { ok: false, error: asClientError(err) };
  }
  if (registered.error) return { ok: false, error: asClientError(registered.error) };
  return signInWithPasskey();
}

async function signInWithPasskey(opts?: { autoFill?: boolean }): Promise<AuthResult<Account>> {
  const a = auth();
  try {
    const res = await a.signIn.passkey({ autoFill: opts?.autoFill === true });
    const unwrapped = unwrap<{ user: SessionUser }>(
      res as { data?: { user: SessionUser } | null; error?: unknown },
    );
    if (!unwrapped.ok) return unwrapped;
    return { ok: true, value: toAccount(unwrapped.value.user) };
  } catch (err) {
    return { ok: false, error: asClientError(err) };
  }
}

/** A label a user can recognize later, without fingerprinting anything. */
export function defaultPasskeyName(now: Date = new Date()): string {
  return `Passkey ${now.toISOString().slice(0, 10)}`;
}

export const betterAuthApi: AuthApi = {
  async getSession() {
    try {
      const res = await auth().getSession();
      const user = (res as { data?: { user?: SessionUser } | null }).data?.user;
      return user ? toAccount(user) : null;
    } catch {
      // A failed session read is not a signed-out user, but the gate has to
      // resolve to something; "no session" is the safe half of the mistake.
      return null;
    }
  },

  createAccountWithPasskey,
  signInWithPasskey,

  async signOut() {
    try {
      await auth().signOut();
    } catch {
      /* the local state is cleared regardless; a stale cookie 401s next call */
    }
  },

  async listPasskeys() {
    try {
      const res = await auth().$fetch<RawPasskey[]>('/passkey/list-user-passkeys', {
        method: 'GET',
      });
      const unwrapped = unwrap<RawPasskey[]>(res as { data?: RawPasskey[] | null; error?: unknown });
      if (!unwrapped.ok) return unwrapped;
      return { ok: true, value: unwrapped.value.map(toRecord) };
    } catch (err) {
      return { ok: false, error: asClientError(err) };
    }
  },

  async addPasskey(name) {
    try {
      const res = await auth().passkey.addPasskey({ name });
      if (res.error) return { ok: false, error: asClientError(res.error) };
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: asClientError(err) };
    }
  },

  async renamePasskey(id, name) {
    try {
      const res = await auth().$fetch('/passkey/update-passkey', {
        method: 'POST',
        body: { id, name },
      });
      if ((res as { error?: unknown }).error) {
        return { ok: false, error: asClientError((res as { error: unknown }).error) };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: asClientError(err) };
    }
  },

  async removePasskey(id) {
    try {
      const res = await auth().$fetch('/passkey/delete-passkey', {
        method: 'POST',
        body: { id },
      });
      if ((res as { error?: unknown }).error) {
        return { ok: false, error: asClientError((res as { error: unknown }).error) };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: asClientError(err) };
    }
  },
};

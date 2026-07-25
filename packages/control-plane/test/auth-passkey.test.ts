// PASSKEYS, end to end, against the real Worker.
//
// The hosted instance has no GitHub OAuth app and no password: a new user's
// FIRST credential is a passkey, created by the ceremony itself. These tests
// drive both halves of that ceremony over `SELF.fetch` with real bindings —
// Better Auth, its passkey plugin and @simplewebauthn/server all run untouched
// inside the Worker. Nothing about the auth layer is mocked; the only emulated
// component is the authenticator device (test/auth-soft-authenticator.ts), which
// produces spec-shaped CBOR and real ES256 signatures that the server verifies
// cryptographically.
//
// What is asserted, beyond "it returned 200":
//   - no user row exists until the attestation VERIFIES (no orphan accounts),
//   - the `account` table stays EMPTY for a passkey account — no password
//     anywhere on the hosted path,
//   - a session cookie results and it actually guards /api/*,
//   - sign-in works from a cold cookie jar with a DISCOVERABLE credential
//     (no allowCredentials, i.e. no username needed),
//   - a tampered signature, a replayed challenge and a foreign origin all fail,
//   - multiple passkeys per user, naming, removal, and cross-tenant refusal.

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, ensureSchema, HOST, apiGet } from './helpers';
import { SoftCredential, b64urlDecode } from './auth-soft-authenticator';

/** The origin the emulated browser is on. Matches HOST so the ceremony's
 *  clientData origin, the request `Origin` header and BASE_URL all agree. */
const ORIGIN = HOST;

/** A cookie jar, because the WebAuthn challenge travels in a signed cookie and
 *  the session comes back in another. */
class Jar {
  #jar = new Map<string, string>();

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const first = raw.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      // A deletion (Max-Age=0 / empty value) must actually drop the cookie.
      if (value === '' || /max-age=0\b/i.test(raw)) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
  }

  header(): string {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(prefix: string): boolean {
    return [...this.#jar.keys()].some((k) => k.startsWith(prefix));
  }

  clone(): Jar {
    const next = new Jar();
    for (const [k, v] of this.#jar) next.#jar.set(k, v);
    return next;
  }
}

interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: string; alg: number }[];
  attestation: string;
  authenticatorSelection: { residentKey?: string; userVerification?: string };
  excludeCredentials?: { id: string }[];
}

interface AuthenticationOptions {
  challenge: string;
  rpId: string;
  allowCredentials?: { id: string }[];
}

interface PasskeyRow {
  id: string;
  name?: string | null;
  userId: string;
  credentialID: string;
  publicKey: string;
  counter: number;
  deviceType: string;
  backedUp: boolean | number;
  transports?: string;
  aaguid?: string;
}

/** Better Auth answers some rejections with an empty body; a test must still be
 *  able to read the status without exploding on `await res.json()`. */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

async function authGet<T>(
  path: string,
  jar: Jar,
): Promise<{ status: number; body: T; res: Response }> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const res = await SELF.fetch(`${HOST}${path}`, { headers });
  jar.absorb(res);
  return { status: res.status, body: await readJson<T>(res), res };
}

async function authPost<T>(
  path: string,
  jar: Jar,
  body: unknown,
): Promise<{ status: number; body: T; res: Response }> {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    'content-type': 'application/json',
  };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const res = await SELF.fetch(`${HOST}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  jar.absorb(res);
  return { status: res.status, body: await readJson<T>(res), res };
}

/** A full sign-UP ceremony: options → attestation → verification. Returns the
 *  jar (now holding the session) and the credential for later sign-ins. */
async function signUpWithPasskey(
  email: string,
  name?: string,
): Promise<{ jar: Jar; credential: SoftCredential; passkey: PasskeyRow; options: RegistrationOptions }> {
  const jar = new Jar();
  const opts = await authGet<RegistrationOptions>(
    `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
    jar,
  );
  expect(opts.status).toBe(200);
  const credential = await SoftCredential.create(opts.body.rp.id, opts.body.user.id);
  const attestation = await credential.attest(opts.body.challenge, ORIGIN);
  const verified = await authPost<PasskeyRow>('/api/auth/passkey/verify-registration', jar, {
    response: attestation,
    ...(name ? { name } : {}),
  });
  expect(verified.status).toBe(200);
  return { jar, credential, passkey: verified.body, options: opts.body };
}

/** A full sign-IN ceremony with a discoverable credential (no username). */
async function signInWithPasskey(
  credential: SoftCredential,
  jar: Jar = new Jar(),
): Promise<{ status: number; body: { user?: { id: string; email: string } }; jar: Jar }> {
  const opts = await authGet<AuthenticationOptions>(
    '/api/auth/passkey/generate-authenticate-options',
    jar,
  );
  expect(opts.status).toBe(200);
  // Discoverable: the server names no credentials, the authenticator chooses.
  expect(opts.body.allowCredentials).toBeUndefined();
  const assertion = await credential.assert(opts.body.challenge, ORIGIN);
  const res = await authPost<{ user?: { id: string; email: string } }>(
    '/api/auth/passkey/verify-authentication',
    jar,
    { response: assertion },
  );
  return { status: res.status, body: res.body, jar };
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

describe('passkey registration and authentication ceremonies', () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  it('creates a brand-new account from the ceremony, with no password anywhere', async () => {
    const email = `new-${crypto.randomUUID().slice(0, 8)}@mari.test`;

    // ---- options: the RP the browser will be asked to sign for -------------
    const jar = new Jar();
    const opts = await authGet<RegistrationOptions>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
      jar,
    );
    expect(opts.status).toBe(200);
    // rpID is config-driven, from BASE_URL (http://localhost in this suite).
    expect(opts.body.rp.id).toBe('localhost');
    expect(opts.body.rp.name).toBe('Mari');
    expect(opts.body.user.name).toBe(email);
    // Discoverable credentials are REQUIRED, not preferred: usernameless
    // sign-in is the only sign-in a hosted account has.
    expect(opts.body.authenticatorSelection.residentKey).toBe('required');
    expect(opts.body.attestation).toBe('none');
    expect(opts.body.pubKeyCredParams.some((p) => p.alg === -7)).toBe(true);
    // The challenge lives in a signed cookie, not in the response body alone.
    expect(jar.has('better-auth')).toBe(true);

    // Nothing has been written yet: an abandoned ceremony must not leave an
    // account behind (and must not squat the email address).
    expect(await countRows('SELECT COUNT(*) AS c FROM user WHERE email = ?', email)).toBe(0);

    // ---- attestation --------------------------------------------------------
    const credential = await SoftCredential.create(opts.body.rp.id, opts.body.user.id);
    const attestation = await credential.attest(opts.body.challenge, ORIGIN);
    const verified = await authPost<PasskeyRow>('/api/auth/passkey/verify-registration', jar, {
      response: attestation,
      name: 'MacBook Pro',
    });
    expect(verified.status).toBe(200);
    expect(verified.body.credentialID).toBe(credential.id);
    expect(verified.body.name).toBe('MacBook Pro');
    expect(verified.body.counter).toBe(0);
    // BE|BS were set in authData, so the server read a synced multi-device
    // passkey off the wire rather than a single-device security key.
    expect(verified.body.deviceType).toBe('multiDevice');
    expect(Boolean(verified.body.backedUp)).toBe(true);
    expect(verified.body.transports).toBe('internal,hybrid');
    expect(verified.body.aaguid).toBe('00000000-0000-0000-0000-000000000000');
    // The stored public key is the real COSE key, not a placeholder.
    expect(b64urlDecode(verified.body.publicKey.replace(/\+/g, '-').replace(/\//g, '_')).length)
      .toBeGreaterThan(32);

    // ---- the account now exists, and holds NO password ---------------------
    const user = await env.DB.prepare('SELECT id, email, name FROM user WHERE email = ?')
      .bind(email)
      .first<{ id: string; email: string; name: string }>();
    expect(user?.email).toBe(email);
    expect(verified.body.userId).toBe(user?.id);
    // `account` is where Better Auth stores password hashes and OAuth links.
    // A passkey-born account has none: there is no password to phish or leak.
    expect(await countRows('SELECT COUNT(*) AS c FROM account WHERE userId = ?', user!.id)).toBe(0);
    expect(await countRows('SELECT COUNT(*) AS c FROM passkey WHERE userId = ?', user!.id)).toBe(1);

    // ---- and the ceremony ended signed in: the cookie guards the API -------
    const fleet = await apiGet<{ computers: unknown[] }>('/api/computers', jar.header());
    expect(fleet.status).toBe(200);
    expect(Array.isArray(fleet.body.computers)).toBe(true);
  });

  it('signs in from a cold cookie jar with a discoverable credential', async () => {
    const email = `signin-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    const { credential } = await signUpWithPasskey(email);

    // A brand-new jar: no session, no memory of the registration.
    const cold = new Jar();
    const denied = await SELF.fetch(`${HOST}/api/computers`);
    expect(denied.status).toBe(401);

    const signedIn = await signInWithPasskey(credential, cold);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.email).toBe(email);

    const fleet = await apiGet<{ computers: unknown[] }>('/api/computers', cold.header());
    expect(fleet.status).toBe(200);

    // The signature counter advanced, which is how a cloned authenticator is
    // detected. It must be persisted, not just verified.
    const row = await env.DB.prepare('SELECT counter FROM passkey WHERE credentialID = ?')
      .bind(credential.id)
      .first<{ counter: number }>();
    expect(Number(row?.counter)).toBe(1);
  });

  it('rejects a tampered assertion signature and mints no session', async () => {
    const email = `tamper-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    const { credential } = await signUpWithPasskey(email);

    const jar = new Jar();
    const opts = await authGet<AuthenticationOptions>(
      '/api/auth/passkey/generate-authenticate-options',
      jar,
    );
    const assertion = await credential.assert(opts.body.challenge, ORIGIN);
    // Flip one bit inside the DER signature.
    const sig = b64urlDecode(assertion.response.signature);
    sig[sig.length - 1] ^= 0x01;
    let flipped = '';
    for (const b of sig) flipped += String.fromCharCode(b);
    assertion.response.signature = btoa(flipped)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await authPost<{ code?: string }>(
      '/api/auth/passkey/verify-authentication',
      jar,
      { response: assertion },
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_FAILED');
    const fleet = await SELF.fetch(`${HOST}/api/computers`, {
      headers: jar.header() ? { Cookie: jar.header() } : {},
    });
    expect(fleet.status).toBe(401);
  });

  it('refuses a replayed challenge', async () => {
    const email = `replay-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    const { credential } = await signUpWithPasskey(email);

    const jar = new Jar();
    const opts = await authGet<AuthenticationOptions>(
      '/api/auth/passkey/generate-authenticate-options',
      jar,
    );
    const first = await credential.assert(opts.body.challenge, ORIGIN);
    const ok = await authPost('/api/auth/passkey/verify-authentication', jar.clone(), {
      response: first,
    });
    expect(ok.status).toBe(200);

    // Same challenge, same cookie, a fresh (higher-counter) assertion: the
    // verification value was consumed, so this must not authenticate.
    const replay = await credential.assert(opts.body.challenge, ORIGIN);
    const res = await authPost<{ code?: string }>(
      '/api/auth/passkey/verify-authentication',
      jar,
      { response: replay },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CHALLENGE_NOT_FOUND');
  });

  it('refuses an attestation signed for a foreign origin', async () => {
    const email = `evil-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    const jar = new Jar();
    const opts = await authGet<RegistrationOptions>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
      jar,
    );
    const credential = await SoftCredential.create(opts.body.rp.id, opts.body.user.id);
    // The clientData says the ceremony happened on someone else's site.
    const attestation = await credential.attest(opts.body.challenge, 'https://evil.example');
    const res = await authPost<{ code?: string }>(
      '/api/auth/passkey/verify-registration',
      jar,
      { response: attestation },
    );
    expect(res.body.code).toBe('FAILED_TO_VERIFY_REGISTRATION');
    // No account, and — because nothing was written before verification — the
    // address is still free for a real signup.
    expect(await countRows('SELECT COUNT(*) AS c FROM user WHERE email = ?', email)).toBe(0);
    const retry = new Jar();
    const reopened = await authGet<RegistrationOptions>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
      retry,
    );
    expect(reopened.status).toBe(200);
  });

  it('will not attach a passkey to an existing account without a session', async () => {
    const email = `taken-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    await signUpWithPasskey(email);

    // A stranger who merely knows the address must not be able to enrol a
    // credential on it — that would be takeover by email.
    const jar = new Jar();
    const res = await authGet<{ code?: string; message?: string }>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
      jar,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ACCOUNT_EXISTS');
    expect(
      await countRows(
        'SELECT COUNT(*) AS c FROM passkey p JOIN user u ON u.id = p.userId WHERE u.email = ?',
        email,
      ),
    ).toBe(1);
  });

  it('will not attach a passkey to a PASSWORD account without a session', async () => {
    // The dev seed creates an account with an email/password credential. An
    // unauthenticated passkey enrolment on it must be refused for the same
    // reason: it would be takeover by email address. (This is the branch that
    // consults the `account` table rather than the passkey table.)
    const seeded = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
    expect(seeded.status).toBe(200);
    const { user } = (await seeded.json()) as { user: { id: string; email: string } };
    expect(
      await countRows('SELECT COUNT(*) AS c FROM account WHERE userId = ?', user.id),
    ).toBeGreaterThan(0);
    expect(await countRows('SELECT COUNT(*) AS c FROM passkey WHERE userId = ?', user.id)).toBe(0);

    const res = await authGet<{ code?: string }>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(user.email)}`,
      new Jar(),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ACCOUNT_EXISTS');
  });

  it('adopts an account that holds NO credential at all, rather than locking the address out', async () => {
    // A user row with no passkey, no password and no OAuth link is unreachable:
    // there is no password to reset and no email loop on the hosted path. If a
    // ceremony ever half-completed, refusing a fresh enrolment would burn that
    // email address permanently. So an unauthenticated registration adopts it.
    const email = `orphan-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    const orphanId = `orphan${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
      .bind(orphanId, email, email, now, now)
      .run();

    const jar = new Jar();
    const opts = await authGet<RegistrationOptions>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
      jar,
    );
    expect(opts.status).toBe(200);
    const credential = await SoftCredential.create(opts.body.rp.id, opts.body.user.id);
    const verified = await authPost<PasskeyRow>('/api/auth/passkey/verify-registration', jar, {
      response: await credential.attest(opts.body.challenge, ORIGIN),
    });
    expect(verified.status).toBe(200);
    // Attached to the EXISTING row — no duplicate account for the address.
    expect(verified.body.userId).toBe(orphanId);
    expect(await countRows('SELECT COUNT(*) AS c FROM user WHERE email = ?', email)).toBe(1);

    // And now that it holds a credential, it is no longer adoptable.
    const second = await authGet<{ code?: string }>(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`,
      new Jar(),
    );
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('ACCOUNT_EXISTS');

    // The adopted account can sign in with its new credential.
    const signedIn = await signInWithPasskey(credential);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.id).toBe(orphanId);
  });

  it('rejects a signup with no email', async () => {
    const jar = new Jar();
    const res = await authGet<{ code?: string }>(
      '/api/auth/passkey/generate-register-options',
      jar,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EMAIL');
  });

  it('holds multiple passkeys per user, and names, renames and removes them', async () => {
    const email = `multi-${crypto.randomUUID().slice(0, 8)}@mari.test`;
    const { jar, credential: first } = await signUpWithPasskey(email, 'Phone');

    // ---- a SECOND passkey, on the session path (no email needed) ----------
    const opts = await authGet<RegistrationOptions>(
      '/api/auth/passkey/generate-register-options',
      jar,
    );
    expect(opts.status).toBe(200);
    // The first credential is excluded, so the authenticator will not enrol the
    // same device twice.
    expect(opts.body.excludeCredentials?.some((c) => c.id === first.id)).toBe(true);
    const second = await SoftCredential.create(opts.body.rp.id, opts.body.user.id);
    const added = await authPost<PasskeyRow>('/api/auth/passkey/verify-registration', jar, {
      response: await second.attest(opts.body.challenge, ORIGIN),
      name: 'Laptop',
    });
    expect(added.status).toBe(200);

    const listed = await authGet<PasskeyRow[]>('/api/auth/passkey/list-user-passkeys', jar);
    expect(listed.status).toBe(200);
    expect(listed.body.length).toBe(2);
    expect(new Set(listed.body.map((p) => p.name))).toEqual(new Set(['Phone', 'Laptop']));
    expect(new Set(listed.body.map((p) => p.credentialID))).toEqual(
      new Set([first.id, second.id]),
    );

    // ---- rename ------------------------------------------------------------
    const target = listed.body.find((p) => p.credentialID === second.id)!;
    const renamed = await authPost<{ passkey: PasskeyRow }>(
      '/api/auth/passkey/update-passkey',
      jar,
      { id: target.id, name: 'Work Laptop' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.passkey.name).toBe('Work Laptop');

    // ---- another user cannot touch it -------------------------------------
    const stranger = await signUpWithPasskey(`stranger-${crypto.randomUUID().slice(0, 8)}@mari.test`);
    const forbidden = await authPost('/api/auth/passkey/delete-passkey', stranger.jar, {
      id: target.id,
    });
    expect(forbidden.status).toBe(401);
    const forbiddenRename = await authPost<{ code?: string }>(
      '/api/auth/passkey/update-passkey',
      stranger.jar,
      { id: target.id, name: 'stolen' },
    );
    expect(forbiddenRename.status).toBe(401);
    expect(forbiddenRename.body.code).toBe('YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY');
    expect(await countRows('SELECT COUNT(*) AS c FROM passkey WHERE id = ?', target.id)).toBe(1);

    // ---- remove, and the remaining credential still signs in --------------
    const removed = await authPost<{ status: boolean }>(
      '/api/auth/passkey/delete-passkey',
      jar,
      { id: target.id },
    );
    expect(removed.status).toBe(200);
    const after = await authGet<PasskeyRow[]>('/api/auth/passkey/list-user-passkeys', jar);
    expect(after.body.length).toBe(1);
    expect(after.body[0]?.credentialID).toBe(first.id);

    const again = await signInWithPasskey(first);
    expect(again.status).toBe(200);
    expect(again.body.user?.email).toBe(email);

    // The deleted credential can no longer authenticate.
    const gone = await signInWithPasskey(second);
    expect(gone.status).toBe(401);
  });
});

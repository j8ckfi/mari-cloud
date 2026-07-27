// The R2 credential seam for a hosted computer's chunk store (deploy/DEPLOY.md
// §1 item 3; decisions.md commits to direct-to-R2).
//
// On Cloudflare Containers all disk is ephemeral, so `MARI_STORE` must name the
// R2 bucket's S3 endpoint — and R2's S3 endpoint accepts nothing but SigV4
// credentials. marid reads them the standard way (opendal → reqsign's default
// AWS chain): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
// `AWS_ENDPOINT_URL`, `AWS_REGION`. This module composes exactly that set at
// materialize time, so the values live in the supervisor's process environment
// for one generation and nowhere else.
//
// THE CREDENTIALS ARE PER-COMPUTER AND SHORT-LIVED, NOT A FLEET KEY. Every
// materialize mints a scoped credential via Cloudflare's temporary-access API
// (`POST accounts/{account_id}/r2/temp-access-credentials` — request/response
// shape verified against Cloudflare's published OpenAPI schema, which also gives
// `ttlSeconds` its `maximum: 604800`). The scope is `object-read-write` on the
// prefixes this computer legitimately touches (contracts.md §9 plus marid's own
// durable-state keys, crates/marid/src/state.rs):
//
//   journal/{computer}/   runs/{computer}/   state/{computer}/
//   heat/{computer}.cbor  chunks/            manifests/
//
// The per-computer prefixes are the tenancy boundary: a leaked credential for
// computer A cannot read B's journal (terminal output — routinely
// secret-bearing), B's run records, or B's head history. `chunks/` and
// `manifests/` are deliberately SHARED — they are content-addressed, every
// manifest references chunks written by other computers (that is the whole
// base-image dedup argument, spec §2), and R2's prefix scoping has no way to
// express "the chunks your manifests reach". The residual risk is stated in
// decisions.md rather than papered over: a computer's credential can read any
// chunk/manifest it can NAME (ids are unguessable blake3s, but `ListObjects`
// within the prefix enumerates them) and can write garbage under either prefix
// (harmless to integrity — both sides verify blake3 on read and a wrong body
// under a right key is detected — but it is spend). `base/` is EXCLUDED on
// purpose: only the control plane reads/writes base pointers, via its R2
// binding, and handing computers write access to `base/` would let one tenant
// repoint the fleet's shared base image.
//
// The FALLBACK — static `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` Worker
// secrets injected as-is — exists so a deploy is not hostage to the temp-cred
// API being reachable, but it is a bucket-wide key in every computer's
// environment and this module says so on every use. Configure the parent-token
// pair instead.

/** Permission granted to a minted credential: object CRUD within the scoped
 *  prefixes, no bucket administration. One of the API's four enum values. */
export const R2_TEMP_PERMISSION = 'object-read-write';

/** The API's own ceiling for `ttlSeconds` (OpenAPI `maximum: 604800` — 7 days),
 *  and our default: mint the longest-lived credential the platform allows,
 *  because the credential's lifetime bounds the SESSION's, not the attacker's
 *  (scope does that). A container generation that outlives its credential —
 *  seven days AWAKE/WARM without a cold materialize — starts failing store
 *  writes (snapshots, journal segments) until its next cold wake re-mints;
 *  decisions.md documents that window. */
export const R2_TEMP_TTL_MAX_SECONDS = 604_800;

/** Floor for a configured TTL: the API's documented default. A credential
 *  shorter than a plausible session is worse than the risk it mitigates. */
export const R2_TEMP_TTL_MIN_SECONDS = 900;

/** Everything this seam reads out of the Worker environment. Structural on
 *  purpose: `types.ts` belongs to another lane, and every field is optional, so
 *  the control plane's `Env` is assignable here while the runtime values arrive
 *  from wrangler vars/secrets. */
export interface StoreCredentialEnv {
  /** Chunk store URI as the SUPERVISOR sees it (`MARI_STORE`). Only `s3://`
   *  engages this module. */
  STORE_URI?: string;
  /** Cloudflare account id (a var): names both the temp-credential API route
   *  and the S3 endpoint `https://{account}.r2.cloudflarestorage.com`. */
  CF_ACCOUNT_ID?: string;
  /** SECRET — access key id of the parent R2 API token; the minted credential
   *  is derived from (and revoked with) it. */
  R2_PARENT_ACCESS_KEY_ID?: string;
  /** SECRET — the parent R2 API token VALUE, used as the Bearer token on the
   *  temp-credential call. Never forwarded to a computer. */
  R2_PARENT_API_TOKEN?: string;
  /** Optional TTL override (seconds), clamped to [900, 604800]. */
  R2_TEMP_TTL_SECONDS?: string;
  /** SECRET — static fallback key id (bucket-wide; see module header). */
  R2_ACCESS_KEY_ID?: string;
  /** SECRET — static fallback secret. */
  R2_SECRET_ACCESS_KEY?: string;
  /** Optional explicit S3 endpoint (dev/MinIO); defaults from CF_ACCOUNT_ID. */
  R2_ENDPOINT?: string;
}

/** A store credential could not be composed. Thrown from the materialize path,
 *  so the wake fails LOUDLY (`wake_failed`, reason in the DO's log) instead of
 *  booting a supervisor that cannot reach the computer's own filesystem. */
export class StoreCredentialError extends Error {
  override readonly name = 'StoreCredentialError';
}

/** `s3://bucket[/root]` → its parts. Returns null for any other scheme. */
export function parseS3StoreUri(uri: string): { bucket: string; root: string } | null {
  if (!uri.startsWith('s3://')) return null;
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const root = slash === -1 ? '' : rest.slice(slash + 1).replace(/\/+$/, '');
  if (bucket === '') {
    throw new StoreCredentialError(`s3 store URI has no bucket: ${JSON.stringify(uri)}`);
  }
  return { bucket, root };
}

/** Mirror of mari-core's `check_computer_id`: the id becomes a store-key
 *  segment, and an id containing a separator would scope the credential to a
 *  DIFFERENT computer's prefix — the exact hole this module exists to close. */
function checkComputerId(computer: string): void {
  const bad =
    computer === '' ||
    computer === '.' ||
    computer === '..' ||
    computer.includes('/') ||
    computer.includes('\\') ||
    computer.includes('\0');
  if (bad) {
    throw new StoreCredentialError(
      `computer id ${JSON.stringify(computer)} is not a single store key segment`,
    );
  }
}

/**
 * The key prefixes one computer's credential is scoped to (contracts.md §9 +
 * crates/marid/src/state.rs). `root` is the path segment of the store URI
 * (`s3://bucket/root`), empty in production (`s3://mari-store`).
 *
 * `heat/{computer}.cbor` is scoped as the FULL key, deliberately: a bare
 * `heat/{computer}` prefix would also match `heat/{computer}-anything.cbor`,
 * i.e. an adjacent computer whose id extends this one.
 */
export function storeCredentialPrefixes(computer: string, root = ''): string[] {
  checkComputerId(computer);
  const withRoot = (key: string): string => (root === '' ? key : `${root}/${key}`);
  return [
    `chunks/`,
    `manifests/`,
    `heat/${computer}.cbor`,
    `journal/${computer}/`,
    `runs/${computer}/`,
    `state/${computer}/`,
  ].map(withRoot);
}

/** What the temp-credential API answers with (unwrapped `result`). */
export interface MintedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Narrow `fetch` so tests can hand a recording stub without carrying the whole
 *  DOM signature. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Mint one scoped, short-lived credential. The request shape is Cloudflare's
 * published one — `bucket`, `parentAccessKeyId`, `permission`, `ttlSeconds` are
 * required; `prefixes` scopes object access to keys starting with any listed
 * prefix. Errors carry the HTTP status and the API's error text, never any
 * secret material.
 */
export async function mintTempCredentials(
  opts: {
    accountId: string;
    apiToken: string;
    parentAccessKeyId: string;
    bucket: string;
    prefixes: string[];
    ttlSeconds: number;
  },
  fetchImpl: FetchLike,
): Promise<MintedCredentials> {
  const url = `${CF_API_BASE}/accounts/${opts.accountId}/r2/temp-access-credentials`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      bucket: opts.bucket,
      parentAccessKeyId: opts.parentAccessKeyId,
      permission: R2_TEMP_PERMISSION,
      ttlSeconds: opts.ttlSeconds,
      prefixes: opts.prefixes,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new StoreCredentialError(
      `temp-access-credentials answered ${res.status}: ${text.slice(0, 512)}`,
    );
  }
  // Validated boundary: the envelope is Cloudflare's `{ success, result }`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreCredentialError('temp-access-credentials answered non-JSON');
  }
  const envelope = parsed as {
    success?: boolean;
    result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
    errors?: unknown;
  };
  const result = envelope.result;
  if (
    envelope.success !== true ||
    typeof result?.accessKeyId !== 'string' ||
    result.accessKeyId === '' ||
    typeof result.secretAccessKey !== 'string' ||
    result.secretAccessKey === '' ||
    typeof result.sessionToken !== 'string' ||
    result.sessionToken === ''
  ) {
    throw new StoreCredentialError(
      `temp-access-credentials answered success=${String(envelope.success)} with an ` +
        `incomplete credential (errors: ${JSON.stringify(envelope.errors ?? null).slice(0, 512)})`,
    );
  }
  return {
    accessKeyId: result.accessKeyId,
    secretAccessKey: result.secretAccessKey,
    sessionToken: result.sessionToken,
  };
}

/** The configured TTL, clamped to the API's own bounds. */
export function tempCredentialTtlSeconds(env: StoreCredentialEnv): number {
  const raw = Number(env.R2_TEMP_TTL_SECONDS);
  const wanted = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : R2_TEMP_TTL_MAX_SECONDS;
  return Math.min(Math.max(wanted, R2_TEMP_TTL_MIN_SECONDS), R2_TEMP_TTL_MAX_SECONDS);
}

/**
 * Compose the store half of a computer's materialize environment.
 *
 * - `fs://` (or unset) store: `{}` — a filesystem store needs no credentials,
 *   which is every test binding and the Node private instance.
 * - `s3://` store: `AWS_ENDPOINT_URL` + `AWS_REGION` plus, in order of
 *   preference, (1) a minted per-computer temporary credential (includes
 *   `AWS_SESSION_TOKEN`), or (2) the static fallback pair, loudly.
 * - `s3://` store with neither credential path configured THROWS, which fails
 *   the wake as `wake_failed` with this reason in the log — the alternative is
 *   a container that materializes, cannot open its store, and dies where only
 *   the WAKING watchdog notices.
 */
export async function composeStoreEnv(
  env: StoreCredentialEnv,
  computer: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Record<string, string>> {
  const uri = env.STORE_URI;
  if (uri === undefined || !uri.startsWith('s3://')) return {};
  const parsed = parseS3StoreUri(uri);
  if (parsed === null) return {};

  const endpoint =
    env.R2_ENDPOINT ??
    (env.CF_ACCOUNT_ID !== undefined && env.CF_ACCOUNT_ID !== ''
      ? `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  if (endpoint === undefined) {
    throw new StoreCredentialError(
      `STORE_URI is ${JSON.stringify(uri)} but no S3 endpoint can be derived: set the ` +
        'CF_ACCOUNT_ID var (or R2_ENDPOINT)',
    );
  }
  const base: Record<string, string> = {
    AWS_ENDPOINT_URL: endpoint,
    // R2's documented region for its S3 endpoint; marid forwards it verbatim
    // (crates/marid/src/store_uri.rs reads AWS_REGION, default us-east-1 —
    // which R2 also accepts, but say what we mean).
    AWS_REGION: 'auto',
  };

  const canMint =
    env.CF_ACCOUNT_ID !== undefined &&
    env.CF_ACCOUNT_ID !== '' &&
    env.R2_PARENT_ACCESS_KEY_ID !== undefined &&
    env.R2_PARENT_ACCESS_KEY_ID !== '' &&
    env.R2_PARENT_API_TOKEN !== undefined &&
    env.R2_PARENT_API_TOKEN !== '';
  if (canMint) {
    const minted = await mintTempCredentials(
      {
        accountId: env.CF_ACCOUNT_ID as string,
        apiToken: env.R2_PARENT_API_TOKEN as string,
        parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID as string,
        bucket: parsed.bucket,
        prefixes: storeCredentialPrefixes(computer, parsed.root),
        ttlSeconds: tempCredentialTtlSeconds(env),
      },
      fetchImpl,
    );
    return {
      ...base,
      AWS_ACCESS_KEY_ID: minted.accessKeyId,
      AWS_SECRET_ACCESS_KEY: minted.secretAccessKey,
      AWS_SESSION_TOKEN: minted.sessionToken,
    };
  }

  const hasStatic =
    env.R2_ACCESS_KEY_ID !== undefined &&
    env.R2_ACCESS_KEY_ID !== '' &&
    env.R2_SECRET_ACCESS_KEY !== undefined &&
    env.R2_SECRET_ACCESS_KEY !== '';
  if (hasStatic) {
    // The loud part of the loud fallback: every single materialize says a
    // bucket-wide key just entered a tenant's environment.
    console.warn(
      `mari: STATIC R2 credentials injected for computer=${computer} — this key is ` +
        'bucket-wide, not scoped to the computer. Configure R2_PARENT_ACCESS_KEY_ID + ' +
        'R2_PARENT_API_TOKEN so per-computer temporary credentials are minted instead ' +
        '(deploy/DEPLOY.md).',
    );
    return {
      ...base,
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID as string,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY as string,
    };
  }

  throw new StoreCredentialError(
    `STORE_URI is ${JSON.stringify(uri)} but no R2 credentials are configured: set the ` +
      'R2_PARENT_ACCESS_KEY_ID + R2_PARENT_API_TOKEN secrets (preferred, per-computer ' +
      'scoped) or R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (static fallback)',
  );
}

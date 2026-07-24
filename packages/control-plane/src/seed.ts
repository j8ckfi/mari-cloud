// Deterministic dev seed (env DEV_SEED=1). Creates a user + session, a COLD
// computer, and writes that computer's manifest + chunks into the R2 STORE as a
// small deterministic tree. The web Playwright suite depends on this route's
// exact request/response shape (documented below and in docs/contracts.md's
// appendix).
//
// CONTRACT — POST /api/dev/seed  (only when DEV_SEED=1; otherwise 404)
//   Request:  no body required. Optional JSON `{ "email"?, "password"?, "name"? }`
//             overrides the default seed identity.
//   Response 200 JSON:
//     {
//       "user":     { "id": string, "email": string },
//       "session":  { "token": string },   // Better Auth session token
//       "computer": { "id": string, "name": string, "state": "cold",
//                     "head": string },    // head === manifest id below
//       "manifest": string,                // manifest id (content address)
//       "files":    string[],              // absolute paths in the seed tree
//       "postRunManifest": string,         // a SECOND real manifest (below)
//       "postRunFiles":    string[]
//     }
//   Side effects: applies the D1 schema; upserts the user + a session; writes the
//   manifest + chunks to R2; resets each seeded computer's DO run/attention/
//   journal state; sets the computer's DO head (no wake); the response also
//   carries the Better Auth `Set-Cookie` session header.
//
// DEVIATION: content addressing here uses SHA-256 (Web Crypto) as a stand-in for
// blake3. mari-core (the real blake3 chunker/manifest writer) is not yet wired
// into the control plane; the ids are self-consistent within the seed, which is
// all the file-browse path needs (it fetches chunks by the id in the manifest).

import { encodeCbor, type Manifest, type ManifestEntry } from '@mari/shared';
import type { Env } from './types';
import { applySchema } from './db/apply';
import { chunkKey, manifestKey } from './manifest-store';
import { insertComputer, deleteComputer, setSecret } from './db/fleet';
import { makeAuth } from './auth';
import { toArrayBuffer } from './bytes';

const SEED_COMPUTER_ID = 'seedcomputer';
const SEED_COMPUTER_NAME = 'Seed Computer';
// A second COLD computer so the fleet has >= 2 workspaces (Super/Alt+1..9 slot
// switching, spec 8.1). It shares the same seeded manifest head, so it browses
// the same files COLD. The primary computer above remains the one reported in
// the seed response body (files/auth tests key off it).
const SEED_COMPUTER_ID_2 = 'seedcomputertwo';
const SEED_COMPUTER_NAME_2 = 'Seed Computer Two';
const DEFAULT_EMAIL = 'seed@mari.test';
const DEFAULT_PASSWORD = 'seed-password-123';
const DEFAULT_NAME = 'Seed User';

/** The deterministic seed tree: absolute path -> UTF-8 contents. */
export const SEED_TREE: Record<string, string> = {
  '/README.md': '# seed computer\n\nThis filesystem was written by the dev seed.\n',
  '/src/main.ts': 'export const answer = 42;\nconsole.log(answer);\n',
  '/src/util.ts': 'export const add = (a: number, b: number) => a + b;\n',
  '/notes/todo.txt': 'wake the computer\nbrowse the files\n',
};

/**
 * A SECOND deterministic tree, written to R2 by the same seed: what the seed
 * tree looks like after a run has touched it. It differs from {@link SEED_TREE}
 * in exactly one way of each kind — one file added, one modified, one removed —
 * so a diff of `manifest -> postRunManifest` is `{ added: 1, modified: 1,
 * removed: 1 }` with known paths.
 *
 * WHY IT EXISTS. A run's result is a difference between two manifests (spec
 * 5.3), and only a real supervisor (mari-core) can write one. The web e2e's
 * fake supervisor cannot, so before this it reported a made-up manifest id in
 * `run_completed` — which made `GET /runs/:id/diff` a `404 manifest_missing`
 * (the review pane rendered its error state and the e2e assertion on "its
 * difference" proved nothing), and made a subsequent `keep` move the computer's
 * head to an id that is not in the store, after which the file browser 404s.
 * Seeding the post-run manifest for real fixes both: the fake reports ids that
 * exist, and the diff the reviewer sees is computed by the real engine from
 * real manifest bytes.
 */
export const SEED_TREE_AFTER: Record<string, string> = {
  // modified: content changed (the same path, different bytes)
  '/README.md':
    '# seed computer\n\nThis filesystem was written by the dev seed.\nA run appended this line.\n',
  // unchanged
  '/src/main.ts': 'export const answer = 42;\nconsole.log(answer);\n',
  // unchanged
  '/notes/todo.txt': 'wake the computer\nbrowse the files\n',
  // added
  '/notes/made-by-mari.txt': 'a run created this file\n',
  // NOTE: '/src/util.ts' is absent — removed by the run.
};

/** The paths {@link SEED_TREE_AFTER} changes, by change class (the e2e asserts
 *  these exact rows in the review pane). */
export const SEED_RUN_CHANGES = {
  added: ['/notes/made-by-mari.txt'],
  modified: ['/README.md'],
  removed: ['/src/util.ts'],
} as const;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const arr = new Uint8Array(digest);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function dirsOf(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      dirs.add(cur);
    }
  }
  return [...dirs];
}

/** Build the manifest, write chunks + the manifest CBOR to R2, return the id. */
export async function writeSeedTree(
  store: R2Bucket,
  tree: Record<string, string> = SEED_TREE,
): Promise<{ manifest: string; files: string[] }> {
  const enc = new TextEncoder();
  const entries: ManifestEntry[] = [];

  for (const dir of dirsOf(Object.keys(tree))) {
    entries.push({
      path: dir,
      kind: 'dir',
      mode: 0o040755,
      size: 0,
      symlink_target: null,
      chunks: [],
    });
  }

  for (const [path, contents] of Object.entries(tree)) {
    const bytes = enc.encode(contents);
    const id = await sha256Hex(bytes);
    await store.put(chunkKey(id), bytes);
    entries.push({
      path,
      kind: 'file',
      mode: 0o100644,
      size: bytes.length,
      symlink_target: null,
      chunks: [{ chunk: id, len: bytes.length }],
    });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifest: Manifest = {
    version: 1,
    parent: null,
    created_at: 1_700_000_000, // fixed, deterministic
    entries,
  };
  const cbor = encodeCbor(manifest);
  const manifestId = await sha256Hex(cbor);
  await store.put(manifestKey(manifestId), cbor);

  return { manifest: manifestId, files: Object.keys(tree).sort() };
}

export interface SeedResult {
  body: {
    user: { id: string; email: string };
    session: { token: string };
    computer: { id: string; name: string; state: 'cold'; head: string };
    manifest: string;
    files: string[];
    /** A second real manifest in the store, {@link SEED_TREE_AFTER} — the
     *  post-run side of a difference. No computer's head points at it. */
    postRunManifest: string;
    postRunFiles: string[];
  };
  /** Set-Cookie header value from Better Auth, to attach to the HTTP response. */
  setCookie: string | null;
}

/** Run the full seed. Throws on failure; the route maps that to a 500. */
export async function runSeed(
  env: Env,
  opts?: { email?: string; password?: string; name?: string },
): Promise<SeedResult> {
  await applySchema(env.DB);

  const email = opts?.email ?? DEFAULT_EMAIL;
  const password = opts?.password ?? DEFAULT_PASSWORD;
  const name = opts?.name ?? DEFAULT_NAME;

  const auth = makeAuth(env);

  // Sign up, or sign in if the seed identity already exists. `returnHeaders`
  // gives us both the session token and the Set-Cookie header.
  //
  // The existence check is a LOOKUP, not a caught exception: Better Auth's
  // `signUpEmail` rejects with `USER_ALREADY_EXISTS` from inside its own
  // transaction wrapper, and that rejection surfaces as an unhandled rejection
  // even when this function catches the awaited one — which fails a Workers
  // vitest run. Re-seeding is the normal case (the e2e suite seeds on every
  // run), so it must not travel an error path at all.
  const existing = await env.DB.prepare('SELECT id FROM user WHERE email = ?')
    .bind(email)
    .first<{ id: string }>()
    .catch(() => null);

  let token: string;
  let userId: string;
  let setCookie: string | null = null;
  if (existing) {
    const res = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    token = res.response.token as string;
    userId = (res.response.user as { id: string }).id;
    setCookie = res.headers.get('set-cookie');
  } else {
    const res = await auth.api.signUpEmail({
      body: { email, password, name },
      returnHeaders: true,
    });
    token = res.response.token as string;
    userId = (res.response.user as { id: string }).id;
    setCookie = res.headers.get('set-cookie');
  }

  // Write the manifest + chunks to R2 — both the seed tree and its post-run
  // variant, so a run's difference can be computed from real manifests.
  const { manifest, files } = await writeSeedTree(env.STORE, SEED_TREE);
  const after = await writeSeedTree(env.STORE, SEED_TREE_AFTER);

  // (Re)create the COLD computer owned by the seed user, head = manifest.
  await deleteComputer(env.DB, SEED_COMPUTER_ID, userId).catch(() => undefined);
  await insertComputer(env.DB, {
    id: SEED_COMPUTER_ID,
    name: SEED_COMPUTER_NAME,
    userId,
    head: manifest,
    state: 'cold',
    excludeGlobs: ['/root/.config/mari/secrets/**'],
  });
  // A sample vault secret name (spec 10.1). Value never leaves the vault.
  await setSecret(env.DB, SEED_COMPUTER_ID, 'ANTHROPIC_API_KEY', 'seed-secret-value');

  // Seed the DO head without waking (spec 8.4). `resetSeedState` first, because
  // `wrangler dev` PERSISTS Durable Object storage between sessions: without it
  // the "deterministic seed" inherits the previous session's run rows and
  // undismissed attention events, and an e2e that asserts "attention appears"
  // would pass on that residue instead of on the event it raised.
  const stub = env.COMPUTER.get(env.COMPUTER.idFromName(SEED_COMPUTER_ID));
  await stub.resetSeedState(SEED_COMPUTER_ID);
  await stub.initFromManifest(SEED_COMPUTER_ID, manifest);

  // A second COLD computer owned by the same user, sharing the manifest head so
  // the fleet has >= 2 workspaces to switch between (spec 8.1).
  await deleteComputer(env.DB, SEED_COMPUTER_ID_2, userId).catch(() => undefined);
  await insertComputer(env.DB, {
    id: SEED_COMPUTER_ID_2,
    name: SEED_COMPUTER_NAME_2,
    userId,
    head: manifest,
    state: 'cold',
    excludeGlobs: ['/root/.config/mari/secrets/**'],
  });
  const stub2 = env.COMPUTER.get(env.COMPUTER.idFromName(SEED_COMPUTER_ID_2));
  await stub2.resetSeedState(SEED_COMPUTER_ID_2);
  await stub2.initFromManifest(SEED_COMPUTER_ID_2, manifest);

  return {
    body: {
      user: { id: userId, email },
      session: { token },
      computer: { id: SEED_COMPUTER_ID, name: SEED_COMPUTER_NAME, state: 'cold', head: manifest },
      manifest,
      files,
      postRunManifest: after.manifest,
      postRunFiles: after.files,
    },
    setCookie,
  };
}

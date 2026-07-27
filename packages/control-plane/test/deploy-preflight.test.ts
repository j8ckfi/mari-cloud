// DEPLOY PREFLIGHT — the production environment must be internally consistent.
//
// `test/auth-production.test.ts` holds `env.production` to the auth standard: the
// secret arrives as a secret, the dev flags are off, every non-inheritable
// binding is repeated. This file holds it to the SUBSTRATE standard, which is the
// other half of "a deploy that can actually run a computer":
//
//   1. A real substrate needs a control URL and a chunk store the computer can
//      reach. `marid`'s `MARI_CONTROL_URL` has NO default (crates/marid/src/config.rs
//      is a clap `String` with an env fallback and nothing else), so an absent
//      `SUPERVISOR_URL_BASE` means every materialized container exits at startup
//      — a wake that "succeeds" and a computer that never connects. And on a
//      substrate whose disk is ephemeral, a `fs://` store means every chunk the
//      computer writes is discarded at the next stop.
//   2. `CF_MAX_INSTANCES` exists only to let the capacity error name the real cap;
//      a value that does not match `containers[].max_instances` makes the error
//      lie, which is worse than not having it.
//   3. The two `containers` blocks (top level and production) are copies, because
//      the key is non-inheritable. Copies drift.
//
// The container image path itself is proven by `wrangler deploy --dry-run --env
// production`, which BUILDS it; asserting `existsSync` here would only re-check
// the string.
//
// These are assertions about a FILE, so they run in any pool. They live in the
// Workers pool because that is where wrangler.jsonc is already under test.

import { describe, it, expect } from 'vitest';
import wranglerRaw from '../wrangler.jsonc?raw';
import migration0001 from '../migrations/0001_init.sql?raw';
import migration0002 from '../migrations/0002_limits.sql?raw';
import migration0003 from '../migrations/0003_usage.sql?raw';
import secretPreflightRaw from '../../../deploy/check-production-secrets.sh?raw';

/**
 * Strip `//` line comments outside of strings.
 *
 * String-aware on purpose and not a regex: the file is full of `https://` and
 * `ws://` values, and a naive strip would eat the rest of those lines — silently
 * turning `"BASE_URL": "https://app.mari.sh"` into a parse error or, worse, into
 * something that parses differently.
 */
function stripLineComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

interface ContainerBlock {
  name?: string;
  class_name: string;
  image: string;
  image_build_context?: string;
  instance_type?: string;
  max_instances?: number;
  constraints?: { regions?: string[] };
}

interface Block {
  vars: Record<string, string>;
  containers?: ContainerBlock[];
  secrets?: { required?: string[] };
  observability?: {
    enabled?: boolean;
    head_sampling_rate?: number;
    logs?: {
      enabled?: boolean;
      head_sampling_rate?: number;
      invocation_logs?: boolean;
      persist?: boolean;
    };
  };
}

interface Config extends Block {
  compatibility_date: string;
  compatibility_flags?: string[];
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  assets?: { directory: string; binding: string; run_worker_first?: boolean };
  env: { production: Block & { account_id?: string } };
}

const config = JSON.parse(stripLineComments(wranglerRaw)) as Config;
const prod = config.env.production;

/** Every substrate the control plane can actually construct on Workers. */
const REAL_MODES = ['cloudflare'];

describe('production substrate wiring', () => {
  it('names a substrate mode the Workers entry can construct', () => {
    // `makeSubstrate` falls back to the FAKE for anything it does not know, so a
    // typo here is not an error at deploy time — it is a fleet that silently
    // materializes nothing. Enumerate instead.
    expect([...REAL_MODES, 'fake']).toContain(prod.vars.SUBSTRATE_MODE);
  });

  it('carries the configuration a materialized computer needs, whenever the substrate is real', () => {
    if (!REAL_MODES.includes(prod.vars.SUBSTRATE_MODE as string)) {
      // The fake. Its consequence is enforced in code, not documented in prose:
      // `ComputerDO` refuses to wake on a production environment with the fake
      // driver (`test/node/unbacked-substrate.test.ts`). So this branch is a
      // legitimate deploy — of a control plane that cannot run a computer, and
      // says so — and nothing below applies to it.
      expect(prod.vars.SUBSTRATE_MODE).toBe('fake');
      return;
    }

    // `MARI_CONTROL_URL` has no default in marid. Absent ⇒ every container exits
    // at startup with a clap error, and the DO sits in WAKING until its watchdog.
    const base = prod.vars.SUPERVISOR_URL_BASE;
    expect(base, 'SUPERVISOR_URL_BASE is required with a real substrate').toBeTruthy();
    // `wss://`, not `ws://`: marid refuses a plaintext control URL to a public
    // host and exits non-zero (crates/marid/src/ws.rs `classify_control_url`),
    // because the Hello carries the computer's fencing token.
    expect(base).toMatch(/^wss:\/\//);
    expect(base?.endsWith('/')).toBe(false);

    // The chunk store as the SUPERVISOR sees it. `fs://` is a path on the
    // substrate's own disk; on Cloudflare Containers that disk is wiped on every
    // stop, so the computer's home would be discarded at the first sleep.
    const store = prod.vars.STORE_URI;
    expect(store, 'STORE_URI is required with a real substrate').toBeTruthy();
    expect(store, 'a substrate-local fs:// store is discarded on stop').not.toMatch(/^fs:\/\//);
    expect(store).toMatch(/^s3:\/\//);
    expect(prod.vars.CF_ACCOUNT_ID, 'CF_ACCOUNT_ID derives the R2 S3 endpoint').toMatch(/^[a-f0-9]{32}$/);

    // Temporary per-computer R2 credentials are a production isolation boundary,
    // not a convenience. Without these secrets the wake fails before a container
    // can boot with a bucket-wide or missing store credential.
    expect(prod.secrets?.required ?? []).toEqual(
      expect.arrayContaining(['R2_PARENT_ACCESS_KEY_ID', 'R2_PARENT_API_TOKEN']),
    );
  });

  it('never enables the bucket-wide static R2 fallback in hosted production', () => {
    expect(prod.vars.ALLOW_STATIC_R2_CREDENTIALS).toBeUndefined();
    expect(prod.vars.R2_ACCESS_KEY_ID).toBeUndefined();
    expect(prod.vars.R2_SECRET_ACCESS_KEY).toBeUndefined();
    expect(prod.secrets?.required ?? []).not.toContain('R2_ACCESS_KEY_ID');
    expect(prod.secrets?.required ?? []).not.toContain('R2_SECRET_ACCESS_KEY');
  });

  it('has an executable remote-secret preflight for every required production binding', () => {
    expect(secretPreflightRaw).toContain('wrangler secret list');
    expect(secretPreflightRaw).toContain('--env production');
    for (const name of prod.secrets?.required ?? []) {
      expect(secretPreflightRaw, `remote preflight must require ${name}`).toContain(`'${name}'`);
    }
    // Accidentally uploading the static pair is also a launch blocker, not just
    // an operator warning.
    expect(secretPreflightRaw).toContain("'R2_ACCESS_KEY_ID'");
    expect(secretPreflightRaw).toContain("'R2_SECRET_ACCESS_KEY'");
  });

  it('mirrors max_instances into CF_MAX_INSTANCES so the capacity error cannot lie', () => {
    const cap = prod.containers?.[0]?.max_instances;
    expect(cap).toBeTypeOf('number');
    expect(prod.vars.CF_MAX_INSTANCES).toBe(String(cap));
    // The default block is what the suites bind against; keep both honest.
    expect(config.vars.CF_MAX_INSTANCES).toBe(String(config.containers?.[0]?.max_instances));
  });

  it('keeps the two container blocks identical apart from the name wrangler cannot derive', () => {
    const top = config.containers?.[0];
    const bottom = prod.containers?.[0];
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    // `name` is required inside a named environment and absent at the top level
    // (wrangler derives it there); everything else is a copy, and a copy drifts.
    const { name, ...rest } = bottom as ContainerBlock;
    expect(name).toBeTruthy();
    expect(rest).toEqual(top);
  });
});

describe('production identity: origin, Relying Party, preview zone', () => {
  it('puts the app on app.mari.sh and the preview hosts one label under mari.sh', () => {
    expect(prod.vars.BASE_URL).toBe('https://app.mari.sh');
    // A `*.mari.sh` wildcard certificate covers ONE label, which is why the
    // preview host is `{port}--{computer}--{user}` (decisions.md).
    expect(prod.vars.PREVIEW_ZONE).toBe('mari.sh');
  });

  it('scopes the passkey Relying Party to the app host, not the preview zone', () => {
    // rpID must be a registrable-domain suffix of the ceremony origin's host. If
    // it were `mari.sh`, a `{port}--{computer}--{user}.mari.sh` preview host —
    // which serves whatever the user is running on their computer — would be able
    // to drive a WebAuthn ceremony for the account.
    expect(prod.vars.AUTH_RP_ID).toBe('app.mari.sh');
    expect(prod.vars.AUTH_RP_ID).not.toBe(prod.vars.PREVIEW_ZONE);
    const host = new URL(prod.vars.BASE_URL as string).hostname;
    expect(prod.vars.AUTH_RP_ID).toBe(host);
  });
});

describe('the platform contract the bundle depends on', () => {
  it('keeps the compatibility date past the container PID-namespace change', () => {
    // 2026-04-01 turns on `containers_pid_namespace`; before it, `ps` inside a
    // computer lists every process in the VM. The same date switches binary
    // WebSocket messages to Blob, which is why computer-do.ts pins
    // `binaryType = 'arraybuffer'` — see wrangler.jsonc's own note.
    expect(config.compatibility_date >= '2026-04-01').toBe(true);
    expect(config.compatibility_flags).toContain('nodejs_compat');
  });

  it('creates each Durable Object class exactly once, as SQLite-backed', () => {
    const created = (config.migrations ?? []).flatMap((m) => [
      ...(m.new_sqlite_classes ?? []),
      ...(m.new_classes ?? []),
    ]);
    // A class named twice, or moved between tags, is a data-loss event on an
    // existing deployment. Both classes must appear once, and as SQLite classes
    // (`ctx.storage.sql` and the container binding both require it).
    expect(created).toEqual(['ComputerDO', 'EventsDO']);
    expect((config.migrations ?? []).flatMap((m) => m.new_classes ?? [])).toEqual([]);
  });

  it('serves the web app from the Worker, worker-first', () => {
    // Without `run_worker_first` the asset router answers `/api/*`, `/attach`,
    // `/supervisor`, `/api/events` and every preview host with index.html.
    expect(config.assets?.run_worker_first).toBe(true);
    expect(config.assets?.directory).toBe('../web/dist');
    expect(config.assets?.binding).toBe('ASSETS');
  });

  it('persists unsampled production logs for launch diagnosis', () => {
    expect(prod.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true,
      },
    });
  });

  it('ships all three D1 migrations and the expected 13 SQL statements', () => {
    const statementCount = (sql: string): number => sql.match(/;\s*(?:\n|$)/g)?.length ?? 0;
    expect([
      statementCount(migration0001),
      statementCount(migration0002),
      statementCount(migration0003),
    ]).toEqual([10, 1, 2]);
  });
});

// REAL Cloudflare container e2e for the substrate driver.
//
//   MARI_CF_E2E=1 CLOUDFLARE_ACCOUNT_ID=… pnpm --filter @mari/control-plane test:substrates
//
// Ungated it collects nothing and exits 0. Gated, it:
//
//   1. assembles a build context whose Dockerfile is `deploy/Dockerfile.mari`
//      VERBATIM plus one appended line (busybox, so there is something for the
//      exposePort assertion to talk to) — so the PRODUCTION base image is what
//      gets exercised, not a lookalike;
//   2. deploys the scratch Worker in `deploy/cf-e2e/` (namespaced mari-cf-e2e,
//      no custom domain, no DNS record, no shared binding), whose Durable Object
//      drives the REAL driver over a REAL `ctx.container`;
//   3. materializes, execs, exposes a port and destroys, asserting bytes and exit
//      codes rather than "no exception was thrown";
//   4. deletes the Worker AND the container application in `afterAll`, then
//      verifies nothing named mari-cf-e2e* is left on the account. It never
//      touches any other container application.
//
// Requires: Docker (wrangler builds and pushes the image) and an authenticated
// wrangler (the same credentials `wrangler r2 bucket info` uses).
//
// Why a deployed scratch app and not `wrangler dev`: a container-enabled Durable
// Object only has a live `ctx.container` on the real platform, and local dev runs
// the image on the local Docker daemon — which would test Docker, not Cloudflare.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATED = process.env.MARI_CF_E2E === '1';
const SLOW = process.env.MARI_CF_E2E_SLOW === '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const PKG = resolve(HERE, '../..');
const APP_DIR = resolve(REPO, 'deploy/cf-e2e');
const CTX_DIR = resolve(APP_DIR, 'ctx');
const CONFIG = resolve(APP_DIR, 'wrangler.jsonc');
const WORKER_NAME = 'mari-cf-e2e';
/** wrangler derives `<worker>-<class lowercased>` for the container application
 *  (confirmed by a `--dry-run`, which names the image `mari-cf-e2e-e2edo`). */
const CONTAINER_APP = 'mari-cf-e2e-e2edo';

const TOKEN = `t${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const COMPUTER = 'e2e-cloudflare-1';
/** Byte pattern with a NUL and a high byte: the point is that bytes survive. */
const PAYLOAD = new Uint8Array([0x00, 0x01, 0xff, 0x41, 0x0a, 0x7f, 0x80, 0xfe, 0x00, 0x42]);
const PAYLOAD_B64 = Buffer.from(PAYLOAD).toString('base64');
const WWW_BODY = 'mari-e2e-port-body\n';

let baseUrl = '';

/**
 * Run wrangler FROM THE CONTROL-PLANE PACKAGE with the scratch app's config: the
 * pinned workspace wrangler is the one that understands this config (`constraints`,
 * container `instance_type`), while `npx` in a directory with no node_modules would
 * fetch whatever version it likes.
 */
function wrangler(args: string[], timeoutMs = 1_800_000): string {
  return runWrangler([...args, '-c', CONFIG], timeoutMs);
}

/**
 * Registry commands must NOT carry the scratch config: it references `ctx/Dockerfile`,
 * and by cleanup time that context has been removed — wrangler then rejects the
 * config before running the command. Run these against the control plane's own
 * config instead (which validates), since they name their target explicitly.
 */
function wranglerNoConfig(args: string[], timeoutMs = 300_000): string {
  return runWrangler(args, timeoutMs);
}

function runWrangler(args: string[], timeoutMs: number): string {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: PKG,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      // Non-interactive: a prompt here is a hang. wrangler answers its own
      // confirmations with "yes" in this mode, which is what cleanup needs.
      CI: '1',
    },
  });
}

/** The container application's row from `containers list`, or null when gone. */
function containerAppRow(): { id: string; state: string } | null {
  const list = (() => {
    try {
      return wrangler(['containers', 'list'], 120_000);
    } catch {
      return '';
    }
  })();
  for (const line of list.split('\n')) {
    if (!line.includes(CONTAINER_APP)) continue;
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(line);
    if (!id) continue;
    const cells = line
      .split('│')
      .map((c) => c.trim())
      .filter(Boolean);
    return { id: id[1] as string, state: cells[2] ?? '' };
  }
  return null;
}

function containerAppId(): string | null {
  return containerAppRow()?.id ?? null;
}

/** The production Dockerfile plus exactly one test-only layer. */
function assembleContext(): void {
  rmSync(CTX_DIR, { recursive: true, force: true });
  mkdirSync(CTX_DIR, { recursive: true });
  for (const entry of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) {
    cpSync(resolve(REPO, entry), resolve(CTX_DIR, entry));
  }
  cpSync(resolve(REPO, 'crates'), resolve(CTX_DIR, 'crates'), { recursive: true });
  const production = readFileSync(resolve(REPO, 'deploy/Dockerfile.mari'), 'utf8');
  writeFileSync(
    resolve(CTX_DIR, 'Dockerfile'),
    `${production}\n` +
      '# ---- e2e ONLY: an HTTP listener for the exposePort assertion ------------\n' +
      '# Appended by test/substrates/cloudflare.e2e.test.ts. Everything above is\n' +
      '# deploy/Dockerfile.mari verbatim.\n' +
      'RUN set -eux; apt-get update; apt-get install -y --no-install-recommends busybox; ' +
      'rm -rf /var/lib/apt/lists/*\n' +
      // A per-run label, and it is load-bearing rather than decorative: the image
      // digest would otherwise be identical run to run, and wrangler skips the push
      // when it believes the digest is already in the registry — which fails with
      // IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE once a previous run's cleanup deleted it.
      `LABEL mari.e2e.run=${TOKEN}\n`,
  );
}

async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // `id` picks the Durable Object; `computer` is the identity the driver stamps on
  // the instance. Both are the same computer here, and both are always sent so a
  // route cannot silently fall back to a default.
  const res = await fetch(
    `${baseUrl}${path}${path.includes('?') ? '&' : '?'}id=${COMPUTER}&computer=${COMPUTER}`,
    {
      method: init.method ?? 'GET',
      headers: {
        'x-e2e-token': TOKEN,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    },
  );
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON reply from ${path} (${res.status}): ${text.slice(0, 400)}`);
  }
  return { status: res.status, body };
}

/** Assert a 2xx and put the server's own error in the failure message. */
function ok(path: string, res: { status: number; body: Record<string, unknown> }): Record<string, unknown> {
  if (res.status !== 200) {
    throw new Error(`${path} returned ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function exec(
  argv: string[],
  extra: { cwd?: string; env?: Record<string, string>; inputB64?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { status, body } = await call('/exec', { method: 'POST', body: { argv, ...extra } });
  if (status !== 200) throw new Error(`exec ${argv.join(' ')} failed: ${JSON.stringify(body)}`);
  return body as { exitCode: number; stdout: string; stderr: string };
}

describe.skipIf(!GATED)('Cloudflare containers, for real (MARI_CF_E2E=1)', () => {
  beforeAll(async () => {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID must be set for the Cloudflare e2e');
    }
    assembleContext();
    const out = wrangler(['deploy', '--var', `E2E_TOKEN:${TOKEN}`]);
    const match = /https:\/\/[a-z0-9.-]*workers\.dev/i.exec(out);
    if (!match) throw new Error(`could not find the deployed URL in wrangler output:\n${out}`);
    baseUrl = match[0];

    // The Worker is live before the container is; wait for the route only.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const res = await fetch(`${baseUrl}/healthz`).catch(() => null);
      if (res && res.ok) break;
      if (Date.now() > deadline) throw new Error(`${baseUrl} never became reachable`);
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // A FRESH container application is not immediately schedulable: the deploy
    // pushes the image and the application rolls out, and until it reports `ready`
    // every `start()` is refused with the same "no container instance" message
    // that an over-capacity account produces. Measured here: a first materialize
    // 90 s after the deploy still failed. Wait for the platform's own signal.
    const readyBy = Date.now() + 900_000;
    for (;;) {
      const row = containerAppRow();
      if (row && row.state === 'ready') break;
      if (Date.now() > readyBy) {
        throw new Error(`container application ${CONTAINER_APP} never became ready: ${JSON.stringify(row)}`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }, 2_400_000);

  afterAll(async () => {
    // Destroy the instance first (labelled `mari.computer=<id>` by the driver, which
    // is how it is attributable in Cloudflare's logs — the platform exposes no label
    // query, so cleanup is by NAME: this app and nothing else).
    if (baseUrl) await call('/destroy', { method: 'POST' }).catch(() => undefined);
    try {
      wrangler(['delete', '--name', WORKER_NAME, '--force'], 300_000);
    } catch {
      // Fall through to the container-application cleanup and the verification.
    }
    // Delete the container application BY ID, looked up from its name, so this can
    // only ever remove `mari-cf-e2e-e2edo` and never an unrelated application on
    // this account.
    const appId = containerAppId();
    if (appId) {
      try {
        wrangler(['containers', 'delete', appId], 300_000);
      } catch {
        // Deleting the Worker usually takes the application with it.
      }
    }
    // The pushed IMAGE is a separate resource from the application, and it is NOT
    // removed with it: account image storage is capped at 50 GB, so a suite that
    // leaves images behind is a slow leak. Delete every tag of ours by name.
    const images = (() => {
      try {
        return wranglerNoConfig(['containers', 'images', 'list']);
      } catch {
        return '';
      }
    })();
    for (const line of images.split('\n')) {
      if (!line.startsWith(CONTAINER_APP)) continue;
      const tag = line.trim().split(/\s+/)[1];
      if (!tag) continue;
      try {
        wranglerNoConfig(['containers', 'images', 'delete', `${CONTAINER_APP}:${tag}`]);
      } catch {
        // Reported by the verification below.
      }
    }

    // And the locally built image, so a workstation does not accumulate one per run.
    try {
      const ids = execFileSync('docker', ['images', '-q', CONTAINER_APP], { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (ids.length > 0) {
        execFileSync('docker', ['image', 'rm', '-f', ...ids], { stdio: 'ignore' });
      }
    } catch {
      // Docker may not be reachable at teardown; the remote side is what matters.
    }

    // Nothing of ours is left behind: no application, and no image.
    expect(containerAppId()).toBeNull();
    const remaining = (() => {
      try {
        return wranglerNoConfig(['containers', 'images', 'list']);
      } catch {
        return '';
      }
    })();
    expect(remaining).not.toContain(CONTAINER_APP);
    rmSync(CTX_DIR, { recursive: true, force: true });
    if (existsSync(resolve(APP_DIR, '.wrangler'))) {
      rmSync(resolve(APP_DIR, '.wrangler'), { recursive: true, force: true });
    }
  }, 900_000);

  it('materializes a real container that is exec-ready, with marid’s env in PID 1', async () => {
    const body = ok('/materialize', await call('/materialize?epoch=41', { method: 'POST' }));
    expect(body.handle).toMatchObject({
      substrate: 'cloudflare',
      computer: COMPUTER,
      id: COMPUTER,
      epoch: 41,
      ports: [8080],
    });
    // The handle survived a round trip through Durable Object storage, which is
    // provider.ts's requirement for a handle.
    const state = await call('/state');
    expect(state.body.hasBinding).toBe(true);
    expect(state.body.running).toBe(true);

    // start()'s env really reached the container's process 1 — read from the
    // kernel, not from a shell the driver happened to spawn.
    const env = await exec([
      '/bin/sh',
      '-c',
      "tr '\\0' '\\n' < /proc/1/environ | grep '^MARI_' | sort",
    ]);
    expect(env.exitCode).toBe(0);
    expect(env.stdout.split('\n').filter(Boolean)).toEqual([
      // From the base image's own ENV (deploy/Dockerfile.mari) — the start() env
      // is merged with it rather than replacing it.
      'MARI_AGENTS_DIR=/etc/mari/agents.d',
      // Everything below came from `materialize`.
      `MARI_COMPUTER_ID=${COMPUTER}`,
      'MARI_CONTROL_URL=wss://example.invalid/supervisor/e2e-cloudflare-1',
      'MARI_EPOCH=41',
      `MARI_RESTORE_MANIFEST=${'e'.repeat(64)}`,
      'MARI_ROOT=/work',
      'MARI_STORE=https://example.invalid/store',
      'MARI_TOKEN=token-41-abcdef',
    ]);
  }, 600_000);

  it('runs the production marid binary and honours MARI_ROOT', async () => {
    const help = await exec(['/usr/local/bin/marid', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout + help.stderr).toMatch(/marid|USAGE|Usage/);

    const root = await exec(['/bin/sh', '-c', 'printf %s "$PWD"'], { cwd: '/work' });
    expect(root.stdout).toBe('/work');
  }, 300_000);

  it('exec is byte-exact in both directions and never shell-interpreted', async () => {
    // stdin -> file -> stdout, compared as base64 so a NUL and a 0xff byte are
    // part of the assertion rather than lost in a UTF-8 round trip.
    const write = await exec(['/bin/sh', '-c', 'base64 -d > /work/probe.bin'], {
      inputB64: Buffer.from(PAYLOAD_B64).toString('base64'),
    });
    expect(write.exitCode).toBe(0);
    const read = await exec(['base64', '-w0', '/work/probe.bin']);
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe(PAYLOAD_B64);

    // argv is NOT shell-interpreted: the redirect survives as one argument and no
    // file called `b` is created.
    const echoed = await exec(['/bin/echo', 'a > b']);
    expect(echoed.stdout).toBe('a > b\n');
    const listed = await exec(['/bin/sh', '-c', 'ls /work']);
    expect(listed.stdout.split('\n').filter(Boolean).sort()).toEqual(['probe.bin']);

    // Exit codes and stderr are real.
    const failed = await exec(['/bin/sh', '-c', 'echo oops >&2; exit 7']);
    expect(failed.exitCode).toBe(7);
    expect(failed.stderr).toBe('oops\n');

    // ExecOptions.env reaches the process.
    const withEnv = await exec(['/bin/sh', '-c', 'printf %s "$MARI_E2E_EXTRA"'], {
      env: { MARI_E2E_EXTRA: 'extra-value' },
    });
    expect(withEnv.stdout).toBe('extra-value');
  }, 600_000);

  it('serves a port through the Worker-fronted path, byte for byte', async () => {
    const serve = await exec([
      '/bin/sh',
      '-c',
      `mkdir -p /work/www && printf %s '${WWW_BODY}' > /work/www/hello.txt && ` +
        'busybox httpd -p 8080 -h /work/www && sleep 1 && echo started',
    ]);
    expect(serve.exitCode).toBe(0);

    const body = ok('/expose', await call('/expose?port=8080&path=/hello.txt'));
    expect(body.address).toBe('http://127.0.0.1:8080');
    expect(body.status).toBe(200);
    expect(Buffer.from(String(body.bodyB64), 'base64').toString('utf8')).toBe(WWW_BODY);
  }, 600_000);

  it('holdAwake is accepted by the real platform', async () => {
    const body = ok('/hold', await call('/hold', { method: 'POST' }));
    expect(body.ok).toBe(true);
  }, 300_000);

  it('sleep destroys, and a stopped instance refuses exec instead of lying', async () => {
    ok('/sleep', await call('/sleep', { method: 'POST' }));

    const { status, body } = await call('/exec', {
      method: 'POST',
      body: { argv: ['/bin/true'] },
    });
    expect(status).toBe(500);
    // Either the driver's own refusal (`running` already false) or the platform's
    // "no container instance" — measured: `running` can report a stale true for
    // minutes after destroy, and the driver classifies that as capacity. What must
    // NOT happen is a silent success against a fresh, empty disk.
    expect(['not_running', 'capacity']).toContain(body.kind);
  }, 600_000);

  it.skipIf(!SLOW)('a wake after sleep comes back with a FRESH disk (WARM cannot exist here)', async () => {
    // This is the assertion the whole WARM-unsupported decision rests on. It is
    // slow because destroy() → start() on the same Durable Object is refused for
    // minutes (measured >563 s), so it is gated behind MARI_CF_E2E_SLOW=1.
    const deadline = Date.now() + 900_000;
    for (;;) {
      const attempt = await call('/materialize?epoch=42', { method: 'POST' });
      if (attempt.status === 200) break;
      if (Date.now() > deadline) {
        throw new Error(`could not re-materialize within the budget: ${JSON.stringify(attempt.body)}`);
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    const listed = await exec(['/bin/sh', '-c', 'ls -a /work']);
    expect(listed.stdout.split('\n').filter((l) => l && l !== '.' && l !== '..')).toEqual([]);
  }, 1_200_000);
});

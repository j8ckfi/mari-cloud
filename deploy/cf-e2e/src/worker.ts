/**
 * SCRATCH app for the Cloudflare substrate e2e (`MARI_CF_E2E=1`).
 *
 * It exists so the REAL driver — imported by path from
 * `packages/control-plane/src/substrates/cloudflare.ts`, not reimplemented — can
 * drive a REAL Cloudflare container: this is the only way to get a live
 * `ctx.container` on a container-enabled Durable Object.
 *
 * It is named `mari-cf-e2e-*`, shares no binding with app.mari.sh, has no custom
 * domain or DNS record, and the test deletes it in `afterAll`.
 *
 * Every route requires `x-e2e-token` to match the E2E_TOKEN var (a random value
 * minted per deploy): `/exec` runs an arbitrary argv inside the container, so an
 * unauthenticated caller would have remote code execution on it.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  createCloudflareProvider,
  CloudflareSubstrateError,
  type CloudflareHandle,
} from '../../../packages/control-plane/src/substrates/cloudflare';

interface Env {
  E2E: DurableObjectNamespace<E2eDO>;
  E2E_TOKEN: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function tokenOk(given: string | null, want: string): boolean {
  if (!given || !want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class E2eDO extends DurableObject<Env> {
  /** One driver per request, exactly as ComputerDO constructs it. */
  #provider() {
    return createCloudflareProvider({
      container: this.ctx.container,
      maxInstances: 5,
      startTimeoutMs: 90_000,
      execTimeoutMs: 60_000,
      waitUntil: (p) => this.ctx.waitUntil(p.then(() => undefined)),
      onContainerExit: (info) => console.log(`container exit: ${JSON.stringify(info)}`),
    });
  }

  /** The handle is persisted, which is provider.ts's requirement: a driver
   *  instance does not outlive a request, so the handle must round-trip through
   *  DO storage unchanged. */
  async #handle(): Promise<CloudflareHandle> {
    const stored = await this.ctx.storage.get<CloudflareHandle>('handle');
    if (!stored) throw new Error('no handle: call /materialize first');
    return stored;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!tokenOk(request.headers.get('x-e2e-token'), this.env.E2E_TOKEN)) {
      return json({ error: 'forbidden' }, 403);
    }
    const provider = this.#provider();
    try {
      switch (url.pathname) {
        case '/state': {
          const stored = await this.ctx.storage.get<CloudflareHandle>('handle');
          return json({
            running: this.ctx.container?.running ?? null,
            hasBinding: this.ctx.container !== undefined,
            handle: stored ? { ...stored, env: Object.keys(stored.env).sort() } : null,
          });
        }

        case '/materialize': {
          const computer = url.searchParams.get('computer') ?? 'e2e-computer';
          const epoch = Number(url.searchParams.get('epoch') ?? '1');
          const t0 = Date.now();
          const handle = await provider.materialize({
            computer,
            image: 'declared-in-wrangler',
            env: {
              MARI_COMPUTER_ID: computer,
              MARI_EPOCH: String(epoch),
              MARI_TOKEN: `token-${epoch}-abcdef`,
              MARI_ROOT: '/work',
              MARI_STORE: 'https://example.invalid/store',
              MARI_CONTROL_URL: `wss://example.invalid/supervisor/${computer}`,
              MARI_RESTORE_MANIFEST: 'e'.repeat(64),
            },
            // marid is the image's ENTRYPOINT; it cannot connect to
            // `example.invalid`, so the e2e runs a bespoke idle process instead —
            // which is exactly what MaterializeSpec.cmd exists for.
            cmd: ['/bin/sh', '-c', 'sleep 3600'],
            ports: [8080],
          });
          await this.ctx.storage.put('handle', handle);
          return json({ materializeMs: Date.now() - t0, handle: { ...handle, env: undefined } });
        }

        case '/exec': {
          const body = (await request.json()) as {
            argv: string[];
            cwd?: string;
            env?: Record<string, string>;
            inputB64?: string;
          };
          const t0 = Date.now();
          const result = await provider.exec(await this.#handle(), body.argv, {
            ...(body.cwd ? { cwd: body.cwd } : {}),
            ...(body.env ? { env: body.env } : {}),
            ...(body.inputB64 ? { input: b64ToBytes(body.inputB64) } : {}),
          });
          return json({
            ...result,
            stdoutB64: bytesToB64(new TextEncoder().encode(result.stdout)),
            execMs: Date.now() - t0,
          });
        }

        case '/expose': {
          const port = Number(url.searchParams.get('port') ?? '8080');
          const handle = await this.#handle();
          const address = await provider.exposePort(handle, port);
          const path = url.searchParams.get('path') ?? '/';
          const forwarded = new Request(`http://container.invalid${path}`, {
            headers: { 'x-mari-epoch': String(handle.epoch ?? 0) },
          });
          const res = await provider.proxyFetch(handle, port, forwarded);
          return json({
            address,
            status: res.status,
            bodyB64: bytesToB64(new Uint8Array(await res.arrayBuffer())),
          });
        }

        case '/hold': {
          await provider.holdAwake(await this.#handle());
          return json({ ok: true });
        }

        case '/sleep': {
          // WARM is unsupported: this must destroy.
          await provider.sleep(await this.#handle());
          return json({ ok: true, running: this.ctx.container?.running ?? null });
        }

        case '/destroy': {
          const stored = await this.ctx.storage.get<CloudflareHandle>('handle');
          if (stored) await provider.destroy(stored);
          await this.ctx.storage.delete('handle');
          return json({ ok: true, running: this.ctx.container?.running ?? null });
        }

        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (err) {
      const kind = err instanceof CloudflareSubstrateError ? err.kind : null;
      return json({ error: err instanceof Error ? err.message : String(err), kind }, 500);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok');
    const id = url.searchParams.get('id') ?? 'e2e-1';
    return env.E2E.get(env.E2E.idFromName(id)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

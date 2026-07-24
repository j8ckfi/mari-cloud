// Wake proxy (spec 8.3/8.5): a preview host routes to the computer's DO, which
// ensures AWAKE via the substrate driver and proxies the request to the exposed
// port. A fake `upstreamFetch` stands in for the exposed server.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { ensureSchema, computerStub } from './helpers';
import type { ComputerDO } from '../src/computer-do';

describe('wake proxy', () => {
  beforeAll(ensureSchema);

  it('parses the preview host, wakes, and reaches the exposed port', async () => {
    const id = 'proxycomp';
    const user = 'alice';
    const port = 8080;
    const stub = computerStub(id);

    // Inject a fake exposed server into the DO (default upstreamFetch = global
    // fetch; overridden here so the proxied request reaches a controllable peer).
    await runInDurableObject(stub, (instance: ComputerDO) => {
      instance.upstreamFetch = async (url: string) =>
        new Response('ok:' + new URL(url).pathname, {
          status: 200,
          headers: { 'x-target': url },
        });
    });

    const res = await SELF.fetch(`http://${port}--${id}--${user}.mari.sh/app/index.html?q=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok:/app/index.html');

    // The request reached the exposed PORT at the substrate-provided address.
    const target = res.headers.get('x-target') ?? '';
    expect(target).toContain(`:${port}/app/index.html`);
    expect(target).toContain('?q=1');

    // The DO woke the computer: materialize + exposePort were driven.
    const ops = await runInDurableObject(stub, (instance: ComputerDO) =>
      (instance.substrate as { calls: { op: string }[] }).calls.map((c) => c.op),
    );
    expect(ops).toContain('materialize');
    expect(ops).toContain('exposePort');
    expect(await stub.getState()).toBe('awake');
  });

  it('does not proxy a non-preview host (falls through to the REST app)', async () => {
    // A plain API host is not a preview host: the app handles it, and an
    // unauthenticated /api/* request is rejected (proving no proxy happened).
    const res = await SELF.fetch('http://api.example.com/api/computers');
    expect(res.status).toBe(401);
  });
});

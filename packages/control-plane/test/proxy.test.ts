// Wake proxy (spec 8.3/8.5 + spec 10): a preview host routes to the computer's
// DO, which ensures AWAKE via the substrate driver and proxies the request to the
// exposed port. A fake `upstreamFetch` stands in for the exposed server.
//
// THIS SUITE USED TO ENCODE A HOLE AS CORRECT BEHAVIOUR. It asserted `200` for an
// unauthenticated GET of `{port}--{computer}--{user}.mari.sh` and never tried a
// foreign user, so two defects passed CI:
//
//   * cross-tenant read — anyone who knew a computer id reached any port it had
//     published, on a hosted instance, with no cookie at all;
//   * denial of wallet — the same anonymous request on a COLD computer called
//     `ComputerDO.wake()` and MATERIALIZED substrate resources, repeatedly, for a
//     computer belonging to someone else. Spec 10.3's CPU-hour/egress limits are
//     the stated defence and do not exist.
//
// The `user` label was parsed and thrown away, so it authorized nothing either.
//
// What is asserted now: the label must belong to the computer's OWNER, and the
// request must carry either a scoped capability (`preview.ts`) or an owning
// session. Every refusal happens BEFORE the Durable Object is addressed, which is
// what makes the denial-of-wallet claim testable: no substrate call, no wake.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { HOST, apiGet, computerStub, createComputer, ensureSchema, seedSession, substrateOps } from './helpers';
import type { ComputerDO } from '../src/computer-do';
import { PREVIEW_COOKIE, PREVIEW_TOKEN_PARAM } from '../src/preview';

interface PreviewInfo {
  computer: string;
  port: number;
  host: string;
  url: string;
  stableUrl: string;
  expiresAt: number;
}

/** Point the DO's upstream at a controllable peer instead of the real network. */
async function fakeUpstream(id: string): Promise<void> {
  await runInDurableObject(computerStub(id), (instance: ComputerDO) => {
    instance.upstreamFetch = async (url: string, init: RequestInit) =>
      new Response('ok:' + new URL(url).pathname, {
        status: 200,
        headers: {
          'x-target': url,
          // Echo what the guest would have received, so the test can assert what
          // Mari does NOT forward.
          'x-guest-cookie': (new Headers(init.headers).get('cookie') ?? '<none>'),
        },
      });
  });
}

let cookie = '';
beforeAll(async () => {
  await ensureSchema();
  cookie = (await seedSession()).cookie;
});

describe('wake proxy', () => {
  it('mints a stable URL, then serves the port through it', async () => {
    const id = await createComputer(cookie, 'previewable');
    await fakeUpstream(id);

    const info = await apiGet<PreviewInfo>(`/api/computers/${id}/preview?port=8080`, cookie);
    expect(info.status).toBe(200);
    expect(info.body.port).toBe(8080);
    // The host is the ONE label decisions.md locks: no dots inside it.
    expect(info.body.host).toMatch(/^8080--[0-9a-f]+--[0-9a-f]{12}\.mari\.sh$/);
    expect(info.body.stableUrl).not.toContain(PREVIEW_TOKEN_PARAM);
    expect(info.body.url).toContain(`${PREVIEW_TOKEN_PARAM}=`);
    expect(info.body.expiresAt).toBeGreaterThan(Date.now());

    const host = info.body.host;
    const token = new URL(info.body.url).searchParams.get(PREVIEW_TOKEN_PARAM) as string;

    // The capability arrives in the URL once; the proxy turns it into a
    // host-scoped cookie and redirects it out of the address bar.
    const first = await SELF.fetch(
      `http://${host}/app/index.html?q=1&${PREVIEW_TOKEN_PARAM}=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
    );
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/app/index.html?q=1');
    const setCookie = first.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${PREVIEW_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');

    const res = await SELF.fetch(`http://${host}/app/index.html?q=1`, {
      headers: {
        // The guest app's OWN cookie must survive; Mari's must not (below).
        Cookie:
          `${PREVIEW_COOKIE}=${encodeURIComponent(token)}; ` +
          `__Secure-better-auth.session_token=forged; guest_pref=dark`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok:/app/index.html');

    // The request reached the exposed PORT at the substrate-provided address.
    const target = res.headers.get('x-target') ?? '';
    expect(target).toContain(`:8080/app/index.html`);
    expect(target).toContain('?q=1');
    // Mari's own credentials did NOT reach whatever the user is running — not the
    // capability and not the session cookie, whatever prefix it carries — while
    // the guest's own cookie is untouched.
    expect(res.headers.get('x-guest-cookie')).toBe('guest_pref=dark');

    // The DO woke the computer: materialize + exposePort were driven.
    const ops = await substrateOps(computerStub(id));
    expect(ops).toContain('materialize');
    expect(ops).toContain('exposePort');
    expect(await computerStub(id).getState()).toBe('awake');
  });

  it('an owning session authorizes without a capability', async () => {
    const id = await createComputer(cookie, 'session-preview');
    await fakeUpstream(id);
    const info = await apiGet<PreviewInfo>(`/api/computers/${id}/preview?port=3000`, cookie);
    const res = await SELF.fetch(`http://${info.body.host}/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it('refuses an unauthenticated request AND wakes nothing (denial of wallet)', async () => {
    const id = await createComputer(cookie, 'not-yours');
    const info = await apiGet<PreviewInfo>(`/api/computers/${id}/preview?port=8080`, cookie);
    const before = await substrateOps(computerStub(id));
    expect(await computerStub(id).getState()).toBe('cold');

    // The exact request the old suite asserted 200 for.
    const res = await SELF.fetch(`http://${info.body.host}/`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-mari-preview')).toBe('preview_unauthorized');

    // Repeat it: an anonymous caller must not be able to spend a stranger's
    // substrate budget by retrying.
    for (let i = 0; i < 3; i++) {
      expect((await SELF.fetch(`http://${info.body.host}/x/${i}`)).status).toBe(401);
    }
    expect(await substrateOps(computerStub(id))).toEqual(before);
    expect(await computerStub(id).getState()).toBe('cold');
  });

  it('refuses a foreign user’s session and a wrong user label', async () => {
    const id = await createComputer(cookie, 'tenant-a');
    const info = await apiGet<PreviewInfo>(`/api/computers/${id}/preview?port=8080`, cookie);
    const before = await substrateOps(computerStub(id));

    // A second real identity (DEV_AUTH=1 enables email/password in test builds).
    const signup = await SELF.fetch(`${HOST}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'proxy-intruder@mari.test',
        password: 'intruder-password-123',
        name: 'Intruder',
      }),
    });
    expect(signup.status).toBe(200);
    const intruder = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const foreign = await SELF.fetch(`http://${info.body.host}/`, { headers: { Cookie: intruder } });
    expect(foreign.status).toBe(401);

    // The label is part of the address, so a label that is not the owner's is not
    // this computer's preview host at all — and says nothing about whether the
    // computer exists.
    const wrongLabel = info.body.host.replace(/--[0-9a-f]{12}\./, '--deadbeefcafe.');
    const mislabelled = await SELF.fetch(`http://${wrongLabel}/`, { headers: { Cookie: cookie } });
    expect(mislabelled.status).toBe(404);
    expect(mislabelled.headers.get('x-mari-preview')).toBe('no_such_preview');

    expect(await substrateOps(computerStub(id))).toEqual(before);
    expect(await computerStub(id).getState()).toBe('cold');
  });

  it('a capability is scoped to one port and one computer', async () => {
    const a = await createComputer(cookie, 'scoped-a');
    const b = await createComputer(cookie, 'scoped-b');
    const infoA = await apiGet<PreviewInfo>(`/api/computers/${a}/preview?port=3000`, cookie);
    const infoB = await apiGet<PreviewInfo>(`/api/computers/${b}/preview?port=3000`, cookie);
    const tokenA = new URL(infoA.body.url).searchParams.get(PREVIEW_TOKEN_PARAM) as string;

    // Same computer, different port.
    const otherPort = infoA.body.host.replace(/^3000--/, '9999--');
    const wrongPort = await SELF.fetch(`http://${otherPort}/`, {
      headers: { Cookie: `${PREVIEW_COOKIE}=${encodeURIComponent(tokenA)}` },
    });
    expect(wrongPort.status).toBe(401);

    // Same port, different computer.
    const wrongComputer = await SELF.fetch(`http://${infoB.body.host}/`, {
      headers: { Cookie: `${PREVIEW_COOKIE}=${encodeURIComponent(tokenA)}` },
    });
    expect(wrongComputer.status).toBe(401);

    // A tampered signature.
    const tampered = tokenA.slice(0, -1) + (tokenA.endsWith('0') ? '1' : '0');
    const bad = await SELF.fetch(`http://${infoA.body.host}/`, {
      headers: { Cookie: `${PREVIEW_COOKIE}=${encodeURIComponent(tampered)}` },
    });
    expect(bad.status).toBe(401);

    expect(await computerStub(a).getState()).toBe('cold');
    expect(await computerStub(b).getState()).toBe('cold');
  });

  it('refuses a preview host for a computer that does not exist', async () => {
    const res = await SELF.fetch('http://3000--nosuchcomputer--abcdef012345.mari.sh/');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-mari-preview')).toBe('no_such_preview');
  });

  it('rejects a bad port on the minting route', async () => {
    const id = await createComputer(cookie, 'badport');
    for (const port of ['0', '70000', 'abc', '']) {
      const res = await apiGet<{ error: string }>(
        `/api/computers/${id}/preview?port=${port}`,
        cookie,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_port');
    }
  });

  it('does not proxy a non-preview host (falls through to the REST app)', async () => {
    // A plain API host is not a preview host: the app handles it, and an
    // unauthenticated /api/* request is rejected (proving no proxy happened).
    const res = await SELF.fetch('http://api.example.com/api/computers');
    expect(res.status).toBe(401);
  });
});

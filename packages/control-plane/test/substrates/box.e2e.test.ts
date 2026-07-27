// REAL Box API e2e for the substrate driver.
//
//   BOX_API_KEY=box_… MARI_BOX_E2E_ALLOW_RETAINED=1 \
//     pnpm --filter @mari/control-plane test:substrates -- substrates/box
//
// DOUBLE GATE: Box exposes no delete API and retains the latest archived
// snapshot for the life of the box. The suite therefore runs only with BOTH an
// API key and explicit acknowledgement of that retained test artifact. It
// always archives before exit (stopping compute billing), but cannot erase the
// snapshot. Ungated it skips and prints why.
//
//   1. materialize — create a box, poll to ready, run the bootstrap with a test
//      `cmd` (a systemd-managed sleeper that writes a boot marker: no public
//      marid binary exists yet, and this proves the long-running primitive);
//   2. exec — argv quoting, stdin bytes, per-exec env, cwd, exit codes;
//   3. sleep (stop/archive) → wake (resume + bootstrap re-run) — asserting the
//      DISK SURVIVED the archive (the file from step 1 is still there, plus the
//      re-run bootstrap's second line: WARM really is "resources retained");
//   4. exposePort — start an HTTP server on 0.0.0.0, `host` it, fetch the
//      public URL;
//   5. cleanup — archive and assert destroy fails closed instead of claiming
//      the retained snapshot was deleted.
//
// It measures and logs create→ready, exec round-trip, and resume→ready
// latencies; those numbers feed the SUBSTRATE_PROFILES row in index.ts.

import { describe, it, expect, afterAll } from 'vitest';
import { BoxProvider, BOX_SUBSTRATE } from '../../src/substrates/box.js';
import type { BoxHandle } from '../../src/substrates/box.js';

const BOX_API_KEY = process.env.BOX_API_KEY;
const ALLOW_RETAINED = process.env.MARI_BOX_E2E_ALLOW_RETAINED === '1';
if (!BOX_API_KEY || !ALLOW_RETAINED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[substrates/box] real e2e skipped — requires BOX_API_KEY and ' +
      'MARI_BOX_E2E_ALLOW_RETAINED=1 (Box cannot delete the retained snapshot)',
  );
}

const BOOT_LOG = '/tmp/mari-box-e2e-boot.log';

describe.skipIf(!BOX_API_KEY || !ALLOW_RETAINED)('BoxProvider (real API)', () => {
  const provider = BOX_API_KEY
    ? new BoxProvider({ apiKey: BOX_API_KEY, allowRetainedBoxesForTesting: true })
    : null;
  let handle: BoxHandle | null = null;
  const timings: Record<string, number> = {};

  afterAll(async () => {
    if (handle) await provider?.destroy(handle).catch(() => undefined);
    // eslint-disable-next-line no-console
    console.info('[substrates/box] measured latencies (ms):', JSON.stringify(timings));
  }, 300_000);

  it('materialize: create → ready → systemd bootstrap survived', async () => {
    const t0 = Date.now();
    expect(provider).not.toBeNull();
    handle = await provider!.materialize({
      computer: `mari-box-e2e-${Date.now()}`,
      image: 'mari/base:v0', // recorded only; Box has one fixed image
      env: { MARI_E2E_MARKER: 'marker-1' },
      // Append once per service start, then stay alive so the bootstrap's
      // stable-MainPID readiness proof is meaningful.
      cmd: [
        '/bin/sh',
        '-c',
        `echo boot:$MARI_E2E_MARKER >> ${BOOT_LOG}; exec sleep infinity`,
      ],
    });
    timings.createToReadyAndBootstrapped = Date.now() - t0;

    expect(handle.substrate).toBe(BOX_SUBSTRATE);
    expect(handle.id).toMatch(/^bx_/);

    // systemd kept the process alive after the command request returned.
    await new Promise((r) => setTimeout(r, 2_000));
    const log = await provider!.exec(handle, ['cat', BOOT_LOG]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('boot:marker-1');
  }, 300_000);

  it('exec: argv quoting, stdin bytes, env, cwd, exit codes', async () => {
    expect(handle).not.toBeNull();
    expect(provider).not.toBeNull();
    const h = handle as BoxHandle;

    const t0 = Date.now();
    const echo = await provider!.exec(h, ['echo', 'hello box', "it's quoted"]);
    timings.execRoundTrip = Date.now() - t0;
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout).toContain("hello box it's quoted");

    // stdin: bytes with a NUL and a high byte must survive the base64 pipe.
    const stdin = await provider!.exec(h, ['wc', '-c'], {
      input: new Uint8Array([0x00, 0x01, 0xff, 0x41]),
    });
    expect(stdin.exitCode).toBe(0);
    expect(stdin.stdout.trim()).toBe('4');

    const env = await provider!.exec(h, ['/bin/sh', '-c', 'echo $MARI_E2E_X'], {
      env: { MARI_E2E_X: 'per-exec' },
    });
    expect(env.stdout).toContain('per-exec');

    const cwd = await provider!.exec(h, ['pwd'], { cwd: '/tmp' });
    expect(cwd.stdout.trim()).toBe('/tmp');

    const fail = await provider!.exec(h, ['/bin/sh', '-c', 'exit 7']);
    expect(fail.exitCode).toBe(7);
  }, 120_000);

  it('sleep → wake: archive keeps the disk, resume re-runs the bootstrap', async () => {
    expect(handle).not.toBeNull();
    const h = handle as BoxHandle;

    // A file written by hand before the archive — the WARM cache assertion.
    await provider!.exec(h, ['/bin/sh', '-c', 'echo survived > /tmp/mari-box-e2e-warm']);

    let t0 = Date.now();
    await provider!.sleep(h);
    timings.stopToArchived = Date.now() - t0;

    // Archived is `alive` (disk retained), and exec must refuse, not hang.
    expect(await provider!.instanceStatus(h)).toBe('alive');
    await expect(provider!.exec(h, ['true'])).rejects.toMatchObject({ kind: 'not_running' });

    t0 = Date.now();
    await provider!.wake(h);
    timings.resumeToReadyAndBootstrapped = Date.now() - t0;

    const warm = await provider!.exec(h, ['cat', '/tmp/mari-box-e2e-warm']);
    expect(warm.exitCode).toBe(0);
    expect(warm.stdout).toContain('survived');

    // Bootstrap ran twice: once at materialize, once at wake (reboot semantics).
    await new Promise((r) => setTimeout(r, 2_000));
    const log = await provider!.exec(h, ['cat', BOOT_LOG]);
    expect(log.stdout.split('\n').filter((l) => l.startsWith('boot:'))).toHaveLength(2);
  }, 600_000);

  it('exposePort: host a 0.0.0.0 listener and fetch the public URL', async () => {
    expect(handle).not.toBeNull();
    const h = handle as BoxHandle;

    const start = await provider!.exec(h, [
      '/bin/sh',
      '-c',
      'mkdir -p /tmp/mari-www && echo mari-box-e2e-body > /tmp/mari-www/index.html && ' +
        'setsid nohup python3 -m http.server 8080 --bind 0.0.0.0 --directory /tmp/mari-www ' +
        '>/tmp/mari-www.log 2>&1 </dev/null & sleep 1; echo started',
    ]);
    expect(start.exitCode).toBe(0);

    const url = await provider!.exposePort(h, 8080);
    expect(url).toMatch(/^https:\/\/.+on\.ascii\.dev/);

    // The route may take a beat to register; bounded retry, then assert bytes.
    let body = '';
    for (let attempt = 0; attempt < 10 && !body.includes('mari-box-e2e-body'); attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000));
      const res = await fetch(url).catch(() => null);
      if (res?.ok) body = await res.text();
    }
    expect(body).toContain('mari-box-e2e-body');
  }, 180_000);

  it('destroy archives compute but fails closed on permanent snapshot retention', async () => {
    expect(handle).not.toBeNull();
    const h = handle as BoxHandle;
    await expect(provider!.destroy(h)).rejects.toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('not destroyed'),
    });
    handle = null;
  }, 300_000);
});

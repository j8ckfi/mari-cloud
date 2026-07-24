// Docker substrate driver tests against the REAL local daemon.
//
// GATE: skips (with a visible message) when /var/run/docker.sock is absent.
// When present, these drive a real Docker daemon: they pull/create/start real
// containers, exec real processes, publish a real reachable port, pause/unpause,
// and force-remove. afterAll sweeps every container this file created, by label,
// even on failure.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import {
  createDockerProvider,
  findDockerSocket,
  DockerProvider,
  DOCKER_SUBSTRATE,
  COMPUTER_LABEL,
} from '../../src/substrates/docker.js';
import type { DockerHandle } from '../../src/substrates/docker.js';

// The daemon socket may live at /var/run/docker.sock or a runtime-specific path
// (Colima, Docker Desktop, Rancher). findDockerSocket() resolves it the same way
// the driver does; if none exists we skip cleanly.
const DOCKER_SOCKET = findDockerSocket();
const dockerAvailable = DOCKER_SOCKET != null;

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    '[substrates/docker] no Docker daemon socket found (checked DOCKER_HOST and ' +
      '/var/run, ~/.docker, ~/.colima, ~/.rd) — skipping Docker driver tests',
  );
}

// An in-container HTTP listener: busybox nc serves "mari-ok" on :80 in a loop so
// the container both stays running and answers the exposePort probe.
const NC_LOOP =
  "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\nConnection: close\\r\\n\\r\\nmari-ok' | nc -l -p 80; done";

const TEST_IMAGE = 'alpine:3.20';
const PULL_IMAGE = 'busybox:latest';
const STAMP = Date.now();
const COMPUTER = `mari-test-${STAMP}`;
const PULL_COMPUTER = `mari-test-pull-${STAMP}`;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!dockerAvailable)('DockerProvider (real daemon)', () => {
  let provider: DockerProvider;
  let rawDocker: Docker;
  let handle: DockerHandle;

  beforeAll(async () => {
    provider = await createDockerProvider();
    rawDocker = new Docker(DOCKER_SOCKET ? { socketPath: DOCKER_SOCKET } : undefined);
    // Fail fast with a clear message if the socket exists but the daemon is down.
    await rawDocker.ping();
  });

  afterAll(async () => {
    // Sweep every container this file created, by our exact computer labels.
    for (const computer of [COMPUTER, PULL_COMPUTER]) {
      let containers: Docker.ContainerInfo[] = [];
      try {
        containers = await rawDocker.listContainers({
          all: true,
          filters: { label: [`${COMPUTER_LABEL}=${computer}`] },
        });
      } catch {
        // daemon gone; nothing to clean
      }
      for (const c of containers) {
        try {
          await rawDocker.getContainer(c.Id).remove({ force: true });
        } catch {
          // best effort
        }
      }
    }
  });

  it('materialize creates and starts a running container with env + label', async () => {
    handle = await provider.materialize({
      computer: COMPUTER,
      image: TEST_IMAGE,
      env: {
        MARI_CONTROL_URL: 'https://ctl.example',
        MARI_TOKEN: 'sup-token',
        MARI_EPOCH: '1',
      },
      ports: [80],
      cmd: ['sh', '-c', NC_LOOP],
    });

    expect(handle.substrate).toBe(DOCKER_SUBSTRATE);
    expect(handle.computer).toBe(COMPUTER);
    expect(handle.id).toMatch(/^[0-9a-f]{12,64}$/);
    expect(handle.ports).toEqual([80]);

    const info = await rawDocker.getContainer(handle.id).inspect();
    expect(info.State.Running).toBe(true);
    expect(info.State.Status).toBe('running');
    expect(info.Config.Labels?.[COMPUTER_LABEL]).toBe(COMPUTER);
    // env was injected
    expect(info.Config.Env).toContain('MARI_TOKEN=sup-token');
    expect(info.Config.Env).toContain('MARI_CONTROL_URL=https://ctl.example');
  });

  it('exec captures stdout and returns exit 0', async () => {
    expect(handle).toBeDefined();
    const res = await provider.exec(handle, ['echo', 'hello mari']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello mari\n');
    expect(res.stderr).toBe('');
  });

  it('exec separates stderr and propagates a non-zero exit code', async () => {
    const res = await provider.exec(handle, ['sh', '-c', 'echo oops 1>&2; exit 7']);
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toBe('oops\n');
    expect(res.stdout).toBe('');
  });

  it('exec honors cwd and per-command env', async () => {
    const res = await provider.exec(handle, ['sh', '-c', 'printf "%s %s" "$FOO" "$PWD"'], {
      cwd: '/tmp',
      env: { FOO: 'bar' },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('bar /tmp');
  });

  it('exec streams stdin to the process', async () => {
    const res = await provider.exec(handle, ['cat'], { input: 'piped-in\n' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('piped-in\n');
  });

  it('exposePort returns a reachable published address', async () => {
    const addr = await provider.exposePort(handle, 80);
    expect(addr).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // The nc listener may need a moment after start; retry the probe.
    let body: string | undefined;
    for (let attempt = 0; attempt < 20 && body === undefined; attempt++) {
      try {
        const resp = await fetch(addr);
        if (resp.ok) body = await resp.text();
      } catch {
        await delay(250);
      }
    }
    expect(body).toBe('mari-ok');
  });

  it('exposePort rejects a port that was not published at materialize', async () => {
    await expect(provider.exposePort(handle, 9999)).rejects.toThrow(/not published/);
  });

  it('sleep pauses the container', async () => {
    await provider.sleep(handle);
    const info = await rawDocker.getContainer(handle.id).inspect();
    expect(info.State.Paused).toBe(true);
    expect(info.State.Status).toBe('paused');
  });

  it('wake unpauses the container', async () => {
    await provider.wake(handle);
    const info = await rawDocker.getContainer(handle.id).inspect();
    expect(info.State.Paused).toBe(false);
    expect(info.State.Running).toBe(true);
  });

  it('destroy removes the container and is idempotent', async () => {
    await provider.destroy(handle);
    await expect(rawDocker.getContainer(handle.id).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
    // Destroying an already-gone handle resolves without error.
    await expect(provider.destroy(handle)).resolves.toBeUndefined();
  });

  it('materialize pulls the image when it is absent', async () => {
    // Guarantee absence, then let materialize pull it.
    try {
      await rawDocker.getImage(PULL_IMAGE).remove({ force: true });
    } catch {
      // already absent
    }
    await expect(rawDocker.getImage(PULL_IMAGE).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });

    const pulled = await provider.materialize({
      computer: PULL_COMPUTER,
      image: PULL_IMAGE,
      env: {},
      cmd: ['sleep', '60'],
    });
    try {
      // The image is now present locally...
      const img = await rawDocker.getImage(PULL_IMAGE).inspect();
      expect(img.Id).toMatch(/^sha256:[0-9a-f]{64}$/);
      // ...and the container is running.
      const info = await rawDocker.getContainer(pulled.id).inspect();
      expect(info.State.Running).toBe(true);
    } finally {
      await provider.destroy(pulled);
    }
  });
});

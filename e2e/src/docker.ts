// A second, independent view of substrate state: the `docker` CLI.
//
// The loop suite must be able to say "the container is really gone" and "the
// bytes inside the FRESH container are really the ones the run wrote" without
// asking the code under test. Everything here therefore shells out to the
// daemon directly — Mari's own API is never the witness for a Docker fact.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** The label every Mari container carries (packages/control-plane/src/substrates/docker.ts). */
export const COMPUTER_LABEL = 'mari.computer';

export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run `docker …`, capturing output and the exit code (never throws). */
export async function docker(args: string[], timeout = 120_000): Promise<DockerResult> {
  try {
    const { stdout, stderr } = await exec('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

/** `docker` with a raw (binary-safe) stdout buffer. */
export async function dockerBytes(args: string[], timeout = 120_000): Promise<Uint8Array> {
  const { stdout } = await exec('docker', args, {
    timeout,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Uint8Array(stdout as unknown as Buffer);
}

export async function dockerAvailable(): Promise<boolean> {
  return (await docker(['version', '--format', '{{.Server.Version}}'], 20_000)).code === 0;
}

export async function imageExists(image: string): Promise<boolean> {
  return (await docker(['image', 'inspect', image], 60_000)).code === 0;
}

/** Container ids (all states) carrying `mari.computer=<computer>`. */
export async function containersFor(computer: string): Promise<string[]> {
  const res = await docker([
    'ps',
    '-a',
    '--no-trunc',
    '--filter',
    `label=${COMPUTER_LABEL}=${computer}`,
    '--format',
    '{{.ID}}',
  ]);
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `.State.Status` of a container: running | paused | exited | (null if gone). */
export async function containerStatus(id: string): Promise<string | null> {
  const res = await docker(['inspect', '--format', '{{.State.Status}}', id]);
  if (res.code !== 0) return null;
  return res.stdout.trim();
}

/** The container's environment, as the daemon recorded it at create time. */
export async function containerEnv(id: string): Promise<Record<string, string>> {
  const res = await docker(['inspect', '--format', '{{json .Config.Env}}', id]);
  if (res.code !== 0) return {};
  const out: Record<string, string> = {};
  for (const line of JSON.parse(res.stdout) as string[]) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** The container's bind mounts as `source -> target`. */
export async function containerMounts(id: string): Promise<{ source: string; target: string }[]> {
  const res = await docker(['inspect', '--format', '{{json .Mounts}}', id]);
  if (res.code !== 0) return [];
  return (JSON.parse(res.stdout) as { Source: string; Destination: string }[]).map((m) => ({
    source: m.Source,
    target: m.Destination,
  }));
}

/** Raw bytes of a file inside a RUNNING container. Throws if it is absent. */
export function readFileInContainer(id: string, path: string): Promise<Uint8Array> {
  return dockerBytes(['exec', id, 'cat', path]);
}

/** Paths under `dir` inside a RUNNING container, sorted. */
export async function listFilesInContainer(id: string, dir: string): Promise<string[]> {
  const res = await docker(['exec', id, 'find', dir, '-mindepth', '1']);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/** Force-remove every container any Mari suite may have created. */
export async function cleanupAllMariContainers(): Promise<void> {
  const res = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${COMPUTER_LABEL}`]);
  const ids = res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  await docker(['rm', '-f', ...ids], 180_000);
}

/** Container logs (marid's tracing output), for failure diagnostics. */
export async function containerLogs(id: string, tail = 60): Promise<string> {
  const res = await docker(['logs', '--tail', String(tail), id]);
  return `${res.stdout}\n${res.stderr}`;
}

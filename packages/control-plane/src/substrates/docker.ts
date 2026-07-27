// Local Docker substrate driver (spec §3.7: "Local Docker is the second [substrate],
// for development and private instances").
//
// NODE-ONLY. dockerode pulls in Node core modules (net, stream, ...) and the
// docker socket, none of which exist on Cloudflare Workers. This module is
// therefore written so a Workers bundle never statically pulls dockerode in:
//
//   * `dockerode` is imported **type-only** at the top (erased at compile time
//     under `verbatimModuleSyntax`), so it contributes nothing to the bundle.
//   * The runtime constructor is loaded with a **dynamic** `import('dockerode')`
//     that only executes inside {@link createDockerProvider}, which throws on a
//     non-Node runtime before it ever gets there.
//   * The registry (index.ts) reaches this file through a lazy `import()` keyed
//     on the substrate name, so selecting Sprites on Workers never touches it.
//
// A Workers build should additionally mark `dockerode` external; the docker
// driver is simply never selected on the Workers entry (spec §3.6/§3.7).

import { existsSync } from 'node:fs';
import type DockerT from 'dockerode';
import type {
  MaterializeSpec,
  SubstrateHandle,
  SubstrateProvider,
  ExecOptions,
  ExecResult,
  InstanceStatus,
} from './provider.js';

/** The registry name of this driver. */
export const DOCKER_SUBSTRATE = 'docker';

/** Label key stamped on every container (decisions.md/task: `mari.computer=<id>`). */
export const COMPUTER_LABEL = 'mari.computer';

type Docker = DockerT;
type Container = DockerT.Container;

/** A published container port and the host address Docker bound it to. */
export interface PublishedPort {
  readonly hostIp: string;
  readonly hostPort: number;
}

/**
 * Docker handle. Extends the base handle with the container id (`id`) and the
 * set of ports that were published at create time (Docker fixes port publishing
 * at container creation — see {@link DockerProvider.exposePort}). Fully
 * serializable for DO storage.
 */
export interface DockerHandle extends SubstrateHandle {
  readonly substrate: typeof DOCKER_SUBSTRATE;
  /** Container ids of the ports published at materialize time. */
  readonly ports: readonly number[];
}

/** Construction options; mainly for tests / private-instance socket overrides. */
export interface DockerProviderOptions {
  /** dockerode connection options; defaults to the local unix socket. */
  readonly dockerodeOptions?: DockerT.DockerOptions;
}

function isDockerHandle(handle: SubstrateHandle): asserts handle is DockerHandle {
  if (handle.substrate !== DOCKER_SUBSTRATE) {
    throw new Error(`DockerProvider received a "${handle.substrate}" handle`);
  }
}

/**
 * `SubstrateProvider` backed by a local Docker daemon via dockerode. Maps the
 * six spec §3.5 functions onto container operations:
 *
 *   materialize  create + start a container from `image` (pull if absent),
 *                with env, host mounts, `mari.computer` label, and published
 *                ports.
 *   destroy      force-remove the container.
 *   sleep        `docker pause`  (freeze the cgroup — WARM, spec §2).
 *   wake         `docker unpause`.
 *   exec         real `docker exec`, streams demuxed to stdout/stderr, exit
 *                code read from the exec inspect.
 *   exposePort   read the host binding Docker assigned to a published port.
 */
export class DockerProvider implements SubstrateProvider {
  readonly name = DOCKER_SUBSTRATE;

  constructor(private readonly docker: Docker) {}

  async materialize(spec: MaterializeSpec): Promise<DockerHandle> {
    await this.ensureImage(spec.image);

    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    const ports = spec.ports ?? [];
    for (const port of ports) {
      const key = `${port}/tcp`;
      exposedPorts[key] = {};
      // Empty HostPort => Docker assigns a free port; bound to loopback so a dev
      // machine does not expose the computer on its LAN (spec §10.4 isolation is
      // the substrate's job — do not weaken it).
      portBindings[key] = [{ HostIp: '127.0.0.1', HostPort: '' }];
    }

    const binds = (spec.mounts ?? []).map(
      (m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`,
    );

    const hostConfig: DockerT.HostConfig = {
      PortBindings: portBindings,
      // The private-instance supervisor URL uses this stable host name. Linux
      // Docker does not add it automatically (unlike Docker Desktop), so a real
      // marid container otherwise fails DNS before it can attach.
      ExtraHosts: ['host.docker.internal:host-gateway'],
    };
    if (binds.length > 0) hostConfig.Binds = binds;
    if (spec.resources?.memoryMiB != null) {
      hostConfig.Memory = Math.round(spec.resources.memoryMiB * 1024 * 1024);
    }
    if (spec.resources?.cpus != null) {
      hostConfig.NanoCpus = Math.round(spec.resources.cpus * 1e9);
    }

    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { [COMPUTER_LABEL]: spec.computer },
      ExposedPorts: exposedPorts,
      Cmd: spec.cmd ? [...spec.cmd] : undefined,
      HostConfig: hostConfig,
    });

    await container.start();

    return {
      substrate: DOCKER_SUBSTRATE,
      computer: spec.computer,
      id: container.id,
      ports: [...ports],
    };
  }

  async destroy(handle: SubstrateHandle): Promise<void> {
    isDockerHandle(handle);
    try {
      await this.docker.getContainer(handle.id).remove({ force: true });
    } catch (err) {
      // Already gone (a prior destroy, or never created) is success.
      if (statusCode(err) === 404) return;
      throw err;
    }
  }

  async sleep(handle: SubstrateHandle): Promise<void> {
    isDockerHandle(handle);
    try {
      await this.docker.getContainer(handle.id).pause();
    } catch (err) {
      // Pausing an already-paused container is a no-op success.
      if (statusCode(err) === 304) return;
      throw err;
    }
  }

  async wake(handle: SubstrateHandle): Promise<void> {
    isDockerHandle(handle);
    try {
      await this.docker.getContainer(handle.id).unpause();
    } catch (err) {
      if (statusCode(err) === 304) return;
      throw err;
    }
  }

  async exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    isDockerHandle(handle);
    if (argv.length === 0) throw new Error('exec requires a non-empty argv');
    const container = this.docker.getContainer(handle.id);

    const exec = await container.exec({
      Cmd: [...argv],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: opts.input != null,
      Tty: false,
      Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
      WorkingDir: opts.cwd,
    });

    const stream = await exec.start({ hijack: true, stdin: opts.input != null });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = collectable(stdoutChunks);
    const stderr = collectable(stderrChunks);

    // Tty:false => Docker multiplexes stdout/stderr with an 8-byte header per
    // frame; demuxStream splits them back apart.
    this.docker.modem.demuxStream(stream, stdout, stderr);

    if (opts.input != null) {
      stream.write(typeof opts.input === 'string' ? Buffer.from(opts.input) : Buffer.from(opts.input));
    }
    stream.end();

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', reject);
    });

    // The exec's ExitCode can lag the stream end by a beat; poll briefly.
    let exitCode = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const info = await exec.inspect();
      if (!info.Running && info.ExitCode != null) {
        exitCode = info.ExitCode;
        break;
      }
      await delay(10);
    }

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    };
  }

  /**
   * Return `http://127.0.0.1:<hostPort>` for a container port.
   *
   * CREATE-TIME CONSTRAINT: Docker fixes a container's published ports when the
   * container is created; you cannot publish a new port on a running container.
   * Therefore `port` MUST have been listed in {@link MaterializeSpec.ports} at
   * materialize time. This driver honors the constraint by reading the host
   * binding Docker already assigned; a port that was not published rejects.
   */
  async exposePort(handle: SubstrateHandle, port: number): Promise<string> {
    isDockerHandle(handle);
    const info = await this.docker.getContainer(handle.id).inspect();
    const bindings = info.NetworkSettings?.Ports?.[`${port}/tcp`];
    if (!bindings || bindings.length === 0) {
      throw new Error(
        `port ${port} was not published at materialize time; Docker fixes port ` +
          `publishing at container creation — include it in MaterializeSpec.ports`,
      );
    }
    // Prefer a loopback binding; fall back to the first.
    const binding = bindings.find((b) => b.HostIp === '127.0.0.1') ?? bindings[0]!;
    const host = binding.HostIp && binding.HostIp !== '0.0.0.0' ? binding.HostIp : '127.0.0.1';
    return `http://${host}:${binding.HostPort}`;
  }

  /**
   * Does this container still exist? (provider.ts's optional liveness
   * declaration.)
   *
   * `inspect` is the same call {@link exposePort} already makes, and it is the
   * only honest answer available: `docker rm -f` (an eviction, by hand or by the
   * daemon) leaves nothing behind, and the daemon then answers 404. A container
   * that exists in ANY state — running, paused (WARM), exited — is `alive`: the
   * question is whether the resources are still there, not whether a process is.
   *
   * Anything that is not a 404 is `unknown` rather than `gone`: a daemon that is
   * restarting, a socket that vanished, or a timeout must not be read as "the
   * user's computer was destroyed".
   */
  async instanceStatus(handle: SubstrateHandle): Promise<InstanceStatus> {
    isDockerHandle(handle);
    try {
      const info = await this.docker.getContainer(handle.id).inspect();
      return info?.Id ? 'alive' : 'unknown';
    } catch (err) {
      return statusCode(err) === 404 ? 'gone' : 'unknown';
    }
  }

  /** Pull `image` if the daemon does not already have it (task: "pull image if absent"). */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return; // present
    } catch (err) {
      if (statusCode(err) !== 404) throw err;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (progressErr) =>
        progressErr ? reject(progressErr) : resolve(),
      );
    });
  }
}

/**
 * Locate a usable Docker daemon socket for a dev / private-instance host.
 *
 * Honors `DOCKER_HOST=unix://…` first, then probes the well-known socket paths
 * of the common local runtimes — plain `/var/run/docker.sock`, Docker Desktop,
 * Colima, Rancher Desktop — returning the first that exists. Returns `undefined`
 * when none are present (so callers can skip Docker-dependent work cleanly).
 * A dangling `/var/run/docker.sock` symlink resolves to non-existent and is
 * skipped, which is exactly the situation on a Colima-only host.
 */
export function findDockerSocket(): string | undefined {
  const env = typeof process !== 'undefined' ? process.env : {};
  const host = env.DOCKER_HOST;
  if (host && host.startsWith('unix://')) {
    const p = host.slice('unix://'.length);
    if (existsSync(p)) return p;
  }
  const home = env.HOME ?? '';
  const candidates = [
    '/var/run/docker.sock',
    home && `${home}/.docker/run/docker.sock`,
    home && `${home}/.colima/default/docker.sock`,
    home && `${home}/.rd/docker.sock`,
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/**
 * Create a `DockerProvider`, dynamically importing dockerode. Throws on a
 * non-Node runtime so a stray Workers code path fails loudly instead of
 * bundling native modules. When no explicit dockerode options are given, the
 * daemon socket is auto-detected via {@link findDockerSocket}.
 */
export async function createDockerProvider(
  options: DockerProviderOptions = {},
): Promise<DockerProvider> {
  if (typeof process === 'undefined' || process.versions?.node == null) {
    throw new Error('DockerProvider requires a Node.js runtime; it is not available on Workers.');
  }
  const mod = (await import('dockerode')) as unknown as { default: new (o?: DockerT.DockerOptions) => Docker };
  const Ctor = mod.default;
  let opts = options.dockerodeOptions;
  if (opts == null) {
    const socketPath = findDockerSocket();
    if (socketPath != null) opts = { socketPath };
  }
  return new DockerProvider(new Ctor(opts));
}

/** A minimal Writable-like sink that buffers chunks; avoids importing node:stream. */
function collectable(sink: Buffer[]): NodeJS.WritableStream {
  // dockerode's demuxStream only calls `.write()`; a partial Writable suffices.
  const writable = {
    write(chunk: Buffer | string): boolean {
      sink.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return true;
    },
    end(): void {},
    on(): NodeJS.WritableStream {
      return writable as unknown as NodeJS.WritableStream;
    },
    once(): NodeJS.WritableStream {
      return writable as unknown as NodeJS.WritableStream;
    },
    emit(): boolean {
      return false;
    },
  };
  return writable as unknown as NodeJS.WritableStream;
}

function statusCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

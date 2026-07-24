// Assemble the control-plane `Env` for a Node private instance (spec 11.2).
//
// On Cloudflare the bindings come from wrangler; here they are constructed:
// SQLite files for the Durable Objects and D1, a directory for R2, and a REAL
// substrate driver (spec 3.6/3.7) instead of the test fake. Everything above
// this line — the Hono app, the Durable Object classes, the wake proxy — is the
// same code the Workers entry runs.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ComputerDO } from '../computer-do.js';
import { EventsDO } from '../events-do.js';
import { applySchema } from '../db/apply.js';
import type { Env } from '../types.js';
import { openD1, type NodeD1Database } from './d1.js';
import { NodeDurableObjectNamespace } from './namespace.js';
import { openStore, type NodeR2Bucket } from './r2.js';
import { createRuntimeSubstrate, type RuntimeSubstrate } from './substrate.js';
import type { NodeDurableObjectState } from './state.js';
import { installWebSocketGlobals } from './websocket-pair.js';

/** Everything the runtime needs beyond the `Env` the shared code sees. */
export interface NodeRuntimeEnv {
  env: Env;
  config: NodeConfig;
  computers: NodeDurableObjectNamespace<ComputerDO>;
  events: NodeDurableObjectNamespace<EventsDO>;
  db: NodeD1Database;
  store: NodeR2Bucket;
  substrate: RuntimeSubstrate | null;
}

/** Resolved private-instance configuration (see deploy/README.md). */
export interface NodeConfig {
  port: number;
  hostname: string;
  dataDir: string;
  /** Chunk store root as THIS process sees it (the R2 equivalent). */
  storeDir: string;
  /** Chunk store root as the DOCKER DAEMON sees it (the bind-mount source). */
  storeHostDir: string;
  /** Mount point of the store inside a computer; matches `MARI_STORE`. */
  storeMountPath: string;
  /** The computer's filesystem root inside the container (`MARI_ROOT`). */
  computerRoot: string;
  baseImage: string;
  /** `ws://host:port` as reachable FROM a materialized computer. */
  supervisorUrlBase: string;
  substrateMode: string;
  substrates: string[];
  publishPorts: number[];
  webDir: string | null;
  baseUrl: string;
  /** Host (without port) a computer dials this control plane on. */
  controlHost: string;
  /** True when the operator pinned the supervisor URL / base URL explicitly, so
   *  binding to an ephemeral port must not rewrite them. */
  urlsPinned: boolean;
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envOpt(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === '' ? undefined : v;
}

function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The host a materialized computer must dial to reach this control plane.
 *
 * A container cannot use `localhost` — that is its own loopback. Three cases,
 * in order: an explicit override; the control plane itself running in a
 * container (then its own bridge address is what siblings can route to); and a
 * control plane on the host, which containers reach through Docker's
 * `host.docker.internal`.
 */
export function containerReachableHost(): string {
  const explicit = envOpt('MARI_CONTROL_HOST');
  if (explicit) return explicit;
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    for (const [, addrs] of Object.entries(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  }
  return 'host.docker.internal';
}

/**
 * A mount source is either a path (resolved against this process's cwd) or a
 * named Docker VOLUME — which is what a containerized control plane hands its
 * computers, because a volume name means the same thing to the daemon no matter
 * which filesystem the control plane itself sees. Resolving a volume name into
 * a path would silently bind an empty directory instead of the chunk store.
 */
function resolveMountSource(source: string): string {
  return source.startsWith('/') || source.startsWith('.') ? resolve(source) : source;
}

function parsePorts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

/** Resolve configuration from the process environment. */
export function readConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  const port = overrides.port ?? envInt('PORT', 8787);
  const dataDir = resolve(overrides.dataDir ?? envStr('MARI_DATA_DIR', join(process.cwd(), 'data')));
  const storeDir = resolve(overrides.storeDir ?? envStr('MARI_STORE_DIR', join(dataDir, 'store')));
  // `MARI_CONTROL_HOST` may carry its own port (a published/forwarded one that
  // differs from the port this process binds); keep the two apart.
  const rawHost = containerReachableHost();
  const colon = rawHost.lastIndexOf(':');
  const host = colon === -1 ? rawHost : rawHost.slice(0, colon);
  const hostWithPort = colon === -1 ? `${rawHost}:${port}` : rawHost;
  const webDirRaw = envOpt('MARI_WEB_DIR');
  const webDir = overrides.webDir === undefined
    ? webDirRaw
      ? resolve(webDirRaw)
      : defaultWebDir()
    : overrides.webDir;
  return {
    controlHost: host,
    urlsPinned: Boolean(
      overrides.supervisorUrlBase ??
        envOpt('MARI_SUPERVISOR_URL') ??
        envOpt('BASE_URL') ??
        (colon === -1 ? undefined : rawHost),
    ),
    port,
    hostname: overrides.hostname ?? envStr('MARI_BIND', '0.0.0.0'),
    dataDir,
    storeDir,
    storeHostDir: resolveMountSource(overrides.storeHostDir ?? envStr('MARI_STORE_HOST_DIR', storeDir)),
    storeMountPath: overrides.storeMountPath ?? envStr('MARI_STORE_MOUNT', '/store'),
    computerRoot: overrides.computerRoot ?? envStr('MARI_COMPUTER_ROOT', '/work'),
    baseImage: overrides.baseImage ?? envStr('MARI_BASE_IMAGE', 'mari/base:v0'),
    supervisorUrlBase:
      overrides.supervisorUrlBase ?? envStr('MARI_SUPERVISOR_URL', `ws://${hostWithPort}`),
    substrateMode: overrides.substrateMode ?? envStr('SUBSTRATE_MODE', 'auto'),
    substrates: overrides.substrates ?? envStr('MARI_SUBSTRATES', 'docker,sprites').split(','),
    publishPorts: overrides.publishPorts ?? parsePorts(envOpt('MARI_PUBLISH_PORTS')),
    webDir,
    baseUrl: overrides.baseUrl ?? envStr('BASE_URL', `http://localhost:${port}`),
  };
}

/**
 * Bind-time fixup: with `port: 0` (tests, and any operator who lets the OS pick)
 * the real port is only known after `listen`, but a materialized computer must
 * dial THAT port. Rewrites the derived URLs in both the config and the live
 * `Env` — unless the operator pinned them.
 */
export function applyBoundPort(rt: NodeRuntimeEnv, port: number): void {
  rt.config.port = port;
  if (rt.config.urlsPinned) return;
  rt.config.supervisorUrlBase = `ws://${rt.config.controlHost}:${port}`;
  rt.config.baseUrl = `http://localhost:${port}`;
  const mutable = rt.env as unknown as Record<string, unknown>;
  mutable['SUPERVISOR_URL_BASE'] = rt.config.supervisorUrlBase;
  mutable['BASE_URL'] = rt.config.baseUrl;
}

/** `packages/web/dist` when it has been built, else null. */
function defaultWebDir(): string | null {
  const candidates = [
    join(process.cwd(), 'packages/web/dist'),
    join(process.cwd(), '../web/dist'),
    '/app/web',
  ];
  for (const c of candidates) {
    const abs = isAbsolute(c) ? c : resolve(c);
    if (existsSync(join(abs, 'index.html'))) return abs;
  }
  return null;
}

/**
 * Build the runtime: open the stores, create the Durable Object namespaces, and
 * select the substrate. The `Env` object is shared by reference with every
 * Durable Object, so `BASE_MANIFEST` can be filled in later, once the base image
 * has been snapshotted (see `base-image.ts`).
 */
export async function createNodeRuntime(config: NodeConfig): Promise<NodeRuntimeEnv> {
  installWebSocketGlobals();

  await mkdir(config.dataDir, { recursive: true });
  await mkdir(join(config.dataDir, 'do'), { recursive: true });
  const store = await openStore(config.storeDir);
  const db = openD1(join(config.dataDir, 'fleet.sqlite'));

  // v0 has no migration runner (db/apply.ts): a private instance applies the
  // schema at boot, which is idempotent and keeps "one command" true.
  await applySchema(db as unknown as D1Database);

  const substrate =
    config.substrateMode === 'fake'
      ? null
      : createRuntimeSubstrate({
          candidates: config.substrates.map((s) => s.trim()).filter(Boolean),
          storeHostDir: config.storeHostDir,
          storeMountPath: config.storeMountPath,
          ports: config.publishPorts,
          ...(envOpt('SPRITES_TOKEN') ? { spritesToken: envOpt('SPRITES_TOKEN') } : {}),
          ...(envOpt('SPRITES_BASE_URL') ? { spritesBaseUrl: envOpt('SPRITES_BASE_URL') } : {}),
        });

  const env = {
    PREVIEW_ZONE: envStr('PREVIEW_ZONE', 'mari.sh'),
    DEV_AUTH: envStr('DEV_AUTH', '0'),
    DEV_SEED: envStr('DEV_SEED', '0'),
    AUTH_SECRET: envStr('AUTH_SECRET', 'mari-private-instance-change-me'),
    BASE_URL: config.baseUrl,
    SUBSTRATE_MODE: config.substrateMode,
    WARM_IDLE_MS: envOpt('WARM_IDLE_MS'),
    COLD_IDLE_MS: envOpt('COLD_IDLE_MS'),
    BASE_IMAGE: config.baseImage,
    COMPUTER_ROOT: config.computerRoot,
    STORE_URI: `fs://${config.storeMountPath}`,
    SUPERVISOR_URL_BASE: config.supervisorUrlBase,
    DB: db as unknown as D1Database,
    STORE: store as unknown as R2Bucket,
  } as unknown as Env;

  const computers = new NodeDurableObjectNamespace<ComputerDO>({
    className: 'ComputerDO',
    dir: join(config.dataDir, 'do'),
    create: (state: NodeDurableObjectState) =>
      new ComputerDO(state as unknown as DurableObjectState, env),
  });
  const events = new NodeDurableObjectNamespace<EventsDO>({
    className: 'EventsDO',
    dir: join(config.dataDir, 'do'),
    create: (state: NodeDurableObjectState) =>
      new EventsDO(state as unknown as DurableObjectState, env),
  });

  const mutable = env as unknown as Record<string, unknown>;
  mutable['COMPUTER'] = computers;
  mutable['EVENTS'] = events;
  if (substrate) mutable['SUBSTRATE'] = substrate;

  return { env, config, computers, events, db, store, substrate };
}

// Booting the REAL private instance, plus the server-side witness that makes
// "the user disconnected" a checkable fact rather than a claim.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { boot, type BootOptions, type NodeInstance } from '../../packages/control-plane/src/node.js';
import { waitUntil } from './wait.js';

export type { NodeInstance };

/**
 * A scratch directory the DOCKER DAEMON can also see. On macOS the daemon runs
 * in a VM that shares `$HOME` but not `/tmp`, so a chunk store bind-mounted from
 * `/tmp` is silently EMPTY inside the container — which looks exactly like a
 * computer that lost its files. Under `$HOME` both sides see one store.
 */
export async function makeSharedDir(prefix: string): Promise<string> {
  const root = process.env.MARI_LOOP_E2E_DIR ?? join(homedir(), '.mari', 'loop-e2e');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${prefix}-`));
}

export function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

export interface InstanceOptions extends BootOptions {
  devAuth?: boolean;
  warmIdleMs?: number;
  coldIdleMs?: number;
}

/** Boot a private instance on an ephemeral port (the `boot()` behind spec 11.2's
 *  one command — deploy/docker-compose.yml runs this same function). */
export async function startInstance(options: InstanceOptions = {}): Promise<NodeInstance> {
  const { devAuth = true, warmIdleMs, coldIdleMs, ...bootOptions } = options;
  process.env.DEV_AUTH = devAuth ? '1' : '0';
  process.env.DEV_SEED = '0';
  process.env.AUTH_SECRET = 'mari-loop-e2e-secret-not-for-prod';
  if (warmIdleMs !== undefined) process.env.WARM_IDLE_MS = String(warmIdleMs);
  else delete process.env.WARM_IDLE_MS;
  if (coldIdleMs !== undefined) process.env.COLD_IDLE_MS = String(coldIdleMs);
  else delete process.env.COLD_IDLE_MS;
  delete process.env.BASE_URL;
  delete process.env.MARI_SUPERVISOR_URL;
  return boot({
    port: 0,
    hostname: '0.0.0.0',
    webDir: null,
    log: () => {},
    ...bootOptions,
  });
}

// ---------------------------------------------------------------------------
// Server-side connection witness
// ---------------------------------------------------------------------------

export interface TrackedConnection {
  socket: Socket;
  remote: string;
  openedAt: number;
  /** Request paths this connection carried, in order (an HTTP keep-alive
   *  connection carries several; a WebSocket carries exactly one). */
  paths: string[];
  /** True once the connection was upgraded (WebSocket). */
  upgraded: boolean;
  upgradedAt: number | null;
}

/**
 * Watches the instance's own HTTP server and records every TCP connection with
 * the request paths it carried. This is the ONLY honest way to assert "no
 * client is watching": Mari's API cannot be the witness for a claim about
 * Mari's own sockets, and a client-side `readyState` proves only what the
 * client believes.
 *
 * A connection is classified by the paths it carried:
 *   * `/supervisor/…` — the supervisor's framed-CBOR link (contracts.md §2).
 *     This one must SURVIVE the disconnect: the supervisor owns the run
 *     (spec 5.1), and it is not a client.
 *   * anything else (`/api/…`, `/attach/…`) — a client connection.
 *
 * By PATH, not by address, and that is not a stylistic choice: with Docker
 * Desktop the container's dial-back arrives through the VM's port forwarder and
 * the server sees it as `127.0.0.1`, exactly like the test's own client. An
 * address-based rule would quietly classify the supervisor as a client (or
 * worse, a client as the supervisor) on this very machine.
 */
export class ConnectionWitness {
  readonly connections: TrackedConnection[] = [];
  #bySocket = new WeakMap<Socket, TrackedConnection>();
  #server: Server;

  constructor(server: Server) {
    this.#server = server;
    server.on('connection', (socket: Socket) => {
      const rec: TrackedConnection = {
        socket,
        remote: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`,
        openedAt: Date.now(),
        paths: [],
        upgraded: false,
        upgradedAt: null,
      };
      this.#bySocket.set(socket, rec);
      this.connections.push(rec);
    });
    server.on('request', (req) => {
      const rec = this.#bySocket.get(req.socket as Socket);
      if (rec && req.url) rec.paths.push(req.url);
    });
    server.on('upgrade', (req, socket) => {
      const rec = this.#bySocket.get(socket as Socket);
      if (!rec) return;
      if (req.url) rec.paths.push(req.url);
      rec.upgraded = true;
      rec.upgradedAt = Date.now();
    });
  }

  static isSupervisor(rec: TrackedConnection): boolean {
    return rec.paths.length > 0 && rec.paths.every((p) => p.startsWith('/supervisor/'));
  }

  /** Connections that are still open (the socket is not destroyed). */
  live(): TrackedConnection[] {
    return this.connections.filter((c) => !c.socket.destroyed);
  }

  liveSupervisor(): TrackedConnection[] {
    return this.live().filter((c) => ConnectionWitness.isSupervisor(c));
  }

  /** Every live connection that is NOT the supervisor's: a client is watching. */
  liveClient(): TrackedConnection[] {
    return this.live().filter((c) => !ConnectionWitness.isSupervisor(c));
  }

  /** The kernel's own count, independent of this bookkeeping. */
  openSocketCount(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.getConnections((err, count) => (err ? reject(err) : resolve(count)));
    });
  }

  /** When the supervisor's WebSocket was accepted (wake latency reference). */
  firstSupervisorUpgradeAfter(since: number): number | null {
    const times = this.connections
      .filter((c) => ConnectionWitness.isSupervisor(c) && c.upgradedAt !== null && c.upgradedAt >= since)
      .map((c) => c.upgradedAt as number)
      .sort((a, b) => a - b);
    return times[0] ?? null;
  }

  describe(): string {
    return this.live()
      .map((c) => `${c.remote}${c.upgraded ? ' [ws]' : ''} ${c.paths.join(',') || '(no request yet)'}`)
      .join('\n  ');
  }

  /** Wait until no client connection is live, then return. Bounded; the failure
   *  message names the sockets that refused to go. */
  async waitForNoClients(timeoutMs = 15_000): Promise<void> {
    try {
      await waitUntil(() => this.liveClient().length === 0, timeoutMs, 'client connections to close');
    } catch {
      throw new Error(`client connections still open after ${timeoutMs} ms:\n  ${this.describe()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Timings (spec 13: measured wake latency)
// ---------------------------------------------------------------------------

export class Timings {
  readonly marks: { label: string; ms: number }[] = [];

  record(label: string, ms: number): number {
    this.marks.push({ label, ms });
    return ms;
  }

  /** Time `fn`, record it, return its value. */
  async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    const value = await fn();
    this.record(label, Date.now() - t0);
    return value;
  }

  all(label: string): number[] {
    return this.marks.filter((m) => m.label === label).map((m) => m.ms);
  }

  /** Median of every mark with this label (spec 13 asks for p50). */
  p50(label: string): number | null {
    const xs = this.all(label).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 1 ? (xs[mid] as number) : Math.round((((xs[mid - 1] as number) + (xs[mid] as number)) / 2));
  }

  report(title: string): string {
    const width = this.marks.reduce((n, m) => Math.max(n, m.label.length), 0);
    const lines = this.marks.map((m) => `  ${m.label.padEnd(width)}  ${String(m.ms).padStart(7)} ms`);
    return `\n${title}\n${lines.join('\n')}\n`;
  }
}

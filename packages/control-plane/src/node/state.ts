// `DurableObjectState` + `DurableObjectStorage` for Node.
//
// A Durable Object is a single-threaded actor with durable storage and exactly
// one alarm (spec 3.2 "the only coordination point for its computer"). This
// module reproduces the three properties `computer-do.ts` actually depends on:
//
//   1. **Serialized entry.** `blockConcurrencyWhile` gates every later call, so
//      the constructor's schema/meta load completes before any RPC, fetch or
//      alarm runs — exactly as workerd orders them.
//   2. **Durable KV + SQL.** `storage.get/put` persist the `meta` blob and
//      `storage.sql` is the DO's SQLite (see `sql.ts`). Both live in one file
//      per object, so a private instance survives a restart.
//   3. **One alarm, persisted.** `setAlarm` overwrites the pending alarm and
//      writes it to disk before scheduling the timer; the timer is re-armed
//      from disk when the object is re-created after a restart. That is what
//      makes the tier policy (spec 4.4 AWAKE→WARM→COLD) real here.

import { DatabaseSync } from 'node:sqlite';
import { NodeSqlStorage, openDatabase, type SqlValue } from './sql.js';

/**
 * Backoff for an alarm handler that THREW, mirroring workerd's own retry rather
 * than dropping the deadline. Bounded: an alarm that fails this many times in a
 * row is a bug, and retrying it forever would spin.
 */
const ALARM_RETRY_MS: readonly number[] = [1_000, 5_000, 15_000, 60_000];

/** Options for `storage.list()`. */
export interface ListOptions {
  prefix?: string;
  start?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
}

export class NodeDurableObjectStorage {
  readonly sql: NodeSqlStorage;
  /** Invoked when the alarm fires; wired by the namespace to `instance.alarm()`. */
  onAlarm: (() => Promise<void> | void) | null = null;

  #db: DatabaseSync;
  #timer: NodeJS.Timeout | null = null;
  #firing = false;
  /** Consecutive alarm handler failures; reset by a clean run. */
  #alarmFailures = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.sql = new NodeSqlStorage(db);
    db.exec(`CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS _alarm (id INTEGER PRIMARY KEY CHECK (id = 0), at INTEGER NOT NULL)`);
  }

  // ---- KV ----

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.#db.prepare(`SELECT value FROM _kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return undefined;
    return JSON.parse(row.value) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.#db
      .prepare(`INSERT INTO _kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value ?? null));
  }

  async delete(key: string): Promise<boolean> {
    const res = this.#db.prepare(`DELETE FROM _kv WHERE key = ?`).run(key);
    return Number(res.changes ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    this.#db.exec(`DELETE FROM _kv`);
  }

  async list<T = unknown>(options: ListOptions = {}): Promise<Map<string, T>> {
    const rows = this.#db
      .prepare(`SELECT key, value FROM _kv ORDER BY key`)
      .all() as { key: string; value: string }[];
    const out = new Map<string, T>();
    for (const r of rows) {
      if (options.prefix && !r.key.startsWith(options.prefix)) continue;
      if (options.start && r.key < options.start) continue;
      if (options.end && r.key >= options.end) continue;
      out.set(r.key, JSON.parse(r.value) as T);
      if (options.limit && out.size >= options.limit) break;
    }
    return out;
  }

  /** workerd exposes a synchronous transaction over SQLite; the DO does not use
   *  it today, but the shape is part of the storage contract. */
  transactionSync<T>(fn: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- alarms (spec 4.4 tier policy) ----

  async getAlarm(): Promise<number | null> {
    const row = this.#db.prepare(`SELECT at FROM _alarm WHERE id = 0`).get() as
      | { at: number }
      | undefined;
    return row === undefined ? null : Number(row.at);
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const at = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
    this.#db
      .prepare(`INSERT INTO _alarm (id, at) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at`)
      .run(at);
    this.#schedule(at);
  }

  async deleteAlarm(): Promise<void> {
    this.#db.exec(`DELETE FROM _alarm WHERE id = 0`);
    this.#clearTimer();
  }

  /** Re-arm a persisted alarm after a restart (called once at construction). */
  async rearm(): Promise<void> {
    const at = await this.getAlarm();
    if (at !== null) this.#schedule(at);
  }

  /** Run the alarm NOW if one is pending (test hook mirroring
   *  `runDurableObjectAlarm` in the Workers pool). Returns false if none. */
  async runAlarmNow(): Promise<boolean> {
    const at = await this.getAlarm();
    if (at === null) return false;
    this.#clearTimer();
    await this.#fire();
    return true;
  }

  /** Release the timer and the SQLite file handle (shutdown, and the restart
   *  path in tests: a second runtime opens the same file). */
  close(): void {
    this.#clearTimer();
    try {
      this.#db.close();
    } catch {
      // Already closed, or a statement is still open: nothing to salvage here.
    }
  }

  #schedule(at: number): void {
    this.#clearTimer();
    const delay = Math.max(0, at - Date.now());
    const timer = setTimeout(() => {
      void this.#fire();
    }, delay);
    // The HTTP server keeps the process alive; a pending tier alarm must not.
    timer.unref?.();
    this.#timer = timer;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #fire(): Promise<void> {
    if (this.#firing) return;
    this.#firing = true;
    let rearmAt: number | null = null;
    try {
      // workerd deletes the alarm before running the handler, so a handler that
      // re-arms (AWAKE->WARM arming WARM->COLD) is not clobbered afterwards.
      this.#db.exec(`DELETE FROM _alarm WHERE id = 0`);
      this.#clearTimer();
      await this.onAlarm?.();
      this.#alarmFailures = 0;
    } catch (err) {
      // AN ALARM THAT THROWS MUST NOT TAKE THE PROCESS DOWN — but it must not
      // vanish either, which is what the empty catch here used to do. The row is
      // DELETEd before the handler runs, and a computer that failed to transition
      // performs no next transition, so the deadline was consumed FOREVER with no
      // log line: every tier deadline, wake retry and liveness check for that
      // computer silently stopped existing. workerd retries a failed alarm with
      // backoff; this is that behaviour, plus the log line that makes a
      // workerd-vs-Node divergence findable.
      this.#alarmFailures += 1;
      const backoff =
        ALARM_RETRY_MS[Math.min(this.#alarmFailures - 1, ALARM_RETRY_MS.length - 1)] as number;
      const give = this.#alarmFailures > ALARM_RETRY_MS.length;
      console.error(
        `mari: durable object alarm threw (attempt ${this.#alarmFailures})` +
          `${give ? ', giving up' : `, retrying in ${backoff} ms`}: ` +
          `${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      if (!give) rearmAt = Date.now() + backoff;
    } finally {
      this.#firing = false;
    }
    // Re-armed OUTSIDE the try/finally so the handler's own re-arm (the healthy
    // path) is never overwritten by the retry: only a throw sets `rearmAt`, and
    // an alarm the handler already re-armed for an EARLIER time wins.
    if (rearmAt !== null) {
      const existing = await this.getAlarm();
      if (existing === null || existing > rearmAt) await this.setAlarm(rearmAt);
    }
  }
}

/** A Durable Object id: a stable name plus its hex form. */
export class NodeDurableObjectId {
  constructor(
    readonly name: string,
    readonly hex: string,
  ) {}
  toString(): string {
    return this.hex;
  }
  equals(other: { toString(): string }): boolean {
    return this.hex === other.toString();
  }
}

/** `DurableObjectState`: storage, input gate, and `waitUntil`. */
export class NodeDurableObjectState {
  readonly storage: NodeDurableObjectStorage;
  #gate: Promise<unknown> = Promise.resolve();
  #pending = new Set<Promise<unknown>>();

  constructor(
    readonly id: NodeDurableObjectId,
    db: DatabaseSync,
  ) {
    this.storage = new NodeDurableObjectStorage(db);
  }

  /** Serialize `fn` against every other gated entry point (workerd's input
   *  gate). Callers await {@link ready} before invoking a method. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#gate.then(fn, fn);
    this.#gate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Resolves once every `blockConcurrencyWhile` callback has settled. */
  ready(): Promise<unknown> {
    return this.#gate;
  }

  waitUntil(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise).catch(() => undefined);
    this.#pending.add(tracked);
    void tracked.then(() => this.#pending.delete(tracked));
  }

  /** Await every outstanding `waitUntil` (used at shutdown and by tests that
   *  assert the journal segment reached the object store). */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }
}

/** Open the SQLite file backing one Durable Object instance. */
export function openObjectDatabase(file: string): DatabaseSync {
  return openDatabase(file);
}

export type { SqlValue };

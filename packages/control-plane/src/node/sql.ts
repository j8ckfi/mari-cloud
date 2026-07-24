// `ctx.storage.sql` for Node, over the built-in `node:sqlite`.
//
// The Durable Object stores its journal, segment index, attention log and run
// history in DO SQLite (`computer-do.ts`). That code is shared verbatim with the
// Workers runtime, so this shim must match `SqlStorage` where the DO touches it:
//
//   * `exec<T>(query, ...bindings)` returns a cursor that is ITERABLE over row
//     objects and exposes `rowsWritten` (the `dispatched` latch and
//     `dismissAttention` both branch on it);
//   * BLOB columns bind from `Uint8Array` and read back as `Uint8Array`
//     (`new Uint8Array(row.bytes)` is then a copy on both runtimes);
//   * statements are prepared once and cached, as workerd does.
//
// No native module: `node:sqlite` ships with Node, which keeps a private
// instance a `docker compose up` and not a compiler toolchain.

import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** The scalar types SQLite exchanges with JS. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** Cursor returned by {@link NodeSqlStorage.exec}. */
export class NodeSqlCursor<T> implements Iterable<T> {
  constructor(
    private readonly rows: T[],
    readonly rowsWritten: number,
    readonly columnNames: string[],
  ) {}

  get rowsRead(): number {
    return this.rows.length;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.rows[Symbol.iterator]();
  }

  toArray(): T[] {
    return [...this.rows];
  }

  /** The single row, or a throw — mirrors `SqlStorageCursor.one()`. */
  one(): T {
    if (this.rows.length !== 1) {
      throw new Error(`expected exactly one row, got ${this.rows.length}`);
    }
    return this.rows[0] as T;
  }

  raw(): IterableIterator<SqlValue[]> {
    const cols = this.columnNames;
    const rows = this.rows as unknown as Record<string, SqlValue>[];
    return rows.map((r) => cols.map((c) => r[c] as SqlValue))[Symbol.iterator]();
  }
}

/** Statements that produce rows; everything else reports `changes`. */
const RETURNS_ROWS = /^\s*(?:with\b|select\b|pragma\b|explain\b)/i;
/** A statement with a RETURNING clause produces rows even though it writes. */
const HAS_RETURNING = /\breturning\b/i;

export class NodeSqlStorage {
  #cache = new Map<string, StatementSync>();
  /** Cumulative rows written, mirroring `SqlStorage.databaseSize`-adjacent
   *  bookkeeping the DO does not use but the API exposes. */
  #written = 0;

  constructor(private readonly db: DatabaseSync) {}

  get databaseSize(): number {
    const row = this.db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined;
    const size = this.db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined;
    return (row?.page_count ?? 0) * (size?.page_size ?? 0);
  }

  get totalRowsWritten(): number {
    return this.#written;
  }

  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): NodeSqlCursor<T> {
    const stmt = this.#prepare(query);
    if (RETURNS_ROWS.test(query) || HAS_RETURNING.test(query)) {
      const rows = stmt.all(...(bindings as never[])) as T[];
      const cols = rows.length > 0 ? Object.keys(rows[0] as object) : [];
      return new NodeSqlCursor<T>(rows, 0, cols);
    }
    const res = stmt.run(...(bindings as never[]));
    const changes = Number(res.changes ?? 0);
    this.#written += changes;
    return new NodeSqlCursor<T>([], changes, []);
  }

  #prepare(query: string): StatementSync {
    const cached = this.#cache.get(query);
    if (cached) return cached;
    const stmt = this.db.prepare(query);
    this.#cache.set(query, stmt);
    return stmt;
  }
}

/** Open (creating if absent) a SQLite database at `file`, tuned for a daemon. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  // WAL keeps concurrent readers off the writer's back; NORMAL is the standard
  // durability/throughput trade for WAL. FULL sync on every DO write would make
  // journal flushes (every 25 ms) needlessly expensive.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

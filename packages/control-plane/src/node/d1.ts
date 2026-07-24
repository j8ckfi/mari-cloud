// The D1 equivalent for Node: fleet-level relational data on local SQLite.
//
// D1 is "SQLite at the edge", so a private instance needs nothing more exotic
// than `node:sqlite` behind the same API. Two consumers pin the shape:
//
//   * `db/fleet.ts` + `db/apply.ts` — raw `prepare().bind().first()/all()/run()`
//     and `batch()`;
//   * `drizzle-orm/d1` under Better Auth — which calls `prepare(sql)` ONCE and
//     then `stmt.bind(...params)` per execution, so `bind` must return a NEW
//     bound statement rather than mutating (drizzle re-binds the same prepared
//     query concurrently), and needs `.all()` → `{ results }`, `.raw()` →
//     arrays of column values, and `.run()` → `{ meta.changes }`.

import { DatabaseSync } from 'node:sqlite';
import { openDatabase, type SqlValue } from './sql.js';

interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: D1Meta;
}

const RETURNS_ROWS = /^\s*(?:with\b|select\b|pragma\b|explain\b)/i;
const HAS_RETURNING = /\breturning\b/i;

function meta(changes = 0, lastRowId = 0, rowsRead = 0): D1Meta {
  return {
    duration: 0,
    changes,
    last_row_id: lastRowId,
    rows_read: rowsRead,
    rows_written: changes,
    changed_db: changes > 0,
  };
}

/** One prepared (and possibly bound) statement. */
export class NodeD1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  /** Returns a NEW statement carrying `values`; never mutates the receiver. */
  bind(...values: unknown[]): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.db, this.sql, values.map(coerce));
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const rows = this.#rows<Record<string, unknown>>();
    const row = rows[0];
    if (row === undefined) return null;
    if (column !== undefined) return (row[column] ?? null) as T;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (!this.#producesRows()) {
      const res = this.#run();
      return { results: [], success: true, meta: res };
    }
    const rows = this.#rows<T>();
    return { results: rows, success: true, meta: meta(0, 0, rows.length) };
  }

  /** Rows as arrays of column values (drizzle's `values()` path). */
  async raw<T = SqlValue[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = this.#rows<Record<string, SqlValue>>();
    const out: SqlValue[][] = rows.map((r) => Object.values(r));
    if (options?.columnNames && rows[0]) out.unshift(Object.keys(rows[0]));
    return out as unknown as T[];
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.#producesRows()) {
      const rows = this.#rows<T>();
      return { results: rows, success: true, meta: meta(0, 0, rows.length) };
    }
    return { results: [], success: true, meta: this.#run() };
  }

  #producesRows(): boolean {
    return RETURNS_ROWS.test(this.sql) || HAS_RETURNING.test(this.sql);
  }

  #rows<T>(): T[] {
    return this.db.prepare(this.sql).all(...(this.params as never[])) as T[];
  }

  #run(): D1Meta {
    const res = this.db.prepare(this.sql).run(...(this.params as never[]));
    return meta(Number(res.changes ?? 0), Number(res.lastInsertRowid ?? 0));
  }
}

export class NodeD1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.db, sql);
  }

  /** D1 runs a batch as one implicit transaction; so does this. */
  async batch<T = Record<string, unknown>>(
    statements: NodeD1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN');
    try {
      const out: D1Result<T>[] = [];
      for (const stmt of statements) out.push(await stmt.run<T>());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Not part of D1's public surface on Workers; used by the runtime to close
   *  the file cleanly on shutdown. */
  close(): void {
    this.db.close();
  }
}

/** SQLite cannot bind booleans or `undefined`; D1 coerces them the same way. */
function coerce(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return JSON.stringify(v);
}

/** Open (creating if absent) the fleet database. */
export function openD1(file: string): NodeD1Database {
  return new NodeD1Database(openDatabase(file));
}

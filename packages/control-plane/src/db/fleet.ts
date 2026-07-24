// Fleet-level data access over D1 (raw prepared statements). Kept separate from
// the Better Auth drizzle tables so the auth adapter's schema stays minimal.
//
// A computer's authoritative live state (spec 3.2: state, epoch, head, layout,
// attention) lives in its Durable Object. D1 carries the fleet ROW — identity,
// ownership, lineage, and a denormalized `state`/`head` copy the DO writes on
// transition so the fleet view renders without waking anything (spec 8.2/8.3).

import type { ComputerState } from '@mari/shared';

/** A fleet row. */
export interface ComputerRow {
  id: string;
  name: string;
  userId: string;
  parentComputer: string | null;
  head: string | null;
  state: ComputerState;
  excludeGlobs: string[];
  createdAt: number;
}

function rowToComputer(r: Record<string, unknown>): ComputerRow {
  return {
    id: String(r['id']),
    name: String(r['name']),
    userId: String(r['userId']),
    parentComputer: r['parentComputer'] == null ? null : String(r['parentComputer']),
    head: r['head'] == null ? null : String(r['head']),
    state: String(r['state'] ?? 'cold') as ComputerState,
    excludeGlobs: parseGlobs(r['excludeGlobs']),
    createdAt: Number(r['createdAt'] ?? 0),
  };
}

function parseGlobs(v: unknown): string[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface CreateComputerInput {
  id: string;
  name: string;
  userId: string;
  parentComputer?: string | null;
  head?: string | null;
  state?: ComputerState;
  excludeGlobs?: string[];
}

export async function insertComputer(db: D1Database, input: CreateComputerInput): Promise<ComputerRow> {
  const row: ComputerRow = {
    id: input.id,
    name: input.name,
    userId: input.userId,
    parentComputer: input.parentComputer ?? null,
    head: input.head ?? null,
    state: input.state ?? 'cold',
    excludeGlobs: input.excludeGlobs ?? [],
    createdAt: Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO computers (id, name, userId, parentComputer, head, state, excludeGlobs, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.userId,
      row.parentComputer,
      row.head,
      row.state,
      JSON.stringify(row.excludeGlobs),
      row.createdAt,
    )
    .run();
  return row;
}

export async function getComputer(db: D1Database, id: string): Promise<ComputerRow | null> {
  const r = await db.prepare(`SELECT * FROM computers WHERE id = ?`).bind(id).first();
  return r ? rowToComputer(r as Record<string, unknown>) : null;
}

/** Fetch a computer that belongs to `userId`, or null (ownership-scoped). */
export async function getOwnedComputer(
  db: D1Database,
  id: string,
  userId: string,
): Promise<ComputerRow | null> {
  const r = await db
    .prepare(`SELECT * FROM computers WHERE id = ? AND userId = ?`)
    .bind(id, userId)
    .first();
  return r ? rowToComputer(r as Record<string, unknown>) : null;
}

export async function listComputers(db: D1Database, userId: string): Promise<ComputerRow[]> {
  const res = await db
    .prepare(`SELECT * FROM computers WHERE userId = ? ORDER BY createdAt DESC`)
    .bind(userId)
    .all();
  return (res.results as Record<string, unknown>[]).map(rowToComputer);
}

export async function renameComputer(
  db: D1Database,
  id: string,
  userId: string,
  name: string,
): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE computers SET name = ? WHERE id = ? AND userId = ?`)
    .bind(name, id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteComputer(db: D1Database, id: string, userId: string): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM computers WHERE id = ? AND userId = ?`)
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Denormalized state/head update, called by the DO on a transition. */
export async function updateComputerState(
  db: D1Database,
  id: string,
  state: ComputerState,
  head: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE computers SET state = ?, head = COALESCE(?, head) WHERE id = ?`)
    .bind(state, head, id)
    .run();
}

export async function insertLineage(
  db: D1Database,
  child: string,
  parent: string,
): Promise<void> {
  await db
    .prepare(`INSERT INTO lineage (child, parent, at) VALUES (?, ?, ?)`)
    .bind(child, parent, Date.now())
    .run();
}

// ---- Credential vault (spec 10.1) ----

export async function setSecret(
  db: D1Database,
  computerId: string,
  name: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO secrets (computerId, name, value) VALUES (?, ?, ?)
       ON CONFLICT(computerId, name) DO UPDATE SET value = excluded.value`,
    )
    .bind(computerId, name, value)
    .run();
}

/** Names only — the fleet API never returns secret VALUES. */
export async function listSecretNames(db: D1Database, computerId: string): Promise<string[]> {
  const res = await db
    .prepare(`SELECT name FROM secrets WHERE computerId = ? ORDER BY name`)
    .bind(computerId)
    .all();
  return (res.results as { name: string }[]).map((r) => r.name);
}

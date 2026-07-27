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

/** Atomic count-cap + insert. The older `canCreateComputer` read is retained so
 * routes can return a helpful current count, but this single D1 statement is the
 * authority: concurrent create/fork requests cannot both pass a COUNT then
 * overfill the account. `null` means the cap was already full. */
export async function insertComputerWithinLimit(
  db: D1Database,
  input: CreateComputerInput,
  maxComputers: number,
): Promise<ComputerRow | null> {
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
  const result = await db
    .prepare(
      `INSERT INTO computers (id, name, userId, parentComputer, head, state, excludeGlobs, createdAt)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM computers WHERE userId = ?) < ?`,
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
      row.userId,
      Math.max(0, Math.floor(maxComputers)),
    )
    .run();
  return (result.meta?.changes ?? 0) > 0 ? row : null;
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
  // Ownership is checked by the caller before substrate teardown. Keep it on
  // the final delete too, then remove all content-bearing D1 dependants in the
  // same batch so "delete" cannot leave vault values or lineage behind.
  const results = await db.batch([
    db.prepare(`DELETE FROM secrets WHERE computerId = ?`).bind(id),
    db.prepare(`DELETE FROM lineage WHERE child = ? OR parent = ?`).bind(id, id),
    db.prepare(`DELETE FROM computers WHERE id = ? AND userId = ?`).bind(id, userId),
  ]);
  const deleted = (results[2]?.meta?.changes ?? 0) > 0;
  if (deleted) {
    // Usage is non-content accounting and migration 0003 may not exist on an
    // old private install yet. Remove it when present without turning a
    // successful secure delete into an error on that legacy schema.
    try {
      await db.prepare(`DELETE FROM usage_ledger WHERE computerId = ?`).bind(id).run();
    } catch {
      // Table not migrated yet.
    }
  }
  return deleted;
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

/**
 * Names AND values — the vault read that spec 10.1 exists for.
 *
 * The ONLY caller is the Durable Object's `materialize` configuration
 * (`#maridEnv`): "the supervisor injects credentials at run start", and marid
 * resolves a run's `env_names` out of its own process environment
 * (crates/marid/src/run.rs), so the values have to reach the supervisor process
 * and nowhere else. They never enter an HTTP response, an event, a journal or a
 * `start_run` frame (contracts.md §5.2 keeps that message name-only).
 *
 * Before this existed the vault was write-only: a stored key was listed by name
 * and never reached a run, so every agent that needs an API key was unusable.
 */
export async function listSecrets(
  db: D1Database,
  computerId: string,
): Promise<{ name: string; value: string }[]> {
  const res = await db
    .prepare(`SELECT name, value FROM secrets WHERE computerId = ? ORDER BY name`)
    .bind(computerId)
    .all();
  return (res.results as { name: string; value: string }[]).map((r) => ({
    name: String(r.name),
    value: String(r.value),
  }));
}

/** Remove one vault entry. Returns false when there was nothing to remove. */
export async function deleteSecret(
  db: D1Database,
  computerId: string,
  name: string,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM secrets WHERE computerId = ? AND name = ?`)
    .bind(computerId, name)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

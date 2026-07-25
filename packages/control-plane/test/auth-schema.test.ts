// The passkey table, and the two places it has to exist.
//
// D1 has no migration runner in the app: `applySchema` (src/db/apply.ts) creates
// tables for the dev seed and for this suite, while the HOSTED database — which
// no test touches — is created by `wrangler d1 migrations apply` from
// `migrations/0001_init.sql`. Two sources of truth for the same schema is how a
// deploy ends up missing a table, so this file pins them together and pins both
// against the passkey plugin's OWN declared field list. Bump the plugin, add a
// field, and this fails instead of the hosted sign-in failing.

import { describe, it, expect, beforeAll } from 'vitest';
import { passkey as passkeyPlugin } from '@better-auth/passkey';
import migrationSql from '../migrations/0001_init.sql?raw';
import { SCHEMA_STATEMENTS } from '../src/db/apply';
import { authSchema } from '../src/db/schema';
import { env, ensureSchema } from './helpers';

/** Collapse whitespace so formatting is not a difference. */
function normalize(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').replace(/;$/, '');
}

/** Split a .sql file into statements, dropping `--` comment lines. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map(normalize)
    .filter((s) => s.length > 0);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

async function columnsOf(table: string): Promise<Map<string, ColumnInfo>> {
  const rows = await env.DB.prepare(
    `SELECT name, type, "notnull", pk FROM pragma_table_info(?)`,
  )
    .bind(table)
    .all<ColumnInfo>();
  return new Map(rows.results.map((r) => [r.name, r]));
}

describe('D1 schema: apply.ts and the wrangler migration cannot drift', () => {
  it('carries byte-for-byte the same statements, in the same order', () => {
    const fromCode = SCHEMA_STATEMENTS.map(normalize);
    const fromMigration = statementsOf(migrationSql);
    expect(fromMigration).toEqual(fromCode);
    // Sanity: this is a real schema, not an empty comparison. 5 Better Auth
    // tables (user/session/account/verification/passkey) + 2 passkey indexes +
    // 3 fleet tables.
    expect(fromCode.length).toBe(10);
  });

  it('is idempotent — every statement is IF NOT EXISTS, so re-application is safe', () => {
    for (const statement of SCHEMA_STATEMENTS) {
      expect(normalize(statement)).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /);
    }
  });

  it('includes the passkey table and its lookup indexes', () => {
    const all = SCHEMA_STATEMENTS.map(normalize).join('\n');
    expect(all).toContain('CREATE TABLE IF NOT EXISTS passkey');
    // `credentialID` is the lookup key on every authentication ceremony — and it
    // must be UNIQUE, or which account an assertion authenticates would depend
    // on row order. `userId` is the lookup key for list/registration.
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON passkey\(credentialID\)/);
    expect(all).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON passkey\(userId\)/);
  });
});

describe('the passkey table matches the plugin that reads it', () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  /** The plugin's own field declarations — the authoritative list. */
  const fields = passkeyPlugin().schema!.passkey!.fields as Record<
    string,
    { type: string; required?: boolean }
  >;

  it('has a column for every field the plugin declares', async () => {
    const columns = await columnsOf('passkey');
    expect(columns.size).toBeGreaterThan(0);
    // `id` is implicit in every Better Auth model.
    expect(columns.get('id')?.pk).toBe(1);
    for (const name of Object.keys(fields)) {
      expect(columns.has(name), `passkey.${name} missing from D1`).toBe(true);
    }
    // And nothing extra: an unexpected column means the drizzle mapping and the
    // DDL have parted ways.
    const expected = new Set(['id', ...Object.keys(fields)]);
    expect([...columns.keys()].filter((c) => !expected.has(c))).toEqual([]);
  });

  it('marks exactly the plugin-required fields NOT NULL', async () => {
    const columns = await columnsOf('passkey');
    for (const [name, spec] of Object.entries(fields)) {
      const column = columns.get(name)!;
      expect(Boolean(column.notnull), `passkey.${name} nullability`).toBe(
        spec.required === true,
      );
    }
  });

  it('stores dates and booleans as INTEGER, the way the drizzle mapping reads them', async () => {
    const columns = await columnsOf('passkey');
    expect(columns.get('counter')?.type).toBe('INTEGER');
    expect(columns.get('backedUp')?.type).toBe('INTEGER');
    expect(columns.get('createdAt')?.type).toBe('INTEGER');
    expect(columns.get('publicKey')?.type).toBe('TEXT');
    expect(columns.get('credentialID')?.type).toBe('TEXT');
  });

  it('is registered in the drizzle schema the adapter resolves columns through', async () => {
    expect(Object.keys(authSchema)).toContain('passkey');
    const columns = await columnsOf('passkey');
    // The drizzle adapter looks up `schemaModel[fieldName]`, so every declared
    // field must be a property on the table object with the SAME column name.
    for (const name of ['id', ...Object.keys(fields)]) {
      const column = (authSchema.passkey as unknown as Record<string, { name?: string }>)[name];
      expect(column, `drizzle passkey.${name}`).toBeDefined();
      expect(column!.name).toBe(name);
      expect(columns.has(name)).toBe(true);
    }
  });

  it('actually refuses a duplicate credentialID at the database level', async () => {
    const one = `dup-${crypto.randomUUID()}`;
    const credentialID = `cred-${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
      .bind(one, 'dup', `${one}@mari.test`, now, now)
      .run();
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp)
         VALUES (?, 'pk', ?, ?, 0, 'multiDevice', 1)`,
      )
        .bind(id, one, credentialID)
        .run();
    await insert(`pk-${crypto.randomUUID()}`);
    await expect(insert(`pk-${crypto.randomUUID()}`)).rejects.toThrow(/UNIQUE/i);
  });

  it('references user(id) so a deleted account cannot leave credentials behind', () => {
    const ddl = SCHEMA_STATEMENTS.map(normalize).find((s) =>
      s.startsWith('CREATE TABLE IF NOT EXISTS passkey'),
    )!;
    expect(ddl).toContain('userId TEXT NOT NULL REFERENCES user(id)');
  });
});

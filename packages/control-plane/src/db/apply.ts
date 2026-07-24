// Schema DDL for D1. Applied by the dev-seed route and by the test harness
// (there is no migration runner in v0; the private-instance milestone adds one).
// The `CREATE TABLE` column names match `schema.ts` exactly so Better Auth's
// drizzle adapter finds every column.

const STATEMENTS: string[] = [
  // ---- Better Auth core ----
  `CREATE TABLE IF NOT EXISTS user (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     emailVerified INTEGER NOT NULL DEFAULT 0,
     image TEXT,
     createdAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS session (
     id TEXT PRIMARY KEY,
     expiresAt INTEGER NOT NULL,
     token TEXT NOT NULL UNIQUE,
     createdAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL,
     ipAddress TEXT,
     userAgent TEXT,
     userId TEXT NOT NULL REFERENCES user(id)
   )`,
  `CREATE TABLE IF NOT EXISTS account (
     id TEXT PRIMARY KEY,
     accountId TEXT NOT NULL,
     providerId TEXT NOT NULL,
     userId TEXT NOT NULL REFERENCES user(id),
     accessToken TEXT,
     refreshToken TEXT,
     idToken TEXT,
     accessTokenExpiresAt INTEGER,
     refreshTokenExpiresAt INTEGER,
     scope TEXT,
     password TEXT,
     createdAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS verification (
     id TEXT PRIMARY KEY,
     identifier TEXT NOT NULL,
     value TEXT NOT NULL,
     expiresAt INTEGER NOT NULL,
     createdAt INTEGER,
     updatedAt INTEGER
   )`,
  // ---- Fleet ----
  `CREATE TABLE IF NOT EXISTS computers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     userId TEXT NOT NULL,
     parentComputer TEXT,
     head TEXT,
     state TEXT NOT NULL DEFAULT 'cold',
     excludeGlobs TEXT,
     createdAt INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS lineage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     child TEXT NOT NULL,
     parent TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // Credential vault (spec 10.1): per-computer secret NAMES + values. Values
  // only ever flow supervisor-ward in StartRun; never into a manifest.
  `CREATE TABLE IF NOT EXISTS secrets (
     computerId TEXT NOT NULL,
     name TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (computerId, name)
   )`,
];

/** Create every table if absent. Idempotent. */
export async function applySchema(db: D1Database): Promise<void> {
  await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
}

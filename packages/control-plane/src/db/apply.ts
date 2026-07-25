// Schema DDL for D1. Applied by the dev-seed route and by the test harness, and
// — for the hosted database, which no test ever touches — by wrangler's D1
// migration runner: `migrations/0001_init.sql` carries these same statements
// verbatim and `wrangler d1 migrations apply mari --env production --remote`
// runs it (deploy/README.md). test/auth-schema.test.ts asserts the two are
// identical, so a table added here can never be missing from the hosted DB.
//
// The `CREATE TABLE` column names match `schema.ts` exactly so Better Auth's
// drizzle adapter finds every column.

/** The DDL, in application order. Exported so the migration-drift test can
 *  compare it against `migrations/0001_init.sql`. */
export const SCHEMA_STATEMENTS: readonly string[] = [
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
  // The @better-auth/passkey model. `credentialID` is looked up on every
  // authentication ceremony, so it carries an index.
  `CREATE TABLE IF NOT EXISTS passkey (
     id TEXT PRIMARY KEY,
     name TEXT,
     publicKey TEXT NOT NULL,
     userId TEXT NOT NULL REFERENCES user(id),
     credentialID TEXT NOT NULL,
     counter INTEGER NOT NULL,
     deviceType TEXT NOT NULL,
     backedUp INTEGER NOT NULL,
     transports TEXT,
     createdAt INTEGER,
     aaguid TEXT
   )`,
  // UNIQUE, not merely indexed: `verify-authentication` finds the credential by
  // `credentialID` alone, so two rows sharing one id would make which account an
  // assertion authenticates depend on row order. The plugin only declares an
  // index; the uniqueness is a real integrity constraint on top of it.
  `CREATE UNIQUE INDEX IF NOT EXISTS passkey_credentialID ON passkey(credentialID)`,
  `CREATE INDEX IF NOT EXISTS passkey_userId ON passkey(userId)`,
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
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

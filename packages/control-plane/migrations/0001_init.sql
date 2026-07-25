-- Mari control plane — D1 schema, migration 0001.
--
-- GENERATED FROM src/db/apply.ts (SCHEMA_STATEMENTS) and asserted statement-for-
-- statement identical to it by test/auth-schema.test.ts. Edit apply.ts, then
-- re-emit this file — see deploy/README.md. Every statement is IF NOT EXISTS, so
-- re-application is a no-op and this migration is safe to run against a database
-- the dev seed already created.
--
-- Apply:  wrangler d1 migrations apply mari --env production --remote

CREATE TABLE IF NOT EXISTS user (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     emailVerified INTEGER NOT NULL DEFAULT 0,
     image TEXT,
     createdAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL
   );

CREATE TABLE IF NOT EXISTS session (
     id TEXT PRIMARY KEY,
     expiresAt INTEGER NOT NULL,
     token TEXT NOT NULL UNIQUE,
     createdAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL,
     ipAddress TEXT,
     userAgent TEXT,
     userId TEXT NOT NULL REFERENCES user(id)
   );

CREATE TABLE IF NOT EXISTS account (
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
   );

CREATE TABLE IF NOT EXISTS verification (
     id TEXT PRIMARY KEY,
     identifier TEXT NOT NULL,
     value TEXT NOT NULL,
     expiresAt INTEGER NOT NULL,
     createdAt INTEGER,
     updatedAt INTEGER
   );

CREATE TABLE IF NOT EXISTS passkey (
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
   );

CREATE UNIQUE INDEX IF NOT EXISTS passkey_credentialID ON passkey(credentialID);

CREATE INDEX IF NOT EXISTS passkey_userId ON passkey(userId);

CREATE TABLE IF NOT EXISTS computers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     userId TEXT NOT NULL,
     parentComputer TEXT,
     head TEXT,
     state TEXT NOT NULL DEFAULT 'cold',
     excludeGlobs TEXT,
     createdAt INTEGER NOT NULL
   );

CREATE TABLE IF NOT EXISTS lineage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     child TEXT NOT NULL,
     parent TEXT NOT NULL,
     at INTEGER NOT NULL
   );

CREATE TABLE IF NOT EXISTS secrets (
     computerId TEXT NOT NULL,
     name TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (computerId, name)
   );

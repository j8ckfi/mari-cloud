-- Mari control plane — D1 schema, migration 0003: usage accounting (spec 8.2).
--
-- GENERATED FROM src/usage.ts (USAGE_SCHEMA_STATEMENTS) and asserted
-- statement-for-statement identical to it by test/usage.test.ts — the same
-- no-drift discipline test/auth-schema.test.ts applies to 0001. Edit usage.ts,
-- then re-emit this file. Every statement is IF NOT EXISTS, so re-application
-- is a no-op and this migration is safe against a database the runtime ensure
-- (`ensureUsageSchema`) already touched.
--
-- 0002 is deliberately not taken: the limits lane owns migrations/0002_limits.sql
-- (quota metering, `usage_period`). This ledger meters COST (awake/box time and
-- run counts per computer per calendar month); if the two tables converge, the
-- merge note lives in docs/obs-hooks.md.
--
-- Apply:  wrangler d1 migrations apply mari --env production --remote

CREATE TABLE IF NOT EXISTS usage_ledger (
     computerId TEXT NOT NULL,
     period TEXT NOT NULL,
     awakeMs INTEGER NOT NULL DEFAULT 0,
     boxMs INTEGER NOT NULL DEFAULT 0,
     runCount INTEGER NOT NULL DEFAULT 0,
     updatedAt INTEGER NOT NULL,
     PRIMARY KEY (computerId, period)
   );

CREATE INDEX IF NOT EXISTS usage_ledger_period ON usage_ledger(period);

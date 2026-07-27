-- Mari control plane — D1 schema, migration 0002: per-user usage ledger
-- (spec 10.3 quotas).
--
-- GENERATED FROM src/limits.ts (LIMITS_SCHEMA_STATEMENTS) and asserted
-- statement-for-statement identical to it by test/limits.test.ts — the same
-- no-drift discipline migration 0001 has with src/db/apply.ts. Edit limits.ts,
-- then re-emit this file. The statement is IF NOT EXISTS (limits.ts also
-- applies it lazily at first use), so re-application is a no-op.
--
-- Apply:  wrangler d1 migrations apply mari --env production --remote

CREATE TABLE IF NOT EXISTS usage_period (
     userId TEXT NOT NULL,
     period TEXT NOT NULL,
     awakeMs INTEGER NOT NULL DEFAULT 0,
     boxMs INTEGER NOT NULL DEFAULT 0,
     updatedAt INTEGER NOT NULL,
     PRIMARY KEY (userId, period)
   );

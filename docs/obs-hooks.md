# Usage-accounting hooks

This document is the integration contract between `ComputerDO` lifecycle state
and the per-computer `usage_ledger` in `packages/control-plane/src/usage.ts`.
The ledger is internal cost accounting, not billing and not a quota gate.

## AWAKE intervals

`ComputerDO.#closeAwakeStretch(reopen)` is the single close/checkpoint point:

1. it reads `awakeSince`, adds the non-negative interval to the Durable Object's
   lifetime `awakeMs`, and clears the start;
2. with `reopen=true`, it immediately sets a new `awakeSince` so an actually
   AWAKE computer continues accruing without a gap; and
3. it schedules `#recordAwakeInterval(startedAt, endedAt)` with
   `ctx.waitUntil`.

The close is called on lifecycle exits/recovery, permanent deletion and the
recurring AWAKE alarm. The alarm uses `reopen=true`, so a long-running computer
is checkpointed rather than remaining invisible until it eventually sleeps.
`noteAwakeInterval` splits an interval across UTC month boundaries and upserts
one row per `(computerId, period)`.

`#recordAwakeInterval` also writes the same interval to the account quota ledger
through `accumulateAwakeInterval`. Keep the two writes adjacent. Adding another
AWAKE close hook elsewhere risks double counting; bypassing this hook creates a
cost and quota gap.

## Completed runs

`ComputerDO.#onRunCompleted` records execution only when the run's previous
status was not already `completed`. It computes `max(0, endedAt - startedAt)` and
schedules `noteRunExecution`, which adds one `runCount` and the interval to
`boxMs` in the completion month.

This guards duplicate completion frames inside one Durable Object state, but it
is not a provider-billing idempotency key. The ledger has no event/outbox ID and
no substrate dimension; see [`costs.md`](costs.md) before interpreting `boxMs`.

## Failure and delivery semantics

Accounting must never break the product transition. The `note*` wrappers catch
D1 failures, log `usage_write_failed`, and resolve. The quota write is collected
with `Promise.allSettled`; its rejection is also warned and does not reject the
state transition. Writes are scheduled with `waitUntil`, not synchronously
awaited by the user operation.

Consequences:

- a D1 outage can undercount cost and quota (fail-open);
- there is no durable outbox/replay or cross-ledger transaction;
- the accounting and quota ledgers can temporarily or permanently differ; and
- retry/crash boundaries cannot satisfy invoice-grade exactly-once semantics.

Alert on every write failure. Reconciliation/outbox + idempotency keys are
required before any value is used for customer billing.

## Schema ownership

Hosted deployment applies `migrations/0003_usage.sql`: `usage_ledger` plus its
period index. `test/usage.test.ts` pins that migration to
`USAGE_SCHEMA_STATEMENTS`. `usage.ts` also performs an idempotent runtime ensure
for private/test databases, but the production migration remains mandatory.

`usage_period` from migration `0002` is intentionally separate: it is per user
and enforces quota, while `usage_ledger` is per computer and reports cost. Do not
merge them without preserving both access patterns and revising the failure
semantics above.

# Hosted quota hooks

Mari v0.1 limits the number of computers an account may hold and gates new
compute after the account crosses its monthly AWAKE allowance. The policy lives
in `packages/control-plane/src/limits.ts`; lifecycle measurement lives in
`ComputerDO`.

## Plan resolution

| Deployment | Computers | AWAKE compute per UTC month |
|---|---:|---:|
| Hosted production, vars unset | 3 | 100 hours |
| Private/dev/test, vars unset | unlimited | unlimited |

`LIMIT_MAX_COMPUTERS` and `LIMIT_COMPUTE_HOURS` override the defaults. A finite
positive value is a cap; `0` or a negative value explicitly means unlimited; an
unset/blank/invalid value falls back to the deployment default. The API exposes
the resolved limits and current month through `GET /api/me/limits`.

There is no egress quota in v0.1 because the control plane cannot truthfully
attribute provider egress to an account.

## Computer-count enforcement

Create and fork first perform the readable `canCreateComputer` gate, then insert
through `insertComputerWithinLimit` when a cap exists. The insert is a single D1
statement whose `WHERE` count check and insert execute together, closing the
race where concurrent creates both passed a separate count. A refusal is HTTP
403 `limit_computers`; no Durable Object is initialized for the refused row.

Permanent delete is strict in the other direction: `ComputerDO` must confirm
substrate destruction before the fleet row is removed. A destroy failure keeps
the row/slot, preventing a paid orphan from being hidden by freeing capacity.

## Compute enforcement

`canWake` reads the current UTC month's per-user `usage_period.awakeMs`. At or
above the cap, these authenticated owner routes refuse **before** addressing the
computer Durable Object:

- explicit `POST /api/computers/:id/wake`;
- run creation (it may implicitly wake);
- file write and upload (they enqueue work and may implicitly wake).

Preview proxy traffic can also wake a computer, but v0.1 does not yet apply the
monthly compute gate on that host-routed path. Treat that as a documented quota
coverage gap, not as unmetered billing: the resulting AWAKE interval is still
checkpointed into the ledger.

The gate is not a kill switch. It does not stop an already-AWAKE computer or an
already-running command, and it does not prevent non-wake reads. The ordinary
idle/cold policy ends the generation. Periodic AWAKE alarm checkpoints close and
reopen the interval so a long generation becomes visible to the cap instead of
waiting until sleep; some overshoot remains possible between checkpoints and
concurrent requests.

## Measurement and month boundaries

`ComputerDO.#closeAwakeStretch` sends every closed/checkpointed interval to
`accumulateAwakeInterval`. `splitUsagePeriods` charges each slice to the UTC
calendar month in which it occurred, so a generation crossing midnight on the
first does not charge the entire interval to its exit month. `usage_period` is
keyed by `(userId, YYYY-MM)`; a new month resets naturally by using a new row.

The hosted schema is migration `0002_limits.sql`, pinned to
`LIMITS_SCHEMA_STATEMENTS` by `test/limits.test.ts`. Runtime idempotent ensure is
for private/test resilience, not a replacement for the deployment migration.

## Failure and consistency semantics

Quota metering is best effort and fail-open: a ledger write must not fail a
sleep, recovery, delete or other lifecycle transition. D1 failures are warned
and can undercount the month; there is no durable outbox or invoice-grade
exactly-once reconciliation. Alert on quota/usage write failures and repair the
ledger before relying on it for abuse control.

Computer-count enforcement is stronger because the capped insert is atomic.
Compute enforcement is intentionally approximate: it gates new work using
observed, checkpointed AWAKE time and never tears down existing user work.

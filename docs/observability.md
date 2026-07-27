# Production observability

Mari emits content-free structured logs and exposes an unauthenticated
`GET /healthz` deployment probe. The production Wrangler environment persists
invocation and application logs with sampling rate `1.0`; launch diagnosis must
not depend on a sampled-away failure.

## Request logs and request IDs

`packages/control-plane/src/handler.ts` writes one JSON line per request:

- `http_access`: method, **route template**, status and duration;
- `http_error`: the same envelope plus the sanitized error; and
- `requestId`, echoed as `x-request-id` on non-upgrade responses.

Paths are never logged raw. Known routes become templates such as
`/api/computers/:id/runs/:runId`; preview traffic is `preview:host`; every
unrecognized path becomes `/unknown`. Query strings, request/response bodies,
terminal/journal bytes, user IDs, computer IDs, run IDs and secret names are not
part of the access record.

`packages/control-plane/src/obs.ts` recursively redacts values under keys matching
`token`, `secret`, `cookie`, `authorization`, `key` or `password`, masks common
credential patterns inside free-form strings, replaces binary buffers with a
byte count, caps depth, and truncates long strings. This is defense in depth,
not permission to log user content. New log events should contain lifecycle
facts and bounded error categories only.

## `/healthz`

A healthy response is HTTP 200 with `ok:true`, the control-plane version and:

- `d1: "ok"` after a bounded `SELECT 1`;
- `r2: "ok"` after a bounded `HEAD healthz-probe` (a missing object still proves
  the binding answered);
- `storeConfig: "ok"` for an S3 store only when `CF_ACCOUNT_ID`,
  `R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_API_TOKEN` are bound; and
- `do: "ok"` when the `COMPUTER` namespace can construct a stub.

D1/R2/config failures make the response 503. A DO-binding construction failure
is reported in the body but does not currently change `ok`.

A 200 is intentionally narrow. It does **not** call a Durable Object, start or
probe a container, mint temporary R2 credentials, exercise the R2 S3 endpoint,
validate the parent token's permission, test DNS/TLS/preview routing, or perform
an auth/passkey ceremony. Use the ordered production smoke test in
[`deploy/DEPLOY.md`](../deploy/DEPLOY.md) for those paths.

## Launch operation

Tail the production Worker while running the smoke test:

```sh
cd packages/control-plane
wrangler tail mari-control-plane-production --env production
```

Production `wrangler.jsonc` enables persisted invocation and application logs at
sampling rate 1.0. Cloudflare dashboard retention/export and notifications are
operator configuration; the repository does not provision an alert destination.
Review log volume and retention cost after real traffic, then change sampling
only with an explicit loss-of-coverage decision.

## Alerts to configure

At minimum, alert or build a query for:

- `/healthz` 503 or `storeConfig:"fail"`;
- `http_error` rate and sustained 5xx by route template;
- wake failures, retries, abandoned wakes, capacity refusals and bounded platform
  timeouts;
- temporary-R2-credential mint failure/15-second timeout and credential rotation;
- `usage_write_failed` or the quota-ledger warning (accounting gaps);
- permanent-delete/destroy failure (possible paid orphan; fleet row is retained);
- final snapshot missed, substrate lost and supervisor lost incidents; and
- **any** static-R2-credential warning in hosted production (expected count zero).

Container/supervisor stdout is available through Cloudflare container logging
when observability is enabled, but the control-plane access log does not promise
to mirror every `marid` line. Correlate by time and lifecycle event without
adding tokens, object keys, terminal output or tenant paths to logs.

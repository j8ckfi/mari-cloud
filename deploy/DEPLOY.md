# Deploying the hosted Mari — `app.mari.sh`

The ordered runbook. Everything in it was rehearsed against the real account
(read-only calls, `wrangler deploy --dry-run`, and a real `wrangler dev --env
production` on local bindings) on **2026-07-27**. No step here has been executed
against production: the Worker does not exist yet.

Three actors, and the split is not negotiable:

| Actor | Owns |
|---|---|
| **OWNER** (holds the Cloudflare account) | secret VALUES, DNS records, the product decision in §1 |
| **ORCHESTRATOR / authorized release agent** | the deploy commands in §4, the smoke checklist in §7, the rollback in §8 |
| **agents without release credentials** | code and dry-run validation only. They must request real secrets instead of inventing or mocking them. |

Prefix every command with the account, or wrangler will pick the wrong one (this
login has two):

```sh
export CLOUDFLARE_ACCOUNT_ID=5b7019b38a2b1c0ce119ecf64e92fd92
cd packages/control-plane          # every wrangler command below runs from here
```

---

## 0. What exists right now (verified, read-only)

| Resource | State |
|---|---|
| Worker `mari-control-plane-production` | **does not exist** — this is a first deploy |
| D1 `mari` (`b423acd3-0b26-482c-a0be-9998393b0cfc`) | exists, **0 tables**; migrations `0001`–`0003` unapplied |
| R2 `mari-store` | exists, WEUR, **0 objects** |
| Zone `mari.sh` | on Cloudflare nameservers (`johnny`/`olivia.ns.cloudflare.com`) |
| `app.mari.sh` | **no DNS record** |
| `*.mari.sh` | **no DNS record, no route** — the preview surface is not reachable |
| Container apps on the account | `perceptrons-runner-runner`, `sailbox-sailbox`, `vibesdk-production-userappsandboxservice` — **all three unrelated to Mari; never touch them** |
| `packages/web/dist` | built (5 files, 3.4 MB / 602 KiB gzip with the Worker) |
| Durable Object migrations | `v1 new_sqlite_classes:[ComputerDO]`, `v2 new_sqlite_classes:[EventsDO]` — each class created **once**, no class renamed or moved between tags. On a first deploy both apply fresh; there is no data-loss path in this list. |

Because the Worker is new, **§8's rollback is a deletion, not a revert.** Read §8
before §4.

---

## 1. Hosted v0.1 substrate wiring

Production is configured for the real hosted substrate:

- `SUBSTRATE_MODE: "cloudflare"` — one Cloudflare Container per computer Durable
  Object. This is the always-on brainstem for the user's PTY, run process,
  scrollback/journal, reconnect fencing and preview proxy.
- `SUPERVISOR_URL_BASE: "wss://app.mari.sh"` — every container dials the control
  plane over TLS; `marid` refuses plaintext WebSockets to a public host because
  the `Hello` carries the fencing token.
- `STORE_URI: "s3://mari-store"` and `COMPUTER_ROOT: "/work"` — `/work` is a
  disposable hydrate/cache. The durable workspace lives in R2 chunks/manifests
  plus the per-computer Durable Object's transactional journal/metadata.
- `CF_ACCOUNT_ID` is set so the supervisor receives
  `AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com`.
- `R2_PARENT_ACCESS_KEY_ID` + `R2_PARENT_API_TOKEN` are required secret bindings.
  At every materialize, the control plane mints a short-lived credential scoped
  inside `tenants/<sha256(owner)>/`: per-computer journal/runs/state/heat plus
  chunks/manifests shared **only by that account's computers**. The supervisor's
  `MARI_STORE` is rewritten to the same opaque tenant root, so another account's
  objects are neither addressable nor listable.
- A new hosted computer gets a deterministic empty manifest immediately when
  `BASE_MANIFEST` is unset. The fleet/operator base manifest remains at the
  bucket root; on first wake the control plane lazily copies that manifest and
  its referenced chunks into the tenant root before minting credentials. The
  supervisor never receives authority to read the global root.

The production preflight suite fails if the Cloudflare flip ships without the
control URL, a non-`fs://` store, a matching container capacity cap, or the R2
temporary-credential secrets.

---

## 2. OWNER: secrets

Secret **values** are typed once, interactively, by the owner. `wrangler secret
put` prompts on stdin and stores the value encrypted; it is never written to the
repo, and no agent ever sees it.

| Secret | Required | What it is for |
|---|---|---|
| `AUTH_SECRET` | **yes** | Signs every Better Auth session cookie. `src/auth.ts` throws at construction when it is missing, is one of the committed placeholders, or is shorter than 32 characters — so a production origin without it answers 500 instead of accepting forged sessions. Generate privately with `openssl rand -base64 32`. |
| `R2_PARENT_ACCESS_KEY_ID` | **yes** | Parent R2 access-key id used only to mint scoped temporary credentials for one computer generation. |
| `R2_PARENT_API_TOKEN` | **yes** | Cloudflare API token for the temporary-access-credentials endpoint. It is never forwarded to a computer; the minted `AWS_*` credential is. |
| `GITHUB_CLIENT_ID` | no | GitHub OAuth. Registers itself **only when both** are present. There is no GitHub OAuth app today; passkeys are the whole hosted auth story. |
| `GITHUB_CLIENT_SECRET` | no | as above |

```sh
wrangler secret put AUTH_SECRET --env production      # required
wrangler secret put R2_PARENT_ACCESS_KEY_ID --env production  # required
wrangler secret put R2_PARENT_API_TOKEN --env production      # required
wrangler secret put GITHUB_CLIENT_ID --env production      # optional
wrangler secret put GITHUB_CLIENT_SECRET --env production  # optional
```

Validate the remote bindings without revealing a value:

```sh
../../deploy/check-production-secrets.sh
```

The static fallback secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are
ignored unless `ALLOW_STATIC_R2_CREDENTIALS=1`. That opt-in and the static pair
are for a private development/MinIO-style deployment only: they are bucket-wide,
have no tenant boundary, and must never be configured on the hosted Worker. The
preflight above fails if either static binding is present remotely.

`env.production.secrets.required` documents the bindings for type generation and
local-development warnings; Wrangler does **not** use it to reject a remote
deploy with missing secrets. That is why the remote preflight is a mandatory
release step rather than a comment in `wrangler.jsonc`.

Wrangler also prints that top-level `AUTH_SECRET` is not inherited into
`env.production.vars`. That warning is expected: the top-level value is a
fail-closed dev placeholder, while production receives an encrypted secret
binding. Do not silence it by copying a value into production vars; use the
remote preflight above as the production check.

---

## 3. Database schema

D1 has no migration-on-boot. This must run **before** the first request, or
sign-up answers 500 (`no such table: user`) — verified locally, and it is the
symptom to look for in §7.

```sh
wrangler d1 migrations apply mari --env production --remote
```

There are **three migrations / 13 SQL statements**:

| Migration | Statements | Adds | Drift test |
|---|---:|---|---|
| `0001_init.sql` | 10 | auth, fleet, lineage and vault schema | `test/auth-schema.test.ts` |
| `0002_limits.sql` | 1 | per-account monthly quota ledger `usage_period` | `test/limits.test.ts` |
| `0003_usage.sql` | 2 | per-computer cost ledger `usage_ledger` + period index | `test/usage.test.ts` |

Every statement is `IF NOT EXISTS`; each migration is pinned to its runtime DDL,
so re-running is a no-op and schema drift fails the suite. Wrangler reports each
migration separately; the complete first apply executes 10 + 1 + 2 statements.

Preview without applying:

```sh
wrangler d1 migrations list mari --env production --remote
```

---

## 4. ORCHESTRATOR: the deploy

Three commands. `packages/web/dist` is already built; if the tree has changed since,
run `pnpm --filter @mari/web build` first — the Worker serves the app from that
directory (`assets.directory`), and a missing one fails the deploy.

```sh
# 1 — verify required REMOTE secret bindings and reject static bucket keys (§2)
../../deploy/check-production-secrets.sh

# 2 — schema (§3)
wrangler d1 migrations apply mari --env production --remote

# 3 — the Worker, assets, custom domain, and Cloudflare Container image
wrangler deploy --env production --domain app.mari.sh
```

What each part is doing:

- `--env production` selects the only deployable environment. Deploying **without**
  it would put the default block on a real `*.workers.dev` origin; `auth.ts` treats
  any public TLS origin as production and refuses, so that mistake fails closed
  rather than serving the committed placeholder secret.
- `--domain app.mari.sh` attaches the custom domain, which creates the DNS record
  and provisions the certificate. `routes` is deliberately absent from
  `wrangler.jsonc` (`test/auth-production.test.ts` asserts that), so the trigger
  comes from the flag. **Repeat the flag on every subsequent deploy**, or move the
  trigger into `env.production.routes` as
  `[{ "pattern": "app.mari.sh", "custom_domain": true }]` and update that test
  deliberately.
- The deploy builds and pushes the container image from `deploy/Dockerfile.mari`.
  It needs a running Docker daemon on the deploying machine.

Expected bindings in the output — check them, this is the cheapest verification
there is:

```
env.COMPUTER (ComputerDO)                Durable Object
env.EVENTS (EventsDO)                    Durable Object
env.DB (mari)                            D1 Database
env.STORE (mari-store)                   R2 Bucket
env.ASSETS                               Assets
env.ENVIRONMENT ("production")
env.PREVIEW_ZONE ("mari.sh")
env.BASE_URL ("https://app.mari.sh")
env.AUTH_RP_ID ("app.mari.sh")
env.DEV_AUTH ("0")   env.DEV_SEED ("0")
env.SUBSTRATE_MODE ("cloudflare")
env.STORE_URI ("s3://mari-store")
env.SUPERVISOR_URL_BASE ("wss://app.mari.sh")
```

Production observability is enabled with persisted invocation + application logs
at sampling rate `1.0`. Keep that unsampled for launch diagnosis; review volume,
retention and price before reducing it. The log and alert contract is in
[`docs/observability.md`](../docs/observability.md).

### Optional hardening: turn the workers.dev origin off

Nothing sets `workers_dev`, so the Worker is also reachable at
`mari-control-plane-production.<subdomain>.workers.dev`. That origin serves the
app but **cannot complete a passkey ceremony** — `AUTH_RP_ID` is `app.mari.sh`,
and in production the ceremony origin is pinned to `BASE_URL` — so it is a second
public front door where sign-in is structurally broken. Add
`"workers_dev": false` to `env.production` to remove it.

---

## 5. The container image

`wrangler deploy` builds and pushes the image itself; there is no separate push
step.

- Needs a **running Docker daemon** on the deploying machine. `deploy/Dockerfile.mari`
  cross-compiles `marid` for **linux/amd64** (what Cloudflare Containers run) from a
  native build stage, so an arm64 workstation does not pay for qemu. Verified: the
  full `--dry-run` builds it end to end.
- Creates the container application **`mari-control-plane-production-computerdo`**
  (the name is pinned in `env.production.containers[0].name`, because wrangler will
  not derive it inside a named environment). Confirm afterwards with
  `wrangler containers list` — and confirm the three unrelated applications in §0
  are untouched.
- `max_instances: 20` caps CONCURRENT AWAKE computers; a wake past it errors
  rather than queueing. `CF_MAX_INSTANCES` mirrors it so the capacity error can
  name the real number; `test/deploy-preflight.test.ts` fails if the two drift.
  **Alert on that error.**
- `instance_type: standard-1`, `constraints.regions: ["WEUR"]` — pinned to the
  chunk store's region, because a cold wake is read-heavy.

Build the image alone, without deploying, to check it or to warm the Docker cache:

```sh
docker build --platform linux/amd64 -f deploy/Dockerfile.mari -t mari/base:v0 .   # from the repo root
```

---

## 6. The preview surface (`*.mari.sh`) — OWNER

Spec 8.5's preview pane needs `{port}--{computer}--{user}.mari.sh` to reach this
Worker. §4 attaches `app.mari.sh` only, so **until this is done the preview pane
cannot load anything**, and `GET /api/computers/:id/preview` will hand the client a
host that does not resolve.

Two pieces, both owner actions:

1. **DNS**: a proxied wildcard record on `mari.sh` — `*` → `AAAA 100::`, proxy
   **on** (the standard placeholder for a Workers-only hostname). Universal SSL
   covers `*.mari.sh`, which is one label — which is exactly why the preview host
   is a single label with `--` separators (`docs/decisions.md`).
2. **Route**: attach the wildcard to this Worker.

```sh
wrangler deploy --env production --domain app.mari.sh --route '*.mari.sh/*'
```

A custom domain cannot be a wildcard, so this one is a **route**, and a route
needs the DNS record from (1) to exist first. As in §4, triggers passed as flags
must be repeated on every deploy. Both forms above were validated with
`--dry-run` (they parse and bundle cleanly); a dry run does not resolve the zone,
so if wrangler cannot infer it from the pattern, declare the route in
`env.production.routes` with an explicit `zone_name: "mari.sh"` instead of passing
the flag.

The surface is authorized before any Durable Object is addressed: the `user` label
is `SHA-256(userId)[0..12]` and is checked against the computer's owner, and a
request must carry either an owning session or an HMAC capability minted by
`GET /api/computers/:id/preview?port=`. An unknown computer and a wrong label
answer the same `404 no_such_preview`.

---

## 7. POST-DEPLOY SMOKE CHECKLIST

Every expected response below was produced by the real Worker on the real
production configuration (`wrangler dev --env production`, local bindings). Run
them in order; the first failure tells you which step above did not happen.

| # | Request | Expected | A different answer means |
|---|---|---|---|
| 1 | `curl -s -o /dev/null -w '%{http_code}\n' https://app.mari.sh/` | `200`, and the body is `<!doctype html>` with `data-theme="dark"` | DNS/route (§4) or the assets directory. **A 200 here proves nothing else** — the app shell is served even when every API call is broken. |
| 1b | `curl -s https://app.mari.sh/healthz` | `200` with `"ok":true`, `"d1":"ok"`, `"r2":"ok"`, `"storeConfig":"ok"`, `"do":"ok"` | `503` or a failed component ⇒ stop. This probes bindings/configuration, not a container start or temporary-credential mint. |
| 2 | `curl -s https://app.mari.sh/api/config` | `200` with `previewZone:"mari.sh"`, both dev flags false, and the configured read/write limits | `500 AuthConfigError: AUTH_SECRET is not bound…` ⇒ §2 not done. `devAuth`/`devSeed` `true` ⇒ **stop and roll back**: a dev login or an unauthenticated session-minting seed route is live. |
| 3 | `curl -s -o /dev/null -w '%{http_code}\n' https://app.mari.sh/api/fleet` | `401 {"error":"unauthorized"}` | `500` ⇒ §2 or §3. `200` ⇒ auth is not enforced; roll back. |
| 4 | `curl -s -X POST -o /dev/null -w '%{http_code}\n' https://app.mari.sh/api/dev/seed` | `404 {"error":"not_found"}` | `200` ⇒ `DEV_SEED` is on. **Roll back immediately**: that route mints a session for anyone. |
| 5 | `curl -s 'https://app.mari.sh/api/auth/passkey/generate-register-options?context=smoke@example.com'` | `200`, and the JSON contains `"rp":{"name":"Mari","id":"app.mari.sh"}` | `500` with an empty body ⇒ **§3 was skipped** (`no such table: user`). An `id` other than `app.mari.sh` ⇒ `AUTH_RP_ID` is wrong and no passkey will ever verify. Nothing is written by this call, so an abandoned ceremony leaves no account. |
| 6 | Browser: open `https://app.mari.sh`, enter an email, press **Create account with a passkey** | The ceremony completes and the fleet view renders, empty | The one check a curl cannot do. Must be the host `app.mari.sh`, not the workers.dev origin (§4). |
| 7 | In the app: **New computer** | The card appears in **deep sleep** (COLD), instantly, with a non-null manifest head and no spinner | A null head ⇒ base-manifest bootstrap failed. The control plane writes/copies manifest metadata and chunks only; nothing is materialized. |
| 8 | Click the computer, then <kbd>⌥R</kbd> and run `echo hello` | The run is accepted immediately, the computer transitions through waking to awake, and terminal bytes show `hello` followed by exit 0. | `503 substrate_not_configured` ⇒ the deployed config is not this v0.1 config. `202 wake_retrying` ⇒ Cloudflare refused capacity/start; the UI should show the retry deadline and the tail should name `capacity` or `timeout`. No terminal bytes after awake ⇒ supervisor dialback or R2 credential/store issue. |
| 8b | `POST /api/computers/<id>/wake` with the session cookie | `200 {"state":"awake",...}` when capacity is available, or `202 {"error":"wake_retrying","retryAt":…}` during a bounded Cloudflare retry. | `503 substrate_not_configured` ⇒ wrong deployed vars. `500 StoreCredentialError…` ⇒ §2 R2 secrets are missing or invalid. |
| 9 | `wrangler tail mari-control-plane-production --env production` while doing 8 | structured `http_access`/lifecycle lines plus `marid` hello/run/journal activity; no secret values or tenant paths in logs. | silence ⇒ you are tailing the wrong Worker or observability was not enabled |
| 10 | `wrangler d1 execute mari --env production --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` | `account`, `computers`, `lineage`, `passkey`, `secrets`, `session`, `usage_ledger`, `usage_period`, `user`, `verification` (plus wrangler's `d1_migrations`) | any missing ⇒ §3. Per-computer live state — runs, journal, incidents, layout — is **not** here; it lives in each Durable Object's SQLite. |
| 11 | `wrangler containers list` | the three unrelated applications from §0 plus `mari-control-plane-production-computerdo` | anything else changed ⇒ stop; another account's workload is in play |

---

## 8. Rollback

**On this first deploy there is nothing to roll back to.** `wrangler rollback`
needs a previous version, and there will be exactly one.

```sh
wrangler versions list --env production          # find the previous version id
wrangler rollback <version-id> --env production -m "why"
```

For the first deploy the only reverse is deletion:

```sh
wrangler delete --env production --dry-run   # prints what it would remove
wrangler delete --env production             # the name comes from the config
```

Know what that costs before typing it:

- **Deleting the Worker deletes its Durable Objects.** Per computer that is the
  fencing epoch, the live journal tables, the incident log, the queued runs and
  the saved pane layout.
- **It does not delete the chunk store.** R2 `mari-store` holds the truth of every
  filesystem (spec 4.1), and the manifest head is also mirrored in D1
  (`computers.head`), so a redeploy can find each computer's filesystem again.
- **It does not delete D1 or R2**, and it does not remove the custom domain's DNS
  record. Remove that in the dashboard if the hostname must stop answering.
- A rollback of the Worker does **not** revert the D1 migrations, and does not
  need to: `0001`–`0003` are additive and `IF NOT EXISTS` throughout.
- If §5 ran, delete the container application separately —
  `wrangler containers delete <id>` with the id from `wrangler containers list`.
  **Read the id twice.** Three unrelated applications live on this account.

# Deploying the hosted Mari — `app.mari.sh`

The ordered runbook. Everything in it was rehearsed against the real account
(read-only calls, `wrangler deploy --dry-run`, and a real `wrangler dev --env
production` on local bindings) on **2026-07-25**. No step here has been executed
against production: the Worker does not exist yet.

Three actors, and the split is not negotiable:

| Actor | Owns |
|---|---|
| **OWNER** (holds the Cloudflare account) | secret VALUES, DNS records, the product decision in §1 |
| **ORCHESTRATOR** | the two deploy commands in §4, the smoke checklist in §7, the rollback in §8 |
| **agents** | nothing here. An agent must never type a secret value, create a DNS record, or run `wrangler deploy` against this origin |

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
| D1 `mari` (`b423acd3-0b26-482c-a0be-9998393b0cfc`) | exists, **0 tables**; `0001_init.sql` unapplied |
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

## 1. BLOCKER: as configured, no computer can wake

`env.production.vars.SUBSTRATE_MODE` is `"fake"`. The fake substrate
(`src/substrate.ts`) hands out handles, reports every instance `alive`, and starts
no process. A deploy in that state can sign in, list a fleet, browse a COLD
computer's manifest and serve the web app — and it can never run a single command.

That is now **loud instead of silent**: on a production environment with the fake
driver, `ComputerDO.wake()` refuses with `substrate_not_configured` (HTTP 503) and
the computer stays at the state it is really in, rather than reporting `awake`
with runs nobody will ever take. Proof:
`packages/control-plane/test/node/unbacked-substrate.test.ts`.

Deploying like this is a legitimate choice — it puts the app, auth and the
read-only surface on the real origin — but say so out loud. A user who presses
*New computer* → *Run* gets a run that is accepted and never starts (spec 8.3
means the run request itself still answers `200 … "state":"pending"`), a computer
that keeps saying deep sleep, and `503 substrate_not_configured` from an explicit
wake. Nothing lies to them; nothing works either.

### What is missing before a hosted computer can wake

Four items. The first is a one-line config change; the rest are real work, and
none of it is done.

1. **`SUBSTRATE_MODE: "cloudflare"`** in `env.production.vars`. The driver itself
   is wired (`computer-do.ts` constructs `createCloudflareProvider` from
   `ctx.container` when the mode says so), tested against a real `ctx.container`
   and, per `e2e/cloudflare.e2e.test.ts`, exercised end to end on a scratch app.
   `docs/decisions.md` records that flipping it is a **product decision** —
   Cloudflare refuses `destroy()`→`start()` on the same Durable Object for
   minutes (measured >563 s), which is exactly what Mari's own tier policy does on
   AWAKE→COLD→AWAKE. If that window is minutes at fleet scale, Sprites should be
   the default and Cloudflare the substrate for computers that idle rarely. That
   call belongs to whoever can run the deploy.
2. **`SUPERVISOR_URL_BASE: "wss://app.mari.sh"`**. `marid`'s `MARI_CONTROL_URL`
   has no default (`crates/marid/src/config.rs`), so with this unset every
   materialized container exits at startup with a clap error and the computer sits
   in WAKING until its watchdog. `wss://`, not `ws://`: marid refuses a plaintext
   control URL to a public host and exits non-zero, because the `Hello` carries
   the computer's fencing token.
3. **A chunk store the container can reach.** All disk on Cloudflare Containers is
   ephemeral (measured: a marker written to `/work` did not survive
   destroy+start), and `STORE_URI` is unset, so `#maridEnv` falls back to
   `fs:///store` — a path on that ephemeral disk. Every chunk a computer writes
   would be discarded at its next stop. Three things are missing here, not one:
   - `deploy/Dockerfile.mari` builds `marid` **without `--features s3`**, so
     `MARI_STORE=s3://mari-store` fails at startup ("s3 store requested but marid
     was built without the `s3` feature");
   - `ComputerDO.#maridEnv` has **no seam for R2 credentials** — it composes a
     fixed `MARI_*` set plus the vault, and R2's S3 endpoint accepts nothing else;
   - no R2 API token exists, so there is no key pair to pass.
   `e2e/cloudflare.e2e.test.ts` works around all three (patches the Dockerfile's
   build line, bakes `AWS_*` into the image, and proxies S3 through the Worker) and
   says so in its header. That workaround is **not** in the production path, and
   `docs/decisions.md` commits to the direct-to-R2 shape instead.
4. **No base manifest.** `BASE_MANIFEST` is unset and `mari-store` holds 0
   objects. The Node runtime bootstraps one at boot (`src/node/base-image.ts`);
   the Workers entry has no equivalent. Consequence is mild — a new hosted
   computer starts from whatever `/work` the image ships (empty) and its first
   snapshot is a full manifest rather than a delta — but base-image dedup (spec
   §2, "the fleet stores each base image once") does not happen.

`packages/control-plane/test/deploy-preflight.test.ts` fails if item 1 is done
without items 2 and 3, so the flip cannot ship half-wired.

---

## 2. OWNER: secrets

Secret **values** are typed once, interactively, by the owner. `wrangler secret
put` prompts on stdin and stores the value encrypted; it is never written to the
repo, and no agent ever sees it.

| Secret | Required | What it is for |
|---|---|---|
| `AUTH_SECRET` | **yes** | Signs every Better Auth session cookie. `src/auth.ts` throws at construction when it is missing, is one of the committed placeholders, or is shorter than 32 characters — so a production origin without it answers 500 instead of accepting forged sessions. Generate privately with `openssl rand -base64 32`. |
| `GITHUB_CLIENT_ID` | no | GitHub OAuth. Registers itself **only when both** are present. There is no GitHub OAuth app today; passkeys are the whole hosted auth story. |
| `GITHUB_CLIENT_SECRET` | no | as above |

```sh
wrangler secret put AUTH_SECRET --env production      # required
wrangler secret put GITHUB_CLIENT_ID --env production      # optional
wrangler secret put GITHUB_CLIENT_SECRET --env production  # optional
```

Confirm what is set without revealing a value:

```sh
wrangler secret list --env production
```

**No other secret is needed for the deploy in §4.** If and when §1 item 3 is
built, it will add an R2 access key id and secret access key to this table; do not
invent names for them now.

> **Expected warning, do not "fix" it.** Every wrangler command prints
> *`AUTH_SECRET` exists at the top level, but not on `env.production.vars` …
> Please add these vars*. Adding it is precisely the forged-session hole
> `env.production` exists to close. It is declared under
> `env.production.secrets.required` instead, which is how it must arrive.

---

## 3. Database schema

D1 has no migration-on-boot. This must run **before** the first request, or
sign-up answers 500 (`no such table: user`) — verified locally, and it is the
symptom to look for in §7.

```sh
wrangler d1 migrations apply mari --env production --remote
```

`migrations/0001_init.sql` is generated from `src/db/apply.ts`, every statement is
`IF NOT EXISTS`, and `test/auth-schema.test.ts` asserts the two are
statement-for-statement identical — so re-running it is a no-op and a schema
change cannot ship without the migration. Expect **11 commands executed**.

Preview without applying:

```sh
wrangler d1 migrations list mari --env production --remote
```

---

## 4. ORCHESTRATOR: the deploy

Two commands. `packages/web/dist` is already built; if the tree has changed since,
run `pnpm --filter @mari/web build` first — the Worker serves the app from that
directory (`assets.directory`), and a missing one fails the deploy.

```sh
# 1 — schema (§3)
wrangler d1 migrations apply mari --env production --remote

# 2 — the Worker, the assets, and the custom domain in one step
wrangler deploy --env production --domain app.mari.sh --containers-rollout none
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
- `--containers-rollout none` deploys **without building or pushing the container
  image**. Correct while `SUBSTRATE_MODE` is `"fake"` (§1): the image would be
  several minutes of Docker work, a fourth container application on this account,
  and a substrate nothing will use. Drop it when §1 is done — see §5.

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
env.SUBSTRATE_MODE ("fake")              ← §1
```

### Optional hardening: turn the workers.dev origin off

Nothing sets `workers_dev`, so the Worker is also reachable at
`mari-control-plane-production.<subdomain>.workers.dev`. That origin serves the
app but **cannot complete a passkey ceremony** — `AUTH_RP_ID` is `app.mari.sh`,
and in production the ceremony origin is pinned to `BASE_URL` — so it is a second
public front door where sign-in is structurally broken. Add
`"workers_dev": false` to `env.production` to remove it.

---

## 5. The container image (only once `SUBSTRATE_MODE` is `"cloudflare"`)

`wrangler deploy` builds and pushes the image itself; there is no separate push
step. Drop `--containers-rollout none`:

```sh
wrangler deploy --env production --domain app.mari.sh
```

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

Build the image alone, without deploying, to check it or to warm the cache:

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
| 2 | `curl -s https://app.mari.sh/api/config` | `200 {"previewZone":"mari.sh","previewScheme":"https","previewPort":"","devAuth":false,"devSeed":false,"maxWriteBytes":1048576,"maxReadBytes":1048576}` | `500 AuthConfigError: AUTH_SECRET is not bound…` ⇒ §2 not done. `devAuth`/`devSeed` `true` ⇒ **stop and roll back**: a dev login or an unauthenticated session-minting seed route is live. |
| 3 | `curl -s -o /dev/null -w '%{http_code}\n' https://app.mari.sh/api/fleet` | `401 {"error":"unauthorized"}` | `500` ⇒ §2 or §3. `200` ⇒ auth is not enforced; roll back. |
| 4 | `curl -s -X POST -o /dev/null -w '%{http_code}\n' https://app.mari.sh/api/dev/seed` | `404 {"error":"not_found"}` | `200` ⇒ `DEV_SEED` is on. **Roll back immediately**: that route mints a session for anyone. |
| 5 | `curl -s 'https://app.mari.sh/api/auth/passkey/generate-register-options?context=smoke@example.com'` | `200`, and the JSON contains `"rp":{"name":"Mari","id":"app.mari.sh"}` | `500` with an empty body ⇒ **§3 was skipped** (`no such table: user`). An `id` other than `app.mari.sh` ⇒ `AUTH_RP_ID` is wrong and no passkey will ever verify. Nothing is written by this call, so an abandoned ceremony leaves no account. |
| 6 | Browser: open `https://app.mari.sh`, enter an email, press **Create account with a passkey** | The ceremony completes and the fleet view renders, empty | The one check a curl cannot do. Must be the host `app.mari.sh`, not the workers.dev origin (§4). |
| 7 | In the app: **New computer** | The card appears in **deep sleep** (COLD), instantly, with no spinner | A spinner or an error ⇒ D1 write path. The computer is a manifest pointer; nothing is materialized. |
| 8 | Click the computer, then <kbd>⌥R</kbd> and run `echo hello` | **While §1 stands:** the run is accepted and never starts. `POST /runs` answers `200 {"state":"pending","computerState":"cold","queued":true}` — spec 8.3 does not let the interface wait for a computer — and the card keeps saying deep sleep. That is the honest answer for this deploy. | The computer reading **`awake`** is the failure: the §1 guard is not in the deployed build and the fleet is claiming a machine that does not exist. Once §1/§5 are done, expect the run to start and terminal bytes to arrive. |
| 8b | `POST /api/computers/<id>/wake` with the session cookie | **While §1 stands: `503 {"error":"substrate_not_configured","state":"cold","epoch":0,"retrying":false}`** | `200 {"state":"awake"}` ⇒ same failure as 8. `202 {"error":"wake_retrying", "retryAt":…}` ⇒ a real substrate IS configured and refused; the DO has armed a bounded retry and `retryAt` says when — that is a healthy answer once §1/§5 are done. |
| 9 | `wrangler tail mari-control-plane-production --env production` while doing 8 | one line: `mari: refusing to wake computer=… SUBSTRATE_MODE=fake selects the in-memory fake substrate on a production environment…` | silence ⇒ you are tailing the wrong Worker |
| 10 | `wrangler d1 execute mari --env production --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` | the eight tables `0001_init.sql` creates: `account`, `computers`, `lineage`, `passkey`, `secrets`, `session`, `user`, `verification` (plus wrangler's own `d1_migrations`) | any of the eight missing ⇒ §3. Per-computer state — runs, journal, incidents, layout — is **not** here; it lives in each Durable Object's own SQLite. |
| 11 | `wrangler containers list` | while §4 used `--containers-rollout none`: **only** the three unrelated applications from §0. After §5: those three plus `mari-control-plane-production-computerdo` | anything else changed ⇒ stop; another account's workload is in play |

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
- A rollback of the Worker does **not** revert the D1 migration, and does not need
  to: `0001_init.sql` is additive and `IF NOT EXISTS` throughout.
- If §5 ran, delete the container application separately —
  `wrangler containers delete <id>` with the id from `wrangler containers list`.
  **Read the id twice.** Three unrelated applications live on this account.

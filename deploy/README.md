# Running a private Mari instance

> Spec 11.2: *"A private instance starts with one command, against the user's
> substrate account or local Docker."*

```sh
./deploy/up.sh
```

That is the command. It builds the base image (the `marid` supervisor plus a
POSIX userland), proves the built binary runs, builds the control plane, creates
the two named volumes, starts the instance on <http://localhost:8787> — REST API,
WebSockets and the web application on one origin — and **waits until that origin
actually answers** before telling you it is up.

**Prerequisites: a Docker daemon and this repository. Nothing else** — no Node,
no pnpm, no Rust, and no compose plugin on the host. Both images build from this
repo. First run compiles `marid` in a container, so expect minutes; after that
the layer cache makes it seconds.

Then, in the browser:

1. open <http://localhost:8787> — use the name `localhost`, not `127.0.0.1`
   (below);
2. type an email and press **Create account with a passkey**. Touch ID, Windows
   Hello or a security key: WebAuthn works over plain http on `localhost`, so a
   private instance needs no certificate and there is no password to store;
3. the fleet is empty. Press **New computer** (or <kbd>⌘K</kbd> → *New
   computer*). It is created in deep sleep — a manifest in the chunk store, no
   container, no cost;
4. press <kbd>⌥R</kbd> and run something. The wake happens behind the interface:
   the request returns in milliseconds with the run queued, a container appears,
   `marid` restores the filesystem, and the run starts.

Stopping:

```sh
./deploy/down.sh              # stop the control plane; computers keep running
./deploy/down.sh --computers  # ...and destroy every materialized computer
./deploy/down.sh --purge      # ...and delete the fleet (prompts first)
```

A computer is a container the control plane created through the Docker socket,
not a service in this stack, so stopping the control plane leaves an AWAKE one
running — by design: it keeps its supervisor, and when the control plane comes
back that supervisor reconnects with the epoch it already holds (spec 4.1).
`--purge` deletes the `mari-store` volume, and that volume is the fleet: the
chunk store is the home of every computer (spec §2), and there is no other copy.

## Why a script and not `docker compose`

`docker compose` is a CLI **plugin**. Docker Engine on Linux, Colima, Rancher
Desktop and Podman all give you a working daemon without it, and Homebrew's
`docker` formula does not pull it in either — so "one command" cannot be a
compose command without also being an install step. This was not theoretical:
the compose path in this file was wrong on the first machine that tried it
(Colima + the Homebrew `docker` CLI, no plugin — `docker: unknown command:
docker compose`).

`deploy/docker-compose.yml` is still here, still correct, and describes exactly
what `up.sh` does: the same two images, the same two named volumes, the same
environment. If you have the plugin, either path works:

```sh
docker compose -f deploy/docker-compose.yml up --build
```

If you want it and do not have it: `apt install docker-compose-plugin` on Debian
or Ubuntu, `brew install docker-compose` on macOS (Homebrew prints the one-line
symlink into `~/.docker/cli-plugins` that makes `docker compose` find it), or
install Docker Desktop, which bundles it.

## Sign-in, and why the URL matters

A private instance uses passkeys, exactly like the hosted one — a WebAuthn
Relying Party is a *name*, and `localhost` is the one name every browser accepts
over plain http. So:

* `http://localhost:8787` — works.
* `http://127.0.0.1:8787` — the ceremony fails. The rpID comes from `BASE_URL`'s
  hostname, and an IP literal is not a valid rpID; Chrome refuses it.
* `http://192.168.x.x:8787` or any other LAN address — WebAuthn needs a secure
  context, so plain http off `localhost` cannot register a passkey at all. Reach
  the instance over an SSH tunnel (`ssh -L 8787:localhost:8787 host`) or put it
  behind TLS and set `MARI_BASE_URL` to the https origin.

`MARI_DEV_AUTH=1` additionally enables email + password sign-in. It exists for
tests and automation — the Playwright suite and `e2e/` use it — and the control
plane refuses to start with it on a public https origin, so `up.sh` leaves it
off. Passkeys are the path a person uses.

## What is running

| Piece | What it is |
|---|---|
| `mari/base:v0` | The base image (spec §2): `marid` built for Linux, `/work` (the computer's filesystem root) and `/store` (the chunk store mount). Built by `deploy/Dockerfile.marid`. |
| `mari/control-plane:v0` | The Node control plane — the SAME Hono app and the SAME `ComputerDO` the Cloudflare entry runs, with `packages/control-plane/src/node/` supplying the platform (SQLite Durable Objects, a filesystem object store, a `ws` server). Built by `deploy/Dockerfile.control-plane`. |
| volume `mari-store` | The chunk store (spec 3.3): chunks, manifests, heat profiles and journal segments, keyed exactly as `docs/contracts.md` §9. The control plane reads and writes it as its object store; every computer mounts the same volume at `/store` and `marid` opens it as `fs:///store`. |
| volume `mari-data` | Durable Object storage (one SQLite file per computer) and the fleet database. |
| Docker socket | The substrate (spec 3.5's six functions). Computers are sibling containers of the control plane, labelled `mari.computer=<id>`. |

A wake materializes a container from `mari/base:v0` and hands `marid` its whole
configuration as environment (`crates/marid/src/config.rs`):
`MARI_COMPUTER_ID`, `MARI_CONTROL_URL`, `MARI_TOKEN`, `MARI_EPOCH`,
`MARI_ROOT`, `MARI_STORE` and, when the computer has a manifest to restore,
`MARI_RESTORE_MANIFEST`.

## Configuration

Every variable is optional, and `up.sh` and `docker-compose.yml` read the same
ones with the same defaults.

| Variable | Default | Meaning |
|---|---|---|
| `MARI_PORT` | `8787` | Published host port. |
| `MARI_AUTH_SECRET` | generated | Better Auth signing secret. `up.sh` generates 32 random bytes into `~/.mari/auth-secret` (mode 600) on first run and reuses it, because a new secret invalidates every session. Compose instead falls back to a published placeholder, which the control plane REFUSES to start with once it is reachable on a public https origin (`AuthConfigError`) — see "Hosted deployment" below. Set this explicitly to pin it. |
| `MARI_BASE_URL` | `http://localhost:$MARI_PORT` | Public origin, if the instance is behind a proxy or a different hostname. Also fixes the WebAuthn Relying Party. |
| `MARI_DEV_AUTH` | `0` from `up.sh`, `1` from compose | Email + password sign-in, for tests and automation (see "Sign-in" above). Refused on a public https origin. |
| `MARI_DEV_SEED` | `0` | The deterministic seed route (`POST /api/dev/seed`); for demos and the web e2e only. |
| `MARI_BASE_IMAGE` | `mari/base:v0` | Base image ref. |
| `MARI_CONTROL_HOST` | auto | Host (optionally `host:port`) a COMPUTER dials to reach the control plane. Auto-detection uses the control plane's own bridge address inside a container, and `host.docker.internal` outside one. Set it when the daemon is remote or the port is forwarded. |
| `MARI_PREVIEW_ZONE` | `mari.sh` | Wake-proxy zone for `{port}--{computer}--{user}.<zone>` (spec 8.5). |
| `MARI_WARM_IDLE_MS` | 5 min | AWAKE → WARM idle threshold (spec 4.4). |
| `MARI_COLD_IDLE_MS` | 30 min | WARM → COLD idle threshold (spec 4.4). |
| `MARI_DOCKER_SOCK` | `/var/run/docker.sock` | Daemon socket to mount. On macOS this path is resolved *inside* the daemon's VM, so it is correct for Docker Desktop and Colima alike. |
| `SPRITES_TOKEN` | unset | Add `sprites` to `MARI_SUBSTRATES` and the wake decision (spec 3.6) considers it too. |

`up.sh` and `down.sh` additionally take:

| Variable | Default | Meaning |
|---|---|---|
| `MARI_CP_IMAGE` | `mari/control-plane:v0` | Control-plane image tag to build and run. |
| `MARI_CONTAINER` | `mari-control-plane` | Container name, so a second instance can coexist. |
| `MARI_STORE_VOLUME` | `mari-store` | Chunk-store volume name. Shared BY NAME with every computer. |
| `MARI_DATA_VOLUME` | `mari-data` | Durable Object + fleet SQLite volume name. |
| `MARI_HOME` | `~/.mari` | Where the generated session secret is kept. |

`up.sh --no-build` skips both image builds (and fails if they are missing);
`down.sh --computers` also destroys materialized computers, `--purge` also deletes
the volumes after a prompt.

Storage variables, if you run the control plane outside a container:

| Variable | Meaning |
|---|---|
| `MARI_DATA_DIR` | Durable Object + fleet SQLite files. |
| `MARI_STORE_DIR` | The chunk store as the CONTROL PLANE sees it. |
| `MARI_STORE_HOST_DIR` | The chunk store as the DOCKER DAEMON sees it — a host path or a named volume. This is what each computer bind-mounts; if it does not name the same store, a cold wake restores from an empty one. |
| `MARI_STORE_MOUNT` | Where that store is mounted inside a computer (`/store`, matching `MARI_STORE=fs:///store`). |
| `MARI_COMPUTER_ROOT` | The computer's filesystem root inside the container (`/work` = `MARI_ROOT`). |
| `MARI_WEB_DIR` | Built web app to serve at `/`. Unset ⇒ API only. |

## On the host, with no container at all

For iterating on the control plane itself. This needs Node and pnpm, which
`up.sh` deliberately does not. The control plane is one bundled file:

```sh
pnpm --filter @mari/control-plane build:node     # -> dist/node.mjs
pnpm --filter @mari/web exec vite build          # -> packages/web/dist
docker build -f deploy/Dockerfile.marid -t mari/base:v0 .

MARI_DATA_DIR=~/.mari/data \
MARI_STORE_DIR=~/.mari/store \
MARI_STORE_HOST_DIR=~/.mari/store \
MARI_WEB_DIR=packages/web/dist \
AUTH_SECRET="$(openssl rand -base64 32)" \
DEV_AUTH=1 \
node packages/control-plane/dist/node.mjs
```

On macOS the daemon usually runs in a VM, so the store directory must be one the
VM shares — under `$HOME` for Colima and Docker Desktop, never `/tmp`. A bind
mount of an unshared path is silently EMPTY inside the container, which looks
exactly like a computer that lost its files. Inside compose this cannot happen:
the store is a named volume.

## The base image

`deploy/Dockerfile.marid` builds `marid` from this repo (release profile, cached
cargo registry and target) and ships it as the container entrypoint with a
Debian userland — a run is an arbitrary program the user brought, and a
control-plane file write is a `/bin/sh -c … base64 -d > path` run.

`/work` is the computer's filesystem root. On first boot the fleet snapshots
that root into the chunk store once, through `marid` itself (the TypeScript side
never writes manifests — decisions.md), and records a pointer at
`base/<image>.json`. Every computer created afterwards starts from that manifest,
so its own snapshots are a delta against shared chunks (spec §2, spec 4.4 "A
COLD computer must cost only its delta").

To bake toolchains into the base image, add them to `deploy/Dockerfile.marid`
under `/work`, rebuild, and delete `base/<image>.json` from the store so the
fleet re-snapshots it.

## Tests

```sh
pnpm --filter @mari/control-plane test:node                 # platform parity, no Docker
MARI_NODE_E2E=1 pnpm --filter @mari/control-plane test:node # + the real Docker substrate
```

The gated suite builds `mari/base:v0` if it is missing, materializes real
containers, and asserts against the Docker daemon directly (paused, destroyed,
`docker exec cat` byte-for-byte). It removes every container labelled
`mari.computer` when it finishes.

On macOS the suite writes its store under `$HOME/.mari/node-e2e` for the reason
described above; override with `MARI_NODE_E2E_DIR`.

## Troubleshooting

**`no substrate available`** — the control plane found no Docker socket. Check
that `/var/run/docker.sock` is mounted (compose does it) or set
`SUBSTRATE_MODE=fake` to run the API without a substrate.

**A computer boots but never appears AWAKE** — `marid` could not dial back.
`docker logs <container>` shows the URL it tried; it must be reachable *from the
container*, never `localhost`. Set `MARI_CONTROL_HOST`.

**A cold wake restores nothing** — the control plane and the computer are not
looking at the same chunk store. Compare `MARI_STORE_DIR` with
`MARI_STORE_HOST_DIR`, and check `docker inspect <container>` shows a mount of
the store at `/store`.

---

# Hosted deployment (app.mari.sh)

> **[deploy/DEPLOY.md](DEPLOY.md) is the runbook** — the ordered commands, what
> the owner does versus what the orchestrator does, a post-deploy smoke
> checklist with the exact expected responses, and the rollback. It also records
> the one thing this section does not: **as configured, `SUBSTRATE_MODE` is
> `"fake"` in production, so a hosted computer cannot wake.** Read DEPLOY.md §1
> before deploying. What follows is the reference for the pieces.

The hosted control plane is the same Hono app on Cloudflare Workers. Its config
lives in `packages/control-plane/wrangler.jsonc` under `env.production`:
account `5b7019b38a2b1c0ce119ecf64e92fd92`, D1 `mari`
(`b423acd3-0b26-482c-a0be-9998393b0cfc`), R2 `mari-store`,
`BASE_URL=https://app.mari.sh`, `PREVIEW_ZONE=mari.sh`, both `DEV_*` flags off.

## Secrets — the OWNER sets these, by hand

Secret VALUES must never be typed by tooling, pasted into a file, or handled by
an agent. They are set once, interactively, by the person who owns the account.
`wrangler secret put` prompts for the value on stdin and stores it encrypted; it
is never written to the repo.

**Required.** The deploy is dead without it, by design:

```sh
export CLOUDFLARE_ACCOUNT_ID=5b7019b38a2b1c0ce119ecf64e92fd92
cd packages/control-plane

# Generate the value privately (`openssl rand -base64 32`), then paste it at the
# prompt. 32 characters minimum; the app refuses to start below that.
wrangler secret put AUTH_SECRET --env production
```

`AUTH_SECRET` signs every session cookie. On a production environment
`src/auth.ts` THROWS at startup when it is missing, still one of the committed
placeholders (`change-me-in-production`, …), or shorter than 32 characters — so
a misconfigured deploy answers 500 rather than accepting forged sessions. The
same check refuses to build the app while `DEV_AUTH=1` or `DEV_SEED=1`, and it
triggers on any of three signals: `ENVIRONMENT=production`, an `https` non-loopback
`BASE_URL`, or an `https` non-loopback REQUEST url. That last one means even
`wrangler deploy` with no `--env` cannot serve the dev block's placeholder from a
real `*.workers.dev` origin.

**Optional.** GitHub OAuth is configured-but-optional (`docs/decisions.md`) and
activates only when BOTH are present. There is no GitHub OAuth app today, so
passkeys are the entire hosted auth story and neither is set:

```sh
wrangler secret put GITHUB_CLIENT_ID --env production      # optional
wrangler secret put GITHUB_CLIENT_SECRET --env production  # optional
```

To confirm what is set without revealing any value:

```sh
wrangler secret list --env production
```

## Database schema

D1 has no automatic migration on boot. Apply the schema — including the
`passkey` table WebAuthn needs — with wrangler's migration runner:

```sh
wrangler d1 migrations apply mari --env production --remote
```

`migrations/0001_init.sql` is generated from `src/db/apply.ts` and every
statement is `IF NOT EXISTS`, so re-running it is a no-op.
`test/auth-schema.test.ts` asserts the two are statement-for-statement identical
and that the `passkey` table matches the plugin's declared fields, so a schema
change cannot ship to production without the migration.

## Passkeys

Sign-up on the hosted origin is a WebAuthn ceremony and nothing else — there is
no password, and `account` rows stay empty for a passkey-born user:

1. `GET /api/auth/passkey/generate-register-options?context=<email>` — no session
   required. Nothing is written yet, so an abandoned ceremony leaves no account
   and does not squat the address.
2. `POST /api/auth/passkey/verify-registration` — on a verified attestation the
   user row is created and the response carries a session cookie. Sign-up ends
   signed in.
3. Later visits: `GET /api/auth/passkey/generate-authenticate-options` then
   `POST /api/auth/passkey/verify-authentication`. Credentials are discoverable
   (`residentKey: "required"`), so no username is typed.
4. Management: `list-user-passkeys`, `update-passkey` (rename), `delete-passkey`.
   Multiple passkeys per user; each is owner-checked.

The Relying Party is config-driven, so one build serves every origin:
`AUTH_RP_ID` (default: `BASE_URL`'s hostname) is `localhost` in dev, the full
`<name>.workers.dev` host on a preview deploy (workers.dev is a public suffix, so
the rpID must be the whole host), and `app.mari.sh` in production. In production
the ceremony origin is PINNED to `BASE_URL` plus anything in
`AUTH_TRUSTED_ORIGINS`, instead of being echoed from the request's `Origin`
header.

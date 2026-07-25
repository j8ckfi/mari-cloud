# Running a private Mari instance

> Spec 11.2: *"A private instance starts with one command, against the user's
> substrate account or local Docker."*

```sh
docker compose -f deploy/docker-compose.yml up --build
```

That is the command. It builds the base image (the `marid` supervisor plus a
POSIX userland), builds the control plane, and starts it on
<http://localhost:8787> — REST API, WebSockets and the web application on one
origin.

Stopping:

```sh
docker compose -f deploy/docker-compose.yml down          # stop the control plane
docker rm -f $(docker ps -aq --filter label=mari.computer)  # and any AWAKE computers
docker volume rm mari-store mari-data                     # ...and the fleet itself
```

A computer is a container the control plane created through the Docker socket,
not a compose service, so `compose down` leaves an AWAKE one running — by
design: it keeps its supervisor, and when the control plane comes back that
supervisor reconnects with the epoch it already holds (spec 4.1). Remove them by
label when you want the substrate empty. The volumes are the fleet: deleting
`mari-store` deletes every computer (spec §2 — the chunk store is the home).

Prerequisites: a Docker daemon and the repo checked out. Nothing else — no
Node, no pnpm, no Rust on the host; both images build from this repo.

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

Every variable is optional; the defaults are the ones in
`deploy/docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `MARI_PORT` | `8787` | Published host port. |
| `MARI_AUTH_SECRET` | `mari-private-instance-change-me` | Better Auth signing secret. **Set this**: 32+ random characters. The default is a published placeholder, so the control plane REFUSES TO START (`AuthConfigError`) once it is reachable on a public https origin — see "Hosted deployment" below for the rule. On plain `http://localhost` it stays a convenience. |
| `MARI_BASE_URL` | derived | Public origin, if the instance is behind a proxy or a different hostname. |
| `MARI_DEV_AUTH` | `1` | Email + password sign-in — the single-user sign-in of a private instance (decisions.md Auth). Also refused on a public https origin: put the instance behind a VPN/tunnel, or use passkeys there. |
| `MARI_DEV_SEED` | `0` | The deterministic seed route (`POST /api/dev/seed`); for demos and the web e2e only. |
| `MARI_BASE_IMAGE` | `mari/base:v0` | Base image ref. |
| `MARI_CONTROL_HOST` | auto | Host (optionally `host:port`) a COMPUTER dials to reach the control plane. Auto-detection uses the control plane's own bridge address inside a container, and `host.docker.internal` outside one. Set it when the daemon is remote or the port is forwarded. |
| `MARI_PREVIEW_ZONE` | `mari.sh` | Wake-proxy zone for `{port}--{computer}--{user}.<zone>` (spec 8.5). |
| `MARI_WARM_IDLE_MS` | 5 min | AWAKE → WARM idle threshold (spec 4.4). |
| `MARI_COLD_IDLE_MS` | 30 min | WARM → COLD idle threshold (spec 4.4). |
| `MARI_DOCKER_SOCK` | `/var/run/docker.sock` | Daemon socket to mount. |
| `SPRITES_TOKEN` | unset | Add `sprites` to `MARI_SUBSTRATES` and the wake decision (spec 3.6) considers it too. |

Storage variables, if you run the control plane outside compose:

| Variable | Meaning |
|---|---|
| `MARI_DATA_DIR` | Durable Object + fleet SQLite files. |
| `MARI_STORE_DIR` | The chunk store as the CONTROL PLANE sees it. |
| `MARI_STORE_HOST_DIR` | The chunk store as the DOCKER DAEMON sees it — a host path or a named volume. This is what each computer bind-mounts; if it does not name the same store, a cold wake restores from an empty one. |
| `MARI_STORE_MOUNT` | Where that store is mounted inside a computer (`/store`, matching `MARI_STORE=fs:///store`). |
| `MARI_COMPUTER_ROOT` | The computer's filesystem root inside the container (`/work` = `MARI_ROOT`). |
| `MARI_WEB_DIR` | Built web app to serve at `/`. Unset ⇒ API only. |

## Without compose

The control plane is one bundled file:

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

## Known gap

Browsing a computer's files and diffing its runs work COLD, from the manifest
alone (spec 8.4). Reading a file's CONTENT through
`GET /api/computers/:id/file` does not yet work for a computer written by
`marid`: `mari-core` stores chunk bodies zstd-compressed and the control plane's
chunk reader does not decompress them, so the response carries the compressed
bytes. The fix is cross-lane (a decoder that also works on Workers, plus a note
in `docs/contracts.md` §9) and is tracked in `docs/decisions.md`.

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

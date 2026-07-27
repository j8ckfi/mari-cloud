# Mari

A low-cost VM-emulator with a good web application and a small set of
primitives. A Mari computer feels like a persistent VM. It is not one.

**The one idea: a computer is data.** Its filesystem is content-addressed chunks
and manifests in object storage, and that store is the computer's home — not a
disk at a provider. A substrate (local Docker, Sprites, Cloudflare Containers) is
a *cache*: somewhere to materialize the data for as long as something is running.
When nothing is running the computer costs object storage for its own changes and
nothing else, and the next wake can happen somewhere else entirely.

Everything follows from that. Wake is a scheduling decision, not a boot. A fork
copies a manifest and transfers no bytes. A snapshot is not a feature above the
storage system — the storage system is snapshots. The supervisor on the computer
owns each run, so closing your laptop does not stop one.

- Normative spec: [docs/spec.md](docs/spec.md)
- Locked decisions and v0 ground rules: [docs/decisions.md](docs/decisions.md)
- Wire protocol and storage formats: [docs/contracts.md](docs/contracts.md)
- Cloudflare Containers as a substrate: [docs/substrates-cloudflare.md](docs/substrates-cloudflare.md)
- How to work on it: [CONTRIBUTING.md](CONTRIBUTING.md)

## State of the project

v0. One substrate is fully tested (local Docker), one is written and unrun
(Sprites), one is written and partly measured (Cloudflare Containers). The loop
the whole product rests on works end to end and is asserted end to end.

**What works, and where it is proven:**

| Claim | Suite that proves it |
|---|---|
| Snapshot → wipe → restore is byte-identical, including modes, symlinks, empty files and files spanning many chunks | `cargo test -p mari-core` |
| One byte inserted mid-file reuses ≥90% of chunks; a computer's snapshot is a delta against its base image | `cargo test -p mari-core` |
| Garbage collection never deletes a chunk reachable from any retained manifest (randomized histories) | `cargo test -p mari-core` (proptest) |
| A run is a real process on a real PTY; the post-run diff lists exactly the files it changed, and revert reverts them | `cargo test -p marid` |
| A stale supervisor cannot advance the manifest head (epoch fencing — spec 4.1's mechanism) | `pnpm --filter @mari/control-plane test` |
| A COLD computer's fleet card and file tree render from the manifest, with the computer never woken | `pnpm --filter @mari/control-plane test`, `pnpm --filter @mari/web test:e2e` |
| A computer whose container is `docker rm -f`'d recovers: new epoch, fresh instance, queued run still runs exactly once | `MARI_NODE_E2E=1 pnpm --filter @mari/control-plane test:node` |
| Create → wake → run writes files → snapshot → destroy → wake into a **fresh container** with the files byte-identical | `MARI_E2E_DOCKER=1 cargo test -p marid --test e2e_docker` |
| Start from the web API, disconnect every socket, the run continues, another device picks up the journal mid-run (spec 1.3) | `MARI_LOOP_E2E=1 pnpm --filter @mari/e2e test` |

**Measured latency.** One run of `e2e/loop.e2e.test.ts` on an Apple Silicon
laptop, local Docker substrate (Colima), warm base image, a delta of a handful of
small files. These are the numbers that run printed, not a benchmark: single-digit
sample counts, one machine, one substrate. The suite prints them every run and
asserts none of them — a latency budget is not a correctness claim.

| Transition | Wall clock |
|---|---|
| `POST /runs` on a COLD computer returns | 2 ms |
| `POST /runs` → container materialized | 95 ms |
| Cold wake → supervisor connected | p50 104 ms (n=3: 107, 104, 104) |
| Cold wake → run's files byte-identical in a fresh container | p50 255 ms (n=2: 254, 255) |
| Run request → first live terminal bytes at the client | 763 ms |
| AWAKE → WARM (`docker pause`) | 839 ms |
| WARM → COLD (final snapshot + destroy) | 423 ms |

Spec 4.6(e) ("the target for the first shell prompt is seconds") holds with room
to spare *on this substrate, for small deltas*. Cloudflare and Sprites p50/p99
are open (spec 13); Docker's numbers will not transfer.

## Run a private instance

Spec 11.2: one command, against local Docker. Prerequisites: a Docker daemon and
this repository. No Node, no pnpm, no Rust, no compose plugin on the host.

```bash
./deploy/up.sh
```

It builds both images, starts the control plane on <http://localhost:8787>, and
waits until that origin answers. Open it, create an account with a passkey
(WebAuthn works over plain http on `localhost`), press **New computer**, then
<kbd>⌥R</kbd> to run something. `./deploy/down.sh` stops it.

[deploy/README.md](deploy/README.md) has the configuration table, the compose
alternative, the hosted (Cloudflare) deployment, and troubleshooting.

## Architecture

| Path | What |
|---|---|
| `crates/mari-core` | Chunking (FastCDC), manifests, the chunk store, restore, GC. The only implementation of the storage logic. |
| `crates/mari-proto` | Wire protocol types (CBOR), mirrored by hand in `packages/shared` and pinned by conformance fixtures. |
| `crates/marid` | The supervisor: owns runs, PTYs, journals, snapshots, attention detection, cold-restart continuation. |
| `packages/control-plane` | Hono app — one Durable Object per computer, wake proxy, auth, substrate drivers, and the Node runtime that makes a private instance the same code. |
| `packages/web` | The web application: hand-built tiling window manager, xterm.js terminals, CodeMirror editor. |
| `packages/shared` | The TypeScript protocol mirror and the client SDK. |
| `e2e/` | Cross-lane suites: the spec 1.3 loop, and the Cloudflare thesis test. |
| `deploy/` | Base image, control-plane image, the one-command private instance, Cloudflare deploy configs. |

The control plane is the brain, the substrates are the body, the chunk store is
the home (spec 3.4). Agents never execute in the control plane; `marid` never
talks to a substrate API.

## Tests

No smoke tests. "It imports and doesn't crash" is not a test — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the rule and
[docs/decisions.md](docs/decisions.md) for the non-negotiable set.

```bash
# The default suite: no Docker, no accounts, no secrets. This is what CI runs.
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm -r typecheck && pnpm -r test
pnpm --filter @mari/control-plane test:node    # Node runtime parity

# Playwright. Gated in CI, and CONTRIBUTING.md says why (the suite has an order
# dependency on the seeded computer staying COLD).
pnpm --filter @mari/web test:e2e

# Gated on a real Docker daemon (minutes; builds the base image if missing).
MARI_E2E_DOCKER=1 cargo test -p marid --test e2e_docker
MARI_NODE_E2E=1   pnpm --filter @mari/control-plane test:node
MARI_LOOP_E2E=1   pnpm --filter @mari/e2e test

# Gated on credentials, and unrun in CI by design.
SPRITES_TOKEN=… pnpm --filter @mari/control-plane test:substrates
MARI_CF_E2E=1 CLOUDFLARE_ACCOUNT_ID=… pnpm --filter @mari/e2e test   # needs a real deploy
```

## Limitations

A publishable project is allowed to have gaps. It is not allowed to hide them.
Everything below is missing, deferred, or unverified **today**.

### Deliberate v0 deviations from the spec

Each one keeps the spec-pure path behind an interface; see *v0 deviations* in
[docs/decisions.md](docs/decisions.md).

1. **The semantic terminal is not libghostty-vt** (spec 7.2). v0 ships a
   `GridEngine` interface in the control plane with a VT-parser implementation
   behind it. `marid` streams raw journal bytes and keeps no grid.
2. **Cold wake is a full restore, not a lazy mount** (spec 4.6(b)(c)). The heat
   profile really does order the restore (4.6(d)), but there is no FUSE overlay:
   a computer with a multi-gigabyte delta pays the whole transfer before the
   first prompt. The restore API already takes a priority list so the lazy
   implementation can slot in.
3. **The Sprites driver has never run against Sprites.** It is written against
   the public API docs and its integration test is gated on `SPRITES_TOKEN`,
   which nobody has set. Treat it as unverified code.
4. **iOS (spec 12) does not exist.** It is v2 and not in this repository.

### Spec features that are not implemented

- **Browser *computer mode*** (spec 8.5) — a Chromium instance on the computer,
  streamed into a pane, with a persistent profile. Not built. Preview mode (a
  stable URL per port, waking on request) *is* built. Because there is no
  browser profile, spec 10.2 (profile chunks encrypted, forks excluding the
  profile, diffs never showing cookie content) protects nothing yet.
- **Fork differences and merges** (spec 9.2). Creating a fork works over the API
  (`POST /api/computers/:id/fork`: lineage recorded, no bulk data copied) but
  there is no fork button in the web app, no control-plane route that diffs two
  arbitrary manifests, and no merge. The diff *view* is real and shared with run
  review; the pane says so rather than offering a picker that cannot resolve.
- **The grid at a past time of a run** (spec 7.6). The journal is complete and
  the control plane replays it to an attaching client, but there is no
  time-travel view over it.
- **Egress limits** (spec 10.3). Hosted v0.1 enforces an atomic computer-count
  cap and a monthly AWAKE compute-hour cap on explicit wakes, runs, writes,
  uploads, and preview wakes. It cannot yet attribute provider egress to an
  account, so it does not pretend to enforce an egress ceiling.
- **Client-side encryption of chunks with per-user keys** (spec 10.4). The spec
  calls it an option; it is not implemented, so a hosted instance can read a
  user's computer.

### Wired but not reachable

- **Garbage collection never runs.** `mari-core`'s mark-and-sweep is implemented,
  audited and property-tested (a chunk reachable from any retained manifest is
  never deleted), but nothing calls it: there is no scheduled sweep and no CLI
  entry point. So `DELETE /api/computers/:id` removes the fleet row and leaves
  every chunk in the store. Storage grows monotonically. This is the single
  largest gap between the code and the spec's §4.4 promise that a COLD computer
  costs only its delta.
- **Each run's journal is written to the chunk store twice.** `marid` writes
  `journal/{computer}/{run}/{seq:08}.seg` and the Durable Object writes
  `…/{seq:012}.seg` — same bytes, two writers, two zero-pad widths, so they do
  not overwrite each other. Latent today because nothing reads segments back
  (the DO replays from its own SQLite), and deliberately not patched: whose
  prefix it is, is a cross-lane decision. Recorded in
  [docs/decisions.md](docs/decisions.md).
- **The cost meter is real; its prices are a guess.** It meters AWAKE seconds
  honestly and multiplies by a static per-substrate list price. Local Docker is
  priced at zero (it is your machine). The Sprites, Sail and Northflank numbers
  are v0 placeholders — actual published rates are an open item in spec 13. It
  is internal accounting only: there is no billing anywhere in this repo, by
  decision, and none of it gates a wake.

### Unverified, and the hosted instance

- **Cloudflare Containers may not be fit to be the default substrate.** A
  `destroy()` followed by a `start()` on the same Durable Object is refused by
  the platform for minutes (measured >563 s), and Mari's own tier policy makes
  AWAKE→COLD→AWAKE exactly that sequence. The control plane's behaviour during
  the window is defensible — an honest `202` with a bounded retry schedule
  spanning ~12 minutes, the fleet view still saying COLD, the queued run
  preserved, proven against the platform's own refusal in
  `test/cloudflare_stall.test.ts` — but the window is real and its true width at
  fleet scale is unmeasured. Whether signal-stopping instead of destroying avoids
  it is untested.
- **Fifteen Cloudflare facts are explicitly unverified**, including whether
  container→R2 traffic is billed as egress, whether the 15-minute SIGTERM grace
  covers platform maintenance, and cold-wake p50/p99 for a realistic delta. They
  are enumerated at the end of
  [docs/substrates-cloudflare.md](docs/substrates-cloudflare.md); nothing in that
  memo is asserted as fact.
- **`MARI_CF_E2E_SLOW=1`** (re-materialize after a `sleep`) has never been run.
  It needs a real deploy, a real image push, and up to fifteen minutes of
  platform patience.
- **Hosted auth is passkeys only.** GitHub OAuth is configured-but-optional and
  no OAuth app exists, so there is no second sign-in path on a hosted instance.
- **There is no sharing.** Computers belong to one account; there are no teams,
  no invites, and no shared fleets.

### One suite is not trustworthy yet

The Playwright web suite shares a single control plane across its spec files, and
`editor-save.spec.ts` performs a spec 8.4 write that wakes the seeded computer.
Every later spec that needs a COLD card then waits out the tier policy — 30 s in
one measured case, past the 45 s test timeout in a full run — while each file
passes on its own. It is therefore in the gated workflow, not the default CI run,
until it states its own precondition. Everything it asserts is real; the *order*
is what is wrong. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

### Private-instance rough edges

- **On macOS the chunk store must live under `$HOME`.** The daemon runs in a VM
  that shares `$HOME` but not `/tmp`, and a bind mount of an unshared path is
  silently *empty* inside the container — which looks exactly like a computer
  that lost its files. Inside `deploy/up.sh` this cannot happen (the store is a
  named volume); it bites when you run the control plane on the host by hand.
- **`marid` compiles its TLS roots in and does not trust a private CA.** A
  self-hosted control plane behind private PKI must terminate TLS in front of
  `marid`, keep the supervisor hop on loopback or private space, or set
  `MARI_ALLOW_INSECURE_WS=1` and accept what that costs. Plaintext `ws://` to a
  public origin is refused outright, and the refusal is fatal.
- **A passkey is bound to a hostname.** Reach a private instance as
  `http://localhost:PORT`, not by IP and not over a LAN address, or the ceremony
  cannot run. `deploy/README.md` explains the SSH-tunnel path.

## License

[AGPL-3.0-only](LICENSE). Spec §1.4 makes "a user can operate a private
instance" load-bearing, and §11.4 settles the license in favour of the one that
keeps a hosted fork open.

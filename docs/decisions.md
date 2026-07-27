# Mari — Locked Decisions & v0 Ground Rules

[spec.md](spec.md) is normative. This file records the decisions already made,
the deliberate v0 deviations, and the rules every contributor (human or agent)
follows. Do not relitigate these in code; if one is wrong, flag it, don't
silently diverge.

## Stack (locked)

- **Supervisor `marid`**: Rust, edition 2024. tokio, portable-pty, opendal
  (store access), blake3, fastcdc, zstd, ciborium (CBOR), tokio-tungstenite,
  thiserror (libs) / anyhow (bins), tracing, clap.
- **Storage logic lives once**: `crates/mari-core` is the only implementation
  of chunking/manifest/GC. It is used natively by marid and will be compiled
  to Wasm for the control plane later. Nothing else reimplements it. The
  TypeScript side READS manifests (CBOR via cbor-x) but never writes them.
- **Wire protocol**: framed CBOR over WebSocket. Types defined in
  `crates/mari-proto`, mirrored by hand in `packages/shared`, kept in lockstep
  by conformance fixtures: a Rust test writes `packages/shared/fixtures/*.cbor`
  + `*.json`; a TS test decodes and deep-equals. Both suites fail on drift.
- **Control plane**: Hono app factory (one codebase, Workers entry + Node entry
  for private instances, spec 3.1/11.2). Cloudflare: one Durable Object per
  computer (DO SQLite storage), D1 for fleet-level data, R2 for chunks and
  journal segments. Tests: vitest + @cloudflare/vitest-pool-workers with real
  bindings (no mocking the platform).
- **Auth**: Better Auth. Hosted: D1, GitHub OAuth + passkeys. Private: SQLite,
  single-admin mode. Email/password may be enabled in dev/test builds for
  testability.
- **Billing**: absent until v0.9+. When it lands: Better Auth Stripe plugin,
  Checkout + Customer Portal, flat tiers with hard caps (spec 10.3 enforces),
  no metered billing in v1. The 8.2 cost meter is internal accounting from
  substrate price sheets, independent of billing.
- **Web**: React + Vite, @xterm/xterm + WebGL addon (code against xterm.js API
  only, spec 7.4), CodeMirror 6, TanStack Query, zustand. The tiling WM is
  hand-built — it is the product; no dashboard-grid library.
- **Preview hostnames are ONE label** under the zone:
  `{port}--{computer}--{user}.mari.sh` (a `*.mari.sh` wildcard cert covers one
  level only).
- **Journal path**: marid writes journal segments directly to R2 (object
  storage); only the coalesced live tail (≤100 ms flush windows) and segment
  pointers flow through the DO. The DO is not the journal's storage medium.
- **Fencing (spec 4.1 mechanism)**: the DO mints a monotonically increasing
  epoch at each wake. Every manifest-head advance carries the supervisor's
  epoch; the DO rejects any advance whose epoch is not current
  (compare-and-swap). Chunk writes are content-addressed and therefore
  harmless from a fenced-out writer; the head is the only thing that matters.
- **GC is mark-and-sweep, not refcounts** (deliberate deviation from the
  letter of spec 4.8, keeping its intent): the live set is computed from all
  retained manifest versions; a sweep deletes only chunks absent from the live
  set AND older than a safety window. Every sweep supports dry-run and emits
  an audit log. Refcounts drift; drift here deletes a computer.
- **Manifest** = a file tree (path, mode, size, symlink target, per-file chunk
  refs) + optional parent (base image) manifest id — NOT a flat chunk list.
  8.4 file browsing and 9.2 diffs are functions of the manifest alone.
- **Direct-to-R2**: chunks never transit the Worker. The DO mints short-lived
  scoped credentials / presigned URLs; marid reads and writes the store
  directly.
- **Substrate drivers are TypeScript, in the control plane**
  (`packages/control-plane/src/substrates/`). Rationale: wake is a
  control-plane scheduling decision (spec 3.6), and the control plane runs on
  Workers/Node which cannot load native modules — but it can speak HTTP to
  Sprites (works on both entries) and dockerode to a local daemon (Node entry
  only, for private instances and tests). The provider interface is exactly
  spec 3.5's six functions: materialize, destroy, sleep, wake, exec,
  exposePort. marid never talks to a substrate API directly; its run-hold
  heartbeat (spec 5.4) flows through the DO, which forwards to the driver.

## v0 deviations (each preserves the spec-pure path behind an interface)

1. **Semantic terminal**: spec 7.2 names libghostty-vt. v0 ships a
   `GridEngine` interface in the control plane with a VT-parser
   implementation (e.g. @xterm/headless if workerd-compatible, else a minimal
   VT state machine). marid streams raw journal bytes and keeps no grid.
   libghostty-vt (native + Wasm) swaps in behind the same interface later.
2. **Lazy mount**: spec 4.6(b)(c) FUSE-lazy overlay is deferred. v0 cold wake
   = full restore, ordered by the heat profile (4.6(d) is real), with the
   restore API taking a priority list so the FUSE implementation slots in
   later. Target 4.6(e) still stands for small deltas.
3. **Sprites module**: implemented against public API docs; its integration
   test is gated on `SPRITES_TOKEN`. Local Docker is the fully-tested
   substrate in v0.
4. **Node control-plane parity**: the Hono app factory is shared and the Node
   entry compiles and boots, but v0 tests target the Workers entry. Full DO
   equivalence on Node comes with the private-instance milestone.
5. iOS is v2 (spec 12). Not in this repo yet.

## Directory ownership

Agents stay in their lane. Root manifests (`Cargo.toml` members list,
`pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`) are frozen —
add dependencies only inside your own crate/package manifest.

| Path | Owner |
|---|---|
| `crates/mari-proto`, `packages/shared` | contracts |
| `crates/mari-core` | core builder |
| `crates/marid` | supervisor builder |
| `packages/control-plane/src/substrates/` (+ its tests) | substrate builder |
| `packages/control-plane` (everything else) | control-plane builder |
| `packages/web` | web builder |
| `docs/` | contracts (append-only for others) |

## Testing philosophy — teeth required

No smoke tests. "It imports and doesn't crash" is not a test. Every suite
asserts real behavior with real data. The non-negotiable set:

- **mari-core**: snapshot → wipe → restore is byte-identical including modes,
  symlinks, empty files, and files spanning many chunks. CDC stability: insert
  one byte mid-file in a large file, ≥90% of chunks reused. Base/delta dedup
  asserted by chunk counts. GC property test (proptest): a chunk reachable
  from ANY retained manifest is NEVER deleted, across randomized
  manifest/retention histories; unreferenced chunks are deleted only after the
  safety window. Corrupted-chunk detection (blake3 verify on read).
- **marid**: a real PTY run (actual child process) with journal byte capture
  and exit status. Pre-run snapshot + post-run diff lists exactly the files
  the run changed; restore reverts them. Attention: BEL and OSC 9 emission
  each produce one content-free attention event; a silent stdin-blocked child
  produces one after the threshold; normal output produces none. WS client
  reconnect resumes journal streaming from the acked offset (against a fake
  control-plane server).
- **control-plane**: epoch fencing — a manifest-head advance with a stale
  epoch is REJECTED and the head unchanged (this is spec 4.1's test). Journal
  segments persist to R2 and the tail replays to an attaching client. Wake
  proxy parses `{port}--{computer}--{user}` hosts and wakes through a fake
  substrate. Auth session lifecycle. File browse of a COLD computer served
  from the manifest in R2 with the computer never woken.
- **e2e (Docker)**: the thesis test — create computer → wake on the Docker
  substrate → run writes files → snapshot → destroy (COLD) → wake into a
  FRESH container → the files are there, byte-identical, and the journal is
  continuous. Gated on `MARI_E2E_DOCKER=1`.
- **web**: Playwright — the fleet view renders a COLD computer's data with no
  spinner and no wake; the file browser browses it COLD; the terminal pane
  round-trips input/output against a fake supervisor; Cmd+K palette and
  workspace hotkeys work.

## Conventions

- No agent runs `git commit`, `git init`, or pushes. Checkpointing is the
  orchestrator's job.
- Rust: thiserror in libraries, anyhow in binaries, tracing (never println) in
  daemon code paths.
- TypeScript: strict; `any` only at the CBOR decode boundary and immediately
  validated.
- Tests live with their component. Env-gated suites document their gate at the
  top of the file.
- Spec 1.2 applies to code too: if a module is not the emulator, the
  interface, or a primitive, it does not belong here.

## Appendix — Agent adapters and rollback handling (supervisor)

_Appended by the supervisor builder (append-only, per directory ownership).
Closes two spec gaps that are pure supervisor concerns: spec 5.6 (continue each
unfinished run after a restart) and spec 4.7 (WARM rollback)._

### Agent adapters (spec 5.6, spec 2 "the user brings the agents")

Spec 5.6 says the supervisor continues an unfinished run "using the resume
function of the agent". An arbitrary program has no resume function, and spec
1.2 forbids an agent-integration surface. The resolution is an **adapter**: a
declarative file, and nothing else.

`/etc/mari/agents.d/*.toml` (`MARI_AGENTS_DIR`), exactly five keys:

```toml
name    = "claude"                          # required, unique
command = ["claude", "--print"]             # required
resume  = ["claude", "--resume", "{run}"]   # optional
env     = ["ANTHROPIC_API_KEY"]             # optional: vault NAMES, never values
cwd     = "/home/agent"                     # optional
```

- Any sixth key makes the file **malformed** (`deny_unknown_fields`) — that is
  the mechanism that keeps this from growing into an integration surface.
- A malformed, unreadable or duplicate-named file is skipped with a warning and
  recorded; loading adapters can never fail the daemon. A missing directory is
  normal: the computer then simply has no agent that declares a resume.
- `command` is **declarative only**. The control plane composes a run's `argv`
  (`start_run`); marid never synthesizes a run. marid uses `command` to *bind* a
  run to an adapter — `argv[0]`'s basename against the adapter's `name` or its
  `command[0]` basename — so a restart knows whose resume template applies.
- Only `resume` is ever spawned, after substituting `{run}`, `{journal}` (the
  run's local journal directory — spec 5.6's "journal as the reference") and
  `{cwd}`. An unknown `{...}` is left alone.

### Durable supervisor state

RAM does not survive COLD and the disk can roll back, so "what was running" and
"what the tree last was" live in the chunk store, beside `heat/{computer}.cbor`:

| Key | Contents |
|---|---|
| `runs/{computer}/{run}.cbor` | one run record: argv, env names, cwd, bound adapter, pre-run manifest, durable journal length + next segment ordinal, epoch, phase (`running`/`completed`/`interrupted`) |
| `state/{computer}/heads.cbor` | the last 8 manifests the supervisor recorded, oldest first |

These are marid's own state, not a wire contract, so they are defined in
`crates/marid/src/state.rs`, not in `mari-proto`. Only the rollback *report*
crosses the wire.

Unlike chunks and manifests these objects are **mutable**, so the "only the head
advance is fenced" rule does not cover them: an update to a run record stamped
with a newer epoch than the writer's is refused. A fenced-out supervisor must not
be able to mark a live run completed — that would stop a later restart from
continuing it.

### Startup continuation (runs on the first `hello_ack`)

| situation | action |
|---|---|
| no rollback, adapter declares `resume` | spawn the resume command |
| no rollback, no adapter or no `resume` | **interrupted** (the defined degradation) |
| rollback, replay provably safe | replay the run's original argv |
| rollback, anything else | **interrupted** |

**Interrupted** means: the run record moves to `interrupted`, its journal is left
exactly as it is (local segments and store segments both), and one *content-free*
`attention` event (`AttentionKind::Interrupted`, new) is sent. No completion
event is fabricated — the run did not complete. The user decides what happens
next; the supervisor never silently drops a run and never silently re-runs one.

A resumed run keeps its identity: the same run id, the same pre-run manifest
(its diff baseline), and a journal that **continues** at the highest offset any
surviving copy attests to (`max` of the store record, the control plane's
`hello_ack` offset, and the disk segments), with segment ordinals continuing
too. Restarting a resumed journal at 0 would collide with bytes the control
plane already holds.

### WARM rollback detection (spec 4.7)

Nothing on the substrate disk can be the reference — a rollback takes marid's own
state back with it. The references are the two things that cannot roll back: the
chunk store (run records, head history) and the control plane's `hello_ack`
offsets. Two signals, either sufficient:

- **journal** — a run's on-disk journal segments hold fewer bytes than its store
  record says were durably written. (Spec 4.7's "compare the disk with the
  journal head".)
- **tree** — the tree on disk equals, byte for byte, one of the *older* recorded
  heads rather than the newest.

Neither can fire on a healthy restart: the local segment file is written before
the store upload and the record after it, so the disk is never behind the record;
and a healthy tree is either the newest head or *ahead* of it, which matches no
older entry. A **cold wake is exempt entirely** — that process wrote the disk
from the store itself and knows exactly what it is.

On detection marid sends `SupervisorMessage::RollbackDetected { disk_manifest,
recorded_manifest, diff, runs[] }` — the tree difference measured against the
newest recorded head, plus, per unfinished run, `control_offset` (what the
control plane holds), `disk_offset` (what survived) and `replayed`.

**"Safe to replay" is deliberately narrow, and the default is no.** A run may be
replayed only if it produced **no journal output at all**: none in its store
record, none at the control plane, none on disk. Such a run said nothing and
showed nothing, so re-running it is indistinguishable from starting it the first
time. One byte of output anywhere and the supervisor will not guess whether the
rollback undid the run's effects in full — it reports, interrupts, and raises the
attention event instead. The adapter has no "idempotent" flag, and will not get
one: that is agent-integration surface (spec 1.2), and it would move a
correctness decision into a config file.

### Protocol additions

- `AttentionKind::Interrupted` — still content-free; the kind is the whole
  signal (spec 6.2/6.3).
- `SupervisorMessage::RollbackDetected` (+ `RunRollback`) — supervisor→control
  report, mirrored in `packages/shared` with conformance fixtures
  (`sup_rollback_detected`, `sup_attention_interrupted`).

## Appendix — The private instance (Node runtime)

_Appended by the private-instance builder (append-only, per directory
ownership). This closes v0 deviation 4: the Node entry no longer merely
compiles, it runs the whole control plane. Deviation 4's wording stands for what
it promised; the rest of this appendix is what landed._

### One implementation, two platforms

`ComputerDO` and `EventsDO` are **not forked**. The Node runtime aliases the
`cloudflare:workers` builtin to a Node base class
(`packages/control-plane/src/node/cloudflare-workers.ts`) — via `resolve.alias`
in `vitest.node.config.ts` and esbuild's `alias` in `scripts/build-node.mjs` —
and supplies the platform underneath:

| Binding | Node implementation |
|---|---|
| Durable Object | `node/namespace.ts` + `node/state.ts`: one live actor per id, an input gate (`blockConcurrencyWhile`), `ctx.storage` KV + `ctx.storage.sql` on `node:sqlite` (`node/sql.ts`), and ONE persisted alarm re-armed at startup — the tier policy (spec 4.4) runs on real timers |
| D1 | `node/d1.ts` — local SQLite behind D1's `prepare/bind/first/all/raw/run/batch` (drizzle's D1 driver re-binds one prepared statement, so `bind` returns a new statement) |
| R2 | `node/r2.ts` — a directory keyed exactly as contracts.md §9, which is the same directory `marid` opens as `fs:///store`; writes are temp-file + rename so a concurrent reader never sees a half-written manifest |
| WebSocket upgrade | `node/websocket-pair.ts` + `node/server.ts` — an in-process `WebSocketPair` with workerd's semantics, an upgrade-capable `Response` (status 101 + `webSocket`), bridged onto a real `ws` connection |

Two consequences worth knowing: `@hono/node-server` must be created with
`overrideGlobalObjects: false` (its lightweight `Response` discards the upgrade
response and defers status validation), and the alias is the only thing that may
ever differ between the runtimes — a second copy of manifest, epoch or tier
logic is the drift this file forbids.

### Seams added to shared code (Workers behavior unchanged)

1. **`materialize` carries marid's whole configuration.** The DO composes
   `MARI_COMPUTER_ID`, `MARI_EPOCH`, `MARI_TOKEN`, `MARI_ROOT`, `MARI_STORE`,
   `MARI_CONTROL_URL` and `MARI_RESTORE_MANIFEST` from `Env` vars
   (`SUPERVISOR_URL_BASE`, `COMPUTER_ROOT`, `STORE_URI`, `BASE_IMAGE`,
   `BASE_MANIFEST`). The control URL must be reachable FROM the container, so
   its origin is deployment config, never `localhost`.
2. **`env.SUBSTRATE`**: the real driver is INJECTED by the Node runtime, which
   performs the spec 3.6 selection itself. `makeSubstrate` never imports a
   driver — not even dynamically — so no Node-only module is reachable from the
   Workers bundle. Unset ⇒ the fake, which is what the Workers tests drive.
3. **`resumeBeforeCold(handle)`**: a driver whose WARM state FREEZES the guest
   (Docker `pause`) cannot answer `prepare_for_cold`, and spec 4.5 requires the
   supervisor to stop sessions cleanly. Such a driver declares it and the DO
   resumes the computer before asking. The fake declares nothing, so the
   Workers tier test is untouched.
4. **Write paths are manifest paths.** A file write is a run (contracts.md
   Appendix C.2), but a manifest path is rooted at the computer's filesystem
   root while the run executes in the substrate's filesystem. When
   `COMPUTER_ROOT` is set (`/work`), `enqueueWrite` targets the substrate path
   and records the manifest path. Unset ⇒ identical argv to before.
5. **The dev supervisor prime needs both query parameters.** `/supervisor/:id`
   only adopts an epoch/token when `?epoch=&token=` are BOTH present. A private
   instance runs with dev sign-in enabled while real supervisors dial that same
   route with no query; defaulting the prime would reset the DO's minted epoch
   on every connect — fencing out the live supervisor (spec 4.1) and handing a
   known token to whoever opened the socket.

### Base image (spec §2, stored once)

The OS arrives as the container image (spec 4.6(a) "boot from a substrate-local
copy of the base image"); the chunk store owns `/work`, the computer's
filesystem root, which the base image ships pre-populated. On first boot the
fleet materializes ONE bootstrap computer from that image, has `marid` snapshot
that root into the chunk store, takes it COLD through the real tier path, and
records a pointer at `base/{image}.json`. Every computer created afterwards
starts from that manifest, so its snapshots are a delta against shared chunks.
The manifest is written by `marid` (mari-core), never by TypeScript.

### Deployment

`deploy/` holds the base-image Dockerfile, the control-plane Dockerfile, the
entrypoint, and a compose file whose one command is documented in
`deploy/README.md`. The store is a NAMED VOLUME shared by name with every
computer, and the control plane joins the default bridge network, because
computers are sibling containers created through the Docker socket and must be
able to dial it back.

### Known gap found by this milestone — CLOSED

`mari-core` stores chunk bodies **zstd-compressed** (`crates/mari-core/src/store.rs`),
while the control plane's `manifest-store.ts` concatenated chunk bytes as-is.
Manifests themselves are plain CBOR, so browsing and diffing a real computer
worked; reading a real computer's file CONTENT through `GET /api/computers/:id/file`
returned a truncated prefix of a compressed frame. Contracts §9 did not mention
compression either, which is why the gap existed at all.

**Fixed.** `manifest-store.ts` now decompresses (`fzstd` — pure JS, so one
implementation serves workerd and Node) and honours `mari-core`'s verify-then-use
contract on this path too: the blake3 of the DECOMPRESSED bytes is compared to the
id the manifest named before anything is served, and a malformed id / missing
object / bad frame / hash mismatch / length disagreement is a typed
`ChunkReadError` naming the chunk (HTTP 500, no bytes). Contracts §9.1 is now
normative about all of it, and the dev seed writes real blake3 ids and real zstd
frames instead of SHA-256 ids and bare bytes. Interoperability is pinned by a
fixture the RUST side generates (`cargo test -p mari-core --test ts_store_fixture`
→ `packages/control-plane/test/fixtures/mari-core-store.json`), read back through
the HTTP routes in `test/chunk-read.test.ts`.

Verification cost, measured rather than assumed: blake3 over 1 MiB is ~11 ms on
Node 26 and ~69 ms inside workerd as the vitest pool runs it (unminified);
decoding a 1 MiB frame is ~0.1 ms, so the hash dominates. Cost is linear in file
size against the path's hard 1 MiB ceiling (`MAX_INLINE_FILE_BYTES`), which puts
a typical source file well under a millisecond and the worst case at tens of
milliseconds of a 30 s budget. Verification is therefore unconditional, never
sampled — a silently corrupt file loaded into the editor gets saved back, turning
a storage fault into data loss.

## Appendix — `e2e/`, the 1.3 loop suite

_Appended by the loop-e2e builder (append-only, per directory ownership)._

### A new top-level lane

`e2e/` (`@mari/e2e`, added to `pnpm-workspace.yaml`) holds suites that need more
than one lane at once. The first is `e2e/loop.e2e.test.ts`, which proves spec
1.3 — *start from the web application, disconnect, the agents continue, see the
results from each device* — end to end. It needs the control plane, `marid`,
the Docker substrate and the chunk store live in one process tree, so it belongs
to no component's lane; see `e2e/README.md` for what it drives and why.

```sh
MARI_LOOP_E2E=1 pnpm --filter @mari/e2e test    # ungated: collects no tests, exits 0
```

The suite imports the control plane BY PATH (`packages/control-plane/src/node`),
because that package publishes no entry map, and aliases `cloudflare:workers` to
the same Node base class its own suites do — one code path, two runtimes, no
fork.

### The one thing that needed a new technique

"The user disconnected" cannot be asserted from the client: a `readyState` is
only what the client believes, and `fetch` hides its socket pool inside undici.
The suite therefore drives HTTP through `node:http` with one `http.Agent` per
DEVICE, and watches the instance's own `http.Server` (`connection` / `request` /
`upgrade`) so the disconnected window is proven from the SERVER's side: during
it the process holds exactly ONE socket, and it is the supervisor's.

Connections are classified by request path, never by address. With Docker
Desktop the container's dial-back arrives at the host as `127.0.0.1`, identical
to a local client — an address-based rule would classify the supervisor as a
client on the very machine this suite runs on.

### Measured wake latency (spec 13's first data point)

Local Docker substrate, Apple Silicon, warm image, delta of four small files.
The suite prints these every run and asserts none of them (a latency budget is
not a correctness claim):

| Transition | p50 |
|---|---|
| `POST /runs` on a COLD computer returns | 2 ms |
| COLD wake → supervisor connected (n=3) | ~115 ms |
| COLD wake → restored files byte-identical in a fresh container (n=2) | ~265 ms |
| run request → first live terminal bytes at the client | ~670 ms |
| AWAKE → WARM (`docker pause`) | ~430 ms |
| WARM → COLD (final snapshot + destroy) | ~420 ms |

Spec 4.6(e) ("the target for the first shell prompt is seconds") holds with
room to spare on this substrate; Sprites p50/p99 remain open.

### Known gap found by this milestone

The chunk store ends up holding each run's journal TWICE under one prefix.
`marid` writes `journal/{computer}/{run}/{seq:08}.seg`
(`crates/marid/src/journal.rs`) and `ComputerDO` writes
`journal/{computer}/{run}/{seq:012}.seg` (`#segmentKey`, `computer-do.ts`) — the
same bytes, two writers, two zero-pad widths, so they do not overwrite each
other and a reader that lists the prefix and concatenates would replay the
journal twice, out of order (`00000000.seg` sorts before `000000000000.seg`).
It is latent today because nothing reads segments back — the DO replays its
SQLite journal — and contracts §9 pins neither the width nor the writer.
Deciding who owns that prefix is a cross-lane call and is deliberately NOT
patched here.

## WARM is a fast cold wake (decided 2026-07-24)

Spec 2 previously defined WARM as native substrate sleep (checkpoint or pause)
with memory intact. That promise cannot be kept uniformly: Sprites suspends,
local Docker `pause` holds RAM on the host, and Cloudflare Containers stop
outright. Rather than let state fidelity vary per substrate — which would make
"my computer" mean something different depending on where it woke — WARM is now
defined fleet-wide as: substrate resources retained, disk cache intact, no
process, no compute billing, **memory gone**.

Consequences, all of them simplifications except the last:

- One state machine for every substrate. `sleep` in the provider interface is
  now "stop the processes and keep the disk", which every substrate can honour.
- Memory never survives any transition, so spec 4.5's clean-stop rule applies to
  AWAKE→WARM as well as WARM→COLD. There is exactly one continuation mechanism
  (journal + agent adapter resume, spec 5.6) instead of two.
- The measured cold wake (~118 ms to supervisor-connected, ~266 ms to files
  byte-identical, small deltas over a warm base image) is what makes this
  affordable. WARM's remaining value is avoiding the chunk-store transfer, not
  avoiding the restart.
- **New requirement**: Mari writes a manifest before AWAKE→WARM. With no live
  process holding the disk, a substrate that reclaims storage would otherwise
  lose everything since the last snapshot. This is cheap (delta only) and closes
  the window.

## Appendix — Supervisor survivability: TLS, signals, keepalive

_Appended by the supervisor builder (append-only, per directory ownership). Three
blockers that made `crates/marid` unusable on a substrate that evicts containers
and reaps idle sockets. All three were verified against HEAD before the fix._

### 1. The control channel is TLS, and plaintext is a policy decision

`tokio-tungstenite` carried no TLS feature, so `connect_async` on a `wss://` URL
returned `Url(TlsFeatureNotEnabled)` before a packet moved: marid could not reach
an https control plane at all, and the one Cloudflare end-to-end run that
"worked" did so by dialing plaintext `ws://` to a `workers.dev` origin — which
puts the computer's fencing **token** on the wire in cleartext, followed by every
journal byte of every run.

- `rustls-tls-webpki-roots` is on, and `ws::install_crypto_provider()` installs
  the `ring` provider at startup. Both halves are required: the rustls that
  tokio-tungstenite declares has `default-features = false`, so
  `ClientConfig::builder()` panics ("no process-level CryptoProvider available")
  without an explicit install. The root store is **compiled in**, so the image
  needs no `ca-certificates` for marid's own socket (agents the user brings still
  do), and a private CA is therefore not trusted — a self-hosted control plane
  behind a private PKI must terminate TLS in front of marid, keep the supervisor
  hop on loopback/private space, or set the opt-in below.
- **Scheme policy** (`ws::classify_control_url`): `wss://` always; `ws://` only
  when the peer is provably off the public internet — an IP literal that is
  loopback / RFC 1918 / link-local / IPv6 ULA, the name `localhost` (or
  `*.localhost`), or a name **every** resolved address of which is one of those.
  One public answer refuses the dial. A verified plaintext dial is pinned to the
  address that was verified, so a second DNS answer cannot undo the check.
- A refusal is **fatal**: marid logs one line naming the host and the override,
  and exits non-zero rather than running in a state where it will leak. A failed
  *resolution* is not fatal (DNS is often not up yet in a fresh container) and is
  retried by the connect loop.
- The override is `--allow-insecure-ws` / `MARI_ALLOW_INSECURE_WS=1` (falsey
  values do not enable it). It logs what it costs, every connect.
- **Cross-lane consequence**: any deployment that hands marid a `ws://` URL for a
  public origin now fails to start. `deploy/cf-thesis/wrangler.template.jsonc`'s
  `SUPERVISOR_URL_BASE: "__WS_ORIGIN__"` must be substituted with a `wss://`
  origin. The private instance is unaffected: `node/env.ts` composes
  `ws://{host.docker.internal|private-ip}:{port}`, which classifies as private.

### 2. SIGTERM is the only warning a computer gets

There was no signal handler at all. With `containers_pid_namespace` on, an init
process is not killed by a signal it does not handle (a probe confirmed the
container surviving `kill -TERM 1` **and** `kill -KILL 1` from inside), so
Cloudflare's ~15-minute eviction grace was spent doing nothing — on the substrate
where eviction is routine and the disk is wiped on every stop. That is silent
data loss during *normal* operation.

SIGTERM and SIGINT now run the **same** sequence as `PrepareForCold` — one code
path, because the durability duty is identical and a second copy is a second
thing to get wrong: stop each run cleanly, drain completions and journal bytes to
the control plane, flush journal segments to the store, write the final manifest
(`SnapshotWritten{reason=final}`), advance the head under the current epoch, exit
0. A signal that arrives with no connection does the store half anyway
(`offline_shutdown`); the head lands in the store's head history, which is what
the next wake reads.

Bounded on purpose (`MARI_SHUTDOWN_GRACE_MS`, default 60 s): the run-stop phase
gets a third of the budget, capped at **10 s**, because `ComputerDO` gives the
`prepare_for_cold` handshake `COLD_FINALIZE_MS` (20 s) before it records
`final_snapshot_missed` and destroys the substrate resources. One stubborn run
must not cost the computer its manifest.

Found while testing this: `main` used to fall out of `async main`, and tokio's
runtime drop **waits for blocking tasks** — a run that ignored the clean stop
leaves its PTY reader parked in `read()`, so the process hung forever after a
shutdown that had already written everything durable. `main` now exits
explicitly. This bug applied to `PrepareForCold` too, and was latent only because
every test run so far exited on its own.

### 3. A keepalive that exists without a run

Spec 5.4's heartbeat holds the machine awake **while a run is active**. A probe
measured an idle WebSocket through the edge killed at ~270 s (1006, no close
frame) while the container kept running, so an AWAKE computer with no run lost
its control channel about four and a half minutes after the last run ended and
then churned.

- `MARI_KEEPALIVE_MS` (default 60 s) sends a WebSocket ping independent of runs.
- `MARI_IDLE_TIMEOUT_MS` (default 240 s) declares a socket dead when **nothing**
  inbound arrives in that window — not even a pong. This is the silent-death case
  a keepalive alone does not fix: a flow dropped without an RST leaves reads
  hanging forever and the supervisor offline with no error to show. The check
  rides the connection loop's own tick, so it works with the keepalive disabled.
- Reconnect logging distinguishes the two: a drop after ≥ the idle window is
  reported as an idle timeout at INFO ("not a failure"), anything else as a WARN
  with its reason. Attributing a reaped idle socket to a failure is what makes a
  real failure impossible to spot.

Tested at both scales against a real local server that reaps silent connections:
a 600 ms reaper with a 100 ms keepalive held for 5.8 reaper windows (the default
suite), and — under `MARI_SLOW_TESTS=1`, run and passing — the literal article: a
270 s reaper, the shipped 60 s keepalive, **320 s** of real idleness, one
connection, the channel still carrying commands afterwards. The negative control
runs by default too: with the keepalive off, the same server reaps the socket and
marid reconnects.

## Appendix — Substrate death and the wedge class

_Appended by the substrate-death lane (append-only, per directory ownership).
Closes the defect the orchestrator reproduced by hand: a computer whose container
was removed could never run anything again._

### The reproduction, and what was actually missing

1. Private instance, Docker substrate, computer AWAKE with a real container; a run
   completed, exit 0.
2. `docker rm -f` that container — a substrate eviction. On Cloudflare this is not
   exotic: instances are evicted routinely and the disk is wiped on every stop.
3. `POST /api/computers/:id/runs` → `200`, run queued, computer `"awake"`,
   `activeRuns: 1` — and **nothing happened**. No container was re-materialized.
   The run stayed `pending` indefinitely.
4. `POST /api/computers/:id/wake` → `200 {"state":"awake","epoch":1}` and did
   nothing, because the Durable Object believed it was already awake.

Every primitive needed to recover already existed — snapshot, epoch fencing,
restore, agent-adapter resume. **The trigger did not.** The bug class is: _a state
that cannot advance without an external event_. The DO's `state` is a record of
what it last asked for, not an observation, and nothing ever compared the two.

### Liveness: an optional capability, not a seventh function

Spec 3.5 fixes the provider interface at six functions and forbids using any other
substrate capability. Liveness is expressed **through** that surface, not beside
it: the control plane can ask spec 3.5's `exec` to run `/bin/sh -c 'exit 0'`, and
either it runs inside the instance or it does not.

What `exec` cannot do is tell _"this instance is gone"_ apart from _"I could not
reach the substrate API"_, and that distinction decides whether a computer is
recovered or left alone. So `provider.ts` gained one **optional declaration** in
the same family as `supportsWarm`, `holdAwake`, `proxyFetch` and
`resumeBeforeCold`:

```ts
instanceStatus?(handle): Promise<'alive' | 'gone' | 'unknown'>
```

- It is a **read** of state Mari already asked for, never a state change; a driver
  that implements it must not start or stop anything, and must not throw.
- `alive` means the resources exist (a `docker pause`d container is `alive`), not
  that a process is running.
- `unknown` is **not** `gone`. A driver that omits the method is probed through
  `exec` and reports `unknown` on refusal; no caller may require the method.
- Implemented by Docker (`inspect`; a removed container is a 404 → `gone`, anything
  else → `unknown`) and Cloudflare (`running`, then the platform's own "no
  container instance" refusal → `gone`; `running` alone is untrustworthy — it
  reports a stale `true` for minutes after `destroy()`). Sprites falls back to the
  `exec` probe.

Against spec 1.2: this is the emulator. A computer is data whose home is the chunk
store (spec 2, 4.1); "does the substrate still hold the copy I asked it to hold" is
the emulator's own question, and without an answer spec 4.1's "exactly one writable
copy" cannot be distinguished from **zero**.

### One alarm, five deadlines

A Durable Object has exactly one alarm (spec 3.2's single coordination point), and
before this change every new deadline had to fight the tier policy for it — which
is why several transitions had no deadline at all. `computer-do.ts` now multiplexes
named slots onto that alarm (`wakeRetry`, `waking`, `liveness`, `cold`, `tier`),
processes every slot that is due, and — when the alarm fires ahead of schedule,
which is exactly what `runDurableObjectAlarm` and the Node shim's `runAlarmNow` do
to simulate idle time — processes the earliest pending one.

| Slot | Exists because |
|---|---|
| `liveness` | The supervisor's socket closing arms a grace window; a computer with work in flight is health-checked on a cadence. A supervisor that spoke inside the window is its own proof, so a healthy computer costs an alarm and **no** substrate call. |
| `cold` | The AWAKE/WARM→COLD handshake asks a supervisor for a final manifest; a dead supervisor never answers. |
| `waking` | WAKING is a transition, not a resting place, and nothing else acts on it. |
| `wakeRetry` | A refused wake with work pending, bounded (see below). |
| `tier` | Spec 4.4, unchanged in meaning. |

Tunable per deployment, defaults in production shape:
`SUPERVISOR_GRACE_MS` 15 s, `LIVENESS_MS` 30 s, `COLD_FINALIZE_MS` 20 s,
`WAKE_TIMEOUT_MS` 120 s. **The order matters, not just the magnitudes**: the grace
window must be shorter than the idle deadline, or the tier policy reaches a dead
computer before the liveness check does.

### Recovery, and what it is allowed to assume

A closed supervisor socket is the FIRST signal and never sufficient — a network
blip is not a dead container, and marid reconnects with the same epoch and token.
It arms the grace window; only after it, with no supervisor back, is the substrate
asked. Two signals reach the same place, because on Cloudflare a torn-down microVM
left the DO's socket **open** (the platform reported the instance inactive while
D1's mirror still said `awake` 15 minutes later): the socket close, and a health
check that finds a computer with work in flight whose supervisor has said nothing
for a whole window.

When the instance is gone (or, after a bounded number of `unknown`s, cannot be
asked):

- the resources are destroyed best-effort — a destroy that fails records
  `destroy_failed` and the transition continues, because a handle nobody can
  destroy must not wedge a computer;
- the computer becomes **COLD at its last manifest head**. The head is not
  touched: its truth is the chunk store (spec 4.1), and nothing is invented;
- one content-free `state` event goes out (spec 6.2/6.3) — the UI's whole
  notification of this;
- in-flight runs take spec 5.6's degradation (below);
- if work was in flight or is queued, the computer is **woken again**: a FRESH
  instance under a **NEW epoch**, restoring from the head, so the dead generation
  can never advance anything even if it turns out to be alive somewhere.

`POST /wake` is honest in every outcome: `200` when the computer is really up,
`202 {error:"wake_retrying", retryAt}` when the substrate refused but a bounded
retry is armed, `503` when it refused and nothing is waiting. It never answers
"already awake" without either a live supervisor or a fresh instance behind it, and
every substrate call on the path is bounded (`WAKE_TIMEOUT_MS`) so a driver that
hangs — dockerode has no timeout of its own, and Cloudflare's over-capacity failure
mode is a hang — cannot hang a client request (spec 8.3).

### Runs in flight (spec 5.6, applied by the control plane)

The line is whether the run **provably never began** — no `startedAt`, no pre-run
manifest, not one journal byte:

- **Never began** → re-queued and the dispatch latch released. Starting it now is
  indistinguishable from starting it the first time, which is the same rule marid
  uses for a replay after a rollback. Before this it stayed `dispatched = 1`
  forever and no supervisor was ever handed it again — a run silently lost.
  **Once**, though (`MAX_RUN_REQUEUES = 1`): a run whose machine dies every time it
  is dispatched may be the reason it died (the Cloudflare e2e tears its microVM
  down from inside a run), and re-queueing forever would spend instances in a loop.
- **It ran** → the journal is left exactly as it is (spec 4.2) and the run is
  `interrupted`: a new `RunStatus`, projected onto the client's five states as
  `failed`, because no completion is fabricated. One content-free attention event
  (`kind: "interrupted"`) tells the user. marid raises the same event when it
  restarts and finds the run unfinished, so the DO de-duplicates on an
  **undismissed** `interrupted` badge — one interruption, one notification. A
  resume (marid's agent adapter, same run id) puts the run back to `running`.

Recovery itself is bounded: `RECOVERY_STREAK_MAX = 3` consecutive recoveries with
no successful `hello` in between, then the computer sits COLD with its work still
queued and `recovery_exhausted` in the incident log. A broken image must not
materialize instances forever.

### Incidents: a content-free record of what Mari had to do

Attention events belong to a RUN (spec 6.2); "your computer's instance was gone, so
it is COLD at its last snapshot" belongs to no run. A per-computer `incident` table
(kind, time, epoch — nothing else can be put in it) records `substrate_lost`,
`substrate_unknown`, `supervisor_lost`, `final_snapshot_missed`, `destroy_failed`,
`wake_abandoned`, `recovery_exhausted`, and is served by
`GET /api/computers/:id/incidents`. It exists so that a transition which completed
**without** the thing it asked for cannot be read as a clean success.

### The two observed stalls

**(a) `#beginCold` stalled.** The Cloudflare thesis e2e had to nudge a hung
AWAKE→COLD handshake with `POST /wake` and count the nudges. That nudge is gone
from `e2e/cloudflare.e2e.test.ts`: the handshake has its own deadline, and on
expiry the DO finalizes from the last known head, destroys the instance, and
records `final_snapshot_missed` — honest about the work since the last snapshot
genuinely not being in the chunk store, rather than reporting a clean COLD.

**(b) Cloudflare refuses `destroy()`→`start()` on the same Durable Object for
minutes** (measured >563 s and ~300 s; a freshly deployed container application is
likewise unschedulable for a while, with the same "no container instance" message
an over-capacity account gives). Mari's tier policy makes AWAKE→COLD→AWAKE exactly
that sequence.

What this lane did about it, all of it above the platform:

- the wake never claims success it cannot deliver and never hangs (above);
- `WAKE_RETRY_MS` spans ~12 minutes in six bounded steps (5 s, 20 s, 60 s, 120 s,
  240 s, 300 s) while work is pending, so a queued run outlives the refusal
  window; the fleet view keeps saying COLD, which is the truth, and the client is
  told when the next attempt is due;
- proven with the REAL driver over a fake `ctx.container` returning the platform's
  own refusal (`test/cloudflare_stall.test.ts`): honest 202, bounded latency, run
  preserved, then a new epoch and a dispatch when the platform relents.

**What is NOT measured, and the orchestrator has to decide it.** This lane did not
deploy: it never ran `wrangler deploy`, so the two experiments that would settle
the platform question are still open —

1. whether stopping **without** `destroy()` (`ctx.container.signal(SIGTERM)`, which
   is what `@cloudflare/containers`' `stop()` does) avoids the refusal window,
   letting the platform reclaim the instance instead of tearing it down. If it
   does, the substrate lane should make `sleep`/the tier path signal-stop and keep
   `destroy` for the cases that need it. This is a substrate-lane change.
2. Cloudflare cold-wake p50/p99 immediately after a COLD, i.e. how long the window
   really is at fleet scale.

`packages/control-plane/test/substrates/cloudflare.e2e.test.ts`'s
`MARI_CF_E2E_SLOW=1` case (re-materialize after `sleep`) therefore remains unrun in
this lane — it needs a real deploy, a real image push and up to 15 minutes of
platform patience. **If the window really is minutes on every AWAKE→COLD→AWAKE,
Cloudflare is not fit to be the DEFAULT substrate** and Sprites should be, with
Cloudflare kept for computers that idle rarely. That is a product decision, and it
belongs to whoever can run the deploy — the control plane's conduct during the
window is now defensible either way.

### Also fixed while auditing the class

- The epoch mint is persisted **before** the substrate call. A crash in between
  used to let the next wake hand the same epoch number to a different generation,
  and the whole fencing argument rests on monotonicity (contracts.md §6).
- The materialize handle is persisted **immediately**, so a failure or eviction
  after it cannot leave an instance nobody can destroy — on Cloudflare that orphan
  holds the computer's only slot.
- A computer found in WAKING when its Durable Object is CONSTRUCTED gets a fresh,
  short watchdog window: the wake it was waiting for belonged to a process that no
  longer exists.
- The Node runtime re-arms every computer's persisted alarm at boot
  (`reviveComputers`). Objects are created lazily there, so a restarted private
  instance used to leave tier deadlines, wake retries and watchdogs sitting in
  SQLite until something happened to touch that object.
- `close()` on a private instance drains background work with a 5 s bound: a
  shutdown must not wait out a substrate call, and the persisted deadlines are the
  crash-recovery path anyway.
- `sleepNow()` no longer records WARM when the substrate refused the sleep, and it
  arms the WARM→COLD deadline it always should have.
- A journal flush that cannot write (shutdown, closed storage) warns with offsets
  instead of taking the process down with an unhandled rejection.

### Tests

- `packages/control-plane/test/liveness.test.ts` — the repro end to end against a
  real ComputerDO: eviction → recovery → fresh instance, NEW epoch, the queued run
  runs, journal byte-identical with an empty anomaly ledger, the dead generation's
  head advance refused and its credentials unable to handshake; the interrupted-run
  degradation (exactly one content-free attention event, journal preserved, resume
  puts it back to `running`); the never-acked run re-queued and run exactly once;
  the poison-run bound; the self-completing COLD handshake; the tier alarm against
  a gone substrate; a hanging wake bounded and retried; the WAKING watchdog not
  fighting a live wake; a healthy computer never probed.
- `packages/control-plane/test/cloudflare_stall.test.ts` — the destroy→start
  refusal, with the real Cloudflare driver.
- `packages/control-plane/test/node/liveness.test.ts` — the same recovery on the
  private instance with **no alarm harness at all** (real timers), plus a computer
  left WAKING by a hard restart of the whole control plane.
- `packages/control-plane/test/node/substrate-death.e2e.test.ts`
  (`MARI_NODE_E2E=1`) — the orchestrator's manual repro against **real Docker**:
  `docker rm -f`, then a fresh container, a restored file read back with
  `docker exec`, the queued run executed exactly once, and the in-flight-run
  degradation. This is the case the whole suite missed, so it drives the daemon
  rather than a fake.

## Appendix — Data loss, the preview surface, and the vault (blocker-closing lane)

_Appended by the blocker-closing lane (append-only, per directory ownership).
Everything here was verified broken against HEAD before the fix, and each item
carries the test that would have caught it._

### 1. A file write is no longer allowed to lie

`MAX_ARG_STRLEN` is 32 pages (131072 bytes, NUL included) — the Linux ceiling on
ONE `execve` argument. The write run carried the whole base64 payload as a single
argv element, so **every write above 96 KiB of raw bytes failed at spawn** while
`PUT /file` and `POST /upload` had already answered `202 {"ok":true,"bytes":N}`.
Measured: the file never appeared, the run ended `signal=6`, and editor Save and
the files pane's Upload both reported success and discarded the user's work.

- The payload now travels in the script's POSITIONAL PARAMETERS, split into
  32 KiB pieces and re-joined by `printf '%s' "$@"` (POSIX reuses the format for
  every operand). `MAX_ARGV_ELEMENT_BYTES` / `MAX_ARGV_TOTAL_BYTES` in
  `src/runs.ts` state the kernel arithmetic, and a test asserts the worst case
  (a write at the cap) against both numbers — so raising the cap cannot silently
  re-create the defect.
- **`MAX_WRITE_BYTES` is now equal to `MAX_INLINE_FILE_BYTES` (1 MiB).** A file the
  editor can open is a file the editor can save; the previous 1 MiB read / 256 KiB
  write split meant the Save button was structurally unable to work on a file the
  Open button had just loaded.
- The decode writes a sibling `.mari-{run}.part` and `mv`s it over the target, so a
  failed decode leaves the previous content intact. `> target` truncated the file
  before `base64` produced a byte.
- Two lanes' work meets here: the control plane no longer composes an argv that can
  trip `E2BIG`, but **marid must still (a) not abort on a spawn failure and (b) not
  redact-fail the log** — `crates/marid` logs the composed write argv, so a write's
  full base64 content lands in `docker logs` (1,063,564 bytes for four failed
  writes) and a credentials file written through the editor is recoverable in
  plaintext from any log sink. That is a supervisor change and is NOT done here.
- Tests: `test/runs-argv.test.ts` (the arithmetic), `test/writes.test.ts` (every
  size on the reported curve through the real route and a real `ComputerDO`),
  `test/node/write-argv.test.ts` (a REAL `/bin/sh`: the round trip, the pre-fix
  single-element form failing to spawn at all, and the atomic-replace property).

### 2. A run's working directory is inside the computer

`DEFAULT_CWD` was `/` — the container's root, while `MARI_ROOT` (`/work`) is the
only tree that is snapshotted. A run's default output was therefore absent from
every manifest and destroyed at deep sleep (`git clone && npm i` in the default
directory was silently discarded). marid's own empty-cwd fallback covers a
RESUMED run only, so the control plane must send a concrete directory.

`resolveRunCwd(root, requested)` (`src/runs.ts`) is the whole rule: no request ⇒
the root; a path already inside the root ⇒ verbatim (callers that speak substrate
paths are unaffected); any other absolute path ⇒ interpreted in the COMPUTER's
filesystem space — the space the file browser, the editor and every manifest path
use — and joined onto the root. `/project` on a `/work`-rooted computer is
`/work/project`.

### 3. The credential vault is wired end to end (spec 10.1)

The vault was **write-only**: `PUT /secrets/:name` stored a value, `GET /secrets`
listed the name, and `listSecretNames` was the only reader in the repository. marid
resolves a run's `env_names` from its OWN process environment
(`crates/marid/src/run.rs`), and `ComputerDO#maridEnv` composed `MARI_*` only — so
`echo $ANTHROPIC_API_KEY` in a run printed nothing and no agent that needs an API
key could work.

- `#maridEnv` now reads the computer's vault (`listSecrets`) and merges the values
  into the `materialize` environment, which IS the supervisor's process
  environment. Values therefore never travel in `start_run` (contracts.md §5.2
  stays name-only), never enter an HTTP response, an event or a journal.
- Vault entries are written FIRST and `MARI_*` names are refused at the route and
  skipped at the merge: a computer whose vault held `MARI_TOKEN` could otherwise
  fence itself out or hand its own fencing token to a run.
- A name must be a valid environment variable (`[A-Za-z_][A-Za-z0-9_]*`), and
  `DELETE /api/computers/:id/secrets/:name` exists so a key can be rotated out.
- Not done: spec 10.1's "configured credential paths are excluded from manifests"
  (the `excludeGlobs` column exists and is passed to marid, but nothing in the
  product sets it), and the web app still has no vault UI — `packages/web` was
  being edited by another lane during this run (see §7).

### 4. The wake proxy is authorized (SEC-03)

`tryWakeProxy` did no session check and discarded the parsed `user` label. Two
consequences on a hosted instance: any port a computer published was readable by
anyone who knew the computer id, and an anonymous GET on a COLD computer called
`ComputerDO.wake()` and MATERIALIZED substrate resources — unbounded
denial-of-wallet against a stranger's computer. `test/proxy.test.ts` asserted
`200` for exactly that request, so the suite encoded the hole as correct.

The model now, all of it in `src/preview.ts` + `src/handler.ts`:

| Rule | Why |
|---|---|
| the `user` label is `SHA-256(userId)[0..12]` and is CHECKED against the computer's owner | the label is part of the address, so it must authorize something; a hash because a preview hostname ends up in DNS logs, referrers and screenshots |
| a request must carry a capability (`mari_preview` cookie, or once in the query) **or** an owning session | the preview surface both reads a port and spends substrate budget |
| the capability is an HMAC over `computer:port:expiry` (12 h), minted only by `GET /api/computers/:id/preview?port=` for a computer the caller owns | scoped: a token for port 3000 is not a token for port 22, and not a token for another computer |
| a token in the query becomes a host-scoped `HttpOnly` cookie and is redirected out of the URL | the iframe's later asset requests carry it; the token does not linger in the address bar |
| every refusal happens BEFORE the Durable Object is addressed | a refused request costs no substrate call — which is what makes the denial-of-wallet fix testable |
| `Cookie` is filtered before the request reaches the guest | whatever the user is running on their computer has no business receiving Mari's session cookie or the capability |
| unknown computer and wrong label answer the SAME 404 | the preview host of a computer that exists must not be distinguishable from one that does not |

**Spec 10.3 (CPU-hour and egress limits) is still not implemented** — zero hits for
`cpuHour`/`egressLimit` in `packages/control-plane/src`. The anonymous
denial-of-wallet path is closed, but an authenticated user can still hold their own
computers AWAKE without a ceiling. It belongs in the fleet/tier code and is a
deliberate gap, not an oversight.

### 5. Preview URLs come from the server

The pane composed `https://{port}--{computer}--user.mari.sh` from a hardcoded
scheme, a BUILD-time `VITE_PREVIEW_ZONE`, and the literal string `'user'`
(`Shell.tsx`'s `VITE_USER ?? 'user'`, whose comment claimed the control plane set
the real one). It could not work on a private instance at all, and an operator
could not configure it without editing source and rebuilding.

- `GET /api/config` (unauthenticated, content-free) serves `previewZone`,
  `previewScheme`, `previewPort`, `devAuth`, `devSeed` and the write/read caps.
- `GET /api/computers/:id/preview?port=` serves the host, the capability URL and
  the stable URL; `BrowserPreviewPane` frames what it is given and validates the
  one-label shape with the client mirror of the proxy's parser.
- The Node runtime's default `PREVIEW_ZONE` is now **`localhost`**, not `mari.sh`:
  `*.localhost` resolves to loopback in Chrome and Firefox with no DNS, so a
  private instance's preview pane works out of the box.
- Every proxy failure is now a 502 with a reason (`expose_port`,
  `upstream_unreachable`, `proxy_fetch`), the driver's own message, and one log
  line. It used to be a bare 500 with an empty body and no log — indistinguishable
  from a control-plane fault, for the two most common cases (a port that was never
  published, and a port with nothing listening).

### 6. Smaller honesty fixes

- **Sleep on demand** (`POST /api/computers/:id/sleep`, `{deep:true}` for spec
  4.4's deep sleep). There was no route at all, so an AWAKE computer billed until
  the idle timer. The response reports `settled`, because AWAKE→COLD waits for the
  supervisor's final manifest (spec 4.5) and claiming `cold` before it arrives
  would be a lie.
- **A brand-new computer is browsable.** `POST /api/computers` seeds the head with
  the fleet's `BASE_MANIFEST` (spec §2), and a computer with no manifest at all
  lists an EMPTY root instead of `404 no_manifest` — a new computer looked like a
  broken file browser.
- **Actionable error shapes.** `dismiss` answers `400 bad_event_id` for a
  non-numeric id and `404 attention_not_found` for a miss (it used to answer
  `200 {ok:false}` for both, which `res.ok` reads as success); `stop` on a run that
  never started reports `status:"cancelled"` beside the client's `failed`, so a
  user's own cancellation is not recorded as a failure.
- **The Node alarm no longer swallows throws.** `node/state.ts` deleted the alarm
  row before running the handler and caught every error silently, so a computer
  whose transition threw consumed its deadline FOREVER with no log line. It now
  logs and re-arms with bounded backoff (1 s, 5 s, 15 s, 60 s), never overwriting a
  re-arm the handler itself performed.
- **`MARI_`-prefixed environment variables work.** `deploy/README.md` documents
  `MARI_AUTH_SECRET`, `MARI_DEV_AUTH`, `MARI_DEV_SEED`, `MARI_PREVIEW_ZONE`,
  `MARI_WARM_IDLE_MS`, `MARI_COLD_IDLE_MS`, `MARI_PORT`, `MARI_BASE_URL`; the Node
  entry read only the unprefixed forms, so the README's own "without compose"
  recipe silently ignored the auth secret and the tier thresholds. Both spellings
  are accepted, the documented one winning.
- **`+ Terminal` opens a real terminal.** It (and the palette's "New terminal
  pane") bound the pane to the literal run id `'shell'`, which no supervisor has
  ever heard of: the pane was permanently blank. It now starts `/bin/sh -i` as a
  run and binds the pane to the id the control plane returned (spec 7.1: a terminal
  pane is a view OF a run).

### 7. v0 deviation: spec 8.5 "Browser, computer mode" does not exist

Spec 8.5's second browser pane — a Chromium instance ON the computer, streamed
into the pane, with a persistent profile, agent-drivable, with the user able to
take control — **is not implemented anywhere in this repository.** `grep -rn
'computer mode|chromium|CDP|devtools'` over `packages/web`,
`packages/control-plane` and `crates` returns nothing, and `wm/pane.ts` declares
only `terminal`/`files`/`editor`/`preview`/`runs`/`diff`.

Spec 10.2 is therefore unimplemented too, in all three of its parts: the default
fork does not exclude a browser profile (there is none), profile chunks are not
encrypted, and a difference view has no cookie content to hide.

This is recorded as a v0 deviation rather than a bug: preview mode (a stable URL
per port, spec 8.5's first browser pane) is real and now works end to end, and
"computer mode" is a separate build — a browser in the base image, a stream
protocol, an input path, and a profile-exclusion rule in the snapshotter. Whoever
picks it up should read it as new work, not as a repair.

### 8. Not fixed by this lane, and why

- **`crates/marid`**: the write-argv log leak and the abort-on-spawn-failure
  (§1). Supervisor lane.
- **`packages/web` fleet controls, the vault UI and attention dismissal**: another
  lane was editing `FleetHome.tsx`, `Shell.tsx`, `api/client.ts`, `EditorPane.tsx`
  and `FilesPane.tsx` while this one ran, so the only web changes made here are in
  files that lane had not touched (`BrowserPreviewPane.tsx`, `PaneHost.tsx`,
  `runs/shell.ts`, `Workspace.tsx`, `commands.ts`, plus additive functions at the
  end of `api/client.ts`). The `user` prop chain from `Shell.tsx` is now inert and
  should be deleted by whoever next owns that file.
- **The passkey-only sign-in screen**: `GET /api/config` now reports `devAuth`, so
  the screen CAN offer the email+password path a private instance documents, but
  the screen itself was not changed — that needs `AuthApi`, the auth machine and
  the gate, and the private instance is usable with passkeys on `localhost` today.
- **Spec 10.3 CPU-hour/egress limits** (§4).
- **Layout minimum pane width, header overflow, and Super+1..9 vs Alt/Meta+1..9**:
  cosmetic, and in the contested files.
- **Two findings from the sweep were already fixed and are recorded here as such**:
  `manifest-store.readFile` DOES verify blake3 and refuse a short chunk
  (`decodeChunkBody`, `ChunkLengthMismatch`, `ManifestSizeMismatch`), and the dev
  seed DOES write real zstd frames (`encodeChunkBody`) — both landed with the
  compression fix that this file's private-instance appendix already describes.

## Appendix — Deploy preflight: a deployment may not claim a substrate it lacks

_Appended by the deploy-preflight lane (append-only, per directory ownership).
`deploy/DEPLOY.md` is the runbook; this records the one behavioural rule that lane
added and the reason it is a rule and not a README paragraph._

`wrangler.jsonc`'s `env.production` ships `SUBSTRATE_MODE: "fake"` on purpose — a
real substrate must not be switched on by the change that first defines it, and
whether Cloudflare Containers should be Mari's DEFAULT substrate is still an open
product decision (see "the two observed stalls": `destroy()`→`start()` on the same
Durable Object is refused for minutes, and Mari's tier policy makes
AWAKE→COLD→AWAKE exactly that sequence).

But the fake driver hands out handles, reports every instance `alive`, and starts
no process. Deployed, that is the wedge class the substrate-death lane closed,
wearing a success costume: `POST /wake` answers `200 {"state":"awake"}`, the fleet
shows `activeRuns`, no supervisor ever connects, and nothing appears in the logs —
for the life of the deployment.

So: **on a production environment (auth.ts's `isProductionEnv`, the same three
OR'd triggers the auth layer uses) a `ComputerDO` holding a `FakeSubstrate`
refuses to wake** — `substrate_not_configured`, HTTP 503, no state touched, no
epoch spent, no substrate call. Everything a computer can serve without a
substrate keeps working: sign-in, the fleet view, browsing the manifest head
(spec 8.4). The verdict is taken in the constructor, from `instanceof
FakeSubstrate` rather than a second reading of `SUBSTRATE_MODE`, because the
driver selection has already answered that question and two sources for one
verdict is how they drift.

Two tests, both with the failure they exist for:

- `test/node/unbacked-substrate.test.ts` — a REAL production-shaped `Env` on the
  Node runtime (the Workers pool cannot make a Durable Object's own environment
  production-shaped; its `env` comes from wrangler.jsonc). The refusal, a queued
  run left `queued` with the computer COLD, and the polarity control: the same
  fake still wakes a dev origin. Neutralise the guard and the first two fail with
  `expected 'awake' to be 'cold'`.
- `test/deploy-preflight.test.ts` — the production config's substrate wiring must
  be internally consistent: a real `SUBSTRATE_MODE` requires a `wss://`
  `SUPERVISOR_URL_BASE` (marid's `MARI_CONTROL_URL` has no default, so an absent
  one kills every container at startup) and a `STORE_URI` that is not a
  substrate-local `fs://` path (that disk is wiped on every stop). Plus the
  `CF_MAX_INSTANCES` ↔ `containers[].max_instances` mirror, the two container
  blocks being copies, the migration list creating each DO class exactly once, and
  `AUTH_RP_ID` being the app host rather than the preview zone.

**Resolved for hosted v0.1 (2026-07-27).** Production now flips to the real
Cloudflare substrate, uses `wss://app.mari.sh`, builds marid with S3, mints
short-lived tenant-scoped R2 credentials, rewrites the supervisor store into an
opaque account root, and lazily bootstraps/copies the base manifest into that
root. The older Cloudflare thesis harness still uses its scratch S3 facade and
plain workers.dev channel; its header now marks those as coverage gaps, not
workarounds or evidence for the hosted credential/TLS path.

## Appendix — Hosted v0.1 integration supersedes the earlier gap inventory

_Appended by the v0.1 integration lane on 2026-07-27. The older sections remain
above because this log is append-only; this appendix is the current verdict._

The earlier appendices accurately described the branch at the time, but their
lists of missing product surfaces are no longer the v0.1 boundary:

- Browser computer mode now runs Chromium inside the computer on Xvfb, binds VNC
  to loopback, and streams noVNC through the authenticated preview proxy. The
  live profile stays under excluded `.mari`; only an AES-256-GCM archive enters
  the manifest. Its key is derived from `AUTH_SECRET`, owner id, and computer id,
  so forks quarantine the unreadable inherited archive and begin with a fresh
  browser profile.
- The hosted quota ledger atomically caps create/fork at three computers and
  gates explicit wake, run, write, upload, and preview-wake paths against 100
  AWAKE hours per UTC month. Recurring alarms checkpoint long intervals and
  split them at month boundaries. Provider egress is still not attributable and
  therefore is not presented as an enforced limit.
- Vault names are visible while values remain write-only. Wake materializes only
  that computer's vault values into the supervisor, and each run starts with an
  empty environment plus ordinary process ergonomics and explicitly named
  values. `MARI_*` and `AWS_*` cannot be stored or requested.
- Account-scoped R2 roots, temporary exact-object/prefix credentials, rotation
  before expiry, a lazy empty base manifest, strict permanent deletion, wake and
  incident visibility, usage/limit UI, ordered layout persistence, connection
  recovery, and WebSocket input queuing are part of the integrated v0.1.

Box remains implemented as an experimental provider, not a hosted scheduler.
The observed API can archive and resume but cannot delete, and archived boxes
retain storage for their lifetime. Enabling it would violate Mari's permanent
delete and honest-COLD contracts. The driver therefore fails closed unless a
retained-resource test is explicitly authorized; hosted execution remains in
the isolated Cloudflare computer until Box offers bounded deletion or an
equivalent disposable resource.

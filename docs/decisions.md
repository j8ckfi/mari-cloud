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

### Known gap found by this milestone

`mari-core` stores chunk bodies **zstd-compressed** (`crates/mari-core/src/store.rs`),
while the control plane's `manifest-store.ts` concatenates chunk bytes as-is.
Manifests themselves are plain CBOR, so browsing and diffing a real computer
work; reading a real computer's file CONTENT through `GET /api/computers/:id/file`
returns the compressed bytes. Contracts §9 does not mention compression either.
This is a cross-lane fix (a Workers-compatible zstd decoder plus a contracts
note) and is deliberately NOT patched here.

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

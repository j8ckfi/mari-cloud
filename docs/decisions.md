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
| `crates/mari-substrate` | substrate builder |
| `packages/control-plane` | control-plane builder |
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

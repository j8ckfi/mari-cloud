# Mari — Wire & Storage Contracts

This document is normative for the byte-level contract between the supervisor
(`marid`), the control plane, the web client, and the chunk store. It describes
what [`crates/mari-proto`](../crates/mari-proto) defines and
[`packages/shared`](../packages/shared) mirrors. The two sides are held in
lockstep by conformance fixtures (§8); if this document and the code disagree,
the code plus its passing fixtures win — fix the document.

Terms are used with the meanings in [spec.md §2](spec.md). Stack and mechanism
decisions come from [decisions.md](decisions.md).

## 1. Encoding rules

The wire and storage encoding is **CBOR** (RFC 8949), produced on the Rust side
by `ciborium` and on the TypeScript side by `cbor-x` configured to match it
byte-for-byte (`packages/shared/src/cbor.ts`).

- **Structs are CBOR maps** with definite length and **text-string keys**. Keys
  are the Rust field names in **declaration order** (e.g. `computer`, `epoch`,
  `token`, `proto_version`). Field names are `snake_case`; the TypeScript mirror
  uses the identical keys — never camelCase them.
- **The two message envelopes** (`SupervisorMessage`, `ControlMessage`) and
  **data-carrying enums** (`ExitStatus`) are **adjacently tagged**: a value is a
  map `{ "t": <variant>, "c": <payload> }`, where `t` is the `snake_case`
  variant name and `c` is the payload. Payload-free variants
  (`prepare_for_cold`) omit `c` entirely: `{ "t": "prepare_for_cold" }`.
- **Simple field enums** (`ComputerState`, `EntryKind`, `SnapshotReason`,
  `AttentionKind`) serialize as a **bare `snake_case` text string** (e.g.
  `"warm"`, `"file"`, `"pre_run"`, `"blocked_read"`) — not a tagged map.
- **`Option::None` is CBOR `null`**; fields are never skipped. Every struct's key
  set is therefore fixed regardless of values (`parent` and `symlink_target` are
  always present, `null` when absent).
- **Byte payloads are CBOR byte strings** (major type 2), decoded to
  `Uint8Array` in TypeScript. Only `JournalFrame.bytes` is a byte string today.
- **Integers use shortest-form encoding** and are always CBOR **integers**
  (major type 0/1), never floats. All `u64` values MUST be `<= 2^53 - 1`
  (`MAX_SAFE_INTEGER`) so the TypeScript side decodes them as `number`, not
  `BigInt`. `Epoch` and `JournalOffset` `debug_assert!` this when serialized. On
  the TS side `packages/shared/src/cbor.ts` decodes 8-byte uints with
  `int64AsNumber` and rewrites any integer-valued `Number >= 2^32` to a CBOR
  integer before encoding — calling `assertJsSafe` so an out-of-contract value
  fails loudly — because `cbor-x` would otherwise emit a CBOR float64 for such
  values, which `ciborium` (marid) refuses to decode into a `u64`. Fixtures with
  offsets/epochs at `2^32` and `2^53 - 1` (`*_large`, §8) pin this parity.
- Maps and arrays are definite-length. No CBOR tags, no self-describe header, no
  indefinite-length items are emitted.

### Casing map (Rust variant → wire tag)

| Rust | Wire |
|---|---|
| `SupervisorMessage::HeadAdvanceRequest` | `head_advance_request` |
| `SupervisorMessage::JournalFrame` | `journal_frame` |
| `ControlMessage::PrepareForCold` | `prepare_for_cold` |
| `ControlMessage::HeadAdvanceResult` | `head_advance_result` |
| `SnapshotReason::PreRun` | `pre_run` |
| `AttentionKind::BlockedRead` | `blocked_read` |
| `ExitStatus::Signaled` | `signaled` |

## 2. Framing

The supervisor <-> control-plane stream carries back-to-back frames. Each frame
is a **4-byte big-endian `u32` body length** followed by that many bytes of CBOR
body:

```
+--------- 4 bytes ----------+------------- N bytes -------------+
| body length N (big-endian) | CBOR body (one encoded message)  |
+----------------------------+----------------------------------+
```

- Maximum body length is **`MAX_FRAME_LEN` = 64 MiB**. A larger declared length
  is rejected before allocation (`FrameTooLarge`), on both sides.
- `mari_proto::{encode_frame, decode_frame, FrameReader}` and
  `packages/shared/src/frame.ts` (`encodeFrame`, `decodeFrame`, `writeFrame`,
  `FrameReader`) implement this identically. `FrameReader` accepts stream bytes
  in arbitrary chunks and yields complete bodies.
- The framing is validated across languages by the `*.frame` fixtures (§8): the
  Rust-produced `sup_hello.frame` equals `writeFrame(sup_hello.cbor)` byte-for-
  byte in TypeScript.

The **client <-> Durable Object** attach protocol (§7) does **not** use this
framing: a browser `WebSocket` already delimits messages, so those are sent as
discrete CBOR messages.

## 3. Identifiers

| Type | Rust | Wire | Meaning |
|---|---|---|---|
| `ComputerId` | `String` | text | Stable computer identity (spec §2); not a substrate address. |
| `RunId` | `String` | text | One run (spec §5). |
| `ManifestId` | `String` | text | blake3 **hex** of a manifest's CBOR. |
| `ChunkId` | `String` | text | blake3 **hex** of a chunk's bytes. |
| `Epoch` | `u64` | uint `< 2^53` | Fencing token minted at wake (§6). |
| `JournalOffset` | `u64` | uint `< 2^53` | Byte offset into a run's journal. |

`ManifestId`/`ChunkId` are the lowercase hex of the 32-byte blake3 digest (64
hex chars). `mari-core` computes them; this crate only carries them.

## 4. Manifest format (storage)

A `Manifest` is a snapshot of a whole filesystem: a **flat, path-ordered list**
of entries (a file tree, not a bare chunk list — decisions.md). It is stored at
`manifests/{id}.cbor`; its `ManifestId` is the blake3 of that CBOR.

**`Manifest`**

| Field | Type | Meaning |
|---|---|---|
| `version` | `u32` | Schema version, currently `1` (`MANIFEST_VERSION`). |
| `parent` | `ManifestId \| null` | Base-image manifest this layers on, or `null`. |
| `created_at` | `u64` | Creation time, Unix **seconds**. |
| `entries` | `ManifestEntry[]` | The filesystem, sorted by `path`. |

**`ManifestEntry`**

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | Absolute path; the ordering key. |
| `kind` | `EntryKind` | `"file"` \| `"dir"` \| `"symlink"`. |
| `mode` | `u32` | Unix mode bits incl. file-type bits (e.g. `33188` = `0o100644`). |
| `size` | `u64` | File byte length; `0` for directories. |
| `symlink_target` | `string \| null` | Link text for a symlink, else `null`. |
| `chunks` | `ChunkRef[]` | Ordered content chunks; empty for dirs/symlinks. |

**`ChunkRef`**: `{ chunk: ChunkId, len: u64 }` — a chunk id and the number of
bytes it contributes to the file. A file's content is the concatenation of its
`chunks` in order; `sum(len) == size`.

**`HeatProfile`** (`heat/{computer}.cbor`): `{ paths: string[] }` — the ordered
list of paths a computer reads at boot and run start. Cold wake prefetches
chunks in this order (spec 4.6(d)).

**`DiffSummary`**: `{ added: u32, modified: u32, removed: u32 }` — counts of
entries changed against the pre-run manifest (spec 5.3).

## 5. Messages

Every message below is one adjacently-tagged envelope value; a `—` payload means
the `c` key is omitted.

### 5.1 Supervisor → control (`SupervisorMessage`)

| `t` | Payload `c` | Meaning |
|---|---|---|
| `hello` | `computer: ComputerId, epoch: Epoch, token: string, proto_version: u32` | First frame after connect. Identifies the computer, its wake epoch, an auth token, and the protocol version (`PROTO_VERSION` = 1). |
| `journal_frame` | `run: RunId, offset: JournalOffset, bytes: byte string` | A slice of a run's journal (terminal bytes + framed tool events) starting at `offset`. |
| `run_started` | `run: RunId, pre_run_manifest: ManifestId` | A run began; names its diff baseline (spec 5.2). |
| `run_completed` | `run: RunId, exit: ExitStatus, post_run_manifest: ManifestId, diff: DiffSummary` | A run finished. `exit` is `{t:"exited",c:{code}}` or `{t:"signaled",c:{signal}}`. |
| `snapshot_written` | `manifest: ManifestId, epoch: Epoch, reason: SnapshotReason` | A snapshot was written to the store (spec 4.3). |
| `head_advance_request` | `manifest: ManifestId, epoch: Epoch` | Ask the DO to advance the manifest head; CAS on `epoch` (§6). |
| `attention` | `run: RunId, kind: AttentionKind` | **Content-free** attention event (spec 6.2). `kind` ∈ `bell`/`osc`/`blocked_read`. No terminal text is ever included. |
| `run_heartbeat` | `run: RunId` | Liveness / substrate hold during a run (spec 5.4). |

### 5.2 Control → supervisor (`ControlMessage`)

| `t` | Payload `c` | Meaning |
|---|---|---|
| `hello_ack` | `acked: RunOffset[]` | Reply to `hello`: the durably-acked journal offset per run (`RunOffset = {run, offset}`), so the supervisor resumes streaming from the right place. |
| `journal_ack` | `run: RunId, offset: JournalOffset` | Bytes durably received up to (exclusive) `offset`. |
| `start_run` | `run: RunId, argv: string[], env_names: string[], cwd: string` | Start a run. `env_names` are the vault variables to inject at run start (spec 10.1); **values never travel in this message**. |
| `stop_run` | `run: RunId` | Stop a run's process. |
| `input` | `run: RunId, bytes: byte string` | Terminal input for a run's PTY: the raw bytes an attached client typed. The DO forwards these from the client↔DO attach protocol (§7.1); the supervisor writes them to the run's PTY (spec 7). |
| `resize` | `run: RunId, cols: u16, rows: u16` | Viewport resize for a run's PTY window (spec 7.5). Forwarded by the DO from the attach protocol. |
| `snapshot_now` | `reason: SnapshotReason` | Take a snapshot now, tagged with `reason`. |
| `prepare_for_cold` | — | Stop each agent session cleanly ahead of WARM→COLD (spec 4.5). |
| `head_advance_result` | `accepted: bool, current_epoch: Epoch` | Reply to `head_advance_request`: whether the head advanced, plus the DO's authoritative epoch so a fenced-out supervisor learns it lost. |
| `restore_to_manifest` | `manifest: ManifestId` | Restore the disk to a manifest (spec 5.3 restore / 4.7 replay). |

### 5.3 `ComputerState`

`"awake"` \| `"warm"` \| `"cold"` \| `"waking"` (spec §2). Held by the Durable
Object and rendered in the fleet view; a bare string on the wire.

## 6. Epoch fencing (spec 4.1 mechanism)

Exactly one writable copy of a computer may exist (spec 4.1). The mechanism is a
fencing epoch owned by the Durable Object (decisions.md):

1. **Mint at wake.** When a computer transitions toward AWAKE, the DO increments
   and persists a monotonic `Epoch` and hands it to the supervisor. The
   supervisor echoes it in `hello` and carries it on every state-changing
   message.
2. **CAS on head advance.** To move the manifest head, the supervisor sends
   `head_advance_request { manifest, epoch }`. The DO accepts **only if `epoch`
   equals its current epoch** (compare-and-swap), then advances the head and
   replies `head_advance_result { accepted: true, current_epoch }`.
3. **Stale epoch rejected.** If `epoch` is not current (a previous supervisor
   was fenced out by a newer wake), the DO leaves the head unchanged and replies
   `head_advance_result { accepted: false, current_epoch }`. The stale
   supervisor now knows it lost and must stop writing.

Chunk writes are content-addressed and so are harmless from a fenced-out writer;
**only the head advance is fenced** — it is the sole thing that matters.

```
supervisor                         Durable Object
    | hello { epoch = E }                |
    |----------------------------------->|  (E == current? proceed)
    |                 hello_ack { acked } |
    |<-----------------------------------|
    | head_advance_request { M, epoch=E }|
    |----------------------------------->|  if E == current: head = M
    | head_advance_result{accepted,E_cur}|
    |<-----------------------------------|
```

## 7. Client ↔ Durable Object attach protocol (web app)

Defined in TypeScript only (`packages/shared/src/attach.ts`); it never reaches
`marid`. A terminal pane speaks it to the computer's Durable Object over a
browser `WebSocket`, exchanging discrete CBOR messages (no length framing).

**Flow (spec 7.3):** on attach the DO replies with the **current grid** (not a
journal replay); it then streams **live frames**. Input flows
client → DO → supervisor.

### 7.1 Client → DO (`ClientToDo`)

| `t` | Fields | Meaning |
|---|---|---|
| `attach` | `run, cols, rows` | Attach to a run's terminal at the given viewport. |
| `input` | `run, bytes: Uint8Array` | Terminal input; the DO forwards bytes to the supervisor's PTY. |
| `resize` | `run, cols, rows` | Viewport resize; propagated to the PTY window size. |
| `detach` | `run` | Stop receiving live frames. |

### 7.2 DO → client (`DoToClient`)

| `t` | Fields | Meaning |
|---|---|---|
| `grid` | `run, grid: GridSnapshot, baseOffset` | The full grid at attach time; live frames start at `baseOffset`. |
| `frame` | `run, offset, bytes: Uint8Array` | A live slice of terminal output to feed xterm.js. |
| `run_status` | `run, alive: bool, exitCode: number\|null` | The run's liveness/exit changed. |

`GridSnapshot = { cols, rows, cells: GridCell[][], cursorCol, cursorRow,
cursorVisible }`, `GridCell = { ch, attrs, fg, bg }`. The grid is produced by
the control-plane `GridEngine` (decisions.md v0 deviation 1); the client codes
only against xterm.js (spec 7.4), so this shape may evolve with that engine.

## 8. Conformance fixtures

`crates/mari-proto/tests/fixtures.rs` serializes one deterministic exemplar of
every message plus `Manifest`, `HeatProfile`, `ComputerState`, and a `signaled`
`ExitStatus` into `packages/shared/fixtures/`:

- `NAME.cbor` — the CBOR body of the value.
- `NAME.expected.json` — canonical JSON of the same value (byte payloads appear
  as arrays of numbers).
- `sup_hello.frame`, `sup_journal_frame.frame` — the length-prefixed wire frame,
  for cross-language framing checks.

The `*_large` exemplars (`ctl_journal_ack_large`, `ctl_hello_ack_large`,
`sup_hello_large`) carry `JournalOffset`/`Epoch` values at `2^32` and at
`2^53 - 1`, so the re-encode check catches any regression to the integer-encoding
parity described in §1.

Regeneration is deterministic (fixed values, no timestamps, no randomness): run
`cargo test -p mari-proto`. The `packages/shared` vitest suite loads every
`.cbor`, decodes it, deep-equals it against the `.expected.json`, and re-encodes
it to assert byte-identical output. Either suite fails on drift.

## 9. Store object layout

The chunk store (R2 / S3-compatible; spec 3.3) uses these keys:

| Key | Contents |
|---|---|
| `chunks/{id[0..2]}/{id}` | One chunk's body: its bytes **zstd-compressed** (see below). The 2-hex-char prefix directory (`id[0..2]`) shards the keyspace. |
| `manifests/{id}.cbor` | One `Manifest`, CBOR (§4), **uncompressed**. `id` is its blake3. |
| `heat/{computer}.cbor` | The `HeatProfile` for a computer (§4), uncompressed. |
| `journal/{computer}/{run}/{seq}.seg` | Journal segments written directly to the store by `marid` (decisions.md); `seq` is a zero-padded ordinal. Raw journal bytes, uncompressed. Only the coalesced live tail and segment pointers flow through the DO. |

Chunks and manifests are immutable and content-addressed, so writes are
idempotent and safe from a fenced-out writer (§6). Garbage collection is
mark-and-sweep over the live set of all retained manifests (decisions.md); no
object here is deleted except by that swept process after its safety window.

### 9.1 A chunk body is compressed; a chunk id is not

**The object at `chunks/{id[0..2]}/{id}` is a zstd frame, and `id` is the blake3
of the frame's CONTENTS, never of the frame.** `mari-core` compresses every chunk
body at zstd level 3 on write (`crates/mari-core/src/store.rs`) because a wake
reads many chunks; compression is a storage detail that identity deliberately
ignores, so the same bytes always land under the same key whatever the encoder
did with them.

This section used to omit that, and the omission cost a release: the control
plane's reader concatenated stored bodies and sliced them to the plaintext length
from the manifest, so `GET /api/computers/:id/file` served a truncated prefix of a
compressed frame for every file a real supervisor had written. Directory listings
and diffs were unaffected (they are functions of the manifest alone), which is
exactly why nothing noticed. So, normatively:

**A reader of a chunk MUST**

1. **decompress** the stored body as a zstd frame, and
2. **verify then use**: re-hash the decompressed bytes with blake3 and compare to
   the `ChunkId` it asked for, *before* the bytes are used or served, and
3. treat a `ChunkRef.len` from a manifest as the length of the **plaintext**
   (never of the stored object), and
4. **refuse** — with an error naming the chunk — on a malformed id, a missing
   object, an undecodable frame, a hash mismatch, or a length disagreement.
   Partially verified content must never be emitted; assemble, then serve.

Both implementations do exactly this: `ChunkStore::get_chunk`
(`Error::ChunkDecompress` / `Error::ChunkCorrupted`) and, on the TypeScript side,
`packages/control-plane/src/manifest-store.ts` (`decodeChunkBody`, `getChunk`,
`readFile`) using `fzstd` and a pure-JS blake3 so the same code runs on workerd
and on Node. Its `ChunkReadError.code` is the wire code the file routes return
with **HTTP 500** and a JSON body `{ error, path, chunk }`: `chunk_id_malformed`,
`chunk_missing`, `chunk_undecodable`, `chunk_corrupt`, `chunk_length_mismatch`,
`manifest_size_mismatch`. A store-integrity failure is not a 404: the path exists,
the store's answer for it does not, and no bytes are served.

A **writer** other than `mari-core` (the dev seed, and tests) must produce the
same shape. A conformant zstd frame of *raw* blocks is acceptable and is what
`encodeChunkBody` emits, there being no pure-JS zstd compressor that runs on
workerd; it is a 1:1 ratio, not a different format, and `zstd(1)`, libzstd and
`fzstd` all decode it. An **empty file has zero chunk refs** — no empty chunk
body is ever stored.

Cross-language proof lives in
`packages/control-plane/test/fixtures/mari-core-store.json`: a store written by
the Rust snapshotter (regenerate with `cargo test -p mari-core --test
ts_store_fixture`), loaded into a real R2 binding and read back through the HTTP
routes by `test/chunk-read.test.ts`.

## Appendix A — Dev seed route (control-plane)

_Appended by the control-plane builder (append-only, per directory ownership)._

The control plane exposes a deterministic seed endpoint used by the web
Playwright suite. It exists **only when the `DEV_SEED=1` var is set**; otherwise
it responds `404`. It is unauthenticated because it mints the session it returns.

**`POST /api/dev/seed`**

- Request body: none required. Optional JSON overrides the seed identity:
  `{ "email"?: string, "password"?: string, "name"?: string }`.
- Success `200`, JSON body:

  ```json
  {
    "user":     { "id": "<userId>", "email": "seed@mari.test" },
    "session":  { "token": "<betterAuthSessionToken>" },
    "computer": { "id": "seedcomputer", "name": "Seed Computer",
                  "state": "cold", "head": "<manifestId>" },
    "manifest": "<manifestId>",
    "files":    ["/README.md", "/notes/todo.txt", "/src/main.ts", "/src/util.ts"],
    "postRunManifest": "<manifestId>",
    "postRunFiles":    ["/README.md", "/notes/made-by-mari.txt",
                        "/notes/todo.txt", "/src/main.ts"]
  }
  ```

- Response also carries the Better Auth **`Set-Cookie`** session header; reuse it
  (or `session.token`) to authenticate subsequent `/api/*` calls.
- Side effects (idempotent): applies the D1 schema; upserts the seed user + a
  session; writes the manifest + chunks for the tree above into the R2 `STORE`;
  **resets each seeded computer's Durable Object run/attention/journal state**;
  sets the `seedcomputer` Durable Object head **without waking** (spec 8.4); and
  records one sample vault secret name (`ANTHROPIC_API_KEY`, spec 10.1).
- **`postRunManifest`** is a SECOND real manifest in the store (`SEED_TREE_AFTER`
  in `src/seed.ts`): the seed tree after a run touched it, differing by exactly
  one added (`/notes/made-by-mari.txt`), one modified (`/README.md`) and one
  removed (`/src/util.ts`) entry, so `diff(manifest → postRunManifest)` is
  `{ added: 1, modified: 1, removed: 1 }` at known paths. No computer's head
  points at it. It exists because a run's result is a difference between two
  manifests (spec 5.3) and only `marid`/`mari-core` can write one: the web e2e's
  fake supervisor reports these two ids in `run_started`/`run_completed` so the
  review pane renders a difference the real engine computed from real manifest
  bytes. (A made-up id makes `GET /runs/:id/diff` a `404 manifest_missing`, and a
  subsequent `keep` moves the head to an object that is not in the store, after
  which the file browser 404s.)
- **The reset is what makes the seed deterministic on a re-run.** `wrangler dev`
  persists Durable Object storage between sessions, so without it a second suite
  run inherits the previous run's run rows and undismissed attention events —
  and an e2e assertion such as "the attention badge shows exactly one waiting
  run" would pass on residue. `ComputerDO.resetSeedState()` is gated on
  `DEV_SEED=1` and is a no-op in any deployed control plane.

**Content addressing in the seed is real** (superseding the earlier note that it
used SHA-256 as a stand-in): chunk ids are the blake3 of the plaintext, the
manifest id is the blake3 of its CBOR (§3), and every chunk body is written as a
zstd frame (§9.1). It has to be — the file-read path now verifies every chunk it
serves, and a seed with its own digest algorithm would fail that check on the
first read. The remaining deviation is only that TypeScript writes a manifest at
all (decisions.md says `mari-core` is the writer); the seed does it because the
web Playwright suite needs a deterministic COLD computer with no supervisor in
the picture.

## Appendix B — v0 control-plane protocol notes

_Appended by the control-plane builder._

- **Supervisor ↔ DO WebSocket** uses the §2 length-framed CBOR envelopes
  (`SupervisorMessage`/`ControlMessage`). Request/response replies (`hello_ack`,
  `head_advance_result`) return on the **originating** socket; DO-initiated
  messages (`journal_ack`, `prepare_for_cold`) go to the active (last-handshook)
  supervisor. The handshake validates `proto_version`, the current `epoch`, and
  the one-time `token` minted at wake; a mismatch closes that socket (`1008`).
- **Client terminal input.** Terminal input/resize are first-class
  `ControlMessage`s (§5.2 `input` / `resize`). The client→DO attach protocol
  (§7.1) carries `input`/`resize` as discrete CBOR; the DO re-frames each as the
  matching length-framed `ControlMessage` (`{ "t": "input", "c": { run, bytes } }`
  / `{ "t": "resize", "c": { run, cols, rows } }`) and forwards it to the
  supervisor, which writes the bytes to the run's PTY and applies the window
  size. (This closes the earlier v0 gap: the ad-hoc `client_input` /
  `client_resize` frames no longer exist.)
- **Attach snapshot (v0).** Because v0 `marid` keeps no grid (decisions.md
  deviation 1), on attach the DO sends an empty `grid` then replays the exact
  prior journal tail as a `frame` at offset 0 (byte-identical), and streams live
  frames thereafter. The control-plane `GridEngine` still renders a server-side
  grid, exposed via the DO `snapshotGrid(run)` method; that is the point where
  attach will send a populated `grid` (baseOffset = journal head) once
  libghostty-vt lands.

## Appendix C — Run lifecycle, file writes, fleet, and the event stream

_Appended by the control-plane builder (append-only, per directory ownership)._

The REST surface that drives spec 1.3's central loop. Every route below is under
the `/api/*` session guard and is ownership-scoped (a computer id you do not own
is `404`, never `403`-by-existence). Ids in paths are URL-encoded.

### C.1 Runs (spec 5)

| Route | Body / result |
|---|---|
| `POST /api/computers/:id/runs` | `{ argv: string[], cwd?, envNames?: string[], agent?, path? }` → `200 { runId, run, state: "pending", computerState, queued }` |
| `GET /api/computers/:id/runs` | → `{ computer, runs: RunSummary[] }` (newest first) |
| `GET /api/computers/:id/runs/:runId` | → `RunSummary` + `{ journalLength, journalTailOffset, journalTail (base64), journalTailEncoding }` |
| `POST /api/computers/:id/runs/:runId/stop` | → `{ runId, state, sent }` |
| `POST /api/computers/:id/runs/:runId/keep` | `{ epoch? }` → `{ runId, review: "kept", head, applied, currentEpoch }` |
| `POST /api/computers/:id/runs/:runId/revert` | `{ epoch? }` → `{ runId, review: "reverted", head, applied, currentEpoch }` |
| `GET /api/computers/:id/runs/:runId/diff` | → `{ runId, base, head, summary, entries[], truncated }` |
| `POST /api/computers/:id/snapshot` | `{ reason?: "command" \| "scheduled" }` → `{ computer, manifest, state }` |

`RunSummary` = `{ id, state, argv, cwd, exitCode, signal, attention, startedAt,
endedAt, preRunManifest, postRunManifest, diff, review }` plus control-plane
detail (`kind`, `queuedAt`, `dispatched`, `dispatchedAt`, `writePath`,
`attentionCount`, `epoch`). `state` is the client run state
(`pending`/`running`/`stopping`/`exited`/`failed`); `review` is
`pending`/`kept`/`reverted`.

- **Queue-then-dispatch (spec 5.1 + 8.3).** `POST /runs` persists the run in the
  computer's DO and returns immediately. If no current-generation supervisor is
  attached it starts a wake in the background (`computerState: "waking"`) and the
  run is handed over when that supervisor's `hello` arrives. A persisted
  `dispatched` latch is written **before** the `start_run` frame, so a reconnect
  (a second `hello`) never re-dispatches and a closed tab never loses a run.
  A stop before dispatch cancels the run in place and latches it, so it is never
  started later.
- **`argv` is required** unless an `agent` is given (a brief then runs as
  `[agent, path]`, spec 8.5). The control plane never invents a command.
- **`envNames`** default to the computer's vault secret NAMES (spec 10.1);
  values never travel in `start_run`.
- **keep/revert (spec 5.3)** are idempotent and epoch-fenced. An `epoch` in the
  body (or `?epoch=`) is compared with the DO's current fencing epoch; a stale
  one is refused `409 { error: "stale_epoch", currentEpoch }` with the head
  untouched and nothing sent to the supervisor. `keep` leaves the head at the
  post-run manifest; `revert` sets the head back to the pre-run manifest and
  sends exactly one `restore_to_manifest`. Conflicting decisions are `409`
  (`already_kept` / `already_reverted`); an unfinished run is `409 run_active`.
- **Diff (spec 5.3 / 9.2)** is computed in the control plane from the two
  manifests in R2 — no substrate, no wake. `entries[]` is
  `{ path, change: "added"|"modified"|"removed", oldMode, newMode, oldSize,
  newSize, contentChanged, kind, symlinkTarget }`, path-sorted, capped at 5000
  with `truncated: true`. A run without both manifests is `409 run_incomplete`.

### C.2 Files (spec 8.4, 8.5)

| Route | Result |
|---|---|
| `GET /api/computers/:id/files?path=` (and `/files/*`) | directory listing `{ computer, manifest, path, entries[] }` |
| `GET /api/computers/:id/file?path=` | the file's bytes, `x-mari-manifest`, `x-mari-state`, `x-mari-source: manifest` |
| `PUT /api/computers/:id/file?path=` (body = bytes) | `202 { ok, path, state, runId, queued, bytes }` |
| `POST /api/computers/:id/upload` (multipart `file` + `path`, or raw body + `?path=`) | `202 { ok, path, state, runId, queued, bytes }` |

- Reads are served from the **manifest head in every state** — for a COLD
  computer that is spec 8.4 literally; for an AWAKE one the head is the latest
  snapshot the supervisor wrote (spec 4.3), and `x-mari-manifest` names it, so a
  client is never misled about freshness. Reading never wakes anything.
- **A write is a RUN.** Spec 4.1 makes the AWAKE substrate disk the only copy
  that accepts writes, so the control plane does not synthesize chunks or
  manifests for an editor Save. It queues a small run —
  `["/bin/sh", "-c", "set -e; mkdir -p '<dir>'; printf '%s' '<base64>' | base64 -d > '<path>'"]`
  — through the same queue-then-dispatch path as any other run, which also gives
  the write a pre-run snapshot, a journal, and a post-run diff (spec 5.2/5.3).
  **No new `ControlMessage` was added**: `start_run` already carries everything.
  Paths and payloads are POSIX single-quoted (`'` → `'\''`). Limits: 256 KiB per
  write (`413`), absolute non-directory paths without `..` (`400`).
- A write to a non-AWAKE computer **starts a wake** and reports the transition
  (`state: "waking"`) without blocking on it (spec 8.3).

### C.3 Fleet (spec 8.2)

`GET /api/fleet` → `{ computers: [{ id, hostname, state, activeRuns,
activeRunIds, attention, changedFiles, cost, manifestHead, updatedAt }] }`.

- `activeRuns`/`activeRunIds`: runs in `queued`/`dispatched`/`running`.
- `attention`: undismissed attention events on that computer.
- `changedFiles`: the diff count of the current head against the **previous**
  head (the DO records `prevHead` on every head change); `0` when there is no
  previous head or a manifest is missing — the fleet view never fails on a
  storage gap.
- `cost`: `{ currency, accrued, ratePerHour, window, awakeSeconds }`, computed as
  accumulated **AWAKE seconds × a static substrate price sheet**
  (`src/pricing.ts`). Internal accounting only, independent of billing
  (decisions.md); `ratePerHour` is the live burn rate, so it is `0` unless the
  computer is AWAKE, while `accrued` keeps the lifetime total.
- The whole view is a read of D1 plus each computer's DO — it never wakes a
  computer. `GET /api/computers/:id` carries the same summary plus `runs[]`.

### C.4 `/api/events` — the live, content-free stream (spec 6.2)

`GET /api/events` is a `text/event-stream` (SSE) for the authenticated USER,
covering the whole fleet. It opens with an SSE comment (`: ready`), which
`EventSource` ignores.

Each record is `event: <type>` + `data: <json>`:

| `type` | Payload |
|---|---|
| `attention` | `{ type, seq, at, computer, runId, state: "waiting"\|"cleared", kind? }` |
| `run` | `{ type, seq, at, computer, runId, state, exitCode? }` |
| `state` | `{ type, seq, at, computer, state: ComputerState }` |

- `seq` is a per-stream monotonic sequence (seeded from the wall clock so it
  never goes backwards across a hub restart); clients de-duplicate on it.
- **Content-free (spec 6.3).** The hub rebuilds every event from an allow-list of
  metadata fields before it reaches a socket, so terminal bytes, prompt text, or
  file contents cannot appear on this stream even if a caller passed them.
- **Transport addition:** a second Durable Object class, `EventsDO`, bound as
  `EVENTS` (wrangler migration `v2`), is the per-user rendezvous — a ComputerDO
  is the coordination point for ONE computer (spec 3.2) and cannot reach a client
  watching the fleet. Each ComputerDO publishes into `EventsDO(userId)`; an event
  with no listener is dropped, and the durable record of an attention remains the
  attention log in the computer's own DO.

## Appendix D — Write encoding, run cwd, and the preview capability

_Appended by the blocker-closing lane (append-only). This SUPERSEDES two details
of Appendix C.2 and adds the preview surface's contract. Where this appendix and
C.2 disagree, this one is current (and `packages/control-plane/test/runs-argv.test.ts`
plus `test/writes.test.ts` are the executable form of it)._

### D.1 A write run's argv (supersedes C.2's one-liner)

C.2 described the write as
`["/bin/sh","-c","set -e; mkdir -p '<dir>'; printf '%s' '<base64>' | base64 -d > '<path>'"]`.
That form was **unspawnable** for a payload above 96 KiB of raw bytes: Linux caps
one `execve` argument at `MAX_ARG_STRLEN` = 131072 bytes (NUL included), and 96 KiB
base64-encodes to exactly 131072 characters. The failure was `E2BIG` at spawn,
after the route had already answered `202 {ok:true}`.

The current form, normatively:

```
argv[0] = "/bin/sh"
argv[1] = "-c"
argv[2] = "set -e; mkdir -p '<dir>'; T='<path>.mari-<run>.part'; trap 'rm -f \"$T\"' EXIT; \
           printf '%s' \"$@\" | base64 -d > \"$T\"; mv -f \"$T\" '<path>'"
argv[3] = "mari-write"        # $0 for `sh -c`
argv[4..] = base64 payload, split into pieces of at most 32768 characters
```

- The payload is `argv[4]` onward and is re-joined by `printf '%s' "$@"` (POSIX
  reuses the format for each operand, so the pieces concatenate with nothing
  between them). **No argv element may exceed `MAX_ARGV_ELEMENT_BYTES` (32 KiB)**
  and the whole block must stay under `MAX_ARGV_TOTAL_BYTES` (1.6 MB), which is
  what keeps the largest accepted write inside Linux's `RLIMIT_STACK / 4` total.
- An EMPTY file has no payload pieces; `printf '%s' "$@"` then emits nothing and
  the decode produces a zero-byte file.
- The decode targets `<path>.mari-<run>.part` and is renamed over the target, so a
  failed decode leaves the previous content intact, and an `EXIT` trap removes the
  staging file so a failed write leaves nothing behind for the next snapshot to
  commit into the manifest. The temp name carries the RUN ID so two writes racing
  on one path cannot clobber each other's staging file.
- Paths and the script are POSIX single-quoted exactly as before (`'` → `'\''`).
- **Limit: 1 MiB per write** (`MAX_WRITE_BYTES`), equal to `MAX_INLINE_FILE_BYTES`
  on the read path. C.2's "256 KiB per write" is superseded. Over the limit is
  still `413 {error:"too_large", limit}`.

### D.2 `cwd` in `start_run` is always inside the computer

`start_run.cwd` is a substrate path and is **never empty and never `/`** unless the
computer's root really is `/`. The control plane resolves it (`resolveRunCwd`):

| Request | `cwd` sent |
|---|---|
| absent / empty | the computer's filesystem root (`MARI_ROOT`) |
| a path at or under the root (`/work/project`) | verbatim |
| any other absolute path (`/project`) | joined onto the root (`/work/project`) |

The third row is the one that matters: a manifest path (what the file browser, the
editor and a diff all speak) is rooted at the computer's filesystem root, and a run
that executed at the container's `/` wrote files no manifest recorded and deep
sleep destroyed. marid's own empty-`cwd` fallback applies to a RESUMED run only, so
an empty string on this field is not a valid way to say "the root".

### D.3 Preview capability (spec 8.5 + spec 10)

| Route | Result |
|---|---|
| `GET /api/config` | `{ previewZone, previewScheme, previewPort, devAuth, devSeed, maxWriteBytes, maxReadBytes }` — unauthenticated, content-free, no user data |
| `GET /api/computers/:id/preview?port=` | `{ computer, port, host, url, stableUrl, expiresAt }` — session-authenticated and ownership-scoped |

- `host` is `{port}--{computer}--{user}.{zone}`, where **`user` is
  `SHA-256("mari-preview-user:" + userId)` truncated to 12 hex characters** — the
  owner's account id never appears in a hostname.
- `url` carries the capability once as `?mari_preview=<token>`; `stableUrl` is the
  spec 8.5 address with no capability.
- A token is `p1.<expiresAtMs>.<hex HMAC-SHA256(AUTH_SECRET, "p1:{computer}:{port}:{expiresAt}")>`,
  valid for 12 h, and is accepted only for that computer and that port.
- The wake proxy accepts a request iff the host's `user` label matches the
  computer's owner AND (a valid capability arrives in the `mari_preview` cookie, or
  in the query string, or a session that OWNS the computer is presented). A
  capability in the query on a GET/HEAD is converted into a host-scoped
  `HttpOnly; SameSite=Lax` cookie and 302-redirected to the same path without it.
- Refusals: `404` + `x-mari-preview: no_such_preview` for an unknown computer or a
  label that is not its owner's (identical answers, deliberately); `401` +
  `x-mari-preview: preview_unauthorized` otherwise. **No refusal reaches the
  Durable Object**, so it cannot wake a computer or spend substrate budget.
- Mari's own cookies (`mari_*`, `better-auth*`) are stripped from the request
  before it reaches the guest process.
- Proxy failures are `502` + `x-mari-preview-error`:
  `expose_port` (the port was never published — the driver's message says so),
  `upstream_unreachable` (nothing is listening), `proxy_fetch` (a
  `proxyFetch`-serving driver refused).

### D.4 Other route-shape corrections

- `POST /api/computers/:id/sleep` — body `{ deep?: boolean }` (or `?deep=1`) →
  `{ computer, state, deep, settled }`. `deep` is spec 4.4's deep sleep (COLD);
  `settled` is false while the supervisor's final-manifest handshake is still in
  flight.
- `DELETE /api/computers/:id/secrets/:name` → `{ ok, name }`, or
  `404 {error:"secret_not_found"}`. `PUT` refuses a name that is not a valid
  environment variable (`400 bad_name`) or starts with `MARI_`
  (`400 reserved_name`), because vault names become variables in the SUPERVISOR's
  process environment (spec 10.1) and `MARI_TOKEN`/`MARI_EPOCH` are the fencing
  credentials.
- `POST /api/computers/:id/attention/:eventId/dismiss` →
  `400 {error:"bad_event_id"}` for a non-numeric id, `404
  {error:"attention_not_found"}` for a miss, `200 {ok:true, eventId}` for a
  dismissal (it used to answer `200 {ok:false}` for every failure).
- `POST /api/computers/:id/runs/:runId/stop` also returns `status` (the control
  plane's own `RunStatus`) and `cancelled`, so a run stopped before it ever reached
  a supervisor is not reported to the user as a failure.
- `GET /api/computers/:id/files` with **no manifest at all** answers
  `200 { manifest: null, entries: [] }` for the root and `404` for any deeper path,
  instead of `404 no_manifest` for everything.

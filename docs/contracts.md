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
- **Integers use shortest-form encoding.** All `u64` values MUST be
  `<= 2^53 - 1` (`MAX_SAFE_INTEGER`) so the TypeScript side decodes them as
  `number`, not `BigInt`. `Epoch` and `JournalOffset` `debug_assert!` this when
  serialized; `assertJsSafe` enforces it on the TS side.
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

Regeneration is deterministic (fixed values, no timestamps, no randomness): run
`cargo test -p mari-proto`. The `packages/shared` vitest suite loads every
`.cbor`, decodes it, deep-equals it against the `.expected.json`, and re-encodes
it to assert byte-identical output. Either suite fails on drift.

## 9. Store object layout

The chunk store (R2 / S3-compatible; spec 3.3) uses these keys:

| Key | Contents |
|---|---|
| `chunks/{id[0..2]}/{id}` | One chunk's bytes, content-addressed. The 2-hex-char prefix directory (`id[0..2]`) shards the keyspace. |
| `manifests/{id}.cbor` | One `Manifest`, CBOR (§4). `id` is its blake3. |
| `heat/{computer}.cbor` | The `HeatProfile` for a computer (§4). |
| `journal/{computer}/{run}/{seq}.seg` | Journal segments written directly to the store by `marid` (decisions.md); `seq` is a zero-padded ordinal. Only the coalesced live tail and segment pointers flow through the DO. |

Chunks and manifests are immutable and content-addressed, so writes are
idempotent and safe from a fenced-out writer (§6). Garbage collection is
mark-and-sweep over the live set of all retained manifests (decisions.md); no
object here is deleted except by that swept process after its safety window.

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
    "files":    ["/README.md", "/notes/todo.txt", "/src/main.ts", "/src/util.ts"]
  }
  ```

- Response also carries the Better Auth **`Set-Cookie`** session header; reuse it
  (or `session.token`) to authenticate subsequent `/api/*` calls.
- Side effects (idempotent): applies the D1 schema; upserts the seed user + a
  session; writes the manifest + chunks for the tree above into the R2 `STORE`;
  sets the `seedcomputer` Durable Object head **without waking** (spec 8.4); and
  records one sample vault secret name (`ANTHROPIC_API_KEY`, spec 10.1).

**v0 deviation:** the seed's content addresses (`manifest`/chunk ids) are
SHA-256 hex, a stand-in for blake3 (§3) until `mari-core`'s blake3 chunker is
compiled into the control plane. The ids are self-consistent within the seed,
which is all the manifest file-browser (§8.4) requires — it fetches chunks by the
id recorded in the manifest, and does not re-verify the digest algorithm.

## Appendix B — v0 control-plane protocol notes

_Appended by the control-plane builder._

- **Supervisor ↔ DO WebSocket** uses the §2 length-framed CBOR envelopes
  (`SupervisorMessage`/`ControlMessage`). Request/response replies (`hello_ack`,
  `head_advance_result`) return on the **originating** socket; DO-initiated
  messages (`journal_ack`, `prepare_for_cold`) go to the active (last-handshook)
  supervisor. The handshake validates `proto_version`, the current `epoch`, and
  the one-time `token` minted at wake; a mismatch closes that socket (`1008`).
- **Client terminal input.** The §5.2 `ControlMessage` enum has **no terminal
  input variant**, but the client→DO attach protocol (§7.1) carries `input`/
  `resize`. v0 forwards these supervisor-ward as out-of-band framed messages
  `{ "t": "client_input", "c": { run, bytes } }` and
  `{ "t": "client_resize", "c": { run, cols, rows } }`. **This is a v0 gap** —
  the contracts owner should add first-class input/resize messages to
  `mari-proto`'s `ControlMessage`, after which the DO switches to them.
- **Attach snapshot (v0).** Because v0 `marid` keeps no grid (decisions.md
  deviation 1), on attach the DO sends an empty `grid` then replays the exact
  prior journal tail as a `frame` at offset 0 (byte-identical), and streams live
  frames thereafter. The control-plane `GridEngine` still renders a server-side
  grid, exposed via the DO `snapshotGrid(run)` method; that is the point where
  attach will send a populated `grid` (baseOffset = journal head) once
  libghostty-vt lands.

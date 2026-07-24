# Mari — Specification

This document is normative. Terms in §2 have one meaning only.

## 1. General

1.1 Mari is a low-cost VM-emulator with a good web application and a small set
of primitives. A Mari computer feels like a persistent VM. It is not one.
Everything else, the user brings.

1.2 Test each feature request against 1.1. If the feature is not the emulator,
the interface, or a primitive, reject it.

1.3 A user starts work from the web application. The user can then disconnect.
The agents continue. The user can see the results from each device.

1.4 Mari is open-source software. A user can operate a private instance. A
hosted instance is optional.

## 2. Definitions

Use each term with one meaning only.

- **Computer**: a persistent identity with one filesystem, a hostname, a state,
  and a history. A computer is data. It is not a machine at a provider.
- **State**: a computer is AWAKE, WARM, COLD, or WAKING.
  - **AWAKE**: materialized on a substrate, processes active, compute billing
    active.
  - **WARM**: on a substrate in native sleep (checkpoint or pause). Wake is
    immediate. Cost is near zero.
  - **COLD**: in the chunk store only. No substrate resources exist. Cost is
    object storage only.
  - **WAKING**: in transition to AWAKE.
- **Substrate**: an external compute service. Examples: Sprites, Sail,
  Northflank, local Docker. A substrate is stateless to Mari. A substrate disk
  is a cache.
- **Chunk**: an immutable, content-addressed block of file data.
- **Chunk store**: the object storage that holds all chunks. The chunk store is
  the home of each computer.
- **Manifest**: the list of chunks that defines the full filesystem of a
  computer at one time. A snapshot is a manifest.
- **Base image**: a shared manifest (operating system, toolchains). The fleet
  stores each base image once.
- **Delta**: the chunks of a computer that are not in its base image.
- **Heat profile**: the record of the files that a computer reads at boot and
  at run start.
- **Control plane**: the edge services that hold identity, coordination,
  journals, and manifests.
- **Supervisor**: the Mari daemon on each AWAKE computer. The supervisor owns
  all runs.
- **Run**: one task that an agent does on a computer.
- **Journal**: the record of a run: terminal bytes, tool events, exit status.
- **Fork**: a new computer that starts from a manifest of a different computer.
- **Agent**: an installed agent program with credentials and defaults. The user
  selects and brings the agents.
- **Wake proxy**: the edge service that receives connections and starts
  computers.
- **Pane**: one tile in the web application. Pane types: terminal, files,
  editor, browser.

## 3. Architecture

3.1 The control plane operates at the edge (Cloudflare Workers, or an
equivalent Node service for private instances).

3.2 Each computer has one Durable Object (or equivalent). This object holds the
state, the substrate location, the manifest head, the journal head, and the
pane layout. This object is the only coordination point for its computer.

3.3 The chunk store is R2 or an S3-compatible store. Zero-egress storage is
preferred. The reason: a wake reads many chunks, and egress fees would put a
tax on the core operation.

3.4 Agents must not execute in the control plane. The control plane is the
brain. The substrates are the body. The chunk store is the home.

3.5 The provider interface has these functions only: materialize, destroy,
sleep, wake, exec, expose-port. Each substrate module obeys this interface.
Mari must not use other substrate functions.

3.6 Wake is a scheduling decision. On each cold wake, Mari selects a substrate
by price, capacity, and latency. A computer has no fixed substrate.

3.7 The first substrate is Sprites. Local Docker is the second, for development
and private instances.

## 4. Storage

4.1 The chunk store holds the truth of each filesystem. The substrate disk of
an AWAKE computer is the only copy that accepts writes. Two writable copies of
one computer must not exist. These rules have no exceptions.

4.2 The supervisor sends the journal to the control plane continuously. The
journal in the control plane is the truth. The journal on the disk is a cache.

4.3 The supervisor writes a manifest to the chunk store on these events: before
each run, on a schedule, and on a user command.

4.4 Tier policy: after a configured idle time, an AWAKE computer becomes WARM.
After a configured longer idle time, Mari writes a final manifest, destroys the
substrate resources, and the computer becomes COLD. The user-visible name for
COLD is deep sleep. A COLD computer must cost only its delta in object storage.

4.5 Before the WARM-to-COLD transition, the supervisor stops each agent session
in a clean state. Memory does not survive COLD. The journal and the agent
resume function cover continuation (see 5.6).

4.6 Cold wake uses streaming restore:

- (a) Boot from a substrate-local copy of the base image immediately.
- (b) Mount the delta as an overlay.
- (c) Read absent chunks from the chunk store on demand.
- (d) Prefetch chunks in the order of the heat profile.
- (e) The target for the first shell prompt is seconds, not the full transfer
  time.

4.7 If a substrate restores an old checkpoint (a WARM rollback), the supervisor
must compare the disk with the journal head, report the difference, and replay
the run if replay is safe.

4.8 Chunk garbage collection uses reference counts across all manifests. A
chunk with zero references is deleted after a safety delay. Treat this code as
critical: an error here deletes a computer.

4.9 Manifests are versioned. The control plane backs up all manifests
independently of the chunk store.

4.10 Client-side encryption of chunks with per-user keys is an option. With
this option, a hosted instance cannot read a user's computer.

## 5. Runs

5.1 The supervisor owns each run. A network connection must not own a run. A
closed laptop must not stop a run.

5.2 Each run has: an ID, a pre-run manifest, a journal, and a result.

5.3 The result of a run shows as a difference against the pre-run manifest. The
user keeps the changes or restores the manifest.

5.4 On a substrate that stops idle machines, the supervisor holds the machine
AWAKE during a run (a heartbeat, on Sprites). If the run process ends, the hold
ends.

5.5 The supervisor sends a completion event for each run.

5.6 After a cold restart, the supervisor must continue each unfinished run. The
supervisor uses the resume function of the agent, with the journal as the
reference.

## 6. Attention

6.1 The supervisor detects an attention state from generic terminal signals
only: a blocked read on the PTY with no output, the bell character, or a
notification escape sequence (OSC 9, OSC 777).

6.2 The supervisor sends a content-free attention event to the control plane.
The control plane sends a notification to the user. The notification opens the
terminal pane of the run.

6.3 The supervisor must not read, interpret, or answer the content of an agent
prompt. Permission decisions occur in the terminal. What happens in the
terminal is the user's business.

## 7. Terminal

7.1 A terminal pane is a view of a run. It is not the owner of a process.

7.2 The semantic terminal is libghostty-vt. It operates in the supervisor and
in the control plane (as a Wasm module). It holds the grid state of each run.

7.3 On attach, the client receives the current grid, not a journal replay.
Attach to an AWAKE computer must complete in less than 200 ms.

7.4 The render terminal in the web application is xterm.js with the WebGL
renderer. Code against the xterm.js API only, so that a change to a ghostty
renderer stays possible.

7.5 The client applies local echo prediction to input (the mosh method). A
substrate migration must not stop the input.

7.6 A user can see the grid at each past time of a run. The control plane makes
this view from a journal replay.

## 8. Web Application

8.1 The model is a tiled window manager. Each computer is one workspace.
Super+1 to Super+9 change the workspace. A command palette (Cmd+K) gives all
commands. Full keyboard operation must be possible.

8.2 The home view shows the fleet. For each computer: the state, the active
runs, the waiting attention events, the changed files, and the cost meter.
After an absence, this view is the summary of the results.

8.3 The interface must not wait for a computer. Each view renders first from
control-plane data: journal tail, manifest content, saved layout. Liveness
follows when the computer is AWAKE. A wake occurs behind the interface. A
spinner in front of the interface is not permitted.

8.4 For a computer that is not AWAKE, the file browser reads from the manifest
head. A write to such a computer starts a wake.

8.5 Pane types:

- **Terminal**: see section 7. More than one terminal pane per computer is
  permitted.
- **Files**: a browser of the filesystem. Upload and download are possible. A
  file opens into a pane of the correct type.
- **Editor**: CodeMirror. The targets are markdown, configuration files, and
  briefs. A brief is a document that starts as a run. LSP is not included. The
  editor is not an IDE.
- **Browser, preview mode**: a stable URL per port per computer. The wake proxy
  wakes the computer on a request.
- **Browser, computer mode**: a Chromium instance on the computer, streamed
  into the pane, with a persistent profile. Agents drive this browser with
  their own tools. The user can take control, complete a step, and return
  control.

8.6 The pane layout of each computer persists in the Durable Object.

## 9. Forks and History

9.1 A fork is a manifest copy with lineage. A fork transfers no bulk data at
creation.

9.2 A fork difference view compares two manifests. A merge is a reviewed
application of that difference. An automatic merge is not permitted.

9.3 Snapshots are not a feature above the storage system. Snapshots are the
storage system. The time machine is the manifest retention policy.

9.4 A COLD fork costs near zero. The interface can thus offer forks freely,
and should.

## 10. Security and Limits

10.1 Agent credentials stay in the control plane vault. The supervisor injects
credentials at run start. Configured credential paths are excluded from
manifests.

10.2 The browser profile contains sessions. The default fork excludes the
profile. The profile chunks are encrypted. A difference view must not show
cookie content.

10.3 Each computer has CPU-hour limits and egress limits. The hosted instance
sets defaults. A private instance sets its own.

10.4 Isolation between computers is the responsibility of the substrate
(microVMs). Mari must not weaken it.

## 11. Instances and License

11.1 The open-source core includes: the control plane, the supervisor, the web
application, the chunk store logic, and the substrate modules.

11.2 A private instance starts with one command, against the user's substrate
account or local Docker.

11.3 The hosted instance adds: accounts, metering, payment, the wake-proxy
fleet, and the iOS application.

11.4 License: AGPL-3.0-only. Decided 2026-07-24. FSL was rejected because it is
not open source, and 1.4 is load-bearing.

## 12. iOS Application (v2)

12.1 The iOS application is a full client. A new user can start from the
application alone.

12.2 The terminal core is libghostty (native). Attention events arrive as push
notifications and open the terminal.

## 13. Open Items

- Measured wake latency per substrate and per tier, p50 and p99.
- Egress prices and outbound abuse policy per substrate.
- Garbage collection design review before any deletion code executes.
- Durable Object write throughput as the ceiling for concurrent runs; estimate
  before v1.
- Model provider terms for subscription authentication on cloud computers.
- ~~License decision (11.4).~~ Settled: AGPL-3.0-only.
- ~~The supervisor binary name.~~ Settled: `marid`.

# Cloudflare Containers as a Mari substrate

_Decision memo. Written 2026-07-24. Every load-bearing claim cites a primary
Cloudflare source with the source page's own last-updated date, because this
space moves monthly. Items I could not verify are marked **unverified** — treat
them as experiments, not facts._

---

## Recommendation

**Build the Cloudflare Containers driver and make it the first hosted substrate
for app.mari.sh — but never adopt `@cloudflare/sandbox`.** Cloudflare Containers
went GA on 2026-04-13 ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)),
`ctx.container.exec()` maps onto spec §3.5's `exec` exactly, each instance runs
in its own VM (satisfying §10.4), the chunk store is already R2 in the same
account, and Cloudflare's platform enforces the one rule Mari's whole design
rests on: **"All disk is ephemeral. When a Container instance goes to sleep, the
next time it is started, it will have a fresh disk as defined by its container
image."**
([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/),
Apr 23 2026). That is spec §2's "a substrate disk is a cache" made
non-negotiable — every other substrate lets you cheat, Cloudflare does not.
The cost is WARM: Cloudflare has no pause, no checkpoint, and no disk that
survives a stop, so on Cloudflare WARM collapses into COLD. That collapse costs
Mari almost nothing, because the thing WARM exists to buy — cheap idle — is
already free on Cloudflare ("Charges stop after the container instance goes to
sleep",
[pricing](https://developers.cloudflare.com/containers/pricing/), Apr 21 2026),
so what Mari loses is wake latency — a documented 1–3 s container start on every
idle-resume — not money.
The `@cloudflare/sandbox` SDK is a separate matter and the answer there is a
flat no: it ships its own `/container-server/sandbox` supervisor binary that
must run in the image
([Docker-in-Docker guide](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/),
Apr 21 2026), with its own sessions, PTY server, process manager and backup
system. That is
`marid`'s job. Adopting it means two supervisors in one container and fails spec
§1.2 on sight. Use the raw `ctx.container` API and nothing else.

One thing gates all of this and must be tested before a line of driver code:
**Cloudflare Containers run without root privileges**
([FAQ](https://developers.cloudflare.com/containers/faq/), Apr 21 2026;
repeated in the [Sandbox Docker-in-Docker guide](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/)).
`mari-core`'s non-negotiable test is "snapshot → wipe → restore is
byte-identical including modes, symlinks, empty files" (decisions.md). If
rootless restore cannot reproduce uid/gid, setuid bits or device nodes, Mari's
storage contract does not hold on this substrate and the answer flips. That is a
one-day experiment. Run it first.

---

## The six functions, mapped

Spec §3.5: *materialize, destroy, sleep, wake, exec, expose-port. Each substrate
module obeys this interface. Mari must not use other substrate functions.*

| §3.5 function | Cloudflare primitive | Verdict |
|---|---|---|
| `materialize` | `ctx.container.start({ entrypoint, env, enableInternet })` on a DO with a `containers` binding | **Clean.** `env` carries `MARI_COMPUTER_ID`, `MARI_EPOCH`, `MARI_TOKEN`, `MARI_STORE`, `MARI_CONTROL_URL`, `MARI_RESTORE_MANIFEST` unchanged. |
| `destroy` | `ctx.container.destroy()` | **Clean, and stronger than elsewhere.** Disk is gone by definition; there is no orphaned-volume failure mode. |
| `sleep` | *nothing* | **Gap.** See the WARM section. `sleep()` on Cloudflare must be `destroy()`. |
| `wake` | `ctx.container.start()` + streaming restore | **Gap.** Every wake is a cold wake: 1–3 s container start ([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/): *"Container cold starts can often be in the 1-3 second range"*) **before** restore begins. |
| `exec` | `ctx.container.exec(argv, { cwd, env, stdin, stdout, stderr, user })` | **Exact fit.** Returns `{pid, stdout, stderr, exitCode, output(), kill()}` — the same shape as `ExecResult`. And *"The `exec()` operation starts the executable directly with the provided argument array. It does not start a shell first"* ([execute-commands](https://developers.cloudflare.com/containers/execute-commands/)), matching provider.ts's "the array is NOT shell-interpreted" verbatim. |
| `exposePort` | `this.containerFetch(request, port)` from inside the DO's `fetch()` | **Works, with a caveat.** See below. |

### Gaps, precisely

**`exec` requires a running-check.** *"`exec()` does not start a stopped
Container. In remote procedure call (RPC) methods, check
`this.ctx.container.running` and call `await this.start()` when needed"*
([execute-commands](https://developers.cloudflare.com/containers/execute-commands/)).
The Docker driver can `unpause` then `exec`; here the driver must branch. Note
also that `exec()` shipped **2026-06-18** ([containers
changelog](https://developers.cloudflare.com/changelog/product/containers/)) —
five weeks ago. The single capability Mari most depends on is the newest thing
on the platform. That is a maturity risk, not a blocker, but it is why the
driver should be behind a feature flag until it has run a week.

**`exec` has no PTY.** There is no `pty`/`tty` option on `ctx.container.exec()`
— confirmed at the docs, in workerd's `ExecOptions` (`src/workerd/api/container.h`)
and in the capnp wire protocol (`src/workerd/io/container.capnp`). PTY is
structurally absent from the RPC, not merely undocumented. **This does not
matter for Mari**, because `marid` already owns the PTY (portable-pty,
decisions.md) and streams the journal over its own WebSocket. `exec` is for
discrete commands — exactly how ComputerDO uses it today for file writes
(contracts.md Appendix C.2). Do not reach for the Sandbox SDK to get a PTY.

**`exposePort` has a routing constraint, not a WebSocket constraint.** The docs
say *"`fetch` is the only method that supports WebSocket proxying"* and that
`containerFetch()` *"Does not support WebSockets"*
([Container class](https://developers.cloudflare.com/containers/container-class/),
Apr 21 2026). Reading `@cloudflare/containers` 0.3.7 shows the real shape: the
WebSocket pumping lives *inside* `containerFetch()`, and `Container.fetch()`
just sets the `cf-container-target-port` header and delegates to it. The actual
limitation is that a WebSocket cannot be serialized across the Durable Object
JSRPC boundary (workerd issue
[#2319](https://github.com/cloudflare/workerd/issues/2319), still open). So:
`stub.containerFetch(req)` from a Worker fails; `this.containerFetch(req, port)`
from inside the DO's own `fetch()` override works, for any port. Mari already
routes through `ComputerDO.fetch()` (computer-do.ts), so this costs nothing —
but record the constraint correctly as *"WebSockets cannot cross the Worker→DO
RPC boundary"*, not *"containerFetch does not support WebSockets"*.

**The structural cost: the container binds to a DO class at deploy time.** The
wrangler `containers` block requires `class_name` to name a Durable Object class
— *"This will make this Durable Object a container-enabled Durable Object and
allow each instance to control a container"* — and the Durable Object must use
`new_sqlite_classes`, not `new_classes`
([wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/#containers);
[containers docs](https://developers.cloudflare.com/containers/)).
`image` and `instance_type` are properties of that class, fixed at deploy. Two
consequences:

1. **`ComputerDO` should be the container class.** It already uses
   `new_sqlite_classes` (packages/control-plane/wrangler.jsonc, migration `v1`),
   so the prerequisite is met. A DO that never calls `start()` costs nothing, so
   a computer scheduled onto Sprites is unaffected. The alternative — a separate
   `ContainerDO` per (image × size) with `ComputerDO` delegating — adds a second
   object per computer, which brushes against spec §3.2 ("This object is the
   only coordination point for its computer"), adds a hop on the epoch-check hot
   path, and cannot carry the terminal WebSocket across the RPC boundary. Don't.
2. **Spec §3.6 loses one degree of freedom here.** "Mari selects a substrate by
   price, capacity, and latency" survives; *sizing* per cold wake does not,
   because `instance_type` is per-class. If Mari needs three sizes and two base
   images, that is six DO classes. For v0 — one base image
   (`deploy/Dockerfile.marid`), one size — it is one class and a non-issue.
   Write it down as a known ceiling.

**Handles stay plain.** provider.ts requires serializable handles. A Cloudflare
driver is constructed per-request with the live `ctx.container` injected as
config (exactly as the Docker driver takes a dockerode client), and the handle
stays `{substrate: 'cloudflare', computer, id}`. No contract change. The
`createSubstrate` factory in substrates/index.ts already takes a config object.

---

## The WARM question

Spec §2 defines WARM as: *"substrate resources are retained and the substrate
disk still holds the computer, but no process runs and no compute is billed…
Wake is a fast cold wake: the supervisor restarts and reads the local disk
cache, with no chunk-store transfer. Cost is idle resource cost only."*

**Cloudflare cannot honour this, and the reason is the disk clause, not the
process clause.** Stopping a container is easy. Keeping its disk is impossible:
*"All disk is ephemeral. When a Container instance goes to sleep, the next time
it is started, it will have a fresh disk as defined by its container image."*
([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/) /
[FAQ](https://developers.cloudflare.com/containers/faq/)). There is no
pause/freeze primitive either: `sleepAfter` (default `"10m"`) expiry fires
`onActivityExpired()`, whose default implementation calls `stop()` — SIGTERM,
not a freeze ([Container class](https://developers.cloudflare.com/containers/container-class/)).
Native snapshots are announced but **not shipped**: the FAQ still says
*"Snapshots are coming soon"* as of the current revision, the containers
changelog's most recent entry is Jul 1 2026 and contains no snapshot release,
and the GA blog says only that snapshots will capture *"a container's full disk
state, OS config, installed dependencies, modified files, data files and more"*
with live memory state arriving *"in future releases"*
([blog](https://blog.cloudflare.com/sandbox-ga/), Apr 13 2026). `workerd`'s
`Container` C++ class does expose ungated, undocumented `snapshotContainer()`
and `snapshotDirectory()` methods — production availability **unverified**, and
not something to build on until Cloudflare documents them.

**So on Cloudflare, WARM ≡ COLD. Take the collapse — it is free.** Here is why,
and it is the single most important line in this memo: Mari's WARM exists to buy
cheap idle. Cloudflare's idle is *already* free. *"You only pay for what you
use — charges start when a request is sent to the container or when it is
manually started. Charges stop after the container instance goes to sleep"*
([pricing](https://developers.cloudflare.com/containers/pricing/)). There is no
"idle resource cost" tier on this platform to occupy. A retained-but-stopped
container would cost $0 and hold $0 of value, because its disk is gone anyway.
WARM has nothing to sell here.

What the collapse actually costs, measured against decisions.md's Docker
baselines:

| | Docker (measured, decisions.md) | Cloudflare (projected) |
|---|---|---|
| AWAKE → WARM | ~430 ms (`docker pause`) | n/a — goes straight to COLD |
| WARM → AWAKE | fast, no chunk transfer | n/a |
| COLD → supervisor connected | ~115 ms | 1–3 s container start + WS dial (**unverified**) |
| COLD → files byte-identical | ~265 ms | 1–3 s + restore (**unverified**) |

So the honest cost is **1–3 seconds of extra wake latency on the idle-resume
path**, and nothing else. Spec §4.6(e) says "the target for the first shell
prompt is seconds, not the full transfer time" — 1–3 s spends most of that
budget on container start before Mari does any work, which is why the FUSE lazy
mount (below) matters more here than it does on Docker.

**The spec change this implies.** decisions.md already settled the harder half
on 2026-07-24 ("WARM is a fast cold wake") after noting *"Cloudflare Containers
stop outright"*. What remains is that Cloudflare fails even the amended
definition, because the amended definition still says "disk cache intact". Two
options:

- **(a) A substrate may declare WARM unsupported**, and the DO's tier alarm goes
  AWAKE → COLD directly. The seam already exists: `resumeBeforeCold?(handle)` is
  an optional driver method that ComputerDO consults (computer-do.ts:1954), so a
  second optional declaration is not a new mechanism.
- **(b) Mari refuses to schedule WARM-needing computers onto such substrates.**

**Take (a).** (b) makes the tier policy substrate-dependent, which is exactly
the fleet-wide-behaviour problem decisions.md just solved. And provider.ts's
current doc comment on `sleep` — *"native sleep — WARM (spec §2): checkpoint or
pause. Wake must be immediate and cost near zero"* — is **already stale**
relative to spec.md and decisions.md, and must be fixed regardless of what
happens with Cloudflare. That is a contracts-lane edit, not a substrate-lane
one.

---

## R2 adjacency, with numbers

Spec §3.3: *"Zero-egress storage is preferred. The reason: a wake reads many
chunks, and egress fees would put a tax on the core operation."* Mari's chunk
store is already R2. Cloudflare Containers run in the same account, on the same
network.

`mari-core`'s production chunker is min 64 KiB / **avg 256 KiB** / max 1 MiB
(`crates/mari-core/src/chunker.rs`, `ChunkerConfig::PRODUCTION`), so one logical
GB is ~4,096 objects. At R2's rates ($0.015/GB-month, Class A $4.50/M, Class B
$0.36/M, egress free —
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), May 28 2026):

| Operation | Cost |
|---|---|
| Read a 1 GB delta on cold wake (4,096 Class B) | **$0.0015** |
| Write 1 GB of new chunks on snapshot (4,096 Class A) | **$0.0184** |
| Hold a 2 GB delta at rest for a month | **$0.030** |
| R2 egress, any volume | **$0** |

Those numbers are why the 256 KiB average matters: at 64 KiB it would be 4× the
op count, and per-object billing is R2's sharpest edge. Keep it.

**The unresolved question is container egress, and it is smaller than it
looks.** Container network egress is $0.025/GB in NA/EU after 1 TB/month
([containers pricing](https://developers.cloudflare.com/containers/pricing/)).
No Cloudflare page states whether container→R2 traffic in the same account is
billed as container egress. **Unverified.** But note the asymmetry: egress is
*outbound from the container*. Mari's cold wake is a *download* (inbound), and
its snapshots are *uploads* (outbound). So even under the worst-case reading,
the tax lands on snapshot writes — which Mari deliberately keeps to deltas —
and not on the read-heavy wake path that §3.3 was written to protect. That is an
inference from the ordinary meaning of "egress", not a documented fact; get it
in writing, separately for the two paths, because they may differ:

- **(a) The S3 endpoint path** — `https://<account>.r2.cloudflarestorage.com`.
  This is what Cloudflare's own [R2 FUSE mount
  example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
  (Apr 21 2026) uses, and it is exactly the path decisions.md already commits to
  ("Direct-to-R2: chunks never transit the Worker. The DO mints short-lived
  scoped credentials / presigned URLs; marid reads and writes the store
  directly"). Mari's existing design is Cloudflare's documented pattern.
- **(b) The outbound-handler path** — a container calls a virtual hostname, an
  `outboundByHost` handler intercepts it in the Workers runtime and serves it
  from the R2 binding. *"Outbound handlers are programmable egress proxies that
  run on the same machine as the container. They have access to all Workers
  bindings"*
  ([outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/),
  Apr 21 2026;
  [Workers connections](https://developers.cloudflare.com/containers/platform-details/workers-connections/)).
  Same machine, so plausibly not egress — but every chunk becomes a Workers
  invocation at $0.30/M. At 256 KiB chunks that is ~$0.0012/GB in request fees
  plus Workers CPU time, i.e. comparable to the Class B cost, but with Workers
  subrequest and response-size limits in play on a multi-GB restore
  (**unverified** whether those limits bite at Mari's scale).

**Recommendation: use path (a).** It is what Mari already built, it is what
Cloudflare documents, and it does not put a Worker in the middle of a
multi-gigabyte stream. Settle the billing question with a metered experiment —
write 10 GB of chunks from a container to R2, read the dashboard — before the
hosted fleet grows past a handful of computers.

---

## FUSE and spec §4.6

decisions.md v0 deviation 2 defers spec §4.6(b)(c) — the FUSE lazy overlay — and
ships a full restore ordered by the heat profile. **On Cloudflare that deviation
should be closed sooner than it would be on Docker**, for two reasons.

First, the latency budget is tighter. Docker's cold wake reaches byte-identical
files in ~265 ms; Cloudflare starts 1–3 s in the hole before restore begins. A
full restore of a large delta on top of that will miss §4.6(e) in a way it does
not on Docker.

Second — and this is the pleasant surprise — **Cloudflare points at FUSE itself
as the answer to ephemeral disk.** The FAQ's data-persistence answer is
literally "use FUSE to persist disk to R2 or other object storage backends"
([FAQ](https://developers.cloudflare.com/containers/faq/)), and there is a
dedicated docs page, [Mount R2 buckets with FUSE in
Containers](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
(Apr 21 2026), with a working Dockerfile. So `/dev/fuse` is available and FUSE
mounting is a supported, documented pattern despite the rootless constraint.
Mari's §4.6(b)(c) design is not fighting the platform; it is the platform's own
recommended shape.

Cloudflare's caveat applies and is fair: *"Object storage is not a
POSIX-compatible filesystem, nor is it local storage… you should not expect
native SSD-like performance."* That is fine for §4.6's lower layer, which is
read-mostly and content-addressed; the writable upper layer stays on local disk
and is snapshotted to chunks as usual.

Two things to probe empirically, both **unverified**:

1. Does `mount -t overlay` work inside an unprivileged user namespace
   (`unshare -Urm`)? If yes, kernel overlayfs beats fuse-overlayfs for the upper
   layer. Also check `capsh --print` for the bounding set, and `uname -r` /
   `stat -f -c %T /` — the docs say nothing about kernel version or root fs
   type, and both matter for FUSE and for inotify-heavy agent workloads.
2. Does the FUSE daemon survive shutdown ordering? `marid` must unmount cleanly
   on SIGTERM, inside the 15-minute window, and the final manifest write must
   not depend on a mount that is already gone.

**Do not use `sandbox.mountBucket()`** even though it is GA, read-write, s3fs-based,
and documented as giving *"data that persists across sandbox lifecycles"*
([Storage API](https://developers.cloudflare.com/sandbox/api/storage/), Jun 8
2026). It requires the Sandbox SDK, which requires the Sandbox container-server.
Mari ships its own FUSE adapter in its own base image; that is one dependency,
not a whole second supervisor.

---

## Cost model

Rates from [containers pricing](https://developers.cloudflare.com/containers/pricing/)
(Apr 21 2026). Crucially: *"Memory and disk usage are based on the provisioned
resources for the instance type you select, while CPU usage is based on active
usage only."* Derived hourly rates: memory **$0.0090/GiB-h**, active CPU
**$0.0720/vCPU-h**, disk **$0.000252/GB-h**. Workers Paid ($5/mo) includes 25
GiB-h memory, 375 vCPU-minutes, 200 GB-h disk.

**Per AWAKE hour, at 20% mean CPU duty** (the assumption every number below
rests on — it is a guess, see the experiments list):

| Instance | vCPU / mem / disk | Memory | Disk | CPU @20% | **Total/h** | At 100% CPU |
|---|---|---|---|---|---|---|
| `basic` | 0.25 / 1 GiB / 4 GB | $0.0090 | $0.0010 | $0.0036 | **$0.0136** | $0.0280 |
| `standard-1` | 0.5 / 4 GiB / 8 GB | $0.0360 | $0.0020 | $0.0072 | **$0.0452** | $0.0740 |
| `standard-4` | 4 / 12 GiB / 20 GB | $0.1080 | $0.0050 | $0.0576 | **$0.1706** | $0.2930 |

WARM: **$0.00/h** (does not exist). COLD: **$0.00/h** substrate, plus $0.015/GB-month
of delta in R2.

**Worked fleet — 100 computers, `standard-1`, 2 AWAKE-hours/day, 2 GB delta
each, 500 MB of new chunks/day each, 2 cold wakes/day each:**

| Line item | Monthly |
|---|---|
| Container compute (6,000 AWAKE-h × $0.0452) | $271 |
| R2 storage (200 GB) | $3 |
| R2 Class A, snapshot writes (1,500 GB) | $28 |
| R2 Class B, cold-wake reads (12,000 GB, full restore) | $18 |
| Container egress *if* container→R2 counts (1,500 GB − 1 TB free) | $13 (**unverified**) |
| **Substrate + storage subtotal** | **~$333** |
| **Durable Object rows written, at today's `FLUSH_MS = 25`** | **~$600** |

That last line is not a typo, and it is the most actionable finding in this
memo. `computer-do.ts:60` sets `FLUSH_MS = 25` and each flush performs three
SQLite inserts. Continuously streaming terminal output is therefore 40 flushes/s
× 3 rows = **432,000 rows/hour**. At [Durable Objects
pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(Jun 19 2026) of $1.00 per million rows written, that is **$0.43 per streaming
hour — roughly 10× the $0.045/h cost of the container it is journaling.** Raise
`FLUSH_MS` to 100 (which is what decisions.md already promises: "the coalesced
live tail (≤100 ms flush windows)") and batch the three inserts into one, and
the same hour costs $0.036 — a 12× reduction, cutting ~$550/month out of the
worked fleet. **Fix this before deploying any substrate, Cloudflare or
otherwise.** It is Mari's bug, not Cloudflare's.

A second, smaller DO line item: `ComputerDO` accepts WebSockets with
`server.accept()` (computer-do.ts:1264, 1813), i.e. the non-hibernatable API, so
the object is billed for wall-clock duration for as long as the supervisor's
socket is open — ~$0.0056/h for a 128 MB DO after the 400,000 GB-s included.
Roughly $34/month on the worked fleet. Switching to the Hibernatable WebSockets
API removes it.

**Versus Sprites: I cannot tell you, and neither can anyone else.**
`sprites.dev/pricing`, `docs.sprites.dev/pricing` and `fly.io/sprites` all
return either 404 or CLI installation instructions with no rates. The figures in
circulation — $0.07/CPU-hour and $0.04375/GB-hour — come from a competitor's
comparison blog, not from Fly. **Unverified; do not put them in a model.** If
they were right, a 0.5 vCPU / 4 GiB Sprite would run $0.21/h against
Cloudflare's $0.045/h and the answer would be obvious — which is precisely why
you should get the real rates off a Fly invoice or Cost Explorer before either
of us believes it. Spec §13 lists "egress prices and outbound abuse policy per
substrate" as open; it still is.

---

## Isolation (spec §10.4)

Spec §10.4: *"Isolation between computers is the responsibility of the substrate
(microVMs). Mari must not weaken it."*

Cloudflare satisfies this directly: *"Each container instance runs inside its own
VM, which provides strong isolation from other workloads running on Cloudflare's
network"*
([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)),
and the Durable Objects container docs repeat that *"the container process runs
your image inside a Linux VM"*
([DO Container API](https://developers.cloudflare.com/durable-objects/api/container/),
Jun 26 2026). One computer = one DO = one instance = one VM. §10.4 holds without
Mari doing anything.

Three related notes:

- **No public ingress at the packet level.** *"End-users cannot make non-HTTP TCP
  or UDP requests to a Container instance"* — no listening port is publicly
  reachable. But "all traffic is Worker-mediated" is **false**: `sandbox.tunnels`
  runs `cloudflared` inside the container over an outbound QUIC connection and
  Cloudflare's edge fronts the request directly
  ([Tunnels](https://developers.cloudflare.com/sandbox/api/tunnels/)). For spec
  §8.5 preview mode, **use the Worker-fronted path**
  (`this.containerFetch(request, port)` inside `ComputerDO.fetch()`), because it
  keeps the control plane as a mandatory interception point for the WS auth and
  epoch ingest gating that already exists in app.ts / computer-do.ts. A tunnel
  URL routes around all of it. (For the record: the current Sandbox docs do
  *not* mark `exposePort()` deprecated; they say tunnels are "recommended" for
  most public-URL cases and `exposePort()` is right "when you want the Worker
  itself to front the request" — which is Mari's case exactly. An earlier
  deprecation claim I was handed is not supported by the live docs.)
- **PID namespace isolation is on by default** for compatibility dates ≥
  `2026-04-01` (`containers_pid_namespace` flag). **`wrangler.jsonc` currently
  pins `compatibility_date: "2024-11-01"`** — bump it, or SSH into a container
  shows every process in the VM.
- **Rootless is a constraint, and possibly the constraint.** *"Containers run
  without root privileges"*; *"Containers do not support iptables
  manipulation"* ([FAQ](https://developers.cloudflare.com/containers/faq/)).
  This is good for isolation and potentially bad for restore fidelity. It is the
  first experiment on the list below.
- **Multi-tenant resale posture: unverified.** Cloudflare runs third-party agent
  code themselves (`cloudflare/claude-managed-agents`), but that is not the same
  as a customer reselling arbitrary user code execution. Read the self-serve
  terms, and ask, before app.mari.sh takes a paying stranger's workload.

---

## Comparison

| Dimension | Cloudflare Containers | Sprites | Local Docker |
|---|---|---|---|
| Spec §2 WARM | **No.** No pause, no checkpoint, disk wiped on stop | Yes — auto-suspend, ~300 ms checkpoint/restore claimed (**unverified**) | Yes — `docker pause`, ~430 ms measured |
| Idle cost | **$0** (charges stop at sleep) | "no charges when idle" (**unverified**) | host RAM |
| Disk on sleep | **Gone, by platform rule** | Retained | Retained |
| Isolation (§10.4) | Own VM per instance, documented | microVM (Fly Machines) | container namespaces — weakest |
| `exec` fit | Exact; `argv` not shell-interpreted; **5 weeks old** | HTTP frame protocol, driver already written | dockerode, fully tested |
| PTY from substrate | None (`marid` supplies it) | Yes | Yes |
| Ingress for §8.5 | Worker/DO-fronted, or edge tunnel | Auto-exposed port + sprite URL | Published host port |
| Chunk-store adjacency | **R2 in-account, egress free from R2; FUSE documented** | Cross-network to R2 | Local dir |
| Runtime sizing (§3.6) | **No** — `instance_type` is per-DO-class, deploy-time | Org policy; no per-create sizing in the API either | Per-container hints |
| Root / privileges | **Rootless, no iptables** | Full root in a VM | Full |
| Max run length (§5.1) | No fixed limit; "does not guarantee that any instance will run for any set period"; SIGTERM + 15 min | Not published | Until you stop it |
| Cold wake, measured | **Unverified**; 1–3 s container start documented, before restore | **Unverified** | ~115 ms to supervisor, ~265 ms to files |
| Price transparency | Full public rate card | **No public rate card** | n/a |
| New vendor/billing surface | **None** — same account as Workers, D1, R2 | New account, token, invoice | None |
| Driver exists today | No | Yes (untested, `SPRITES_TOKEN`-gated) | Yes (fully tested) |

Read the table as: Cloudflare wins on cost, storage adjacency, isolation
documentation, and — decisively for a project that already deploys to Workers —
on having no new vendor. Sprites wins on WARM and on being unconstrained by
rootlessness. Docker remains the only substrate with real measured numbers.

---

## What to do this week

app.mari.sh is deployed to Workers with `SUBSTRATE_MODE: "fake"`
(packages/control-plane/wrangler.jsonc). It has no substrate. In priority order:

1. **Run the rootless restore experiment. Nothing else matters until it
   passes.** Build `deploy/Dockerfile.marid` as a Cloudflare container image,
   start it, and run decisions.md's non-negotiable test inside it: snapshot →
   wipe → restore, byte-identical including modes, symlinks, empty files,
   multi-chunk files. Then a spanning test with multiple uid/gid, a setuid bit,
   and a device node. Record `uname -r`, `stat -f -c %T /`, `capsh --print`, and
   whether `unshare -Urm` + `mount -t overlay` succeeds. **If restore fidelity
   fails, stop and stay on Sprites.** One day of work; it decides the substrate
   portfolio.
2. **Fix `FLUSH_MS`.** Raise 25 → 100 ms and batch the three per-flush inserts
   into one. This saves more money than the substrate choice does, is
   substrate-independent, and is a control-plane-lane change. While in there,
   move `ComputerDO`'s WebSockets to the Hibernatable API.
3. **Verify marid's outbound WebSocket.** With `enableInternet: true`, can
   `marid` open `wss://` on 443 from inside a container to the control plane?
   The outbound docs are written entirely in terms of HTTP requests and never
   mention the upgrade. **This is the single most load-bearing unverified item
   in the whole analysis** — the journal and the control channel are that
   socket. Half a day. Test it in the same session as (1).
4. **Then write the driver**, in `packages/control-plane/src/substrates/cloudflare.ts`,
   against `ctx.container` only:
   - `materialize` → `start({ entrypoint, env, enableInternet: true })`
   - `destroy` → `destroy()`
   - `sleep` → **also `destroy()`**, plus declare WARM unsupported so the DO's
     tier alarm goes AWAKE → COLD directly
   - `wake` → `start()` + the existing streaming restore
   - `exec` → `running` check, then `exec(argv, {cwd, env, stdin})`, then
     `output()`
   - `exposePort` → `this.containerFetch(request, port)` from
     `ComputerDO.fetch()`
   - run-hold heartbeat (§5.4) → `renewActivityTimeout()` on the existing
     marid → DO → driver path. **Never** `keepAlive`.
5. **Bump `compatibility_date`** past `2026-04-01` for the PID namespace flag,
   and set `max_instances` deliberately. It *"Defaults to 20"*, *"Stopped
   containers do not count towards this"*, and *"If a request to start a
   container will exceed this limit, that request will error"*
   ([wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/#containers)) —
   so it caps concurrent AWAKE computers, not fleet size, and it fails a wake
   loudly rather than queueing. Alert on it. Also consider
   `constraints.regions` ([placement](https://developers.cloudflare.com/containers/platform-details/placement/))
   to pin containers near the R2 bucket's jurisdiction.
6. **Run the e2e thesis test against Cloudflare.** decisions.md already
   specifies it: create → wake → run writes files → snapshot → destroy (COLD) →
   wake into a *fresh* container → files byte-identical, journal continuous. On
   Cloudflare "fresh container" is guaranteed by the platform, which makes this
   the strongest version of that test anywhere. Record p50/p99 — that closes
   spec §13's first open item for this substrate.
7. **Ask Cloudflare, in writing, whether container→R2 traffic in the same
   account is billed as container network egress**, separately for the S3
   endpoint and the outbound-handler path. Do it now; the answer takes weeks and
   spec §3.3 depends on it.

Do **not** do this week: adopt `@cloudflare/sandbox`; build on
`snapshotContainer()`; use `sandbox.tunnels` for §8.5; or delete the Sprites
driver.

---

## The long-term substrate portfolio

Three substrates, each earning its place under spec §1.2:

- **Local Docker** — development, private instances, and the reference
  implementation of the six functions. It stays the only fully-tested substrate
  and the only one that can be run offline. Never remove it.
- **Cloudflare Containers** — the hosted default. It is where app.mari.sh lives,
  where the chunk store lives, and where the cost floor is. Its ephemeral disk
  makes it the substrate that *proves* Mari's storage thesis: if a computer
  survives on Cloudflare, the chunk store really is the home. Treat that as a
  feature and put it in the README.
- **Sprites (or another WARM-capable substrate)** — the tier-two option for
  computers whose workload genuinely needs a fast idle-resume, and the thing
  that keeps spec §3.6 honest. A scheduler with one substrate is not a
  scheduler. Keep the driver, get the real rate card, and let §3.6 pick.

Two conditions would change this. If Cloudflare ships live-memory snapshots on
the raw `ctx.container` API (not Sandbox-only), Cloudflare becomes strictly
better than Sprites and the portfolio narrows to two. If the rootless restore
experiment fails, Cloudflare drops out entirely and Sprites stays first. Both are
resolvable within a week of work.

---

## Explicitly unverified

Nothing below is asserted as fact anywhere in this memo.

1. Whether container→R2 traffic in the same account is billed as container
   network egress — for the S3 endpoint path and the outbound-handler path
   (they may differ).
2. Whether `marid` can open an outbound `wss://` connection on 443 with
   `enableInternet: true`.
3. Whether rootless containers permit `mari-core` to restore multiple uid/gid,
   setuid bits, and device nodes byte-identically.
4. Cloudflare cold-wake p50/p99 for a realistic Mari delta (container start +
   restore). Docker's ~265 ms will not transfer.
5. Whether an open *inbound* WebSocket resets the `sleepAfter` timer, or only a
   new request does. If not, the driver needs a per-computer DO alarm calling
   `renewActivityTimeout()` at fleet scale.
6. Whether the 15-minute SIGTERM grace applies to platform *maintenance*
   terminations, or only to rollouts and manual stops. §4.4/§4.5's final-manifest
   window depends on it.
7. Whether `ctx.container.monitor()` / `onStop()` fire reliably for
   platform-initiated terminations. §4.7 rollback detection assumes it can tell a
   cold wake from a rollback. (On Cloudflare a restart is unambiguous because the
   disk resets — but confirm the signal arrives.)
8. Whether `snapshotContainer()` / `snapshotDirectory()` (present and ungated in
   `workerd`, absent from the docs) work in production, and whether shipped
   snapshots will land on the raw API or Sandbox-only.
9. DO-to-container non-colocation latency on the hot path, against spec §7.3's
   200 ms attach budget. Cloudflare states the two are *"not guaranteed to run in
   the same location"*.
10. Whether the outbound-handler path has throughput ceilings (Workers subrequest
    counts, response size, concurrent subrequests) that bite on a multi-GB restore.
11. The practical ceiling on `max_instances` (default 20) and whether the
    documented account limits — 6 TiB concurrent memory, 1,500 concurrent vCPU,
    30 TB concurrent disk, and **50 GB total image storage per account**
    ([limits](https://developers.cloudflare.com/containers/platform-details/limits/),
    Jul 3 2026) — are the real fleet bound. The 50 GB image cap also constrains
    spec §2's base-image catalogue, since images are declared at deploy time.
12. Sprites' actual published rates, and whether Sprites charges egress.
13. Whether Cloudflare's self-serve terms permit a hosted multi-tenant Mari
    running third-party users' agents.
14. The real mean CPU duty cycle of a Mari agent run. Every cost figure here
    assumes 20%. `marid` already measures `awakeMs`; adding vCPU-seconds would
    replace the load-bearing guess with a measurement.
15. Whether 20 GB disk (which requires ≥10 GiB memory under the 2 GB-disk-per-GiB
    ratio, so ~$0.10/h in memory alone) is enough once spec §8.5's Chromium
    computer mode lands. Measure `deploy/`'s base image first.

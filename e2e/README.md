# `e2e/` — the cross-lane end-to-end suites

Everything here needs more than one lane at once: the control plane, `marid`,
the Docker substrate and the chunk store, all real, in one process tree. That
is why it is a top-level package rather than a suite inside a component — it
belongs to no single owner (see `docs/decisions.md`, *Directory ownership*).

## The 1.3 loop (`loop.e2e.test.ts`)

> spec 1.3: *"A user starts work from the web application. The user can then
> disconnect. The agents continue. The user can see the results from each
> device."*

That sentence is the product's central claim, and this file is the only place
it is proven end to end.

```sh
MARI_LOOP_E2E=1 pnpm --filter @mari/e2e test
```

Ungated the file collects no tests and exits clean, so `pnpm -r test` stays
green on a machine with no Docker.

**Prerequisites**: a Docker daemon, and `mari/base:v0` (the suite builds it from
`deploy/Dockerfile.marid` if it is missing — the first run then takes minutes
rather than seconds).

**macOS**: the chunk store must live under `$HOME` — the daemon runs in a VM
that shares `$HOME` but not `/tmp`, and a bind mount of an unshared path is
silently EMPTY inside the container, which looks exactly like a computer that
lost its files. The suite therefore works under `~/.mari/loop-e2e`
(`MARI_LOOP_E2E_DIR` overrides it) and deletes its scratch directory when it
finishes.

### What is real

| Piece | What runs |
|---|---|
| Control plane | `boot()` from `packages/control-plane/src/node` — the same function `deploy/docker-compose.yml` runs (spec 11.2), on a temp chunk store and temp SQLite |
| Substrate | the real Docker driver, selected by the real `selectSubstrate` (spec 3.6/3.7) |
| Computer | a real container from `mari/base:v0`, running the real `marid` binary |
| Run | a real process on a real PTY, emitting a known byte sequence for ~12 s and writing three files |
| Client | real HTTP, real WebSocket, real SSE over real sockets — `node:http` with a per-device connection pool, never `fetch` (undici hides its pool, and this suite has to be able to prove a device holds nothing open) |

Substrate facts are asserted against the **Docker daemon**, never against Mari:
paused means `.State.Status == "paused"`, destroyed means the container is gone
from `docker ps -a`, restored means `docker exec cat` returns the same bytes.

### How each clause of 1.3 is proven

* **"starts work from the web application"** — `POST /api/computers/:id/runs`,
  the exact route the web app's run launcher calls, against a COLD computer.
  The request returns in milliseconds with the run queued and the computer
  `waking` (spec 8.3), and a real container appears behind it.
* **"can then disconnect"** — every socket the device holds is torn down, and
  the proof is taken from the **server's** side: a `ConnectionWitness` watches
  the instance's own `http.Server` and, during the window, the process must hold
  exactly one socket — the supervisor's. A client-side `readyState` proves only
  what the client believes. (Connections are classified by request path, not by
  address: with Docker Desktop the container's dial-back arrives as `127.0.0.1`
  too.)
* **"the agents continue"** — while zero client sockets exist, the journal is
  sampled in-process and must grow monotonically; afterwards the reconnecting
  device finds those bytes contiguous and in order, and the final journal is
  asserted byte-for-byte against the exact expected sequence.
* **"from each device"** — a second `Device`: a fresh connection pool, the same
  session cookie. It reads the missed journal, receives the completion event on
  a stream it opened *after* the disconnect, retrieves the exit status, and gets
  a diff listing exactly the four entries the run created.

Then the part that makes the claim survive the machine going away: the tier
policy takes the computer through WARM (a real `docker pause`) to COLD (a real
destroy), and a **fresh** container comes back with the run's files
byte-identical (spec 4.4/4.6/4.1). Twice, because a single wake sample is an
anecdote.

### Reference numbers (spec 13's open item)

The suite prints the wall clock of every transition and the p50 of the two wake
series. It never asserts them: a latency budget is not a correctness claim, and
pinning one would turn a slow laptop into a red build.

### Cleanup

Every container labelled `mari.computer` is removed in `afterAll`, on the
failure path as well. The Docker driver creates no volumes (it bind-mounts the
store), so containers plus the scratch directory are the whole footprint. A
suite killed mid-run leaves containers behind; `docker rm -f $(docker ps -aq
--filter label=mari.computer)` clears them.

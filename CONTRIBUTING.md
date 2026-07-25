# Contributing to Mari

Read [docs/spec.md](docs/spec.md) first. It is normative, it is short, and it
settles most arguments before they start.

## The rule that governs what belongs here

> **Spec 1.1** — Mari is a low-cost VM-emulator with a good web application and a
> small set of primitives. A Mari computer feels like a persistent VM. It is not
> one. Everything else, the user brings.
>
> **Spec 1.2** — Test each feature request against 1.1. If the feature is not the
> emulator, the interface, or a primitive, reject it.

This applies to code as much as to features. Before writing a module, name which
of the three it is. If it is none, it does not belong here — not behind a flag,
not "just for now".

Worked examples of 1.2 doing its job, all of them in the tree:

- **Agent integration.** Spec 5.6 requires the supervisor to continue an
  unfinished run "using the resume function of the agent". Rather than an
  agent-integration surface, an agent is a five-key declarative TOML file, and a
  *sixth key makes the file malformed*. That refusal is the mechanism that keeps
  it from growing into a plugin API. There is no `idempotent = true` flag and
  there will not be: it would move a correctness decision into a config file.
- **Reading agent output.** Spec 6.1/6.3: attention is detected from *generic*
  terminal signals — a blocked PTY read, `BEL`, `OSC 9`/`OSC 777` — and the event
  is content-free. The supervisor must not read, interpret or answer an agent's
  prompt. What happens in the terminal is the user's business.
- **A seventh substrate function.** Spec 3.5 fixes the provider interface at six
  functions. Liveness ("is that instance still there?") is therefore expressed
  *through* `exec`, plus one optional `instanceStatus?()` declaration that is a
  pure read and may be omitted by any driver.
- **Billing.** Not in this repository at all. The spec 8.2 cost meter is internal
  accounting from a static substrate price sheet; it gates nothing.

## Lanes and ownership

Mari is built by many hands (and many agents) at once, so directories have
owners. Stay in your lane, and **never** edit another lane's files to make your
own work compile — say so instead.

| Path | Owner |
|---|---|
| `crates/mari-proto`, `packages/shared` | contracts |
| `crates/mari-core` | core storage |
| `crates/marid` | supervisor |
| `packages/control-plane/src/substrates/` (+ its tests) | substrate drivers |
| `packages/control-plane` (everything else) | control plane |
| `packages/web` | web application |
| `e2e/` | cross-lane suites |
| `docs/` | contracts — **append-only** for everyone else |
| `README.md`, `CONTRIBUTING.md`, `deploy/`, `.github/` | packaging |

Two hard rules that come out of this:

1. **Root manifests are frozen.** The `Cargo.toml` members list,
   `pnpm-workspace.yaml`, the root `package.json` and `tsconfig.base.json` are
   changed by agreement, not in passing. Add dependencies inside your own crate
   or package manifest.
2. **`docs/decisions.md` is append-only** unless you own it. If a locked decision
   is wrong, append the argument — do not silently diverge in code. Divergence
   that is not written down is how two lanes end up implementing the same rule
   twice, differently.

Storage logic in particular lives exactly once: `crates/mari-core` is the only
implementation of chunking, manifests and GC. TypeScript *reads* manifests (CBOR
via `cbor-x`) and never writes one.

## Testing philosophy: teeth required

**No smoke tests.** "It imports and doesn't crash" is not a test. A suite that
cannot fail is worse than no suite, because it makes a red flag look green.

The rules:

- **Real processes, real bindings, real bytes.** `marid`'s run tests spawn actual
  children on actual PTYs. The control-plane suites run against real Durable
  Objects and real R2 through `@cloudflare/vitest-pool-workers` — the platform is
  not mocked. The Docker suites assert against the *Docker daemon*, not against
  Mari: paused means `.State.Status == "paused"`, destroyed means the container is
  gone from `docker ps -a`, restored means `docker exec cat` returns the same
  bytes.
- **Assert the failure mode, not just the happy path.** Epoch fencing is only
  tested by a *rejected* stale head advance. Corruption handling is only tested by
  a corrupted chunk. Recovery is only tested by killing something.
- **Never weaken an assertion to reach green.** Not `toContain` where `toBe` was,
  not a widened timeout, not a `skip`. If a test is wrong, say why in the diff. If
  a repro is parked, it is parked as a *failing* documented case with an owner —
  and the thing that closes it is a test that would have caught the regression.
- **Measurements are printed, not asserted.** A latency budget is not a
  correctness claim; `e2e/loop.e2e.test.ts` prints its numbers and asserts none of
  them.
- **Env-gated suites document their gate at the top of the file**, and collect
  zero tests when the gate is off, so the default run stays green on a machine
  with no Docker.

The non-negotiable per-component set is listed under *Testing philosophy* in
[docs/decisions.md](docs/decisions.md). It is a floor, not a ceiling.

## Running everything

```bash
pnpm install                     # once
```

The default suite — no Docker, no accounts, no secrets. This is exactly what CI
runs on a pull request, so if it is green locally, CI is green:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

pnpm -r typecheck
pnpm -r test
pnpm --filter @mari/control-plane test:node   # Node runtime parity (node:sqlite)
pnpm --filter @mari/control-plane build:node  # the private instance bundles
pnpm --filter @mari/web exec vite build       # the web app builds
```

The Playwright web suite runs in the gated workflow instead — read *The web
Playwright suite* under CI below before you run it:

```bash
pnpm --filter @mari/web test:e2e
```

Gated on a real Docker daemon. Each builds `mari/base:v0` if it is missing, so
the first run takes minutes; each removes the containers it created:

```bash
MARI_E2E_DOCKER=1 cargo test -p marid --test e2e_docker
MARI_NODE_E2E=1   pnpm --filter @mari/control-plane test:node
MARI_LOOP_E2E=1   pnpm --filter @mari/e2e test
MARI_SLOW_TESTS=1 cargo test -p marid          # the real-timescale keepalive case
```

On macOS these suites put their chunk store under `$HOME` on purpose: the daemon
runs in a VM that shares `$HOME` but not `/tmp`, and a bind mount of an unshared
path is silently empty inside the container — indistinguishable from a computer
that lost its files.

Working on the web app or the control plane directly:

```bash
pnpm --filter @mari/control-plane dev        # wrangler dev (Workers entry)
pnpm --filter @mari/control-plane dev:node   # the Node entry, private instance
pnpm --filter @mari/web dev                  # Vite, proxying /api to :8787
./deploy/up.sh                               # the whole private instance in Docker
```

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull
request: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test
--workspace`, `pnpm -r typecheck`, `pnpm -r test`, the Node parity suite, the
private-instance bundle and the web build. Nothing in it is `continue-on-error`,
and nothing in it reports success without asserting something.

One CI step is worth knowing about because it will fail on you: the Rust↔
TypeScript conformance fixtures (`packages/shared/fixtures/*.cbor`,
`packages/control-plane/test/fixtures/*.json`) are **generated by the Rust suites
and committed**. `cargo test` rewrites them, so CI asserts the working tree is
unchanged afterwards — otherwise a wire-format change would regenerate the
fixtures, the TypeScript mirror would be compared against the new bytes, and the
drift would pass. If that step fails: commit the regenerated fixtures *and* update
the mirror in `packages/shared`.

[`.github/workflows/e2e.yml`](.github/workflows/e2e.yml) holds the suites that
need a real substrate. Ask for them by adding the **`e2e`** label to a pull
request, or from Actions → *e2e (gated)* → Run workflow. It runs the three Docker
suites above, the Playwright web suite, and boots `./deploy/up.sh` from scratch to
prove the documented first-run path still works.

### The web Playwright suite

It is in the gated workflow rather than the default run, and that is a **defect
to fix**, not a preference. The suite shares one control plane across every spec
file (`workers: 1`, `fullyParallel: false`), and `editor-save.spec.ts` performs a
spec 8.4 file write — which wakes the seeded computer, correctly. Every later spec
that needs `[data-testid="computer-card"][data-state="cold"]` then waits for the
tier policy to put it back: 30 s for one spec when measured with two files, and
past the 45 s test timeout in a full run. Each file passes on its own.

The fix is for the suite to state its own precondition instead of inheriting one —
re-seed, or give each file its own computer — exactly as `resetLayouts()` already
does for pane layouts, and for the same reason. Until then, gating it keeps a real
signal from being read as noise on unrelated pull requests.

### The suites that are not in CI

- **Sprites** (`SPRITES_TOKEN`): needs an account. The driver is written against
  the public API docs and has never run against the service.
- **Cloudflare** (`MARI_CF_E2E=1`): needs a real `wrangler deploy`, a pushed
  container image, and account credentials. Run by hand by whoever owns the
  account. No workflow in this repo deploys anything.

## Conventions

- **Nobody commits on someone else's behalf.** No `git commit`, `git init` or
  push from a lane; checkpointing belongs to whoever is integrating.
- **Rust**: `thiserror` in libraries, `anyhow` in binaries, `tracing` (never
  `println!`) in daemon code paths. Edition 2024, `cargo fmt` clean.
- **TypeScript**: strict. `any` only at the CBOR decode boundary, and validated
  immediately.
- **Comments explain *why*.** The file already shows what it does. The valuable
  comment is the one that stops the next person from "simplifying" a load-bearing
  detail — why `network_mode: bridge` is required, why the epoch is persisted
  before the substrate call, why a plaintext `ws://` refusal is fatal.
- **Tests live with their component**, next to the code they hold to account.

## Reporting something

Open an issue. If it is a defect, the useful shape is: what you ran, what
happened, what you expected, and which spec clause you think is being broken —
that last one is usually the fastest route to agreement. Security issues:
please report them privately to the repository owner rather than in a public
issue.

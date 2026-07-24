# Mari

A low-cost VM-emulator with a good web application and a small set of primitives.
A Mari computer feels like a persistent VM. It is not one.

The computer is data: content-addressed chunks and manifests in object storage.
Substrates (Sprites, local Docker) are stateless caches. The control plane runs
at the edge. The `marid` supervisor owns runs; a closed laptop never stops one.

- Normative spec: [docs/spec.md](docs/spec.md)
- Locked decisions and v0 ground rules: [docs/decisions.md](docs/decisions.md)
- Wire protocol and storage formats: [docs/contracts.md](docs/contracts.md)

## What works today

A computer is created, materialized on a substrate, snapshotted, destroyed down
to chunks in object storage, and woken again on a *different* container with its
filesystem byte-identical. Runs keep going while nobody is connected; a second
device picks up the journal mid-run. Measured on a laptop with the local Docker
substrate:

| Transition | Wall clock |
|---|---|
| Cold wake → supervisor connected | ~118 ms (p50) |
| Cold wake → run's files byte-identical in a fresh container | ~266 ms (p50) |
| AWAKE → WARM | ~427 ms |
| WARM → COLD | ~419 ms |

These are reference numbers from `e2e/`, not marketing figures; they cover small
deltas over a warm base image.

## Run a private instance

Spec §11.2: one command, against local Docker.

```bash
docker compose -f deploy/docker-compose.yml up --build
```

See [deploy/README.md](deploy/README.md) for configuration and the test suites.

## Layout

| Path | What |
|---|---|
| `crates/mari-core` | Chunking, manifests, store, restore, GC (the storage inversion) |
| `crates/mari-proto` | Wire protocol types (CBOR), mirrored in `packages/shared` |
| `crates/marid` | The supervisor daemon |
| `packages/control-plane` | Hono: Durable Objects, wake proxy, auth, substrate drivers, Node runtime |
| `packages/web` | The tiled web application |
| `packages/shared` | TS protocol mirror + client SDK |
| `e2e/` | The spec §1.3 loop test: start, disconnect, results |
| `deploy/` | Private-instance compose stack and the marid base image |

## Tests

No smoke tests. The suites assert byte-identical restores, ≥90% chunk reuse
after a one-byte edit, that garbage collection never deletes a reachable chunk,
that a stale supervisor cannot advance the manifest head, and that a run
survives every client disconnecting. See the testing section of
[docs/decisions.md](docs/decisions.md).

```bash
cargo test --workspace && pnpm -r test
MARI_E2E_DOCKER=1 cargo test -p marid --test e2e_docker    # real containers
MARI_LOOP_E2E=1 pnpm --filter @mari/e2e test               # the §1.3 loop
```

## License

[AGPL-3.0-only](LICENSE). Spec §1.4 says Mari is open-source software; §11.4's
open question is settled in favour of the license that keeps a hosted fork open.

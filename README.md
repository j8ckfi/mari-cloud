# Mari

A low-cost VM-emulator with a good web application and a small set of primitives.
A Mari computer feels like a persistent VM. It is not one.

The computer is data: content-addressed chunks and manifests in object storage.
Substrates (Sprites, local Docker) are stateless caches. The control plane runs
at the edge. The `marid` supervisor owns runs; a closed laptop never stops one.

- Normative spec: [docs/spec.md](docs/spec.md)
- Locked decisions and v0 ground rules: [docs/decisions.md](docs/decisions.md)

## Layout

| Path | What |
|---|---|
| `crates/mari-core` | Chunking, manifests, store, restore, GC (the storage inversion) |
| `crates/mari-proto` | Wire protocol types (CBOR), mirrored in `packages/shared` |
| `crates/marid` | The supervisor daemon |
| `packages/control-plane` | Hono on Workers: Durable Objects, wake proxy, auth, substrate drivers |
| `packages/web` | The tiled web application |
| `packages/shared` | TS protocol mirror + client SDK |

License: TBD (spec §11.4).

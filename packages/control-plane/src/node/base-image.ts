// The base image, stored once (spec §2).
//
// "Base image: a shared manifest (operating system, toolchains). The fleet
// stores each base image once." On a private instance the OS itself arrives as
// the container image (spec 4.6(a): boot from a substrate-local copy of the base
// image), and the chunk store owns the computer's filesystem root — `/work`,
// `MARI_ROOT` — which the base image ships pre-populated (deploy/Dockerfile.marid).
//
// On first boot that skeleton is snapshotted INTO the chunk store by the only
// component allowed to write a manifest, `marid` itself (decisions.md: the
// TypeScript side reads manifests, never writes them). A pointer object records
// the result, so the second boot — and every later one — reuses it: stored once.
//
// Every computer created afterwards then starts from that manifest, so its own
// snapshots are a DELTA against shared chunks (spec §2 "Delta"), which is what
// makes a COLD computer cost only its delta (spec 4.4).

import type { ComputerId } from '@mari/shared';
import type { NodeRuntimeEnv } from './env.js';

/** Store key of the pointer for one base image (contracts.md §9 neighborhood). */
export function basePointerKey(image: string): string {
  return `base/${image.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/** The computer identity used to bootstrap a base image. */
export function baseComputerId(image: string): ComputerId {
  return `base-${image.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
}

interface BasePointer {
  image: string;
  manifest: string;
  at: number;
}

export interface EnsureBaseOptions {
  /** How long to wait for the bootstrap computer's supervisor to attach. */
  attachTimeoutMs?: number;
  /** How long to wait for the snapshot's head advance. */
  snapshotTimeoutMs?: number;
  /** Called with progress lines; defaults to no output. */
  log?: (message: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Return the base manifest for `config.baseImage`, snapshotting it on first
 * boot. Sets `env.BASE_MANIFEST` (shared by reference with every Durable
 * Object) so later cold wakes restore from it.
 *
 * Returns `null` when the substrate cannot produce it (no daemon, image not
 * built): a private instance still runs, computers simply start from an empty
 * root. The failure is reported, never swallowed silently.
 */
export async function ensureBaseManifest(
  rt: NodeRuntimeEnv,
  options: EnsureBaseOptions = {},
): Promise<string | null> {
  const log = options.log ?? (() => {});
  const image = rt.config.baseImage;
  const key = basePointerKey(image);
  const mutableEnv = rt.env as unknown as Record<string, unknown>;

  const existing = await rt.store.get(key);
  if (existing) {
    try {
      const pointer = JSON.parse(await existing.text()) as BasePointer;
      // The pointer is only good while the manifest it names is still stored.
      if (pointer.manifest && (await rt.store.head(`manifests/${pointer.manifest}.cbor`))) {
        mutableEnv['BASE_MANIFEST'] = pointer.manifest;
        log(`base image ${image} -> manifest ${pointer.manifest} (stored)`);
        return pointer.manifest;
      }
    } catch {
      // A corrupt pointer is re-derived below.
    }
  }

  if (!rt.substrate) return null;

  const id = baseComputerId(image);
  const stub = rt.computers.get(rt.computers.idFromName(id));
  log(`base image ${image}: snapshotting its computer root once (spec §2)`);

  try {
    await stub.wake(id);

    // `snapshotNow` is refused until a supervisor has completed its handshake,
    // so polling it is both "is marid up?" and the snapshot request itself.
    const attachDeadline = Date.now() + (options.attachTimeoutMs ?? 120_000);
    let requested = false;
    while (Date.now() < attachDeadline) {
      const res = await stub.snapshotNow('command');
      if (res.ok) {
        requested = true;
        break;
      }
      await sleep(250);
    }
    if (!requested) throw new Error('supervisor never attached for the base snapshot');

    const headDeadline = Date.now() + (options.snapshotTimeoutMs ?? 60_000);
    let manifest: string | null = null;
    while (Date.now() < headDeadline) {
      manifest = await stub.getHead();
      if (manifest) break;
      await sleep(200);
    }
    if (!manifest) throw new Error('base snapshot never advanced the manifest head');

    const pointer: BasePointer = { image, manifest, at: Date.now() };
    await rt.store.put(key, new TextEncoder().encode(JSON.stringify(pointer)));
    mutableEnv['BASE_MANIFEST'] = manifest;
    log(`base image ${image} -> manifest ${manifest}`);
    return manifest;
  } finally {
    // The bootstrap computer has served its purpose: take it COLD through the
    // real tier path so no substrate resources are left behind (spec 4.4).
    await teardown(rt, id).catch(() => undefined);
  }
}

/** Drive the bootstrap computer AWAKE -> WARM -> COLD via its own tier alarms. */
async function teardown(rt: NodeRuntimeEnv, id: string): Promise<void> {
  const state = rt.computers.stateFor(id);
  const stub = rt.computers.get(rt.computers.idFromName(id));
  if ((await stub.getState()) === 'cold') return;
  await state.storage.runAlarmNow(); // AWAKE -> WARM
  await state.storage.runAlarmNow(); // WARM -> COLD (prepare, final manifest, destroy)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await stub.getState()) === 'cold') return;
    await sleep(200);
  }
}

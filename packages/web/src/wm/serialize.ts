// Layout serialization for persistence to the Durable Object (spec 8.6: "The
// pane layout of each computer persists in the Durable Object").
//
// The WM `Layout` is already plain, JSON-safe data; this module wraps it in a
// versioned envelope so the stored form can evolve, and validates a loaded
// layout back into a live tree (dropping anything malformed rather than
// throwing — a corrupt saved layout must never block the interface, spec 8.3).

import type { Layout, WmNode } from './tree';
import type { PaneSpec } from './pane';

export const LAYOUT_SCHEMA_VERSION = 1;

/** The persisted layout envelope. */
export interface SerializedLayout {
  v: number;
  root: WmNode | null;
  focused: string | null;
}

/** Serialize a live layout for storage. */
export function serializeLayout(layout: Layout): SerializedLayout {
  return { v: LAYOUT_SCHEMA_VERSION, root: layout.root, focused: layout.focused };
}

/**
 * Rebuild a live layout from stored data. Returns null if the input is not a
 * usable layout of the current version, so the caller falls back to a default.
 */
export function deserializeLayout(data: unknown): Layout | null {
  if (!isRecord(data)) return null;
  if (data['v'] !== LAYOUT_SCHEMA_VERSION) return null;
  const root = data['root'];
  if (root !== null && !isValidNode(root)) return null;
  const focused = data['focused'];
  if (focused !== null && typeof focused !== 'string') return null;
  return { root: root as WmNode | null, focused: focused as string | null };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const PANE_KINDS = new Set<PaneSpec['kind']>([
  'terminal',
  'files',
  'editor',
  'preview',
  'runs',
  'diff',
  'vault',
]);

function isValidNode(node: unknown): node is WmNode {
  if (!isRecord(node)) return false;
  if (node['type'] === 'pane') {
    return (
      typeof node['id'] === 'string' &&
      isRecord(node['pane']) &&
      typeof node['pane']['kind'] === 'string' &&
      PANE_KINDS.has(node['pane']['kind'] as PaneSpec['kind'])
    );
  }
  if (node['type'] === 'split') {
    return (
      typeof node['id'] === 'string' &&
      (node['axis'] === 'row' || node['axis'] === 'column') &&
      typeof node['ratio'] === 'number' &&
      isValidNode(node['a']) &&
      isValidNode(node['b'])
    );
  }
  return false;
}

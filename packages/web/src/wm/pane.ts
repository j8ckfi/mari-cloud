// Pane specifications (spec 8.5). A pane is a typed view inside the tiling WM.
// The spec is plain serializable data so the whole layout can be persisted to
// the Durable Object (spec 8.6) and restored on load.

import type { RunId } from '@mari/shared';
import { shortRunId } from '../runs/state';

/** Terminal pane: a view of a run (spec 7.1). */
export interface TerminalPaneSpec {
  kind: 'terminal';
  /** The run whose grid/stream this pane attaches to. */
  run: RunId;
  title?: string;
}

/** Files pane: a filesystem browser over the manifest (spec 8.5). */
export interface FilesPaneSpec {
  kind: 'files';
  /** Directory currently shown (absolute path). */
  path: string;
  title?: string;
}

/** Editor pane: CodeMirror over a single file (spec 8.5). */
export interface EditorPaneSpec {
  kind: 'editor';
  /** Absolute path of the file being edited. */
  path: string;
  title?: string;
}

/** Browser preview pane: an iframe to `{port}--{computer}--{user}` (spec 8.5). */
export interface BrowserPreviewPaneSpec {
  kind: 'preview';
  /** The container port to preview. */
  port: number;
  title?: string;
}

/** Runs pane: the run list of one computer (spec 5, spec 8.2 "active runs"). */
export interface RunsPaneSpec {
  kind: 'runs';
  title?: string;
}

/**
 * Difference pane: the reviewed difference between two manifests. With `run`
 * set it is the result review of that run (spec 5.3); with `base`/`head` set it
 * is a fork difference (spec 9.2). Same view, same data, no automatic merge.
 */
export interface DiffPaneSpec {
  kind: 'diff';
  /** The run whose result is under review, when this is a run diff. */
  run?: RunId;
  /** Explicit manifests, when this is a manifest-to-manifest (fork) diff. */
  base?: string;
  head?: string;
  title?: string;
}

/** Vault pane: the write-only credential vault of one computer (spec 10.1). */
export interface VaultPaneSpec {
  kind: 'vault';
  title?: string;
}

export type PaneSpec =
  | TerminalPaneSpec
  | FilesPaneSpec
  | EditorPaneSpec
  | BrowserPreviewPaneSpec
  | RunsPaneSpec
  | DiffPaneSpec
  | VaultPaneSpec;

export type PaneKind = PaneSpec['kind'];

/** Human label for a pane, for tab strips and the command palette. */
export function paneLabel(pane: PaneSpec): string {
  if (pane.title) return pane.title;
  switch (pane.kind) {
    case 'terminal':
      return `Terminal · ${shortRunId(pane.run)}`;
    case 'files':
      return `Files · ${pane.path}`;
    case 'editor':
      return `Editor · ${basename(pane.path)}`;
    case 'preview':
      return `Preview · :${pane.port}`;
    case 'runs':
      return 'Runs';
    case 'diff':
      return pane.run !== undefined ? `Changes · ${shortRunId(pane.run)}` : 'Changes';
    case 'vault':
      return 'Vault';
  }
}

/** Whether a pane is the terminal view of a particular run (spec 6.2 target). */
export function isTerminalFor(pane: PaneSpec, run: RunId): boolean {
  return pane.kind === 'terminal' && pane.run === run;
}

/** Whether a pane is the difference view of a particular run (spec 5.3). */
export function isDiffFor(pane: PaneSpec, run: RunId): boolean {
  return pane.kind === 'diff' && pane.run === run;
}

/**
 * Whether two pane specs are views of the SAME thing — used to focus an
 * existing pane instead of stacking an identical twin (a double-clicked file,
 * a second press of "+ Runs"). Titles are cosmetic and ignored.
 */
export function samePane(a: PaneSpec, b: PaneSpec): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'terminal':
      return a.run === (b as TerminalPaneSpec).run;
    case 'files':
      return a.path === (b as FilesPaneSpec).path;
    case 'editor':
      return a.path === (b as EditorPaneSpec).path;
    case 'preview':
      return a.port === (b as BrowserPreviewPaneSpec).port;
    case 'runs':
      return true;
    case 'diff': {
      const d = b as DiffPaneSpec;
      return a.run === d.run && a.base === d.base && a.head === d.head;
    }
    case 'vault':
      return true; // one vault per computer
  }
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

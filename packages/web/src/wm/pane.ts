// Pane specifications (spec 8.5). A pane is a typed view inside the tiling WM.
// The spec is plain serializable data so the whole layout can be persisted to
// the Durable Object (spec 8.6) and restored on load.

import type { RunId } from '@mari/shared';

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

export type PaneSpec =
  | TerminalPaneSpec
  | FilesPaneSpec
  | EditorPaneSpec
  | BrowserPreviewPaneSpec;

export type PaneKind = PaneSpec['kind'];

/** Human label for a pane, for tab strips and the command palette. */
export function paneLabel(pane: PaneSpec): string {
  if (pane.title) return pane.title;
  switch (pane.kind) {
    case 'terminal':
      return `Terminal · ${pane.run}`;
    case 'files':
      return `Files · ${pane.path}`;
    case 'editor':
      return `Editor · ${basename(pane.path)}`;
    case 'preview':
      return `Preview · :${pane.port}`;
  }
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

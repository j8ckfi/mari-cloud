// The active panes' actions, for the global command palette.
//
// "Save file", "Run brief" and "Upload file here" are palette commands (spec
// 8.1 demands every action be keyboard-reachable), but each acts on state that
// lives inside one pane — a CodeMirror document, a hidden file input, the
// directory currently listed. Rather than have a pane REGISTER those commands
// (which deletes them from the registry when the pane closes, and makes their
// presence depend on mount order), the pane publishes its actions here and the
// core commands delegate. The registry keeps exactly one stable entry per
// action for the app's whole life, open pane or not.

/** What an editor pane offers the palette. */
export interface EditorActions {
  /** The file being edited, for the command's title. */
  path: string;
  /** Save the document (spec 8.4: this write wakes a sleeping computer). */
  save(): Promise<unknown>;
  /** Save, then start the document as a run (spec 8.5). */
  runBrief(): Promise<unknown>;
}

let active: EditorActions | null = null;
const listeners = new Set<() => void>();

/**
 * Publish the active editor's actions. Returns a disposer that clears them
 * only if this editor is still the active one — so a pane closing after
 * another took focus does not blank the commands.
 */
export function setActiveEditor(actions: EditorActions): () => void {
  active = actions;
  emit();
  return () => {
    if (active === actions) {
      active = null;
      emit();
    }
  };
}

/** The active editor's actions, or null when no editor pane is open. */
export function activeEditor(): EditorActions | null {
  return active;
}

/** Subscribe to changes (the palette re-titles its commands from this). */
export function onActiveEditorChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

// ---- files pane ----

/** What a files pane offers the palette. */
export interface FilesActions {
  /** The directory currently listed. */
  path: string;
  /** Open the file picker for an upload into `path` (spec 8.5). */
  upload(): void;
  /** Navigate to the parent directory. */
  up(): void;
}

let activeFilesActions: FilesActions | null = null;

/** Publish the active files pane's actions. Returns a disposer. */
export function setActiveFiles(actions: FilesActions): () => void {
  activeFilesActions = actions;
  emit();
  return () => {
    if (activeFilesActions === actions) {
      activeFilesActions = null;
      emit();
    }
  };
}

/** The active files pane's actions, or null when none is open. */
export function activeFiles(): FilesActions | null {
  return activeFilesActions;
}

/** Test seam: forget the active panes. */
export function resetPaneActions(): void {
  active = null;
  activeFilesActions = null;
  emit();
}

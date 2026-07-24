// Opening a file into "a pane of the correct type" (spec 8.5, Files pane).
//
// The rule set is deliberately small and total: every entry resolves to exactly
// one action, and the fallback is the safe one. The editor is not an IDE (spec
// 8.5), so anything that plainly is not text goes to a download instead of
// being loaded into CodeMirror as mojibake.

import type { FileEntry } from '../api/types';

/** What activating an entry should do. */
export type OpenAction =
  | { kind: 'browse'; path: string }
  | { kind: 'follow'; path: string }
  | { kind: 'editor'; path: string }
  | { kind: 'download'; path: string };

/** Extensions the editor handles: markdown, configuration, briefs, code. */
const TEXT_EXT =
  /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|conf|cfg|env|sh|bash|zsh|fish|rs|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|xml|svg|py|rb|go|java|c|h|cpp|hpp|sql|lock|log|patch|diff|gitignore|dockerfile|makefile)$/i;

/** Extensions that are certainly not text. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|zst|tar|7z|rar|wasm|so|dylib|dll|exe|bin|o|a|class|jar|mp[34]|mov|mp4|avi|mkv|wav|flac|ogg|ttf|otf|woff2?|eot|db|sqlite3?)$/i;

/** Files above this size never open in the editor; they download. */
export const MAX_EDITOR_BYTES = 1024 * 1024;

/** Resolve what to do with an entry the user activated. Total: never null. */
export function openActionFor(entry: FileEntry): OpenAction {
  if (entry.kind === 'dir') return { kind: 'browse', path: entry.path };
  if (entry.kind === 'symlink') {
    return { kind: 'follow', path: resolveSymlink(entry) };
  }
  if (BINARY_EXT.test(entry.name)) return { kind: 'download', path: entry.path };
  if (entry.size > MAX_EDITOR_BYTES) return { kind: 'download', path: entry.path };
  if (TEXT_EXT.test(entry.name)) return { kind: 'editor', path: entry.path };
  // Unknown, small, not obviously binary: the editor is the useful default —
  // most config files and briefs have no extension at all.
  return { kind: 'editor', path: entry.path };
}

/** Absolute target of a symlink entry (relative targets resolve against its dir). */
export function resolveSymlink(entry: FileEntry): string {
  const target = entry.symlinkTarget;
  if (target === null || target === '') return entry.path;
  if (target.startsWith('/')) return normalize(target);
  const dir = entry.path.slice(0, Math.max(entry.path.lastIndexOf('/'), 0)) || '/';
  return normalize(`${dir}/${target}`);
}

/** Collapse `.`/`..` segments and duplicate separators in an absolute path. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

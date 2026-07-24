import { describe, it, expect } from 'vitest';
import { BRIEF_RUNNER, briefArgv, dirnameOf, parseCommandLine } from '../src/runs/command';
import { openActionFor, normalize, resolveSymlink, MAX_EDITOR_BYTES } from '../src/files/dispatch';
import type { FileEntry } from '../src/api/types';

describe('command line → argv (contracts §5.2)', () => {
  it('splits on whitespace', () => {
    expect(parseCommandLine('npm run build')).toEqual(['npm', 'run', 'build']);
    expect(parseCommandLine('  ls   -la  ')).toEqual(['ls', '-la']);
  });

  it('keeps a quoted argument whole', () => {
    expect(parseCommandLine('git commit -m "wip thing"')).toEqual([
      'git',
      'commit',
      '-m',
      'wip thing',
    ]);
    expect(parseCommandLine("sh -lc 'echo a b'")).toEqual(['sh', '-lc', 'echo a b']);
  });

  it('preserves an intentionally empty argument', () => {
    expect(parseCommandLine('cmd "" x')).toEqual(['cmd', '', 'x']);
  });

  it('does not interpret shell metacharacters — argv is not a shell', () => {
    // A run is exec'd, not evaluated; `|` and `&&` are ordinary characters
    // here, and pretending otherwise would silently change what runs.
    expect(parseCommandLine('echo a | tee b')).toEqual(['echo', 'a', '|', 'tee', 'b']);
    expect(parseCommandLine('a && b')).toEqual(['a', '&&', 'b']);
    expect(parseCommandLine('echo $HOME')).toEqual(['echo', '$HOME']);
  });

  it('handles escapes inside and outside double quotes', () => {
    expect(parseCommandLine('echo a\\ b')).toEqual(['echo', 'a b']);
    expect(parseCommandLine('echo "a\\"b"')).toEqual(['echo', 'a"b']);
    expect(parseCommandLine("echo 'a\\b'")).toEqual(['echo', 'a\\b']); // literal in single quotes
  });

  it('returns [] for nothing typed, so the UI can refuse to start it', () => {
    expect(parseCommandLine('')).toEqual([]);
    expect(parseCommandLine('   \t ')).toEqual([]);
  });

  it('closes an unterminated quote instead of throwing mid-typing', () => {
    expect(parseCommandLine('git commit -m "half')).toEqual(['git', 'commit', '-m', 'half']);
  });
});

describe('brief → run (spec 8.5)', () => {
  it('uses the default runner with the brief path', () => {
    expect(briefArgv('/notes/task.md', '# Do the thing\n')).toEqual([
      BRIEF_RUNNER,
      '/notes/task.md',
    ]);
  });

  it('lets the document name its own runner on a leading #! line', () => {
    // The user brings the agents (spec 1.1) — the brief says what runs.
    expect(briefArgv('/b.md', '#!claude -p\nDo the thing')).toEqual(['claude', '-p', '/b.md']);
    expect(briefArgv('/b.md', '#! /usr/bin/env my-agent --yolo\nbody')).toEqual([
      '/usr/bin/env',
      'my-agent',
      '--yolo',
      '/b.md',
    ]);
  });

  it('ignores a #! that is not on the first line', () => {
    expect(briefArgv('/b.md', 'intro\n#!claude\n')).toEqual([BRIEF_RUNNER, '/b.md']);
  });

  it('ignores an empty #! line', () => {
    expect(briefArgv('/b.md', '#!\nbody')).toEqual([BRIEF_RUNNER, '/b.md']);
  });

  it('derives the run cwd from the brief path', () => {
    expect(dirnameOf('/notes/task.md')).toBe('/notes');
    expect(dirnameOf('/task.md')).toBe('/');
    expect(dirnameOf('/a/b/c/d.md')).toBe('/a/b/c');
  });
});

function fileEntry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'README.md',
    path: '/README.md',
    kind: 'file',
    size: 100,
    mode: 0o100644,
    symlinkTarget: null,
    ...over,
  };
}

describe('open-file dispatch (spec 8.5: "a file opens into a pane of the correct type")', () => {
  it('browses a directory', () => {
    expect(openActionFor(fileEntry({ kind: 'dir', name: 'src', path: '/src' }))).toEqual({
      kind: 'browse',
      path: '/src',
    });
  });

  it('opens text, config and brief files in the editor', () => {
    for (const name of ['README.md', 'config.toml', 'app.ts', '.gitignore', 'notes.txt']) {
      const action = openActionFor(fileEntry({ name, path: `/${name}` }));
      expect(action.kind, name).toBe('editor');
    }
  });

  it('downloads binaries instead of loading them into CodeMirror', () => {
    for (const name of ['logo.png', 'archive.tar.gz', 'app.wasm', 'db.sqlite3', 'font.woff2']) {
      expect(openActionFor(fileEntry({ name, path: `/${name}` })).kind, name).toBe('download');
    }
  });

  it('downloads a huge text file rather than opening it (the editor is not an IDE)', () => {
    expect(openActionFor(fileEntry({ name: 'huge.log', size: MAX_EDITOR_BYTES + 1 })).kind).toBe(
      'download',
    );
    expect(openActionFor(fileEntry({ name: 'ok.log', size: MAX_EDITOR_BYTES })).kind).toBe('editor');
  });

  it('opens an extensionless small file in the editor', () => {
    expect(openActionFor(fileEntry({ name: 'Dockerfile', path: '/Dockerfile' })).kind).toBe('editor');
  });

  it('follows a symlink to its resolved absolute target', () => {
    expect(
      openActionFor(
        fileEntry({ kind: 'symlink', name: 'cur', path: '/app/cur', symlinkTarget: '../rel/x' }),
      ),
    ).toEqual({ kind: 'follow', path: '/rel/x' });

    expect(
      openActionFor(
        fileEntry({ kind: 'symlink', name: 'abs', path: '/a/abs', symlinkTarget: '/etc/hosts' }),
      ),
    ).toEqual({ kind: 'follow', path: '/etc/hosts' });
  });

  it('does not follow a symlink with no target', () => {
    const entry = fileEntry({ kind: 'symlink', name: 'dead', path: '/dead', symlinkTarget: null });
    expect(resolveSymlink(entry)).toBe('/dead');
  });

  it('normalizes . and .. and duplicate separators', () => {
    expect(normalize('/a//b/./c/../d')).toBe('/a/b/d');
    expect(normalize('/../x')).toBe('/x');
    expect(normalize('/')).toBe('/');
  });
});

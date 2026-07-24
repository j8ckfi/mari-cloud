import { useRef, useState } from 'react';
import { useDir } from '../../api/queries';
import { fetchFile, writeFile } from '../../api/client';
import { useUiStore } from '../../store/ui';
import type { FileEntry } from '../../api/types';
import type { FilesPaneSpec } from '../../wm/pane';

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|ini|conf|cfg|env|sh|rs|ts|tsx|js|jsx|css|html?|xml|py|go|lock|gitignore)$/i;
const PREVIEWABLE = new Set(['file']);

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  if (path === '/' || path === '') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

/**
 * Files pane (spec 8.5): a filesystem browser over the manifest-backed API,
 * which works fully on a COLD computer (spec 8.4 — reads come from the manifest
 * head, never a wake). Opening a file dispatches it to the correct pane type.
 * Upload/download are supported; an upload WRITES and therefore wakes (8.4).
 */
export function FilesPane({ computer, spec }: { computer: string; spec: FilesPaneSpec }) {
  const [path, setPath] = useState(spec.path);
  const addPane = useUiStore((s) => s.addPane);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dir = useDir(computer, path);

  const open = (entry: FileEntry): void => {
    if (entry.kind === 'dir') {
      setPath(entry.path);
      return;
    }
    if (!PREVIEWABLE.has(entry.kind)) return;
    if (TEXT_EXT.test(entry.name) || entry.size < 512 * 1024) {
      addPane({ kind: 'editor', path: entry.path });
    }
  };

  const download = async (entry: FileEntry): Promise<void> => {
    const bytes = await fetchFile(computer, entry.path);
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onUpload = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeFile(computer, joinPath(path, file.name), bytes);
    void dir.refetch();
  };

  const entries = dir.data?.entries ?? [];

  return (
    <div className="files" data-testid="files-pane">
      <div className="files-bar">
        <button
          type="button"
          title="Up"
          disabled={path === '/'}
          onClick={() => setPath(parentOf(path))}
        >
          ↑
        </button>
        <span className="files-path" data-testid="files-path">
          {path}
        </span>
        <button type="button" onClick={() => uploadRef.current?.click()}>
          Upload
        </button>
        <input
          ref={uploadRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = '';
          }}
        />
      </div>
      <div data-testid="files-list">
        {entries.map((entry) => (
          <div key={entry.path} style={{ display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              className="file-row"
              data-testid="file-entry"
              data-kind={entry.kind}
              onDoubleClick={() => open(entry)}
              onClick={() => open(entry)}
            >
              <span className="ficon">
                {entry.kind === 'dir' ? '▸' : entry.kind === 'symlink' ? '↗' : '·'}
              </span>
              <span className="fname">{entry.name}</span>
              {entry.kind === 'file' && <span className="fsize">{entry.size}</span>}
            </button>
            {entry.kind === 'file' && (
              <button
                type="button"
                title="Download"
                className="hint"
                onClick={() => void download(entry)}
              >
                ⇩
              </button>
            )}
          </div>
        ))}
        {dir.isError && (
          <div className="empty-note">Could not read directory.</div>
        )}
      </div>
    </div>
  );
}

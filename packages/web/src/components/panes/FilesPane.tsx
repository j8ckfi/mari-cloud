import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useDir } from '../../api/queries';
import { fetchFile, uploadFile } from '../../api/client';
import { useUiStore } from '../../store/ui';
import { openActionFor } from '../../files/dispatch';
import { setActiveFiles } from '../../store/pane-actions';
import type { FileEntry } from '../../api/types';
import type { FilesPaneSpec } from '../../wm/pane';

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
 * head, never a wake). Opening a file dispatches it to the pane of the correct
 * type (see files/dispatch). Upload and download are both possible; an upload
 * WRITES and therefore wakes (8.4), and the pane says so instead of blocking.
 */
export function FilesPane({ computer, spec }: { computer: string; spec: FilesPaneSpec }) {
  const [path, setPath] = useState(spec.path);
  const [status, setStatus] = useState('');
  const addPane = useUiStore((s) => s.addPane);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dir = useDir(computer, path);
  const qc = useQueryClient();

  const open = (entry: FileEntry): void => {
    const action = openActionFor(entry);
    switch (action.kind) {
      case 'browse':
      case 'follow':
        setPath(action.path);
        return;
      case 'editor':
        addPane({ kind: 'editor', path: action.path });
        return;
      case 'download':
        void download(entry);
        return;
    }
  };

  const download = async (entry: FileEntry): Promise<void> => {
    setStatus(`Downloading ${entry.name}…`);
    try {
      const bytes = await fetchFile(computer, entry.path);
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(url);
      setStatus('');
    } catch {
      setStatus(`Could not download ${entry.name}`);
    }
  };

  const onUpload = async (file: File): Promise<void> => {
    const target = joinPath(path, file.name);
    // Spec 8.4: this write wakes the computer. Spec 8.3: say so, do not wait.
    setStatus(`Uploading ${file.name}…`);
    try {
      const res = await uploadFile(computer, target, file);
      setStatus(`Uploaded ${file.name} · ${res.state}`);
      void qc.invalidateQueries({ queryKey: queryKeys.fleet });
      void dir.refetch();
    } catch {
      setStatus(`Upload of ${file.name} failed`);
    }
  };

  // Publish this pane's actions for the palette's stable Files commands
  // (spec 8.1). Re-published per path so "Upload" targets what is on screen.
  useEffect(() => {
    return setActiveFiles({
      path,
      upload: () => uploadRef.current?.click(),
      up: () => setPath((p) => parentOf(p)),
    });
  }, [computer, path]);

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
        <span className="spacer" style={{ flex: 1 }} />
        <span className="hint" data-testid="files-status">
          {status}
        </span>
        <button type="button" onClick={() => uploadRef.current?.click()} data-testid="files-upload">
          Upload
        </button>
        <input
          ref={uploadRef}
          type="file"
          hidden
          data-testid="files-upload-input"
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
              data-path={entry.path}
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
                data-testid="file-download"
                onClick={() => void download(entry)}
              >
                ⇩
              </button>
            )}
          </div>
        ))}
        {dir.isError && (
          <div className="empty-note" role="alert" data-testid="files-error">
            <strong>Could not read this directory.</strong>
            <p>
              The listing comes from the computer’s manifest in the chunk store, not from the
              computer itself — so this is the control plane failing to answer, and nothing on the
              computer has changed. Check the instance is up, then reopen the pane.
            </p>
          </div>
        )}
        {/* An empty directory is a real, common state — a computer that has not
            snapshotted anything yet reads as an empty root. Say so, rather than
            rendering a blank pane the user has to guess about (every other pane
            carries its own empty note). */}
        {!dir.isError && dir.isFetched && entries.length === 0 && (
          <div className="empty-note" data-testid="files-empty">
            Nothing here yet.
          </div>
        )}
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { previewHost, previewUrl } from '../../preview/url';
import type { BrowserPreviewPaneSpec } from '../../wm/pane';

/** The preview zone (hosted default). Private instances override via env. */
const PREVIEW_ZONE = import.meta.env.VITE_PREVIEW_ZONE ?? 'mari.sh';

/**
 * Browser preview pane (spec 8.5 "Browser, preview mode"): an iframe to the
 * stable `{port}--{computer}--{user}` preview URL, with a bar showing that
 * stable URL. A request to the URL wakes the computer via the wake proxy; the
 * pane itself does nothing but frame it.
 */
export function BrowserPreviewPane({
  computer,
  user,
  spec,
}: {
  computer: string;
  user: string;
  spec: BrowserPreviewPaneSpec;
}) {
  const [nonce, setNonce] = useState(0);

  const built = useMemo(() => {
    try {
      return {
        host: previewHost({ port: spec.port, computer, user }, PREVIEW_ZONE),
        url: previewUrl({ port: spec.port, computer, user }, PREVIEW_ZONE),
        error: null as string | null,
      };
    } catch (err) {
      return { host: '', url: '', error: err instanceof Error ? err.message : String(err) };
    }
  }, [spec.port, computer, user]);

  return (
    <div className="preview" data-testid="preview-pane">
      <div className="preview-bar">
        <span className="kind">:{spec.port}</span>
        <span className="preview-url" data-testid="preview-url" title={built.url}>
          {built.host}
        </span>
        <button type="button" title="Reload" onClick={() => setNonce((n) => n + 1)}>
          ⟳
        </button>
      </div>
      {built.error ? (
        <div className="empty-note">Invalid preview target: {built.error}</div>
      ) : (
        <iframe
          key={nonce}
          data-testid="preview-frame"
          src={built.url}
          title={`preview ${built.host}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
    </div>
  );
}

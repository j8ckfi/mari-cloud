import { useEffect, useRef, useState } from 'react';
import { fetchPreview } from '../../api/client';
import { parsePreviewHost } from '../../preview/url';
import type { PreviewResponse } from '../../api/types';
import type { BrowserPreviewPaneSpec } from '../../wm/pane';

/**
 * Browser preview pane (spec 8.5 "Browser, preview mode"): an iframe to the
 * stable `{port}--{computer}--{user}` preview URL, with a bar showing that
 * stable URL. A request to the URL wakes the computer via the wake proxy; the
 * pane itself does nothing but frame it.
 *
 * THE URL COMES FROM THE SERVER. It used to be composed here from
 * `https` + a build-time `VITE_PREVIEW_ZONE` + the literal user label `'user'`,
 * none of which a deployment can influence — so on a private instance the pane
 * pointed at `https://3000--<id>--user.mari.sh` and rendered a blank white box,
 * forever, whatever the operator configured. Three of those four fields are
 * deployment facts (zone, scheme, origin port) and the fourth is derived from the
 * OWNER's account, so `GET /api/computers/:id/preview?port=` is the only thing
 * that can know them. That request also mints the capability the wake proxy now
 * requires: the preview surface both reads a port and materializes substrate
 * resources, so it cannot be anonymous (see control-plane `preview.ts`).
 *
 * The failure states are all shown as text, never as a blank pane: no
 * capability (signed out), a refused mint, and — via the reload button — a port
 * with nothing listening, which the proxy reports as a 502 naming the reason.
 */
export function BrowserPreviewPane({
  computer,
  spec,
  path,
}: {
  computer: string;
  spec: BrowserPreviewPaneSpec;
  /** Optional path/query inside the exposed service (computer browser uses it). */
  path?: string;
}) {
  const [nonce, setNonce] = useState(0);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The capability-bearing URL is loaded ONCE per mint: the proxy converts it
  // into a host-scoped cookie and redirects, so a reload must use the stable URL
  // (re-loading the token URL would just repeat the redirect).
  const loaded = useRef(false);

  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setError(null);
    loaded.current = false;
    fetchPreview(computer, spec.port)
      .then((res) => {
        if (disposed) return;
        // Validate the shape the zone contract locks (decisions.md: ONE DNS label
        // `{port}--{computer}--{user}`, because a wildcard cert covers one level).
        // The parser here is the mirror of the control plane's, so a deployment
        // whose zone or label drifts is a visible error rather than a blank pane.
        const parts = parsePreviewHost(res.host);
        if (parts.port !== spec.port) {
          throw new Error(`preview host names port ${parts.port}, expected ${spec.port}`);
        }
        setPreview(res);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, [computer, spec.port]);

  const base = preview === null ? null : loaded.current ? preview.stableUrl : preview.url;
  const src = base === null ? null : previewPath(base, path);
  if (preview !== null) loaded.current = true;

  return (
    <div className="preview" data-testid="preview-pane">
      <div className="preview-bar">
        <span className="kind">:{spec.port}</span>
        <span
          className="preview-url"
          data-testid="preview-url"
          title={preview?.stableUrl ?? ''}
        >
          {preview?.host ?? '…'}
        </span>
        <button
          type="button"
          title="Reload"
          data-testid="preview-reload"
          onClick={() => setNonce((n) => n + 1)}
        >
          ⟳
        </button>
      </div>
      {error !== null ? (
        <div className="empty-note" data-testid="preview-error">
          No preview for port {spec.port}: {error}
        </div>
      ) : src === null ? (
        // Not a spinner (spec 8.3): the pane's chrome is already on screen and
        // this is one line of text saying what it is waiting for.
        <div className="empty-note" data-testid="preview-pending">
          Resolving the preview address…
        </div>
      ) : (
        <iframe
          key={`${src}#${nonce}`}
          data-testid="preview-frame"
          src={src}
          title={`preview ${preview?.host ?? ''}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
    </div>
  );
}

/** Replace the service path while preserving Mari's one-shot capability query. */
function previewPath(base: string, path: string | undefined): string {
  if (path === undefined) return base;
  const source = new URL(base);
  const target = new URL(path, source.origin);
  for (const [name, value] of source.searchParams) {
    if (!target.searchParams.has(name)) target.searchParams.set(name, value);
  }
  return target.toString();
}

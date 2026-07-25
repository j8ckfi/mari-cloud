// Browser preview pane (spec 8.5 "a stable URL per port per computer").
//
// The pane could never work on a private instance and had no authorization at
// all. It composed its own iframe src as
// `https://{port}--{computer}--user.mari.sh` from:
//
//   * a hardcoded `https` scheme,
//   * `VITE_PREVIEW_ZONE`, a BUILD-time variable defaulting to `mari.sh`, and
//   * the literal string `'user'` — `Shell.tsx`'s `VITE_USER ?? 'user'`, whose
//     comment claimed "the control plane sets the real one". It did not.
//
// Observed before the fix: `iframe src=https://3000--bf8f6807…--user.mari.sh/`
// and a blank white pane, with no way for an operator to configure it short of
// editing source and rebuilding.
//
// So these tests assert the pane takes the URL from the SERVER, which is the only
// party that knows the zone, the scheme, the origin port and the owner's host
// label — and that mints the capability the wake proxy requires.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserPreviewPane } from '../src/components/panes/BrowserPreviewPane';

interface Call {
  url: string;
}

function stub(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const call = { url: String(input) };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PREVIEW = {
  computer: 'c1',
  port: 3000,
  host: '3000--c1--ab12cd34ef56.dev.example.com',
  url: 'http://3000--c1--ab12cd34ef56.dev.example.com:8787/?mari_preview=p1.999.deadbeef',
  stableUrl: 'http://3000--c1--ab12cd34ef56.dev.example.com:8787/',
  expiresAt: Date.now() + 3600_000,
};

describe('BrowserPreviewPane', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('frames the URL the control plane minted, scheme, port and label included', async () => {
    const calls = stub(() => json(PREVIEW));
    render(<BrowserPreviewPane computer="c1" spec={{ kind: 'preview', port: 3000 }} />);

    const frame = await waitFor(() => screen.getByTestId('preview-frame'));
    // The capability-bearing URL is what gets loaded (the proxy turns it into a
    // host-scoped cookie and redirects it away).
    expect(frame.getAttribute('src')).toBe(PREVIEW.url);
    // Nothing about this came from the bundle: not the scheme, not the zone, not
    // the user label.
    expect(frame.getAttribute('src')).not.toContain('https://');
    expect(frame.getAttribute('src')).not.toContain('--user.');
    expect(frame.getAttribute('src')).not.toContain('mari.sh');
    expect(screen.getByTestId('preview-url').textContent).toBe(PREVIEW.host);

    expect(calls.map((c) => c.url)).toEqual(['/api/computers/c1/preview?port=3000']);
  });

  it('re-mints for a different port and asks for exactly that port', async () => {
    stub((c) =>
      json({
        ...PREVIEW,
        port: 8080,
        host: '8080--c1--ab12cd34ef56.dev.example.com',
        url: 'http://8080--c1--ab12cd34ef56.dev.example.com:8787/?mari_preview=p1.999.beef',
        stableUrl: 'http://8080--c1--ab12cd34ef56.dev.example.com:8787/',
      }),
    );
    render(<BrowserPreviewPane computer="c1" spec={{ kind: 'preview', port: 8080 }} />);
    await waitFor(() =>
      expect(screen.getByTestId('preview-url').textContent).toBe(
        '8080--c1--ab12cd34ef56.dev.example.com',
      ),
    );
  });

  it('reloads through the STABLE url, not the one-shot capability', async () => {
    stub(() => json(PREVIEW));
    const user = userEvent.setup();
    render(<BrowserPreviewPane computer="c1" spec={{ kind: 'preview', port: 3000 }} />);
    await waitFor(() => screen.getByTestId('preview-frame'));

    await user.click(screen.getByTestId('preview-reload'));
    await waitFor(() =>
      expect(screen.getByTestId('preview-frame').getAttribute('src')).toBe(PREVIEW.stableUrl),
    );
  });

  it('says why there is no preview instead of showing a blank pane', async () => {
    stub(() => json({ error: 'not_found' }, 404));
    render(<BrowserPreviewPane computer="c1" spec={{ kind: 'preview', port: 3000 }} />);
    const note = await waitFor(() => screen.getByTestId('preview-error'));
    expect(note.textContent).toContain('port 3000');
    expect(screen.queryByTestId('preview-frame')).toBeNull();
  });

  it('refuses a host that is not the locked one-label shape', async () => {
    // A deployment (or a bug) that hands back a nested host would put the iframe
    // outside the wildcard certificate; that is a visible error, not a blank box.
    stub(() =>
      json({ ...PREVIEW, host: '3000--c1--ab12cd34ef56.nested.dev.example.com', port: 3000 }),
    );
    render(<BrowserPreviewPane computer="c1" spec={{ kind: 'preview', port: 3000 }} />);
    // A dotted zone parses fine (the zone is everything after the first label), so
    // the mismatch this catches is a port/label disagreement.
    await waitFor(() => screen.getByTestId('preview-frame'));

    vi.unstubAllGlobals();
    stub(() => json({ ...PREVIEW, host: '9999--c1--ab12cd34ef56.dev.example.com' }));
    render(<BrowserPreviewPane computer="c1" spec={{ kind: 'preview', port: 4321 }} />);
    const errors = await waitFor(() => screen.getAllByTestId('preview-error'));
    expect(errors.some((e) => (e.textContent ?? '').includes('names port 9999'))).toBe(true);
  });
});

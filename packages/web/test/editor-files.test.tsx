import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditorPane } from '../src/components/panes/EditorPane';
import { FilesPane } from '../src/components/panes/FilesPane';
import { useUiStore } from '../src/store/ui';
import { findPane, findPaneBy } from '../src/wm/tree';
import type { FileEntry } from '../src/api/types';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body };
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

describe('EditorPane save (spec 8.4 write wakes / 8.3 never blocks)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('PUTs the document and shows the WAKE transition, with no spinner', async () => {
    const calls = stub((c) =>
      c.method === 'PUT'
        ? json({ ok: true, path: '/notes/todo.md', state: 'waking' })
        : new Response('# todo\n', { status: 200 }),
    );
    const user = userEvent.setup();
    wrap(<EditorPane computer="c1" spec={{ kind: 'editor', path: '/notes/todo.md' }} />);

    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    await user.click(screen.getByTestId('editor-save'));

    const put = await waitFor(() => {
      const found = calls.find((c) => c.method === 'PUT');
      expect(found).toBeDefined();
      return found!;
    });
    expect(put.url).toBe('/api/computers/c1/file?path=%2Fnotes%2Ftodo.md');
    expect(new TextDecoder().decode(put.body as Uint8Array)).toBe('# todo\n');

    // The wake is REPORTED as a state, not waited on: no spinner, no disabled
    // editor, and the Save button stays live.
    await waitFor(() => expect(screen.getByTestId('editor-state').textContent).toBe('waking'));
    expect(screen.getByTestId('editor-status').textContent).toBe('Saved · waking');
    expect(document.querySelector('[role="progressbar"], .spinner, [aria-busy="true"]')).toBeNull();
    expect((screen.getByTestId('editor-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when the write fails instead of pretending it saved', async () => {
    stub((c) => (c.method === 'PUT' ? json({ error: 'nope' }, 500) : new Response('x', { status: 200 })));
    const user = userEvent.setup();
    wrap(<EditorPane computer="c1" spec={{ kind: 'editor', path: '/a.md' }} />);
    await user.click(screen.getByTestId('editor-save'));
    // The wording must state the file's ACTUAL state ("nothing was written"),
    // not merely that an operation failed — a user who cannot tell whether a
    // partial write landed has to go and look.
    await waitFor(() =>
      expect(screen.getByTestId('editor-status').textContent).toBe(
        'Save failed — nothing was written. Try again.',
      ),
    );
  });

  it('Run brief saves first, then starts the run and opens its terminal (spec 8.5)', async () => {
    useUiStore.setState({ activeComputer: null, layouts: {}, workspaces: [], view: 'fleet' });
    const calls = stub((c) => {
      if (c.method === 'PUT') return json({ ok: true, path: '/b.md', state: 'awake' });
      if (c.url.endsWith('/runs')) return json({ runId: 'run-42', state: 'pending' });
      return new Response('#!my-agent --go\nDo the thing\n', { status: 200 });
    });
    const user = userEvent.setup();
    wrap(<EditorPane computer="c1" spec={{ kind: 'editor', path: '/b.md' }} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    await user.click(screen.getByTestId('editor-run-brief'));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/runs'))).toBe(true));
    const order = calls.map((c) => `${c.method} ${c.url}`);
    // The save must precede the run: the run reads the file from the computer.
    expect(order.indexOf('PUT /api/computers/c1/file?path=%2Fb.md')).toBeLessThan(
      order.indexOf('POST /api/computers/c1/runs'),
    );

    // The document named its own runner; the brief path is the argument.
    const runCall = calls.find((c) => c.url.endsWith('/runs'))!;
    expect(JSON.parse(runCall.body as string)).toEqual({
      argv: ['my-agent', '--go', '/b.md'],
      cwd: '/',
    });

    // …and the run's terminal pane opened (spec 5/7.1).
    await waitFor(() => {
      const layout = useUiStore.getState().layoutFor('c1');
      const focused = findPane(layout.root, layout.focused as string);
      expect(focused?.pane).toEqual({ kind: 'terminal', run: 'run-42' });
    });
  });
});

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'README.md',
    path: '/README.md',
    kind: 'file',
    size: 12,
    mode: 0o100644,
    symlinkTarget: null,
    ...over,
  };
}

describe('FilesPane upload / open dispatch (spec 8.5)', () => {
  beforeEach(() => {
    useUiStore.setState({ activeComputer: 'c1', layouts: {}, workspaces: ['c1'], view: 'workspace' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uploads into the current directory and reports the resulting state', async () => {
    const calls = stub((c) =>
      c.url.endsWith('/upload')
        ? json({ ok: true, path: '/src/notes.txt', state: 'waking' })
        : json({ computer: 'c1', path: '/src', manifest: 'm', entries: [] }),
    );
    const user = userEvent.setup();
    wrap(<FilesPane computer="c1" spec={{ kind: 'files', path: '/src' }} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const input = screen.getByTestId('files-upload-input') as HTMLInputElement;
    await user.upload(input, new File(['hello'], 'notes.txt', { type: 'text/plain' }));

    const upload = await waitFor(() => {
      const found = calls.find((c) => c.url.endsWith('/upload'));
      expect(found).toBeDefined();
      return found!;
    });
    expect(upload.method).toBe('POST');
    expect((upload.body as FormData).get('path')).toBe('/src/notes.txt');
    await waitFor(() =>
      expect(screen.getByTestId('files-status').textContent).toBe('Uploaded notes.txt · waking'),
    );
  });

  it('opens a text file into an editor pane and a directory in place', async () => {
    stub(() =>
      json({
        computer: 'c1',
        path: '/',
        manifest: 'm',
        entries: [entry(), entry({ name: 'src', path: '/src', kind: 'dir', size: 0 })],
      }),
    );
    const user = userEvent.setup();
    wrap(<FilesPane computer="c1" spec={{ kind: 'files', path: '/' }} />);

    const rows = await screen.findAllByTestId('file-entry');
    await user.click(rows.find((r) => r.getAttribute('data-path') === '/README.md')!);

    const layout = useUiStore.getState().layoutFor('c1');
    expect(findPane(layout.root, layout.focused as string)!.pane).toEqual({
      kind: 'editor',
      path: '/README.md',
    });

    // A directory navigates the same pane rather than opening a new one.
    await user.click((await screen.findAllByTestId('file-entry')).find((r) => r.getAttribute('data-path') === '/src')!);
    await waitFor(() => expect(screen.getByTestId('files-path').textContent).toBe('/src'));
  });

  it('downloads a binary instead of opening it in the editor', async () => {
    const calls = stub((c) =>
      c.url.includes('/file?')
        ? new Response(new Uint8Array([0, 1, 2]), { status: 200 })
        : json({
            computer: 'c1',
            path: '/',
            manifest: 'm',
            entries: [entry({ name: 'logo.png', path: '/logo.png', size: 3 })],
          }),
    );
    const clicks: string[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => clicks.push((el as HTMLAnchorElement).download);
      }
      return el;
    }) as typeof document.createElement);
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });

    const user = userEvent.setup();
    wrap(<FilesPane computer="c1" spec={{ kind: 'files', path: '/' }} />);
    const row = (await screen.findAllByTestId('file-entry'))[0]!;
    await user.click(within(row).getByText('logo.png'));

    await waitFor(() => expect(clicks).toEqual(['logo.png']));
    expect(calls.some((c) => c.url.includes('/file?path=%2Flogo.png'))).toBe(true);
    // No editor pane was opened for a PNG.
    const layout = useUiStore.getState().layoutFor('c1');
    expect(findPaneBy(layout.root, (p) => p.kind === 'editor')).toBeNull();
    vi.restoreAllMocks();
  });
});

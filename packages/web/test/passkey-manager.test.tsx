import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasskeyManager } from '../src/components/PasskeyManager';
import type { AuthApi, AuthResult, PasskeyRecord } from '../src/auth/api';

// Passkey management (spec 11.3 accounts, spec 8.1 keyboard operation): list,
// name, remove, add. The one rule worth encoding in a test is the last-passkey
// guard — with no password anywhere on the hosted path, removing the only
// credential locks the account out for good.

function record(over: Partial<PasskeyRecord> = {}): PasskeyRecord {
  return {
    id: 'pk1',
    name: 'MacBook',
    createdAt: Date.UTC(2026, 6, 20),
    deviceType: 'multiDevice',
    backedUp: true,
    aaguid: null,
    ...over,
  };
}

interface Fake {
  api: AuthApi;
  calls: string[];
  rows: PasskeyRecord[];
}

function fakeApi(rows: PasskeyRecord[], failures: Partial<Record<string, string>> = {}): Fake {
  const calls: string[] = [];
  const state = { rows: [...rows] };
  const fail = (op: string): AuthResult<undefined> | null =>
    failures[op] === undefined
      ? null
      : { ok: false, error: { message: failures[op], status: 400, code: 'X' } };
  const api: AuthApi = {
    getSession: async () => null,
    createAccountWithPasskey: async () => ({ ok: false, error: {} }),
    signInWithPasskey: async () => ({ ok: false, error: {} }),
    signOut: async () => {},
    listPasskeys: async () => {
      calls.push('list');
      const f = failures.list;
      if (f !== undefined) return { ok: false, error: { message: f, status: 500 } };
      return { ok: true, value: state.rows.map((r) => ({ ...r })) };
    },
    addPasskey: async (name) => {
      calls.push(`add:${name}`);
      const f = fail('add');
      if (f) return f;
      state.rows = [...state.rows, record({ id: `pk${state.rows.length + 1}`, name })];
      return { ok: true, value: undefined };
    },
    renamePasskey: async (id, name) => {
      calls.push(`rename:${id}:${name}`);
      const f = fail('rename');
      if (f) return f;
      state.rows = state.rows.map((r) => (r.id === id ? { ...r, name } : r));
      return { ok: true, value: undefined };
    },
    removePasskey: async (id) => {
      calls.push(`remove:${id}`);
      const f = fail('remove');
      if (f) return f;
      state.rows = state.rows.filter((r) => r.id !== id);
      return { ok: true, value: undefined };
    },
  };
  return { api, calls, rows: state.rows };
}

describe('PasskeyManager', () => {
  it('lists the account’s credentials with their metadata', async () => {
    const { api } = fakeApi([
      record({ id: 'a', name: 'MacBook' }),
      record({ id: 'b', name: null, backedUp: false }),
    ]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('passkey-row');
    expect(within(rows[0] as HTMLElement).getByTestId('passkey-name').textContent).toBe('MacBook');
    // An unnamed credential is still identifiable, not blank.
    expect(within(rows[1] as HTMLElement).getByTestId('passkey-name').textContent).toBe(
      'Unnamed passkey',
    );
    expect(within(rows[0] as HTMLElement).getByTestId('passkey-meta').textContent).toContain(
      '2026-07-20',
    );
    expect(within(rows[0] as HTMLElement).getByTestId('passkey-meta').textContent).toContain(
      'synced',
    );
    expect(within(rows[1] as HTMLElement).getByTestId('passkey-meta').textContent).toContain(
      'this device',
    );
  });

  it('renames a credential and re-reads the list', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi([record({ id: 'a', name: 'Old' }), record({ id: 'b' })]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(2));

    const row = screen.getAllByTestId('passkey-row')[0] as HTMLElement;
    await user.click(within(row).getByTestId('passkey-rename'));
    const input = screen.getByTestId('passkey-name-input');
    await user.clear(input);
    await user.type(input, 'Yubikey{Enter}');

    await waitFor(() => expect(calls).toContain('rename:a:Yubikey'));
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId('passkey-row')[0] as HTMLElement).getByTestId('passkey-name')
          .textContent,
      ).toBe('Yubikey'),
    );
  });

  it('abandons a rename on Escape without calling the server', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi([record({ id: 'a', name: 'Old' }), record({ id: 'b' })]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(2));
    const row = screen.getAllByTestId('passkey-row')[0] as HTMLElement;
    await user.click(within(row).getByTestId('passkey-rename'));
    await user.type(screen.getByTestId('passkey-name-input'), 'Draft');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('passkey-name-input')).toBeNull());
    expect(calls.filter((c) => c.startsWith('rename:'))).toHaveLength(0);
  });

  it('removes a credential when the account has more than one', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi([record({ id: 'a' }), record({ id: 'b' })]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(2));
    const row = screen.getAllByTestId('passkey-row')[0] as HTMLElement;
    await user.click(within(row).getByTestId('passkey-remove'));
    await waitFor(() => expect(calls).toContain('remove:a'));
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(1));
  });

  it('REFUSES to remove the last passkey, and says why', async () => {
    const { api, calls } = fakeApi([record({ id: 'only' })]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(1));

    const remove = screen.getByTestId('passkey-remove') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute('title')).toContain('Add another passkey');
    expect(screen.getByTestId('passkeys-last-note').textContent).toContain('no password');

    // Even a raw click cannot get past it: the account would be unrecoverable.
    fireEvent.click(remove);
    expect(calls.filter((c) => c.startsWith('remove:'))).toHaveLength(0);
  });

  it('adds another passkey, after which the first becomes removable', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi([record({ id: 'only' })]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(1));
    expect((screen.getByTestId('passkey-remove') as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByTestId('passkey-add'));
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(2));
    expect(calls.some((c) => c.startsWith('add:Passkey '))).toBe(true);
    for (const b of screen.getAllByTestId('passkey-remove')) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('surfaces a failed operation without dropping the list', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi([record({ id: 'a' }), record({ id: 'b' })], {
      remove: 'That passkey is already gone.',
    });
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(2));
    await user.click(
      within(screen.getAllByTestId('passkey-row')[0] as HTMLElement).getByTestId('passkey-remove'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('passkeys-error').textContent).toContain('already gone'),
    );
    expect(screen.getAllByTestId('passkey-row')).toHaveLength(2);
  });

  it('reports a failed read as an empty account, not as a blank panel', async () => {
    const { api } = fakeApi([record()], { list: 'Could not reach the control plane.' });
    render(<PasskeyManager api={api} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('passkeys-error')).toBeTruthy());
    expect(screen.getByTestId('passkeys-empty')).toBeTruthy();
  });

  it('closes on Escape and on the close button (spec 8.1)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { api } = fakeApi([record()]);
    const { unmount } = render(<PasskeyManager api={api} onClose={onClose} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(1));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    render(<PasskeyManager api={api} onClose={onClose} />);
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(1));
    await user.click(screen.getByTestId('passkeys-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('never mounts a spinner while reading the list (spec 8.3)', async () => {
    const { api } = fakeApi([record()]);
    render(<PasskeyManager api={api} onClose={() => {}} />);
    expect(
      document.querySelector(
        '.spinner,[role="progressbar"],[aria-busy="true"],[data-testid*="spinner"],[data-testid*="loading"],[data-testid*="skeleton"]',
      ),
    ).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('passkey-row')).toHaveLength(1));
  });
});

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthApi, PasskeyRecord } from '../auth/api';
import { defaultPasskeyName } from '../auth/better-auth';
import { toAuthError } from '../auth/webauthn';

/** Human date for a credential's registration, or an em dash. */
function when(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '—';
}

/**
 * Passkey management: list, name, remove, and add another (spec 11.3 accounts).
 *
 * Two product rules are enforced here rather than left to the server:
 *
 *  - **The last passkey cannot be removed.** With no other credential and no
 *    password anywhere in the hosted path, removing it locks the account out
 *    permanently. The button is disabled and says why.
 *  - **A rename is a real edit, not an inline surprise.** Editing arms one row at
 *    a time; Escape abandons it, Enter saves it (spec 8.1 keyboard operation).
 *
 * Rendered as an overlay panel, like the command palette. Escape closes it.
 */
export function PasskeyManager({ api, onClose }: { api: AuthApi; onClose(): void }) {
  const [rows, setRows] = useState<PasskeyRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const panel = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const res = await api.listPasskeys();
    if (res.ok) {
      setRows(res.value);
      setError(null);
      return;
    }
    setRows([]);
    setError(toAuthError(res.error, 'Could not read your passkeys.').message);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Focus the panel on open so Tab lands inside it.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  // Escape is bound at the DOCUMENT, not at the panel. A panel-scoped handler
  // works only while focus is inside, and removing a row destroys the button that
  // had focus — after which Escape would silently do nothing and the only way out
  // would be the mouse (spec 8.1). The manager is mounted only while open, so
  // this listener cannot fire for anything else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (editing !== null) setEditing(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [editing, onClose]);

  const run = async (op: () => Promise<{ ok: boolean; error?: unknown }>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    const res = await op();
    if (!res.ok) {
      setError(toAuthError(res.error as never, fallback).message);
    } else {
      setError(null);
      await load();
    }
    setBusy(false);
  };

  const list = rows ?? [];
  const onlyOne = list.length === 1;

  return (
    <div className="palette-overlay" data-testid="passkeys-overlay" onMouseDown={onClose}>
      <div
        className="passkeys"
        data-testid="passkeys-panel"
        role="dialog"
        aria-label="Passkeys"
        tabIndex={-1}
        ref={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="passkeys-head">
          <span className="passkeys-title">Passkeys</span>
          <span className="spacer" />
          <button
            type="button"
            data-testid="passkey-add"
            disabled={busy}
            onClick={() =>
              void run(() => api.addPasskey(defaultPasskeyName()), 'Could not add a passkey.')
            }
          >
            Add a passkey
          </button>
          <button type="button" data-testid="passkeys-close" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </div>

        {error !== null && (
          <p className="auth-error" role="alert" data-testid="passkeys-error">
            {error}
          </p>
        )}

        <ul className="passkey-list" data-testid="passkey-list" data-count={list.length}>
          {list.map((p) => (
            <li className="passkey-row" data-testid="passkey-row" data-id={p.id} key={p.id}>
              {editing === p.id ? (
                <form
                  className="passkey-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = draft.trim();
                    setEditing(null);
                    if (name === '' || name === (p.name ?? '')) return;
                    void run(() => api.renamePasskey(p.id, name), 'Could not rename that passkey.');
                  }}
                >
                  <input
                    className="auth-input sm"
                    data-testid="passkey-name-input"
                    aria-label="Passkey name"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button type="submit" data-testid="passkey-name-save">
                    Save
                  </button>
                </form>
              ) : (
                <>
                  <span className="passkey-name" data-testid="passkey-name">
                    {p.name ?? 'Unnamed passkey'}
                  </span>
                  <span className="hint" data-testid="passkey-meta">
                    {when(p.createdAt)}
                    {p.backedUp ? ' · synced' : ' · this device'}
                  </span>
                  <button
                    type="button"
                    data-testid="passkey-rename"
                    onClick={() => {
                      setDraft(p.name ?? '');
                      setEditing(p.id);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid="passkey-remove"
                    disabled={busy || onlyOne}
                    title={
                      onlyOne
                        ? 'Add another passkey before removing your last one.'
                        : 'Remove this passkey'
                    }
                    onClick={() =>
                      void run(() => api.removePasskey(p.id), 'Could not remove that passkey.')
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>

        {rows !== null && list.length === 0 && (
          <p className="empty-note" data-testid="passkeys-empty">
            No passkeys on this account.
          </p>
        )}

        {onlyOne && (
          <p className="hint" data-testid="passkeys-last-note">
            This is your only passkey. Add another before removing it — there is no password to fall
            back on.
          </p>
        )}
      </div>
    </div>
  );
}

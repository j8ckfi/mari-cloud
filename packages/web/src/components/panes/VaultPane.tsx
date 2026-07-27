import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deleteSecret, putSecret } from '../../api/client';
import { queryKeys, useSecretNames } from '../../api/queries';

/**
 * The credential vault of one computer (spec 10.1).
 *
 * Names are listed; values are WRITE-ONLY. A value entered here is stored by
 * the control plane and injected into every run on this computer as an
 * environment variable (e.g. `ANTHROPIC_API_KEY` for Claude Code) — it never
 * appears in a response, an event, or a journal, and this pane never shows a
 * value again after save. "Rotate" is the same write with a new value; there
 * is deliberately no read path to rotate FROM.
 *
 * Client-side name validation mirrors the server's rule exactly
 * (`[A-Za-z_][A-Za-z0-9_]*`, no `MARI_` prefix) so a refusal is explained
 * before a request is made — but the server remains the authority.
 */

/** The server's name rule, mirrored for pre-flight explanation. */
export function secretNameError(name: string): string | null {
  if (name === '') return null; // empty is "not yet typed", not an error
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return 'A secret name must be a valid environment variable: letters, digits and _, not starting with a digit.';
  }
  if (name.startsWith('MARI_')) {
    return 'MARI_-prefixed names are reserved for the supervisor and cannot be set.';
  }
  return null;
}

export function VaultPane({ computer }: { computer: string }) {
  const secretsQ = useSecretNames(computer);
  const qc = useQueryClient();
  const names = secretsQ.data?.names ?? [];

  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Name currently being rotated (its write-only value input is open). */
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState('');
  /** Name armed for deletion (two-step, no modal). */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const refresh = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: queryKeys.secrets(computer) });

  const save = async (name: string, value: string): Promise<boolean> => {
    try {
      await putSecret(computer, name, value);
      await refresh();
      setError(null);
      return true;
    } catch (e) {
      setError(
        e instanceof Error && e.message === 'reserved_name'
          ? 'That name is reserved.'
          : `Could not save ${name} — the control plane refused the write.`,
      );
      return false;
    }
  };

  const onAdd = async (): Promise<void> => {
    const name = newName.trim();
    const invalid = secretNameError(name);
    if (name === '' || invalid !== null) {
      setError(invalid ?? 'Enter a name.');
      return;
    }
    if (newValue === '') {
      setError('Enter a value — an empty secret is almost never what you want.');
      return;
    }
    if (await save(name, newValue)) {
      // The value is gone from the interface the moment it is stored.
      setNewName('');
      setNewValue('');
    }
  };

  const onRotate = async (name: string): Promise<void> => {
    if (rotateValue === '') {
      setError('Enter the new value to rotate to.');
      return;
    }
    if (await save(name, rotateValue)) {
      setRotating(null);
      setRotateValue('');
    }
  };

  const onDelete = async (name: string): Promise<void> => {
    try {
      await deleteSecret(computer, name);
      await refresh();
      setError(null);
    } catch {
      setError(`Could not delete ${name}.`);
    } finally {
      setConfirmingDelete(null);
    }
  };

  const newNameProblem = secretNameError(newName.trim());

  return (
    <div className="vault" data-testid="vault-pane" data-computer={computer}>
      <p className="vault-copy">
        Secrets are injected into every run on this computer as environment variables — set{' '}
        <code>ANTHROPIC_API_KEY</code> here and Claude Code finds it in its shell. Values are
        write-only: they are stored, never displayed again, and never appear in events or journals.
      </p>

      <div className="vault-list" data-testid="vault-list">
        {names.length === 0 && (
          <div className="hint" data-testid="vault-empty">
            No secrets yet.
          </div>
        )}
        {names.map((name) => (
          <div className="vault-row" key={name} data-testid="vault-row" data-name={name}>
            <span className="vault-name">{name}</span>
            <span className="vault-masked" aria-hidden="true">
              ••••••••
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            {rotating === name ? (
              <>
                <input
                  className="auth-input sm"
                  type="password"
                  placeholder="new value"
                  autoComplete="off"
                  value={rotateValue}
                  data-testid="vault-rotate-value"
                  onChange={(e) => setRotateValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onRotate(name);
                    if (e.key === 'Escape') {
                      setRotating(null);
                      setRotateValue('');
                    }
                  }}
                />
                <button type="button" data-testid="vault-rotate-save" onClick={() => void onRotate(name)}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRotating(null);
                    setRotateValue('');
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="vault-rotate"
                title="Store a new value under this name (the old one is overwritten)"
                onClick={() => {
                  setRotating(name);
                  setRotateValue('');
                  setConfirmingDelete(null);
                }}
              >
                Rotate
              </button>
            )}
            {confirmingDelete === name ? (
              <button
                type="button"
                className="vault-danger"
                data-testid="vault-delete-confirm"
                onClick={() => void onDelete(name)}
              >
                Really delete
              </button>
            ) : (
              <button
                type="button"
                data-testid="vault-delete"
                title="Remove this secret; future runs will not see it"
                onClick={() => {
                  setConfirmingDelete(name);
                  setRotating(null);
                }}
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="vault-add" data-testid="vault-add">
        <input
          className="auth-input sm"
          placeholder="NAME (e.g. ANTHROPIC_API_KEY)"
          autoComplete="off"
          spellCheck={false}
          value={newName}
          data-testid="vault-new-name"
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          className="auth-input sm"
          type="password"
          placeholder="value (write-only)"
          autoComplete="off"
          value={newValue}
          data-testid="vault-new-value"
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onAdd();
          }}
        />
        <button type="button" data-testid="vault-add-save" onClick={() => void onAdd()}>
          Add secret
        </button>
      </div>

      {/* Pre-flight explanation of the server's name rule, before any request. */}
      {newNameProblem !== null && (
        <p className="auth-error" data-testid="vault-name-problem">
          {newNameProblem}
        </p>
      )}
      {error !== null && (
        <p className="auth-error" role="alert" data-testid="vault-error">
          {error}
        </p>
      )}
    </div>
  );
}

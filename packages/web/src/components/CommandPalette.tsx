import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandRegistry, ScoredCommand } from '../palette/registry';

/** Render a command title with its fuzzy-matched characters highlighted. */
function HighlightedTitle({ title, matched }: { title: string; matched: number[] }) {
  if (matched.length === 0) return <>{title}</>;
  const set = new Set(matched);
  return (
    <>
      {Array.from(title).map((ch, i) =>
        set.has(i) ? (
          <span className="m" key={i}>
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/**
 * The command palette (spec 8.1). A thin keyboard-driven view over the shared
 * command registry: type to fuzzy-filter, ↑/↓ to move, Enter to run, Esc to
 * close. It exposes every registered command, satisfying "full keyboard
 * operation".
 */
export function CommandPalette({
  registry,
  open,
  onClose,
}: {
  registry: CommandRegistry;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results: ScoredCommand[] = useMemo(
    () => (open ? registry.filter(query) : []),
    [open, query, registry],
  );

  // Reset state each time the palette opens and focus the input.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // Focus after paint so the element exists.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the selection in range as results change.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const run = (index: number): void => {
    const item = results[index];
    onClose();
    if (item && item.command.enabled !== false) {
      void item.command.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(selected);
    }
  };

  return (
    <div
      className="palette-overlay"
      data-testid="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette" data-testid="palette">
        <input
          ref={inputRef}
          data-testid="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Command"
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <div className="palette-empty">No matching commands</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.command.id}
                role="option"
                aria-selected={i === selected}
                data-testid="palette-item"
                data-command-id={r.command.id}
                className={`palette-item ${i === selected ? 'selected' : ''}`}
                onMouseMove={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  run(i);
                }}
              >
                <span className="p-title">
                  <HighlightedTitle title={r.command.title} matched={r.matched} />
                </span>
                {r.command.group && <span className="p-group">{r.command.group}</span>}
                {r.command.hint && <kbd>{r.command.hint}</kbd>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

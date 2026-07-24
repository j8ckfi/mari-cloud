import { describe, it, expect } from 'vitest';
import { handleKeydown, type HotkeyHandlers } from '../src/hotkeys';

function handlers(): HotkeyHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onWorkspaceSlot: (i) => calls.push(`slot:${i}`),
    onPaletteToggle: () => calls.push('palette'),
    onFocusMove: (d) => calls.push(`focus:${d}`),
    onSplitRight: () => calls.push('split:right'),
    onSplitDown: () => calls.push('split:down'),
    onClosePane: () => calls.push('close'),
    onFleet: () => calls.push('fleet'),
  };
}

function ev(o: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    ...o,
  } as KeyboardEvent;
}

describe('handleKeydown', () => {
  it('opens the palette on Cmd+K and Ctrl+K', () => {
    const h = handlers();
    expect(handleKeydown(ev({ metaKey: true, key: 'k' }), h)).toBe(true);
    expect(handleKeydown(ev({ ctrlKey: true, key: 'k' }), h)).toBe(true);
    expect(h.calls).toEqual(['palette', 'palette']);
  });

  it('switches workspace on both Super (Meta) and the Alt fallback', () => {
    const h = handlers();
    expect(handleKeydown(ev({ metaKey: true, key: '2' }), h)).toBe(true);
    expect(handleKeydown(ev({ altKey: true, key: '2' }), h)).toBe(true);
    expect(h.calls).toEqual(['slot:1', 'slot:1']); // 0-based index for "2"
  });

  it('maps Mod+0 and Mod+` to the fleet home', () => {
    const h = handlers();
    handleKeydown(ev({ altKey: true, key: '0' }), h);
    handleKeydown(ev({ metaKey: true, key: '`' }), h);
    expect(h.calls).toEqual(['fleet', 'fleet']);
  });

  it('moves focus with hjkl and arrows under Mod', () => {
    const h = handlers();
    handleKeydown(ev({ altKey: true, key: 'h' }), h);
    handleKeydown(ev({ altKey: true, key: 'j' }), h);
    handleKeydown(ev({ altKey: true, key: 'k' }), h);
    handleKeydown(ev({ altKey: true, key: 'l' }), h);
    handleKeydown(ev({ altKey: true, key: 'ArrowRight' }), h);
    expect(h.calls).toEqual([
      'focus:left',
      'focus:down',
      'focus:up',
      'focus:right',
      'focus:right',
    ]);
  });

  it('splits and closes under Mod', () => {
    const h = handlers();
    handleKeydown(ev({ altKey: true, key: 'Enter' }), h);
    handleKeydown(ev({ altKey: true, shiftKey: true, key: 'Enter' }), h);
    handleKeydown(ev({ altKey: true, key: 'w' }), h);
    expect(h.calls).toEqual(['split:right', 'split:down', 'close']);
  });

  it('ignores plain typing (no modifier)', () => {
    const h = handlers();
    expect(handleKeydown(ev({ key: 'a' }), h)).toBe(false);
    expect(handleKeydown(ev({ key: '2' }), h)).toBe(false);
    expect(handleKeydown(ev({ key: 'l' }), h)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('does not treat Ctrl+Alt+K as the palette (ambiguous modifier)', () => {
    const h = handlers();
    expect(handleKeydown(ev({ ctrlKey: true, altKey: true, key: 'k' }), h)).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

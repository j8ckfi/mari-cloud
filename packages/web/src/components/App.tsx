import { useEffect, useMemo } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '../api/queries';
import { registry, registerCoreCommands } from '../commands';
import { installHotkeys } from '../hotkeys';
import { useUiStore } from '../store/ui';
import { Shell } from './Shell';

/**
 * App root: wires TanStack Query, the global keyboard layer, and the command
 * registry to the UI store, then renders the shell. Everything reachable by
 * pointer is also reachable by keyboard (spec 8.1).
 */
export function App() {
  const queryClient = useMemo(makeQueryClient, []);

  useEffect(() => {
    const offCommands = registerCoreCommands();
    const s = () => useUiStore.getState();
    const offHotkeys = installHotkeys({
      onWorkspaceSlot: (i) => s().switchToSlot(i),
      onPaletteToggle: () => s().togglePalette(),
      onFocusMove: (dir) => s().moveFocus(dir),
      onSplitRight: () => s().splitFocused('row', { kind: 'files', path: '/' }),
      onSplitDown: () => s().splitFocused('column', { kind: 'files', path: '/' }),
      onClosePane: () => s().closeFocused(),
      onFleet: () => s().goFleet(),
    });
    return () => {
      offHotkeys();
      offCommands();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Shell registry={registry} />
    </QueryClientProvider>
  );
}

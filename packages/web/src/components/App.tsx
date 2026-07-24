import { useEffect, useMemo } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient, queryKeys } from '../api/queries';
import { registry, registerCoreCommands } from '../commands';
import { installHotkeys } from '../hotkeys';
import { useUiStore } from '../store/ui';
import { connectEvents } from '../store/events';
import { Shell } from './Shell';

/**
 * App root: wires TanStack Query, the global keyboard layer, the command
 * registry, and the live event stream to the UI store, then renders the shell.
 * Everything reachable by pointer is also reachable by keyboard (spec 8.1).
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
      onRunCommand: () => s().setRunLauncherOpen(true),
    });

    // Live server events (spec 6.2). The stream is content-free; folding it in
    // updates badges immediately, and the invalidations below let the durable
    // control-plane views catch up without the interface ever waiting on them.
    const offEvents = connectEvents({
      onEvent: (event) => {
        if (event.type === 'run' || event.type === 'attention') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.runs(event.computer) });
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
      },
    });

    return () => {
      offEvents();
      offHotkeys();
      offCommands();
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Shell registry={registry} />
    </QueryClientProvider>
  );
}

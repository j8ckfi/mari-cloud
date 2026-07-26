import { useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { makeQueryClient, queryKeys } from '../api/queries';
import { registry, registerCoreCommands } from '../commands';
import { installHotkeys } from '../hotkeys';
import { openShellTerminal } from '../runs/shell';
import { useUiStore } from '../store/ui';
import { connectEvents, useEventsStore } from '../store/events';
import { betterAuthApi } from '../auth/better-auth';
import type { AuthApi } from '../auth/api';
import type { Account } from '../auth/machine';
import { AuthGate } from './AuthGate';
import { PasskeyManager } from './PasskeyManager';
import { Shell } from './Shell';

/**
 * App root: the auth gate wraps everything, and the authenticated subtree owns
 * the keyboard layer, the command registry and the live event stream.
 *
 * The split is not cosmetic. Every `/api/*` route is behind the session guard, so
 * a signed-out visitor must make no fleet request and open no event stream —
 * otherwise the sign-in screen sits behind a stream of 401s and a reconnect
 * backoff. Nothing server-facing exists until there is a session.
 */
export function App({ api = betterAuthApi }: { api?: AuthApi } = {}) {
  const queryClient = useMemo(makeQueryClient, []);

  // A session ending must take its data with it: the next account (or the next
  // sign-in of the same one) must not paint the previous fleet from cache.
  const onSessionEnd = useCallback(() => {
    queryClient.clear();
    useEventsStore.getState().reset();
    useUiStore.getState().goFleet();
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate api={api} options={{ onSessionEnd }}>
        {({ account, signOut }) => (
          <AuthedApp
            api={api}
            account={account}
            onSignOut={signOut}
            queryClient={queryClient}
          />
        )}
      </AuthGate>
    </QueryClientProvider>
  );
}

/**
 * The application proper. Wires TanStack Query invalidation to the live event
 * stream, the global keyboard layer, and the command registry, then renders the
 * shell. Everything reachable by pointer is also reachable by keyboard (8.1).
 */
function AuthedApp({
  api,
  account,
  onSignOut,
  queryClient,
}: {
  api: AuthApi;
  account: Account;
  onSignOut(): void;
  queryClient: QueryClient;
}) {
  const [passkeysOpen, setPasskeysOpen] = useState(false);

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
      onNewTerminal: () => void openShellTerminal(),
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

  // The account actions are commands too, so the palette exposes EVERY command
  // and both are reachable with the keyboard alone (spec 8.1).
  useEffect(() => {
    return registry.registerAll([
      {
        id: 'account.passkeys',
        title: 'Manage passkeys',
        group: 'Account',
        keywords: ['passkey', 'security', 'credential', account.email],
        run: () => setPasskeysOpen(true),
      },
      {
        id: 'account.signout',
        title: 'Sign out',
        group: 'Account',
        keywords: ['logout', 'session', account.email],
        run: onSignOut,
      },
    ]);
  }, [account.email, onSignOut]);

  return (
    <>
      <Shell
        registry={registry}
        account={account}
        onSignOut={onSignOut}
        onPasskeys={() => setPasskeysOpen(true)}
      />
      {passkeysOpen && <PasskeyManager api={api} onClose={() => setPasskeysOpen(false)} />}
    </>
  );
}

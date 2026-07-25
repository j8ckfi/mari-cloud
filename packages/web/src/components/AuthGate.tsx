import type { ReactNode } from 'react';
import type { AuthApi } from '../auth/api';
import { useAuthGate, type UseAuthGateOptions } from '../auth/gate';
import type { Account } from '../auth/machine';
import { SignInScreen } from './SignInScreen';

export interface AuthGateRender {
  account: Account;
  signOut(): void;
}

/**
 * The gate: an unauthenticated visitor gets the sign-in screen, an authenticated
 * one gets the fleet.
 *
 * The `bootstrap` branch is the interesting one. Resolving the session takes a
 * round trip, and there are exactly two wrong things to do during it: mount a
 * spinner (spec 8.3 forbids one in front of the interface) or guess — render the
 * fleet or the sign-in screen and swap it a moment later. So the gate renders the
 * app's CHROME immediately, with the content region empty, and commits to a view
 * only once the answer is in. Nothing spins and nothing flashes.
 */
export function AuthGate({
  api,
  options,
  children,
}: {
  api: AuthApi;
  options?: UseAuthGateOptions;
  children(render: AuthGateRender): ReactNode;
}) {
  const gate = useAuthGate(api, options ?? {});

  if (gate.view === 'app' && gate.state.account !== null) {
    return <>{children({ account: gate.state.account, signOut: () => void gate.signOut() })}</>;
  }

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">MARI</span>
        <span className="spacer" />
      </div>
      <div className="main">
        {gate.view === 'sign-in' ? (
          <SignInScreen
            state={gate.state}
            onCreate={(email) => void gate.createAccount(email)}
            onSignIn={() => void gate.signIn()}
          />
        ) : (
          // Deliberately empty: see the note above. The chrome above is already
          // on screen, which is what "render the shell immediately" means.
          <div className="auth-bootstrap" data-testid="auth-bootstrap" />
        )}
      </div>
    </div>
  );
}

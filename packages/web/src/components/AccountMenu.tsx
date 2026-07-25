import type { Account } from '../auth/machine';

/**
 * The signed-in account in the top bar: who you are, your passkeys, and the way
 * out. Three tab stops, no hover-only menu — spec 8.1 requires every action to
 * be reachable by keyboard, and a pointer-revealed dropdown is not.
 */
export function AccountMenu({
  account,
  onPasskeys,
  onSignOut,
}: {
  account: Account;
  onPasskeys(): void;
  onSignOut(): void;
}) {
  return (
    <div className="account" data-testid="account">
      <span className="account-email" data-testid="account-email" title={account.email}>
        {account.email}
      </span>
      <button type="button" data-testid="open-passkeys" onClick={onPasskeys}>
        Passkeys
      </button>
      <button type="button" data-testid="sign-out" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

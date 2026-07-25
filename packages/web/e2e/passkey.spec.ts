import { test, expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { installSpinnerWatchdog, spinnerSeen } from './helpers';

// REAL passkey ceremonies against the REAL control plane.
//
// Chrome's DevTools Protocol can attach a *virtual authenticator*: from the
// page's point of view `navigator.credentials.create/get` behave exactly as with
// a hardware or platform authenticator — the same CBOR attestation, the same
// signature counter, the same `NotAllowedError` on a ceremony that produces
// nothing. So everything below is a genuine WebAuthn ceremony verified by
// @simplewebauthn/server inside the Worker: nothing here is stubbed, and the
// account this suite creates is created by a credential and by nothing else (no
// password is ever set, sent or stored).
//
// The whole file is one session in one context, in order, because that is what
// the product is: create an account, manage its credentials, leave, come back.

test.describe.configure({ mode: 'serial' });

/** A platform authenticator that stores discoverable (resident) credentials. */
const PLATFORM_AUTHENTICATOR = {
  protocol: 'ctap2' as const,
  ctap2Version: 'ctap2_1' as const,
  transport: 'internal' as const,
  // Discoverable credentials are what make "Sign in with a passkey" possible
  // with no username typed at all.
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

/** A second, removable authenticator — a security key. */
const ROAMING_AUTHENTICATOR = { ...PLATFORM_AUTHENTICATOR, transport: 'usb' as const };

test.describe('passkeys — real WebAuthn ceremonies (CDP virtual authenticator)', () => {
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;
  let platformId: string;
  let roamingId: string | null = null;

  // A fresh identity per run: the control plane's D1 persists across
  // `wrangler dev` sessions, and a passkey-first sign-up refuses an email that
  // already has an account (which is itself asserted below).
  const email = `passkey-${Date.now().toString(36)}@mari.test`;

  async function addAuthenticator(options: typeof PLATFORM_AUTHENTICATOR): Promise<string> {
    const res = await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
    return res.authenticatorId;
  }

  async function credentialCount(authenticatorId: string): Promise<number> {
    const res = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    return res.credentials.length;
  }

  test.beforeAll(async ({ browser, baseURL }) => {
    // A brand-new visitor: no storageState, so no session cookie exists.
    context = await browser.newContext({ storageState: undefined, baseURL });
    page = await context.newPage();
    await installSpinnerWatchdog(page);
    cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    platformId = await addAuthenticator(PLATFORM_AUTHENTICATOR);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('an unauthenticated visitor gets the sign-in screen, not the fleet', async () => {
    await page.goto('/');
    await expect(page.getByTestId('sign-in-screen')).toBeVisible();
    await expect(page.getByTestId('auth-create')).toBeVisible();
    await expect(page.getByTestId('auth-signin')).toBeVisible();
    // The gate committed to a view; it did not flash the fleet on the way.
    await expect(page.getByTestId('fleet-tab')).toHaveCount(0);
    await expect(page.getByTestId('computer-card')).toHaveCount(0);
    // Spec 8.3: resolving the session is not a spinner.
    expect(await spinnerSeen(page), 'no spinner while bootstrapping the session').toBe(false);
    // Nothing is registered yet.
    expect(await credentialCount(platformId)).toBe(0);
  });

  test('“Create account with a passkey” runs a real ceremony and lands on the fleet', async () => {
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-create').click();

    // Registration ceremony → account created → authentication ceremony →
    // session → the fleet (spec 8.2). No password was involved at any point.
    await expect(page.getByTestId('fleet-tab')).toBeVisible();
    await expect(page.getByTestId('account-email')).toHaveText(email);
    await expect(page.getByTestId('sign-in-screen')).toHaveCount(0);
    // The fleet rendered from control-plane data.
    await expect(page.getByTestId('fleet')).toBeVisible();

    // The authenticator really holds a discoverable credential now: this is the
    // proof the ceremony was real and not short-circuited.
    const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId: platformId });
    expect(creds.credentials).toHaveLength(1);
    const credential = creds.credentials[0];
    expect(credential?.isResidentCredential, 'discoverable credential').toBe(true);
    expect(credential?.rpId, 'bound to the app’s Relying Party').toBe('localhost');
    // A private key exists on the authenticator; the server only ever saw the
    // public half.
    expect((credential?.privateKey ?? '').length).toBeGreaterThan(0);

    expect(await spinnerSeen(page), 'no spinner during the ceremony').toBe(false);
  });

  test('the session survives a reload (the cookie is a real session, not page state)', async () => {
    await page.reload();
    await expect(page.getByTestId('account-email')).toHaveText(email);
    await expect(page.getByTestId('fleet-tab')).toBeVisible();
  });

  test('passkey management lists the credential and renames it', async () => {
    // Reached BY KEYBOARD, through the command palette (spec 8.1: the palette
    // gives all commands, and full keyboard operation must be possible).
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.getByTestId('palette-input').fill('sign out');
    await expect(
      page.locator('[data-testid="palette-item"][data-command-id="account.signout"]'),
    ).toBeVisible();
    await page.getByTestId('palette-input').fill('manage passkeys');
    await expect(
      page.locator('[data-testid="palette-item"][data-command-id="account.passkeys"]'),
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('passkeys-panel')).toBeVisible();
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);

    // The only credential cannot be removed — there is no password to fall back
    // on, so removing it would end the account.
    await expect(page.getByTestId('passkey-remove')).toBeDisabled();
    await expect(page.getByTestId('passkeys-last-note')).toBeVisible();

    await page.getByTestId('passkey-rename').click();
    const input = page.getByTestId('passkey-name-input');
    await input.fill('Original');
    await input.press('Enter');
    await expect(page.getByTestId('passkey-name')).toHaveText('Original');

    // The rename is server state, not panel state.
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByTestId('open-passkeys').click();
    await expect(page.getByTestId('passkey-name')).toHaveText('Original');
  });

  test('adding a second passkey is another real ceremony, and then the first is removable', async () => {
    // The platform authenticator already holds a credential for this account, and
    // the server sends it in `excludeCredentials` — so a second registration must
    // come from a different authenticator, exactly as on a real second device.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: platformId });
    roamingId = await addAuthenticator(ROAMING_AUTHENTICATOR);

    await page.getByTestId('passkey-add').click();
    await expect(page.getByTestId('passkey-row')).toHaveCount(2);
    // A real credential landed on the new authenticator.
    expect(await credentialCount(roamingId)).toBe(1);
    // With two credentials, removal is allowed again.
    await expect(page.getByTestId('passkeys-last-note')).toHaveCount(0);

    // Remove the one whose authenticator is gone (a lost device).
    const original = page.locator('[data-testid="passkey-row"]', { hasText: 'Original' });
    await original.getByTestId('passkey-remove').click();
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);
    await expect(page.getByTestId('passkey-name')).not.toHaveText('Original');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('passkeys-panel')).toHaveCount(0);
  });

  test('sign out, then “Sign in with a passkey” signs back in with the surviving credential', async () => {
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('sign-in-screen')).toBeVisible();
    await expect(page.getByTestId('fleet-tab')).toHaveCount(0);
    // A deliberate sign-out is not an error.
    await expect(page.getByTestId('auth-error')).toHaveCount(0);

    // No email typed: a discoverable credential identifies the account by itself.
    await page.getByTestId('auth-signin').click();
    await expect(page.getByTestId('fleet-tab')).toBeVisible();
    await expect(page.getByTestId('account-email')).toHaveText(email);
    expect(await spinnerSeen(page), 'no spinner across sign-out and sign-in').toBe(false);
  });

  test('a ceremony that produces nothing shows the cancellation state and stays put', async () => {
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('sign-in-screen')).toBeVisible();

    // Take the account's authenticator away and offer an empty one instead: the
    // browser finds no usable credential and reports the same `NotAllowedError`
    // it reports for a dismissed prompt — the two are indistinguishable by
    // design, so this is the cancelled-ceremony path.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: roamingId as string,
    });
    const empty = await addAuthenticator(PLATFORM_AUTHENTICATOR);
    expect(await credentialCount(empty)).toBe(0);

    // Watch for the challenge request, so this asserts a ceremony that RAN and
    // produced nothing — not a click that never reached WebAuthn at all.
    const challenged: string[] = [];
    const onRequest = (req: { url(): string }): void => {
      if (req.url().includes('/passkey/generate-authenticate-options')) challenged.push(req.url());
    };
    page.on('request', onRequest);

    await page.getByTestId('auth-signin').click();

    const error = page.getByTestId('auth-error');
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toHaveAttribute('data-code', 'cancelled');
    // Still signed out, still on the sign-in screen, and able to try again.
    await expect(page.getByTestId('sign-in-screen')).toBeVisible();
    await expect(page.getByTestId('fleet-tab')).toHaveCount(0);
    await expect(page.getByTestId('auth-signin')).toBeEnabled();
    await expect(page.getByTestId('auth-create')).toBeEnabled();
    expect(await spinnerSeen(page), 'no spinner in the whole passkey session').toBe(false);

    page.off('request', onRequest);
    expect(challenged.length, 'the browser was really asked for a credential').toBeGreaterThan(0);
  });

  test('creating a second account for the same email is refused, in the server’s words', async () => {
    // Still signed out from the test above. The account created at the top of this
    // file now exists, so the server refuses the ceremony BEFORE it starts and the
    // screen shows that refusal rather than a generic failure.
    await expect(page.getByTestId('sign-in-screen')).toBeVisible();
    await page.getByTestId('auth-email').fill(email);
    await page.getByTestId('auth-create').click();

    const error = page.getByTestId('auth-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('data-code', 'rejected');
    await expect(error).toContainText('already exists');
    await expect(page.getByTestId('fleet-tab')).toHaveCount(0);
  });

  test('an unusable email is refused before any ceremony', async () => {
    // `probe@localdomain` satisfies the browser's own `type="email"` check (HTML
    // permits a dotless domain) but not the server's, so this exercises the
    // server's validation rather than the input element's.
    await page.getByTestId('auth-email').fill('probe@localdomain');
    await page.getByTestId('auth-create').click();
    const error = page.getByTestId('auth-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('valid email');
    await expect(page.getByTestId('sign-in-screen')).toBeVisible();
    await expect(page.getByTestId('fleet-tab')).toHaveCount(0);
  });
});

import { test, expect } from '@playwright/test';
import { coldCard } from './helpers';
// @ts-expect-error — plain .mjs helper, transpiled in-process by Playwright.
import { startFakeSupervisor } from './fake-supervisor.mjs';

// Spec 7: the terminal pane is a view of a run. Against the fake supervisor
// (which echoes input as PTY output), a typed line round-trips through the whole
// stack — attach -> DO -> supervisor -> journal frame -> xterm — and appears in
// the pane. The `--disable-gpu` launch flag forces xterm's DOM renderer so the
// echoed text is assertable in the DOM.
test.describe('terminal round-trip', () => {
  let supervisor: { close: () => void } | null = null;

  test.afterEach(() => {
    supervisor?.close();
    supervisor = null;
  });

  test('typed input echoes back through the fake supervisor', async ({ page }) => {
    await page.goto('/');

    // Identify the COLD computer and stand up a fake supervisor for it.
    const card = coldCard(page);
    await expect(card).toBeVisible();
    const computer = await card.getAttribute('data-computer-id');
    expect(computer).toBeTruthy();
    supervisor = await startFakeSupervisor({
      url: process.env.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787',
      computer: computer as string,
    });

    // Open the workspace and add a terminal pane.
    await card.click();
    await page.getByRole('button', { name: '+ Terminal' }).click();
    const term = page.locator('[data-testid="pane"][data-kind="terminal"]');
    await expect(term).toBeVisible();

    // Focus the terminal and type a line.
    await term.getByTestId('terminal-pane').click();
    await page.keyboard.type('echo mari');

    // The fake supervisor echoes each keystroke; the echoed text renders in the
    // pane (DOM renderer). The local-echo predictor may show it sooner, but the
    // assertion is on the authoritative echo.
    await expect(term).toContainText('echo mari', { timeout: 15_000 });
  });
});

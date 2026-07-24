import { test, expect } from '@playwright/test';
import { coldCard, resetLayouts, seedRecord } from './helpers';
// @ts-expect-error — plain .mjs helper, transpiled in-process by Playwright.
import { startFakeSupervisor } from './fake-supervisor.mjs';

// Spec 7: the terminal pane is a view of a run. Against the fake supervisor
// (which echoes input as PTY output), a typed line round-trips through the whole
// stack — attach -> DO -> supervisor -> journal frame -> DO -> xterm — and lands
// in the AUTHORITATIVE xterm buffer.
//
// Two things make this a real round-trip test rather than a local-echo mirage:
//
//  1. The assertion is scoped to `.term-host` (the xterm mount), NOT the whole
//     pane. TerminalPane renders the local-echo *prediction* in a sibling
//     overlay (`.term-predict`); asserting on the whole pane would pass on that
//     client-side prediction alone, proving nothing about the server. Only
//     `term.write(bytes)` from a real journal frame fills the xterm buffer.
//  2. xterm's authoritative text is only in the DOM when it uses its DOM
//     renderer. `--disable-gpu` does NOT force that in headless Chromium
//     (software WebGL is still present, and xterm would render to a canvas whose
//     text no DOM assertion can read). So we neutralize WebGL below, which makes
//     TerminalPane's WebglAddon activation fail and fall back to the DOM
//     renderer — exactly the fallback path spec 7.4 requires — so the echoed
//     text becomes assertable.
test.describe('terminal round-trip', () => {
  let supervisor: { close: () => void } | null = null;

  test.beforeEach(async ({ page }) => {
    // Force xterm's DOM-renderer fallback by making WebGL context creation fail;
    // the authoritative buffer is only DOM-readable under the DOM renderer.
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (orig as any).call(this, type, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
  });

  test.afterEach(() => {
    supervisor?.close();
    supervisor = null;
  });

  test('typed input echoes back through the fake supervisor', async ({ page, request }) => {
    // Start from a workspace with no panes saved by an earlier spec (8.6).
    await resetLayouts(request);
    await page.goto('/');

    // Identify the COLD computer and stand up a fake supervisor for it.
    const card = coldCard(page);
    await expect(card).toBeVisible();
    const computer = await card.getAttribute('data-computer-id');
    expect(computer).toBeTruthy();
    supervisor = await startFakeSupervisor({
      url: process.env.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787',
      computer: computer as string,
      preRunManifest: seedRecord().manifest,
    });

    // Open the workspace and add a terminal pane.
    await card.click();
    await page.getByRole('button', { name: '+ Terminal' }).click();
    const term = page.locator('[data-testid="pane"][data-kind="terminal"]');
    await expect(term).toBeVisible();
    // Confirm we are on the DOM renderer, so the authoritative buffer is in the
    // DOM (see the file header); otherwise the assertions below would be vacuous.
    await expect(term.getByTestId('terminal-pane')).toHaveAttribute('data-renderer', 'dom');

    // Focus the terminal and type a line.
    await term.getByTestId('terminal-pane').click();
    await page.keyboard.type('echo mari');

    // The typed line must appear in the AUTHORITATIVE xterm buffer (`.term-host`),
    // which only fills from `term.write(bytes)` of real journal frames. The
    // prediction overlay is a sibling of `.term-host`, so this excludes it: the
    // text can only be here if input actually flowed client -> DO -> supervisor
    // -> journal frame -> DO -> xterm.
    const authBuffer = term.locator('.term-host');
    await expect(authBuffer).toContainText('echo mari', { timeout: 15_000 });

    // And the prediction overlay must have CLEARED. It renders only while
    // predictions are pending (`predict.pending > 0`) and its predictions are
    // only ever consumed by `predictor.reconcile()`, which TerminalPane calls
    // solely on a real server frame. A broken round-trip would leave the overlay
    // up forever — so this is an independent, renderer-agnostic proof that the
    // authoritative echo reconciled the local prediction.
    await expect(term.getByTestId('term-predict')).toBeHidden({ timeout: 15_000 });
  });
});

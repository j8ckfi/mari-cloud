import { test, expect } from '@playwright/test';
import {
  CONTROL_PLANE,
  coldCard,
  installSpinnerWatchdog,
  resetLayouts,
  seedRecord,
  spinnerSeen,
} from './helpers';
// @ts-expect-error — plain .mjs helper, transpiled in-process by Playwright.
import { startFakeSupervisor } from './fake-supervisor.mjs';

// Spec 6.2 end to end: the SUPERVISOR emits a content-free attention event, the
// control plane pushes it to the browser over `/api/events`, the fleet card and
// the workspace tab badge, and activating the badge OPENS THE TERMINAL PANE OF
// THAT RUN.
//
// Nothing here is simulated in the browser: the event enters the system as a
// real framed-CBOR `attention` message on the supervisor socket (contracts
// §5.1), so a control plane that drops attention on the floor, or a client that
// never subscribes, fails this test.
interface FakeSupervisor {
  close(): void;
  waitForRun(ms?: number): Promise<string>;
  attention(run: string, kind?: string): void;
}

test.describe('attention (spec 6.2)', () => {
  let supervisor: FakeSupervisor | null = null;

  test.afterEach(() => {
    supervisor?.close();
    supervisor = null;
  });

  test('a waiting run badges the fleet and opens its terminal pane', async ({ page, request }) => {
    await resetLayouts(request);
    await installSpinnerWatchdog(page);
    await page.goto('/');

    const card = coldCard(page);
    await expect(card).toBeVisible();
    const computer = await card.getAttribute('data-computer-id');
    expect(computer).toBeTruthy();

    const sup: FakeSupervisor = await startFakeSupervisor({
      url: CONTROL_PLANE,
      computer: computer as string,
      preRunManifest: seedRecord().manifest,
    });
    supervisor = sup;

    // Start a run so there is something that can wait for the user.
    await card.click();
    await page.getByTestId('workspace-run-command').click();
    await page.getByTestId('run-launcher-input').fill('read-a-prompt');
    await page.keyboard.press('Enter');
    const runId = await sup.waitForRun(15_000);

    // The run blocks on a read: the supervisor emits the content-free event.
    sup.attention(runId, 'blocked_read');

    // The workspace tab badges…
    const tab = page.locator(`[data-testid="workspace-tab"][data-computer-id="${computer}"]`);
    await expect(tab.getByTestId('workspace-attention-badge')).toBeVisible({ timeout: 20_000 });

    // …and so does the fleet card.
    await page.keyboard.press('Alt+0');
    await expect(page.getByTestId('fleet')).toBeVisible();
    const badge = card.getByTestId('attention-badge');
    await expect(badge).toBeVisible({ timeout: 20_000 });

    // EXACTLY the one event this test raised. The dev seed clears each seeded
    // computer's attention log (`resetSeedState`), so this number cannot be
    // inherited from an earlier suite run against the same persisted
    // `wrangler dev` state — without that, a badge left over from a previous
    // run would satisfy "a badge is visible" and this test would prove nothing.
    await expect(badge).toHaveText('1 waiting');

    // Content-free (spec 6.2/6.3): the badge is a count, never a message.
    expect(await badge.textContent()).toMatch(/^\d+ waiting$/);

    // Activating it opens the terminal pane OF THAT RUN, focused.
    await badge.click();
    const term = page.locator(`[data-testid="terminal-pane"][data-run="${runId}"]`);
    await expect(term).toBeVisible({ timeout: 15_000 });
    const pane = page.locator(`[data-testid="pane"][data-kind="terminal"]`).filter({ has: term });
    await expect(pane).toHaveAttribute('data-focused', 'true');

    // Spec 8.3 holds throughout: nothing spun.
    expect(await spinnerSeen(page), 'no spinner element mounted').toBe(false);
  });
});

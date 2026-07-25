import { test, expect } from '@playwright/test';
import { coldCard, installSpinnerWatchdog, resetFleet, spinnerSeen } from './helpers';

// Spec 8.4: "A write to such a computer starts a wake." Spec 8.3: "A spinner in
// front of the interface is not permitted."
//
// The editor Save on a COLD computer must therefore do both things at once:
// issue the PUT that wakes the computer, and show the resulting state
// transition WITHOUT ever mounting a spinner or blocking the editor. This test
// asserts the request really went out (not an optimistic UI), that the state
// appears, and that the spinner watchdog — armed before any app script runs —
// never fired.
test.describe('editor save wakes without blocking', () => {
  test('Save issues PUT /file and shows the state transition, no spinner', async ({ page, request }) => {
    await resetFleet(request);
    await installSpinnerWatchdog(page);

    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/file')) writes.push(r.url());
    });

    await page.goto('/');
    const card = coldCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('computer-state')).toHaveText('cold');
    await card.click();

    // Open a seeded text file from the files pane; it opens in the editor.
    const files = page.getByTestId('files-pane');
    await expect(files).toBeVisible();
    const readme = page.locator('[data-testid="file-entry"][data-kind="file"]').first();
    await expect(readme).toBeVisible();
    await readme.click();

    const editor = page.getByTestId('editor-pane');
    await expect(editor).toBeVisible();

    // Type into the document, then save.
    await page.locator('.cm-content').first().click();
    await page.keyboard.type('\nedited by the e2e suite\n');
    await editor.getByTestId('editor-save').click();

    // The write really left the browser (spec 8.4 wake trigger)…
    await expect.poll(() => writes.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(writes[0]).toContain('path=');

    // …and the resulting computer state is shown as text, not waited on.
    const state = editor.getByTestId('editor-state');
    await expect(state).toBeVisible({ timeout: 15_000 });
    await expect(state).toHaveText(/awake|waking|warm|cold/);
    await expect(editor.getByTestId('editor-status')).toContainText('Saved');

    // The editor stayed usable the whole time: still focusable, still typable.
    await page.locator('.cm-content').first().click();
    await page.keyboard.type('still typing');
    await expect(page.locator('.cm-content').first()).toContainText('still typing');

    // Spec 8.3: no spinner ever mounted, not even during the wake.
    expect(await spinnerSeen(page), 'no spinner element mounted during the wake').toBe(false);
  });
});

import { test, expect } from '@playwright/test';
import { installNoWakeSpy, installSpinnerWatchdog, spinnerSeen, coldCard } from './helpers';

// Spec 8.4: the file browser reads a COLD computer from its manifest head; no
// wake, no spinner. Opening the workspace shows a Files pane rooted at "/".
test.describe('file browser (COLD)', () => {
  test('lists seeded paths of a COLD computer without waking it', async ({ page }) => {
    const wake = installNoWakeSpy(page);
    await installSpinnerWatchdog(page);

    await page.goto('/');
    await coldCard(page).click();

    // The default workspace layout is a Files pane; it lists the manifest head.
    const files = page.getByTestId('files-pane');
    await expect(files).toBeVisible();
    await expect(files.getByTestId('files-path')).toHaveText('/');

    // At least one seeded entry is listed (the seed populates a real manifest).
    const entries = page.getByTestId('file-entry');
    await expect(entries.first()).toBeVisible();
    expect(await entries.count()).toBeGreaterThan(0);

    // Browsing a directory (if a dir is present) still issues only reads.
    const firstDir = page.locator('[data-testid="file-entry"][data-kind="dir"]').first();
    if (await firstDir.count()) {
      await firstDir.click();
      await expect(page.getByTestId('file-entry').first()).toBeVisible();
    }

    expect(wake.wakeCalls(), 'no wake/mutation while browsing COLD files').toEqual([]);
    expect(await spinnerSeen(page), 'no spinner element mounted').toBe(false);
  });
});

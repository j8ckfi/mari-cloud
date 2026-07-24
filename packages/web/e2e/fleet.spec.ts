import { test, expect } from '@playwright/test';
import { installNoWakeSpy, installSpinnerWatchdog, spinnerSeen, coldCard } from './helpers';

// Spec 8.2 / 8.3: the fleet home renders a COLD computer's data — state, active
// runs, attention, changed files, cost — entirely from control-plane data, with
// NO wake request fired and NO spinner element ever mounted.
test.describe('fleet home (COLD, no wake, no spinner)', () => {
  test('renders a COLD computer with its state and stats, cold', async ({ page }) => {
    const wake = installNoWakeSpy(page);
    await installSpinnerWatchdog(page);

    await page.goto('/');

    // The fleet resolves and shows at least one COLD computer.
    const card = coldCard(page);
    await expect(card).toBeVisible();

    // Every summary field is present and rendered from data alone.
    await expect(card.getByTestId('computer-state')).toHaveText('cold');
    await expect(card.getByTestId('active-runs')).toBeVisible();
    await expect(card.getByTestId('changed-files')).toBeVisible();
    await expect(card.getByTestId('cost-meter')).toBeVisible();

    // Spec 8.3: no wake was triggered rendering a cold computer…
    expect(wake.wakeCalls(), 'no wake/mutation request while rendering COLD fleet').toEqual([]);
    // …and no spinner/skeleton ever mounted.
    expect(await spinnerSeen(page), 'no spinner element mounted').toBe(false);
  });
});

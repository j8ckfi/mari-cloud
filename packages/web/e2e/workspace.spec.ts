import { test, expect } from '@playwright/test';

// Spec 8.1: Super+1..9 change the workspace (Alt is the documented fallback
// modifier where the OS swallows Super). The DEV_SEED provides at least two
// computers so slot 2 exists.
test.describe('workspace switching', () => {
  test('Alt+2 switches to the second workspace', async ({ page }) => {
    await page.goto('/');

    // Workspaces populate from the fleet, one tab per computer.
    const tabs = page.getByTestId('workspace-tab');
    await expect(tabs.first()).toBeVisible();
    const count = await tabs.count();
    expect(count, 'seed should provide >= 2 computers for slot switching').toBeGreaterThanOrEqual(2);

    const secondId = await tabs.nth(1).getAttribute('data-computer-id');
    expect(secondId).toBeTruthy();

    // Super/Alt + 2 activates the second workspace.
    await page.keyboard.press('Alt+2');

    const active = page.locator('[data-testid="workspace-tab"].active');
    await expect(active).toHaveAttribute('data-computer-id', secondId as string);
    await expect(page.getByTestId('workspace')).toHaveAttribute('data-computer', secondId as string);

    // Alt+1 switches back to the first.
    const firstId = await tabs.nth(0).getAttribute('data-computer-id');
    await page.keyboard.press('Alt+1');
    await expect(page.getByTestId('workspace')).toHaveAttribute('data-computer', firstId as string);

    // Alt+0 returns to the fleet home.
    await page.keyboard.press('Alt+0');
    await expect(page.getByTestId('fleet')).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';
import { coldCard, resetFleet } from './helpers';

// Spec 8.1: the command palette (Cmd+K) exposes every command and executes them
// by keyboard. Here: open a workspace, open the palette, run "New terminal
// pane", and assert a terminal pane appears.
test.describe('command palette', () => {
  test('opens on Cmd+K and executes a command by keyboard', async ({ page, request }) => {
    await resetFleet(request);
    await page.goto('/');
    await coldCard(page).click();
    await expect(page.getByTestId('workspace')).toBeVisible();

    // Open with the keyboard (Meta+K; the app also accepts Ctrl+K).
    await page.keyboard.press('Meta+k');
    const palette = page.getByTestId('palette');
    await expect(palette).toBeVisible();
    await expect(page.getByTestId('palette-input')).toBeFocused();

    // Fuzzy-filter to the "New terminal pane" command and run it.
    await page.getByTestId('palette-input').fill('new terminal');
    const item = page.locator('[data-testid="palette-item"][data-command-id="pane.new.terminal"]');
    await expect(item).toBeVisible();
    await page.keyboard.press('Enter');

    // The palette closed and a terminal pane now exists.
    await expect(palette).toBeHidden();
    await expect(page.locator('[data-testid="pane"][data-kind="terminal"]')).toBeVisible();
  });

  test('closes on Escape', async ({ page, request }) => {
    // A COLD computer is this test's precondition, not something it may inherit:
    // an earlier spec's editor save or run legitimately wakes one (see
    // `resetFleet`).
    await resetFleet(request);
    await page.goto('/');
    await coldCard(page).click();
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toBeHidden();
  });
});

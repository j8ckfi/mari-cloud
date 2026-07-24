import { test, expect } from '@playwright/test';
import { CONTROL_PLANE, coldCard, resetLayouts, seedRecord } from './helpers';
// @ts-expect-error — plain .mjs helper, transpiled in-process by Playwright.
import { startFakeSupervisor } from './fake-supervisor.mjs';

// Spec 5 + 8.1: a run starts from the command palette with no pointer, reaches
// the control plane, is handed to the SUPERVISOR (the fake one here, speaking
// the real framed-CBOR protocol), and shows up in the workspace's run list.
//
// The teeth: the run id asserted in the UI is the one the SUPERVISOR was told
// to start. A UI that optimistically drew a row without the request landing, or
// that drew a different id, fails — the whole point of spec 5.1 is that the
// supervisor, not the browser, owns the run.
interface FakeSupervisor {
  close(): void;
  waitForRun(ms?: number): Promise<string>;
  attention(run: string, kind?: string): void;
  complete(run: string, code?: number, diff?: { added: number; modified: number; removed: number }): void;
}

test.describe('starting a run', () => {
  let supervisor: FakeSupervisor | null = null;

  test.afterEach(() => {
    supervisor?.close();
    supervisor = null;
  });

  test('palette → Run command starts a run that appears in the runs list', async ({ page, request }) => {
    // Pane layouts persist (spec 8.6); start from a known-empty workspace.
    await resetLayouts(request);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });

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

    await card.click();
    await expect(page.getByTestId('workspace')).toBeVisible();

    // Keyboard only: Cmd+K → "Run command" → type the command → Enter.
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.getByTestId('palette-input').fill('run command');
    await expect(
      page.locator('[data-testid="palette-item"][data-command-id="run.start"]'),
    ).toBeVisible();
    await page.keyboard.press('Enter');

    const input = page.getByTestId('run-launcher-input');
    await expect(input).toBeFocused();
    await input.fill('echo mari-run');
    await page.keyboard.press('Enter');

    // The control plane received the start and forwarded it to the supervisor.
    await expect
      .poll(() => requests.filter((r) => /^POST .*\/runs$/.test(r)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const runId = await sup.waitForRun(15_000);
    expect(runId).toBeTruthy();

    // The run's terminal pane opened for exactly that run (spec 7.1).
    await expect(
      page.locator(`[data-testid="terminal-pane"][data-run="${runId}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // …and the runs list shows it, with the argv that was sent.
    await page.getByTestId('add-runs-pane').click();
    const row = page.locator(`[data-testid="run-row"][data-run-id="${runId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('run-argv')).toHaveText('echo mari-run');
  });

  test('a completed run offers Keep and Revert over its difference (spec 5.3)', async ({ page, request }) => {
    await resetLayouts(request);
    await page.goto('/');
    const card = coldCard(page);
    await expect(card).toBeVisible();
    const computer = await card.getAttribute('data-computer-id');
    // Two REAL manifests, both written to R2 by the dev seed: the run's
    // baseline and what the tree looks like after it ran. The control plane
    // computes the difference from these bytes — an invented id would make
    // `GET /runs/:id/diff` a 404 and everything below assert on an error state.
    const seed = seedRecord();
    const sup: FakeSupervisor = await startFakeSupervisor({
      url: CONTROL_PLANE,
      computer: computer as string,
      preRunManifest: seed.manifest,
      postRunManifest: seed.postRunManifest,
    });
    supervisor = sup;

    await card.click();
    await page.getByTestId('workspace-run-command').click();
    await page.getByTestId('run-launcher-input').fill('touch /tmp/made-by-mari');
    await page.keyboard.press('Enter');

    const runId = await sup.waitForRun(15_000);
    // The supervisor reports a completion with a real diff summary (§5.1).
    sup.complete(runId, 0, { added: 1, modified: 1, removed: 1 });

    await page.getByTestId('add-runs-pane').click();
    const row = page.locator(`[data-testid="run-row"][data-run-id="${runId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('run-review')).toBeVisible({ timeout: 15_000 });

    await row.getByTestId('run-review').click();
    const diff = page.locator('[data-testid="diff-pane"][data-mode="run"]');
    await expect(diff).toBeVisible();

    // The DIFFERENCE ITSELF, computed by the control plane from the two
    // manifests and rendered row by row. This is the part a 404 used to hide:
    // one file added, one modified, one removed, at the exact seeded paths.
    await expect(diff.getByTestId('diff-counts')).toHaveText('+1 ~1 -1', { timeout: 15_000 });
    await expect(diff.locator('[data-testid="diff-row"]')).toHaveCount(3);
    await expect(
      diff.locator('[data-testid="diff-row"][data-path="/notes/made-by-mari.txt"]'),
    ).toHaveAttribute('data-class', 'added');
    await expect(diff.locator('[data-testid="diff-row"][data-path="/README.md"]')).toHaveAttribute(
      'data-class',
      'content',
    );
    await expect(
      diff.locator('[data-testid="diff-row"][data-path="/src/util.ts"]'),
    ).toHaveAttribute('data-class', 'removed');
    // The pane names the two manifests it is comparing (both real ids).
    await expect(diff.getByTestId('diff-range')).toContainText(seed.manifest.slice(0, 12));
    await expect(diff.getByTestId('diff-range')).toContainText(seed.postRunManifest.slice(0, 12));
    // Spec 10.2: a difference view shows paths, modes and sizes — never content.
    await expect(diff.getByTestId('diff-list')).not.toContainText('A run appended this line');

    // Both decisions are offered, and NEITHER is applied automatically (9.2).
    await expect(diff.getByTestId('diff-keep')).toBeVisible();
    await expect(diff.getByTestId('diff-revert')).toHaveText('Revert');
    await expect(diff).toHaveAttribute('data-decided', '');
  });
});

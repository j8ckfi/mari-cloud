import fs from 'node:fs';
import type { Page, Locator, APIRequestContext } from '@playwright/test';
import { SEED_RECORD } from './auth-paths';

/** The control plane the e2e suite boots (playwright.config.ts pins the port). */
export const CONTROL_PLANE: string =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787';

/** The dev seed's response body, as the setup project recorded it. */
export interface SeedRecord {
  computer: { id: string; name: string; state: string; head: string };
  /** The manifest every seeded computer's head points at. */
  manifest: string;
  files: string[];
  /** A second real manifest in R2: the seed tree after a run touched it. */
  postRunManifest: string;
  postRunFiles: string[];
}

/**
 * The seed record written by `global.setup.ts`. Throws if it is missing — a
 * spec that silently fell back to invented manifest ids would assert against
 * the review pane's ERROR state and prove nothing (that is the bug this file
 * pair exists to prevent).
 */
export function seedRecord(): SeedRecord {
  const raw = fs.readFileSync(SEED_RECORD, 'utf8');
  const parsed = JSON.parse(raw) as SeedRecord;
  if (!parsed.manifest || !parsed.postRunManifest) {
    throw new Error(`seed record at ${SEED_RECORD} has no manifest ids`);
  }
  return parsed;
}

/**
 * Record every request that would cause a computer to WAKE. A wake is either an
 * explicit wake-proxy call or a mutating request (a write wakes per spec 8.4).
 * Reads (GET) never wake. The COLD fleet/files tests assert this stays empty.
 */
export function installNoWakeSpy(page: Page): { wakeCalls: () => string[] } {
  const calls: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    const method = req.method();
    const isWakeUrl = /\/wake(\b|\/|\?|$)/.test(url) || /\bwake=/.test(url);
    const isMutation =
      (method === 'PUT' || method === 'POST' || method === 'DELETE' || method === 'PATCH') &&
      url.includes('/api/');
    if (isWakeUrl || isMutation) calls.push(`${method} ${url}`);
  });
  return { wakeCalls: () => calls.slice() };
}

const SPINNER_SELECTOR =
  '.spinner,[role="progressbar"],[aria-busy="true"],[data-testid*="spinner"],[data-testid*="loading"],[data-testid*="skeleton"]';

/**
 * Install a MutationObserver (before any app script runs) that flips a global
 * flag the first time any spinner/skeleton/progress element is ever added to
 * the DOM. Spec 8.3 forbids a spinner in front of the interface, so the flag
 * must stay false for the whole session.
 */
export async function installSpinnerWatchdog(page: Page): Promise<void> {
  await page.addInitScript((selector) => {
    const w = window as unknown as { __MARI_SPINNER_SEEN?: boolean };
    w.__MARI_SPINNER_SEEN = false;
    const flag = (el: Element): void => {
      if (el.matches?.(selector) || el.querySelector?.(selector)) w.__MARI_SPINNER_SEEN = true;
    };
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of Array.from(m.addedNodes)) {
          if (n.nodeType === 1) flag(n as Element);
        }
      }
    });
    const start = (): void => obs.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
  }, SPINNER_SELECTOR);
}

/** Whether any spinner/skeleton was ever observed in the DOM. */
export function spinnerSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __MARI_SPINNER_SEEN?: boolean }).__MARI_SPINNER_SEEN === true);
}

/** The first COLD computer card in the fleet. */
export function coldCard(page: Page): Locator {
  return page.locator('[data-testid="computer-card"][data-state="cold"]').first();
}

/**
 * Clear every computer's saved pane layout.
 *
 * Pane layouts persist in the Durable Object (spec 8.6) — which is the product
 * working correctly, and which makes a workspace's contents depend on what an
 * EARLIER test left behind. A spec that opens a pane and asserts on it must
 * therefore state its precondition instead of inheriting one.
 *
 * This runs on the `request` fixture: a separate APIRequestContext, so the
 * setup PUTs are not page traffic and cannot be mistaken for the application
 * waking a computer. Call it BEFORE `installNoWakeSpy` / `page.goto` all the
 * same, so the window a spec observes contains only the app's own requests.
 */
export async function resetLayouts(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/fleet');
  if (!res.ok()) throw new Error(`fleet read failed: ${res.status()}`);
  const body = (await res.json()) as { computers: Array<{ id: string }> };
  for (const c of body.computers) {
    const put = await request.put(`/api/computers/${encodeURIComponent(c.id)}/layout`, {
      data: null,
    });
    if (!put.ok()) throw new Error(`layout reset failed for ${c.id}: ${put.status()}`);
  }
}

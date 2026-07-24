import type { Page, Locator } from '@playwright/test';

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

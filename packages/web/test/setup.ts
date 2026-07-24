// Test setup for jsdom component tests. Testing Library auto-registers its
// afterEach cleanup when it detects Vitest's globals, so we only polyfill the
// browser APIs jsdom lacks that our components touch.

// matchMedia is read by the theme hook; jsdom does not implement it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// ResizeObserver is used by pane layout measurement; jsdom lacks it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

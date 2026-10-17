import type { Platform } from '../contracts';
import { TauriPlatform } from './tauri';
import { WebPlatform } from './web';

export { TauriPlatform } from './tauri';
export { WebPlatform, WEB_ROOT, SAMPLE_DOCS } from './web';
export { SHORTCUTS, matchShortcut, shortcutLabel } from './shortcuts';
export type { Shortcut } from './shortcuts';

/** Optional extras both implementations provide beyond the `Platform` contract. */
export interface PlatformExtras {
  /** Print the current window/document through the system dialog. */
  print(): Promise<void>;
}

let instance: (Platform & PlatformExtras) | null = null;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The Platform for this runtime (singleton). In the browser, also exposed as `window.__MARGIN_WEB__` for e2e tests. */
export function getPlatform(): Platform & PlatformExtras {
  if (instance) return instance;
  if (isTauri()) {
    instance = new TauriPlatform();
  } else {
    const web = new WebPlatform();
    (globalThis as { __MARGIN_WEB__?: WebPlatform }).__MARGIN_WEB__ = web;
    instance = web;
  }
  return instance;
}

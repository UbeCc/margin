import type { Platform } from '../contracts';

/**
 * Optional Platform capabilities the shell uses when present (feature-detected).
 * Requested in ARCHITECTURE.md / issue #21; until then file-tree
 * rename/delete/new-folder are disabled on platforms that lack them.
 */
export interface PlatformExtras {
  /** Rename/move a file or folder. */
  rename?(from: string, to: string): Promise<void>;
  /** Move to trash (preferred) or delete. */
  remove?(path: string): Promise<void>;
  createDir?(path: string): Promise<void>;
  /** Reveal in Finder / Explorer. */
  revealInFolder?(path: string): Promise<void>;
}

export type FullPlatform = Platform & PlatformExtras;

export function extras(p: Platform): PlatformExtras {
  return p as FullPlatform;
}

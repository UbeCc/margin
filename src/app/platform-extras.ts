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
  /** Export markdown with Pandoc (#81). Resolves to pandoc's warnings ('' if none). */
  pandocExport?(markdown: string, outPath: string, opts: PandocExportOptions): Promise<string>;
  /** Locate pandoc (configured path → PATH → common dirs) and check version ≥ 2. */
  pandocDetect?(pandocPath: string | null): Promise<{ path: string; version: string }>;
  /** Float this window above others (#103; per window, not persisted). Resolves the new state. */
  setAlwaysOnTop?(on: boolean): Promise<boolean>;
  /** Tick / untick a native check menu item (#103 menu state sync). */
  setMenuChecked?(id: string, checked: boolean): Promise<void>;
  /** Open / close the web inspector (debug builds only). */
  toggleDevtools?(): Promise<void>;
  /** Trackpad pinch zoom of the web view (View › Allow Magnification). */
  setMagnification?(allow: boolean): Promise<void>;
}

export interface PandocExportOptions {
  format: 'docx' | 'latex' | 'epub';
  /** Document directory: pandoc's cwd and --resource-path (else the output's dir). */
  docDir: string | null;
  title: string | null;
  /** Explicit pandoc binary or its directory; null = auto-detect. */
  pandocPath: string | null;
  timeoutMs: number;
}

export type FullPlatform = Platform & PlatformExtras;

export function extras(p: Platform): PlatformExtras {
  return p as FullPlatform;
}

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
  /** Open another app window (#94): empty, or showing `path`. */
  openWindow?(opts?: { path?: string }): Promise<void>;
  /** Raw file bytes, for decoding with a chosen / detected encoding (#94). */
  readFileBytes?(path: string): Promise<Uint8Array>;
  /** Write text to the system clipboard (Copy File Path). */
  writeClipboardText?(text: string): Promise<void>;
  /** Write binary export output (Export › Image, #95). */
  exportBinary?(bytes: Uint8Array, outPath: string): Promise<void>;
  /** Open a file this session exported with its default app ("Open exported file"). */
  openExportedFile?(path: string): Promise<void>;
  /** File › Import (#95): convert a docx/odt/epub/rtf/LaTeX/HTML/… file to Markdown with Pandoc. */
  pandocImport?(inputPath: string, pandocPath: string | null, timeoutMs: number): Promise<string>;
  /**
   * Custom export / run-after-export command (#95): tokenized to argv, `${vars}`
   * expanded per token, no shell. `stdin` receives the document.
   */
  runExportCommand?(command: string, vars: Record<string, string>, stdin: string | null, cwd: string | null, timeoutMs: number): Promise<{ stdout: string; stderr: string }>;
  /** Export markdown with Pandoc (#81). Resolves to pandoc's warnings ('' if none). */
  pandocExport?(markdown: string, outPath: string, opts: PandocExportOptions): Promise<string>;
  /** Locate pandoc (configured path → PATH → common dirs) and check version ≥ 2. */
  pandocDetect?(pandocPath: string | null): Promise<{ path: string; version: string }>;
}

export interface PandocExportOptions {
  format: 'docx' | 'latex' | 'epub' | 'odt' | 'rtf' | 'mediawiki' | 'rst' | 'textile' | 'opml';
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

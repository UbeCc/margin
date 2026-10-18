import type { Platform, UploadConfig } from '../contracts';

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
  /** Quick Look a file from the sidebar (`window.previewFile`, #131). */
  quickLook?(path: string): Promise<void>;
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
  runExportCommand?(command: string, vars: Record<string, string>, stdin: string | null, cwd: string | null, timeoutMs: number, exportId?: string): Promise<{ stdout: string; stderr: string }>;
  /** Export markdown with Pandoc (#81). Resolves to pandoc's warnings ('' if none). */
  pandocExport?(markdown: string, outPath: string, opts: PandocExportOptions): Promise<string>;
  /** Abort button (#90): stop the Pandoc export / custom command started with this export id. Resolves false if it already ended. */
  pandocAbort?(exportId: string): Promise<boolean>;
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
  /** Enable / disable a native menu item (#103 menu state sync). */
  setMenuEnabled?(id: string, enabled: boolean): Promise<void>;
  /** Edit › Spelling and Grammar › Show Spelling and Grammar: system panel (desktop). */
  showSpellingPanel?(): Promise<void>;
   * #99: copy (or move) an image file into `dir` (created when missing). Without
   * `name`, a clash gets Typora's `stem-<7 digits>.ext` suffix (identical bytes are
   * reused); with `name` an existing file is refused. Resolves to the absolute destination.
   */
  copyImage?(src: string, dir: string, opts?: { name?: string; move?: boolean }): Promise<string>;
  /** #99: device pixels per point of an image file (2 for Retina screenshots; 1 when unknown). */
  imageScale?(path: string): Promise<number>;
  /** #99: multi-select image picker ("Select image from local file"). */
  openImagesDialog?(): Promise<string[]>;
  /** #92: upload two bundled sample images with this config (Preferences › Test Uploader). */
  testUploader?(config: UploadConfig): Promise<UploaderTestReport>;
  /** #92: abort in-flight uploads. */
  cancelUpload?(): Promise<void>;
}

export interface UploaderTestReport {
  ok: boolean;
  /** argv as run (display form; never run through a shell). */
  command: string;
  stdout: string;
  stderr: string;
  urls: string[];
  message: string;
}

export interface PandocExportOptions {
  format: 'docx' | 'latex' | 'epub' | 'odt' | 'rtf' | 'mediawiki' | 'rst' | 'textile' | 'opml';
  /** Document directory: pandoc's cwd and --resource-path (else the output's dir). */
  docDir: string | null;
  title: string | null;
  /** Explicit pandoc binary or its directory; null = auto-detect. */
  pandocPath: string | null;
  timeoutMs: number;
  /** Per-format options (#90): reference doc, template, css, epub chapter level, extra args. */
  options?: {
    referenceDoc?: string;
    template?: string;
    css?: string;
    epubChapterLevel?: number;
    pdfEngine?: string;
    toc?: boolean;
    extraArguments?: string;
  };
  /** Id for `pandocAbort`. */
  exportId?: string;
}

export type FullPlatform = Platform & PlatformExtras;

export function extras(p: Platform): PlatformExtras {
  return p as FullPlatform;
}

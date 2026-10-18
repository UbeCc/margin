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
  /** Export markdown with Pandoc (#81). Resolves to pandoc's warnings ('' if none). */
  pandocExport?(markdown: string, outPath: string, opts: PandocExportOptions): Promise<string>;
  /** Locate pandoc (configured path → PATH → common dirs) and check version ≥ 2. */
  pandocDetect?(pandocPath: string | null): Promise<{ path: string; version: string }>;
  /**
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

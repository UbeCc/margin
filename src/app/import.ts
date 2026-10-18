/**
 * File › Import (#95, `typora.export.import`): convert a document to Markdown and
 * open it as a new, unsaved document. Pandoc handles docx / odt / epub / rtf /
 * LaTeX / HTML / rst / …; HTML also works without Pandoc through the editor's own
 * HTML → Markdown converter (the one used for rich paste).
 */
import type { Platform } from '../contracts';
import { extras } from './platform-extras';
import { basename, extname } from './util/path';

export const IMPORT_FILTERS = [
  { name: 'Documents', extensions: ['docx', 'odt', 'epub', 'rtf', 'html', 'htm', 'tex', 'latex', 'rst', 'textile', 'wiki', 'mediawiki', 'opml', 'org', 'ipynb', 'csv'] },
  { name: 'Word', extensions: ['docx'] },
  { name: 'HTML', extensions: ['html', 'htm'] },
];

const PANDOC_ONLY = new Set(['docx', 'odt', 'epub', 'rtf', 'tex', 'latex', 'ltx', 'rst', 'textile', 'wiki', 'mediawiki', 'opml', 'org', 'ipynb', 'csv']);
const HTML = new Set(['html', 'htm', 'xhtml']);

export const IMPORT_TIMEOUT_MS = 120_000;

export interface ImportHost {
  platform: Platform;
  pandocPath(): string;
  /** Open `markdown` as a new unsaved document (asks about unsaved changes first). */
  openAsNew(markdown: string, sourceName: string): Promise<boolean>;
  progress(message: string): () => void;
  notify(message: string, kind: 'success' | 'error' | 'info' | 'warning', action?: { label: string; run: () => void }): void;
  /** Lazily loaded HTML → Markdown converter. */
  htmlToMarkdown(html: string): Promise<string>;
  /** "Set Pandoc Path" action (opens Preferences). */
  openPandocSettings(): void;
}

export function importKind(path: string): 'html' | 'pandoc' | null {
  const ext = extname(path).slice(1).toLowerCase();
  if (HTML.has(ext)) return 'html';
  if (PANDOC_ONLY.has(ext)) return 'pandoc';
  return null;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).trim() || 'unknown error';

/** Convert one file. Resolves the Markdown; throws with a user-facing message. */
export async function convertForImport(host: ImportHost, path: string): Promise<string> {
  const kind = importKind(path);
  if (!kind) throw new Error(`${basename(path)} is not a supported import format.`);
  const pandoc = extras(host.platform).pandocImport;
  if (pandoc) {
    try {
      return await pandoc.call(host.platform, path, host.pandocPath().trim() || null, IMPORT_TIMEOUT_MS);
    } catch (e) {
      // HTML still imports without Pandoc (missing / too old / failing).
      if (kind !== 'html') throw e;
    }
  } else if (kind === 'pandoc') {
    throw new Error('Pandoc is needed for importing these file formats.');
  }
  const html = await host.platform.readTextFile(path);
  return host.htmlToMarkdown(html);
}

/** File › Import…: pick a file (or use `path`), convert, open as a new document. */
export async function runImport(host: ImportHost, path?: string | null): Promise<boolean> {
  const p = path ?? (await host.platform.openFileDialog({ filters: IMPORT_FILTERS }));
  if (!p) return false;
  let dismiss: () => void = () => {};
  try {
    dismiss = host.progress(`Importing ${basename(p)}…`);
  } catch {
    /* notices are best-effort */
  }
  let md: string;
  try {
    md = await convertForImport(host, p);
  } catch (e) {
    dismiss();
    const m = msg(e);
    const needsPandoc = /pandoc/i.test(m) && /needed|not found|too old|Cannot run|no such/i.test(m);
    host.notify(`Import failed: failed to import file from ${basename(p)}. ${m}`, 'error', needsPandoc ? { label: 'Set Pandoc Path', run: () => host.openPandocSettings() } : undefined);
    return false;
  }
  dismiss();
  const opened = await host.openAsNew(md, basename(p));
  if (opened) host.notify(`Imported ${basename(p)}`, 'success');
  return opened;
}

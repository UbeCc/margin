/**
 * Pandoc export (docx / latex / epub) — #81.
 *
 * Invariant (Typora's stuck "Exporting…" bug): once the progress notice is shown,
 * every path dismisses it and ends in exactly one success or error notice — even if
 * the platform call throws synchronously, rejects, or never settles (watchdog).
 */
import type { Platform } from '../contracts';
import type { PandocExportOptions, PlatformExtras } from './platform-extras';

export type PandocFormat = 'docx' | 'latex' | 'epub' | 'odt' | 'rtf' | 'mediawiki' | 'rst' | 'textile' | 'opml';

export const PANDOC_FORMATS: Readonly<Record<PandocFormat, { label: string; ext: string; filterName: string }>> = {
  docx: { label: 'Word', ext: 'docx', filterName: 'Word Document' },
  latex: { label: 'LaTeX', ext: 'tex', filterName: 'LaTeX' },
  epub: { label: 'EPUB', ext: 'epub', filterName: 'EPUB' },
  // #95: the rest of the classic Pandoc export list.
  odt: { label: 'OpenOffice', ext: 'odt', filterName: 'OpenDocument Text' },
  rtf: { label: 'RTF', ext: 'rtf', filterName: 'Rich Text Format' },
  mediawiki: { label: 'MediaWiki', ext: 'wiki', filterName: 'MediaWiki' },
  rst: { label: 'reStructuredText', ext: 'rst', filterName: 'reStructuredText' },
  textile: { label: 'Textile', ext: 'textile', filterName: 'Textile' },
  opml: { label: 'OPML', ext: 'opml', filterName: 'OPML' },
};

export const PANDOC_ACTIONS = {
  exportDocx: 'docx',
  exportLatex: 'latex',
  exportEpub: 'epub',
  exportOdt: 'odt',
  exportRtf: 'rtf',
  exportMediawiki: 'mediawiki',
  exportRst: 'rst',
  exportTextile: 'textile',
  exportOpml: 'opml',
} as const satisfies Record<string, PandocFormat>;

export function pandocFormatForAction(id: string): PandocFormat | null {
  return (PANDOC_ACTIONS as Record<string, PandocFormat>)[id] ?? null;
}

/** Default backend timeout; the UI watchdog allows a little more on top. */
export const PANDOC_TIMEOUT_MS = 120_000;
const WATCHDOG_SLACK_MS = 20_000;

export type NoticeKind = 'info' | 'success' | 'error' | 'warning';

export interface PandocExportDeps {
  platform: Pick<Platform, 'saveFileDialog'> & PlatformExtras;
  markdown: string;
  /** Default file stem for the save dialog. */
  name: string;
  /** Directory of the current document (relative images resolve here), if saved. */
  docDir: string | null;
  /** Where the save dialog starts when the document is unsaved. */
  fallbackDir: string | null;
  title: string;
  /** Preferences › Files › Pandoc path ('' = auto-detect). */
  pandocPath: string;
  /** Show a sticky progress notice; returns its dismiss function. */
  progress(message: string): () => void;
  notify(message: string, kind: NoticeKind, action?: { label: string; run: () => void }): void;
  /** Optional "Show in Finder" for the success notice. */
  reveal?: (path: string) => void;
  timeoutMs?: number;
  /** Test hook. */
  watchdogMs?: number;
}

function message(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  return m.trim() || 'unknown error';
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Ensure the chosen path carries the format's extension. */
export function withExtension(path: string, ext: string): string {
  return path.toLowerCase().endsWith(`.${ext}`) ? path : `${path}.${ext}`;
}

/** Resolves true on success, false on cancel/failure. Never rejects. */
export async function exportWithPandoc(format: PandocFormat, deps: PandocExportDeps): Promise<boolean> {
  const spec = PANDOC_FORMATS[format];
  const run = deps.platform.pandocExport;
  if (typeof run !== 'function') {
    deps.notify(`${spec.label} export needs Pandoc and the desktop app.`, 'error');
    return false;
  }
  let target: string | null;
  try {
    const base = deps.docDir ?? deps.fallbackDir;
    target = await deps.platform.saveFileDialog({
      defaultPath: base ? `${base}/${deps.name}.${spec.ext}` : `${deps.name}.${spec.ext}`,
      filters: [{ name: spec.filterName, extensions: [spec.ext] }],
    });
  } catch (e) {
    deps.notify(`Export failed: ${message(e)}`, 'error');
    return false;
  }
  if (!target) return false;
  target = withExtension(target, spec.ext);

  const timeoutMs = deps.timeoutMs ?? PANDOC_TIMEOUT_MS;
  const opts: PandocExportOptions = {
    format,
    docDir: deps.docDir,
    title: deps.title,
    pandocPath: deps.pandocPath.trim() || null,
    timeoutMs,
  };
  let dismiss: () => void = () => {};
  try {
    dismiss = deps.progress(`Exporting ${basename(target)} with Pandoc…`);
  } catch {
    /* a broken notice must not block the export */
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no response from Pandoc after ${Math.round((deps.watchdogMs ?? timeoutMs + WATCHDOG_SLACK_MS) / 1000)}s`)),
        deps.watchdogMs ?? timeoutMs + WATCHDOG_SLACK_MS,
      );
    });
    // `Promise.resolve().then` turns a synchronous throw into a rejection.
    const warnings = await Promise.race([Promise.resolve().then(() => run.call(deps.platform, deps.markdown, target, opts)), watchdog]);
    finish(dismiss);
    const reveal = deps.reveal;
    const action = reveal ? { label: 'Show', run: () => reveal(target) } : undefined;
    const w = typeof warnings === 'string' ? warnings.trim() : '';
    if (w) deps.notify(`Exported ${basename(target)} with warnings: ${w.split('\n')[0]}`, 'warning', action);
    else deps.notify(`Exported ${basename(target)}`, 'success', action);
    return true;
  } catch (e) {
    finish(dismiss);
    deps.notify(`${spec.label} export failed: ${message(e)}`, 'error');
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function finish(dismiss: () => void): void {
  try {
    dismiss();
  } catch {
    /* ignore */
  }
}

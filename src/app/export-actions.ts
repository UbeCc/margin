/**
 * Export pipeline (#95): HTML, HTML (without Styles), PDF and Image exports with
 * the export settings, "Export with Previous" / "Export and Overwrite with
 * Previous", and the after-export action. Other exporters (Pandoc, custom
 * commands) register through `ExportController.register` so they share the same
 * previous/overwrite and after-export behaviour.
 */
import type { PdfExportOptions, Platform } from '../contracts';
import { buildExportHtml, buildPlainHtml, documentTitle, exportHeadings, linkHeadingAnchors } from './export';
import { imageFormatForPath, ImageTooLargeError, rasterizeHtml } from './export-image';
import { effectivePage, expandVars, migrateExportSettings, paperSizeMm, resolveMeta, todayString, MM_TO_PT, type ExportSettings, type PrintSetup } from './export-settings';
import { exportWithPandoc, newExportId, PANDOC_FORMATS, type PandocFormat } from './export-pandoc';
import { extras } from './platform-extras';
import { basename, dirname, extname, join, stripExt } from './util/path';

export type BuiltinExportKind = 'html' | 'html-plain' | 'pdf' | 'image';

export interface ExportHost {
  platform: Platform;
  exportSettings(): ExportSettings;
  updateExportSettings(next: ExportSettings): void;
  markdown(): string;
  docPath(): string | null;
  folder(): string | null;
  /** Rendered body; with `relativeTo` local image srcs become relative to that directory. */
  renderBody(relativeTo: string | null): string;
  themeCss(theme: string): string;
  extraCss(body: string): Promise<string>;
  notify(message: string, kind: 'success' | 'error' | 'info' | 'warning', action?: { label: string; run: () => void }): void;
  /** File › Page Setup (session); export settings' paper wins when not "Default". */
  printSetup?(): PrintSetup;
  /** The "Exporting..." sheet for custom commands (#90); returns its close function. */
  exportProgress?(abort?: () => void): () => void;
  /** Overwrite confirmation; resolves 'overwrite' | 'keep-both' | 'cancel' and whether to stop asking. */
  confirmOverwrite(path: string): Promise<{ choice: 'overwrite' | 'keep-both' | 'cancel'; dontAsk: boolean }>;
}

/** Exporter contract: build + write the output for one target path. */
export interface Exporter {
  label: string;
  extensions: string[];
  /** Write the export to `target`. Throw to report a failure. */
  run(target: string): Promise<void>;
  /** Preflight: a reason the exporter cannot run here (checked before the save panel). */
  unavailable?(): string | null;
  /** No save panel / output path (the exporter decides where output goes). */
  noTarget?: boolean;
}

/** Thrown by an exporter the user stopped (Abort): no error notice, no "previous" update. */
export class ExportAbortedError extends Error {
  constructor() {
    super('Export aborted');
    this.name = 'ExportAbortedError';
  }
}

export interface LastExport {
  kind: string;
  path: string;
}

export type PdfNativeOptions = PdfExportOptions;

/** `name 2.ext`, `name 3.ext`, … — first path not in `exists`. */
export async function keepBothPath(path: string, exists: (p: string) => Promise<boolean>): Promise<string> {
  const dir = dirname(path);
  const ext = extname(path);
  const stem = stripExt(basename(path));
  for (let i = 2; i < 1000; i++) {
    const p = join(dir, `${stem} ${i}${ext}`);
    if (!(await exists(p))) return p;
  }
  return path;
}

export class ExportController {
  last: LastExport | null = null;
  private lastDir: string | null = null;
  private custom = new Map<string, (host: ExportHost) => Exporter>();

  constructor(private host: ExportHost) {}

  /** Register an extra exporter kind (e.g. `pandoc:docx`). */
  register(kind: string, make: (host: ExportHost) => Exporter): void {
    this.custom.set(kind, make);
  }

  private body(relativeTo: string | null): string {
    return linkHeadingAnchors(this.host.renderBody(relativeTo));
  }

  hasPrevious(): boolean {
    return this.last !== null;
  }

  private vars(target: string | null): Record<string, string> {
    const doc = this.host.docPath();
    return {
      today: todayString(),
      currentPath: doc ?? '',
      currentFolder: doc ? dirname(doc) : '',
      currentFileName: doc ? stripExt(basename(doc)) : 'Untitled',
      currentFileFullName: doc ? basename(doc) : 'Untitled',
      openedFolder: this.host.folder() ?? '',
      outputPath: target ?? '',
      outputFolder: target ? dirname(target) : '',
      outputFileName: target ? stripExt(basename(target)) : '',
      outputFileFullName: target ? basename(target) : '',
    };
  }

  private meta(s: ExportSettings) {
    const md = this.host.markdown();
    const doc = this.host.docPath();
    return resolveMeta(md, { title: documentTitle(md, doc ? basename(doc) : null), author: s.pdf.author, header: s.pdf.header, footer: s.pdf.footer }, s.general.allowYamlOverrides);
  }

  private exporter(kind: string): Exporter | null {
    const s = this.host.exportSettings();
    const h = this.host;
    const p = h.platform;
    switch (kind) {
      case 'html':
        return {
          label: 'HTML',
          extensions: ['html'],
          run: async (t) => {
            const body = this.body(dirname(t));
            const meta = this.meta(s);
            const vars = { ...this.vars(t), title: meta.title, author: meta.author };
            await p.exportHtml(
              buildExportHtml({ title: meta.title, body, themeCss: h.themeCss(s.html.theme), extraCss: await h.extraCss(body), appendHead: expandVars(s.html.appendHead, vars), appendBody: expandVars(s.html.appendBody, vars) }),
              t,
            );
          },
        };
      case 'html-plain':
        return {
          label: 'HTML',
          extensions: ['html'],
          run: async (t) => {
            const meta = this.meta(s);
            const vars = { ...this.vars(t), title: meta.title, author: meta.author };
            await p.exportHtml(buildPlainHtml({ title: meta.title, body: this.body(dirname(t)), appendHead: expandVars(s.htmlPlain.appendHead, vars), appendBody: expandVars(s.htmlPlain.appendBody, vars) }), t);
          },
        };
      case 'pdf':
        return { label: 'PDF', extensions: ['pdf'], run: (t) => this.runPdf(t, s) };
      case 'image':
        return {
          label: 'Image',
          extensions: s.image.format === 'jpeg' ? ['jpg', 'jpeg', 'png'] : ['png', 'jpg', 'jpeg'],
          run: (t) => this.runImage(t, s),
        };
      default: {
        if (kind.startsWith('custom:')) return this.customExporter(kind.slice(7), s);
        const make = this.custom.get(kind);
        return make ? make(h) : null;
      }
    }
  }

  /** Variables for custom commands: document/output paths plus title/author. */
  commandVars(target: string | null, s = this.host.exportSettings()): Record<string, string> {
    const meta = this.meta(s);
    return { ...this.vars(target), title: meta.title, author: meta.author };
  }

  private customExporter(id: string, s: ExportSettings): Exporter | null {
    const c = s.custom.find((x) => x.id === id);
    if (!c) return null;
    const h = this.host;
    const run = extras(h.platform).runExportCommand;
    return {
      label: c.name,
      extensions: c.extension ? [c.extension] : ['*'],
      noTarget: !c.saveDialog,
      unavailable: () => (!run ? 'Custom export commands need the desktop app.' : c.command.trim() ? null : `“${c.name}” has no command configured.`),
      run: async (t) => {
        let stdin: string;
        if (c.input === 'html') {
          const body = this.body(t ? dirname(t) : null);
          stdin = buildExportHtml({ title: this.meta(s).title, body, themeCss: h.themeCss(s.html.theme), extraCss: await h.extraCss(body) });
        } else stdin = h.markdown();
        const doc = h.docPath();
        const x = extras(h.platform);
        const id = x.pandocAbort ? newExportId('cmd') : undefined;
        let aborted = false;
        const abort = id
          ? () => {
              aborted = true;
              void x.pandocAbort!.call(h.platform, id).catch(() => undefined);
            }
          : undefined;
        let close: () => void = () => {};
        try {
          close = h.exportProgress?.(abort) ?? close;
        } catch {
          /* a broken sheet must not block the export */
        }
        let out: { stdout: string; stderr: string };
        try {
          out = await run!.call(h.platform, c.command, this.commandVars(t || null, s), stdin, doc ? dirname(doc) : h.folder(), 120_000, id);
        } catch (e) {
          if (aborted || (e instanceof Error && e.message === 'Export aborted')) throw new ExportAbortedError();
          throw e;
        } finally {
          close();
        }
        const w = out.stderr.trim();
        if (w) h.notify(`${c.name}: ${w.split('\n')[0]}`, 'warning');
      },
    };
  }

  /** The PDF payload (HTML + native options), exposed for tests. */
  async pdfPayload(target: string, s = this.host.exportSettings()): Promise<{ html: string; opts: PdfNativeOptions }> {
    const h = this.host;
    const body = this.body(null);
    const meta = this.meta(s);
    const vars = { ...this.vars(target), title: meta.title, author: meta.author };
    const brk = s.pdf.pageBreaks;
    const breakCss = brk === 'none' ? '' : `@media print { .margin-doc h1${brk === 'h2' ? ', .margin-doc h2' : ''} { break-before: page; } .margin-doc > :first-child { break-before: auto !important; } }`;
    const html = buildExportHtml({
      title: meta.title,
      body,
      themeCss: h.themeCss(s.pdf.theme),
      extraCss: `${await h.extraCss(body)}\n${breakCss}`,
      bodyClass: 'margin-export-pdf',
      appendBody: s.pdf.appendBody ? expandVars(s.pdf.appendBody, vars) : undefined,
    });
    const page = effectivePage(s.pdf.page, h.printSetup?.());
    const [w, ht] = paperSizeMm(page);
    const m = page.margins;
    const pt = (x: number): number => Math.round(x * MM_TO_PT * 100) / 100;
    const doc = h.docPath();
    return {
      html,
      opts: {
        baseDir: doc ? dirname(doc) : undefined,
        paper: { width: pt(w), height: pt(ht), margins: { top: pt(m.top), right: pt(m.right), bottom: pt(m.bottom), left: pt(m.left) } },
        header: meta.header ? expandVars(meta.header, vars) : undefined,
        footer: meta.footer ? expandVars(meta.footer, vars) : undefined,
        outline: s.pdf.outline ? exportHeadings(body) : undefined,
        meta: { title: meta.title, author: meta.author, subject: meta.subject, keywords: meta.keywords },
      },
    };
  }

  private async runPdf(target: string, s: ExportSettings): Promise<void> {
    const { html, opts } = await this.pdfPayload(target, s);
    await this.host.platform.exportPdf(html, target, opts);
  }

  /** Render the image bytes (exposed for tests). */
  async imageBytes(target: string, s = this.host.exportSettings()): Promise<Uint8Array> {
    const h = this.host;
    const body = this.body(null);
    const meta = this.meta(s);
    const css = `${await h.extraCss(body)}\n.margin-doc { font-size: ${s.image.fontSize}px; max-width: none; padding: 32px 40px 48px; }`;
    const html = buildExportHtml({ title: meta.title, body, themeCss: h.themeCss(s.image.theme), extraCss: css, bodyClass: 'margin-export-image' });
    const out = await rasterizeHtml(html, { width: s.image.width, format: imageFormatForPath(target), quality: s.image.quality });
    return out.bytes;
  }

  private async runImage(target: string, s: ExportSettings): Promise<void> {
    const write = extras(this.host.platform).exportBinary;
    if (!write) throw new Error('Image export is not supported on this platform');
    await write.call(this.host.platform, await this.imageBytes(target, s), target);
  }

  private defaultDir(s: ExportSettings): string | null {
    const doc = this.host.docPath();
    if (s.general.folder === 'custom' && s.general.customFolder) return s.general.customFolder;
    if (s.general.folder === 'last' && this.lastDir) return this.lastDir;
    return doc ? dirname(doc) : this.lastDir ?? this.host.folder();
  }

  private async exists(p: string): Promise<boolean> {
    try {
      return (await this.host.platform.stat(p)) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Run an export. `mode`:
   *  - 'ask'       save panel (default folder per settings)
   *  - 'previous'  repeat the last export's kind; panel starts at its path
   *  - 'overwrite' repeat the last export to the same path without a panel (confirmed)
   */
  async export(kind: string | null, mode: 'ask' | 'previous' | 'overwrite' = 'ask'): Promise<boolean> {
    if (mode !== 'ask') {
      if (!this.last) {
        this.host.notify('Nothing exported yet in this session.', 'info');
        return false;
      }
      kind = this.last.kind;
    }
    if (!kind) return false;
    const ex = this.exporter(kind);
    if (!ex) {
      this.host.notify(`Unknown export format: ${kind}`, 'error');
      return false;
    }
    const why = ex.unavailable?.();
    if (why) {
      this.host.notify(why, 'error');
      return false;
    }
    const s = this.host.exportSettings();
    let target: string | null;
    if (ex.noTarget) {
      target = '';
    } else if (mode === 'overwrite') {
      target = this.last!.path;
      if (!s.general.noOverwriteWarning && (await this.exists(target))) {
        const r = await this.host.confirmOverwrite(target);
        if (r.choice === 'cancel') return false;
        if (r.dontAsk) this.host.updateExportSettings(migrateExportSettings({ ...s, general: { ...s.general, noOverwriteWarning: true } }));
        if (r.choice === 'keep-both') target = await keepBothPath(target, (p) => this.exists(p));
      }
    } else {
      const doc = this.host.docPath();
      const stem = doc ? stripExt(basename(doc)) : documentTitle(this.host.markdown(), null);
      const prev = mode === 'previous' ? this.last!.path : null;
      const dir = prev ? dirname(prev) : this.defaultDir(s);
      const any = ex.extensions[0] === '*';
      const name = prev ? basename(prev) : any ? stem : `${stem}.${ex.extensions[0]}`;
      target = await this.host.platform.saveFileDialog({
        defaultPath: dir ? join(dir, name) : name,
        filters: any ? undefined : [{ name: ex.label, extensions: ex.extensions }],
      });
    }
    if (target === null || (!target && !ex.noTarget)) return false;
    // Panels on some platforms return the bare name: add the format's extension.
    if (target && ex.extensions[0] !== '*' && !ex.extensions.some((e) => target!.toLowerCase().endsWith(`.${e}`))) target = `${target}.${ex.extensions[0]}`;
    try {
      await ex.run(target);
    } catch (e) {
      if (e instanceof ExportAbortedError) return false;
      const msg = e instanceof ImageTooLargeError ? e.message : `Export failed: ${e instanceof Error ? e.message : String(e)}`;
      this.host.notify(msg, 'error');
      return false;
    }
    this.last = { kind, path: target };
    if (target) this.lastDir = dirname(target);
    if (target) this.afterExport(target, s);
    else this.host.notify(`${ex.label}: done`, 'success');
    void this.runAfterExport(target, s);
    return true;
  }

  /** Export settings › "Run command after export". */
  private async runAfterExport(target: string, s: ExportSettings): Promise<void> {
    const cmd = s.general.runAfterExport.trim();
    const run = extras(this.host.platform).runExportCommand;
    if (!cmd || !run) return;
    const doc = this.host.docPath();
    try {
      await run.call(this.host.platform, cmd, this.commandVars(target || null, s), null, doc ? dirname(doc) : this.host.folder(), 120_000);
    } catch (e) {
      this.host.notify(`Command after export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  private afterExport(target: string, s: ExportSettings): void {
    const x = extras(this.host.platform);
    const reveal = x.revealInFolder ? () => void x.revealInFolder!.call(this.host.platform, target).catch(() => undefined) : undefined;
    const open = x.openExportedFile ? () => void x.openExportedFile!.call(this.host.platform, target).catch(() => undefined) : undefined;
    if (s.general.afterExport === 'open' && open) open();
    else if (s.general.afterExport === 'reveal' && reveal) reveal();
    this.host.notify(`Exported ${basename(target)}`, 'success', reveal ? { label: 'Show', run: reveal } : undefined);
  }
}

/**
 * Route the Pandoc exporters (#81) through the shared pipeline as `pandoc:<format>`
 * kinds, so they get the default folder, Export with Previous / Overwrite and the
 * after-export action. `exportWithPandoc` keeps its own progress/watchdog logic.
 */
export function registerPandocExporters(
  c: ExportController,
  opts: { pandocPath: () => string; title: () => string; progress: (m: string, abort?: () => void) => () => void },
): void {
  for (const format of Object.keys(PANDOC_FORMATS) as PandocFormat[]) {
    const spec = PANDOC_FORMATS[format];
    c.register(`pandoc:${format}`, (h) => ({
      label: spec.filterName,
      extensions: [spec.ext],
      unavailable: () => (extras(h.platform).pandocExport ? null : `${spec.label} export needs Pandoc and the desktop app.`),
      run: async (target) => {
        const x = extras(h.platform);
        let error = '';
        let aborted = false;
        const doc = h.docPath();
        const ok = await exportWithPandoc(format, {
          platform: {
            saveFileDialog: async () => target,
            pandocExport: x.pandocExport ? (md, out, o) => x.pandocExport!.call(h.platform, md, out, o) : undefined,
            pandocAbort: x.pandocAbort ? (id) => x.pandocAbort!.call(h.platform, id) : undefined,
          },
          options: migrateExportSettings(h.exportSettings()).pandoc[format],
          onAborted: () => {
            aborted = true;
          },
          markdown: h.markdown(),
          name: stripExt(basename(target)),
          docDir: doc ? dirname(doc) : null,
          fallbackDir: h.folder(),
          title: opts.title(),
          pandocPath: opts.pandocPath(),
          progress: opts.progress,
          notify: (m, kind) => {
            if (kind === 'error') error = m;
            else if (kind === 'warning') h.notify(m, 'warning');
          },
        });
        if (!ok && aborted) throw new ExportAbortedError();
        if (!ok) throw new Error(error.replace(/^Export failed: /, '') || `${spec.label} export failed`);
      },
    }));
  }
}

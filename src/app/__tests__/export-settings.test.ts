import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../contracts';
import { ExportController, keepBothPath, type ExportHost } from '../export-actions';
import { checkImageSize, imageDimensions, imageFormatForPath, ImageTooLargeError, qualitySettings } from '../export-image';
import { DEFAULT_EXPORT, expandVars, frontMatter, migrateExportSettings, pageCss, pandocArgsPreview, PANDOC_FORMAT_FIELDS, PANDOC_FORMAT_IDS, paperSizeMm, resolveMeta, type ExportSettings } from '../export-settings';
import { printPageCss, withPrintPageCss } from '../../platform/common';
import { buildPlainHtml } from '../export';
import { migrateSettings } from '../settings';

describe('export settings', () => {
  it('migrates garbage to defaults and clamps values', () => {
    expect(migrateExportSettings(undefined)).toEqual(DEFAULT_EXPORT);
    const m = migrateExportSettings({ general: { folder: 'nope', afterExport: 'open' }, image: { width: 99999, quality: 'ultra', format: 'jpeg' }, pdf: { page: { paper: 'Letter', margins: { top: -4 } }, pageBreaks: 'h2' } });
    expect(m.general.folder).toBe('same');
    expect(m.general.afterExport).toBe('open');
    expect(m.image).toMatchObject({ width: 4000, quality: 'high', format: 'jpeg' });
    expect(m.pdf.page.paper).toBe('Letter');
    expect(m.pdf.page.margins.top).toBe(0);
    expect(m.pdf.pageBreaks).toBe('h2');
  });
  it('rides along in MarginSettings', () => {
    expect(migrateSettings({}).export).toEqual(DEFAULT_EXPORT);
    expect(migrateSettings({ export: { html: { theme: 'night' } } }).export.html.theme).toBe('night');
  });
  it('paper sizes honour orientation and custom size', () => {
    const page = migrateExportSettings({}).pdf.page;
    expect(paperSizeMm(page)).toEqual([210, 297]);
    expect(paperSizeMm({ ...page, orientation: 'landscape' })).toEqual([297, 210]);
    expect(paperSizeMm({ ...page, paper: 'custom', custom: [100, 150] })).toEqual([100, 150]);
    expect(pageCss({ ...page, paper: 'Letter' }, 'h1')).toContain('size: 215.9mm 279.4mm');
    expect(pageCss(page, 'h1')).toContain('break-before: page');
    expect(pageCss(page, 'none')).not.toContain('break-before');
  });
});

describe('YAML overrides and variables', () => {
  const md = '---\ntitle: "From YAML"\nauthor: Ann\ntypora-footer: unset\ntags: [a, b]\n---\n# Heading\n';
  it('reads flat front matter', () => {
    expect(frontMatter(md)).toMatchObject({ title: 'From YAML', author: 'Ann', 'typora-footer': 'unset' });
    expect(frontMatter('# no yaml')).toEqual({});
  });
  it('YAML beats settings; "unset" clears; disabled overrides are ignored', () => {
    const base = { title: 'Heading', author: 'Settings', header: 'H', footer: 'F' };
    expect(resolveMeta(md, base, true)).toMatchObject({ title: 'From YAML', author: 'Ann', header: 'H', footer: '', keywords: 'a, b' });
    expect(resolveMeta(md, base, false)).toMatchObject({ title: 'Heading', author: 'Settings', footer: 'F' });
  });
  it('expands known variables and keeps unknown ones', () => {
    expect(expandVars('${title} – ${pageNo}/${totalPages} ${nope}', { title: 'T' })).toBe('T – ${pageNo}/${totalPages} ${nope}');
  });
});

describe('print page CSS (web / non-mac PDF)', () => {
  it('builds @page geometry and margin boxes with page counters', () => {
    const css = printPageCss({ paper: { width: 612, height: 792, margins: { top: 36, right: 30, bottom: 36, left: 30 } }, footer: 'Page ${pageNo} of ${totalPages}', header: '<b>"T"</b>' });
    expect(css).toContain('size: 612pt 792pt');
    expect(css).toContain('@bottom-center { content: "Page " counter(page) " of " counter(pages)');
    expect(css).toContain('@top-center { content: "\\"T\\""');
    expect(printPageCss({})).toBe('');
    expect(withPrintPageCss('<html><head></head></html>', { header: 'x' })).toContain('<style data-margin-page>');
  });
});

describe('image export helpers', () => {
  it('quality presets, size limits and formats', () => {
    expect(qualitySettings('best').scale).toBe(2);
    expect(qualitySettings('medium').jpeg).toBeLessThan(qualitySettings('high').jpeg);
    expect(() => checkImageSize(800, 40000)).toThrow(ImageTooLargeError);
    expect(() => checkImageSize(12000, 12000)).toThrow(/too large/);
    expect(() => checkImageSize(1600, 20000)).not.toThrow();
    expect(imageFormatForPath('/a/b.JPG')).toBe('jpeg');
    expect(imageFormatForPath('/a/b.png')).toBe('png');
  });
  it('reads PNG / JPEG dimensions', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 1, 0x2c]);
    expect(imageDimensions(png)).toEqual({ format: 'png', width: 800, height: 300 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageDimensions(jpg)).toEqual({ format: 'jpeg', width: 200, height: 100 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('plain HTML', () => {
  it('has no styles', () => {
    const html = buildPlainHtml({ title: 'T', body: '<p>x</p>', appendHead: '<meta name="a">' });
    expect(html).not.toContain('<style');
    expect(html).toContain('<meta name="a">');
  });
});

function fakeHost(over: Partial<ExportHost> = {}) {
  const written: { path: string; html: string }[] = [];
  const files = new Set<string>();
  let settings: ExportSettings = migrateExportSettings({});
  const dialogs: (string | null)[] = [];
  const platform = {
    saveFileDialog: vi.fn(async () => dialogs.shift() ?? null),
    exportHtml: vi.fn(async (html: string, path: string) => {
      written.push({ path, html });
      files.add(path);
    }),
    exportPdf: vi.fn(async () => undefined),
    stat: vi.fn(async (p: string) => (files.has(p) ? { name: p, path: p, isDir: false, mtime: 0, size: 1 } : null)),
  } as unknown as Platform;
  const notes: string[] = [];
  const host: ExportHost = {
    platform,
    exportSettings: () => settings,
    updateExportSettings: (n) => (settings = n),
    markdown: () => '# Doc\n\ntext\n',
    docPath: () => '/notes/Doc.md',
    folder: () => '/notes',
    renderBody: () => '<h1 id="doc">Doc</h1><p>text</p>',
    themeCss: () => ':root{}',
    extraCss: async () => '',
    notify: (m) => void notes.push(m),
    confirmOverwrite: vi.fn(async () => ({ choice: 'overwrite' as const, dontAsk: false })),
    ...over,
  };
  return { host, platform, written, files, dialogs, notes, get settings() { return settings; } };
}

describe('ExportController: previous / overwrite', () => {
  it('needs a previous export first', async () => {
    const f = fakeHost();
    const c = new ExportController(f.host);
    expect(await c.export(null, 'previous')).toBe(false);
    expect(f.notes[0]).toMatch(/Nothing exported/);
  });
  it('previous reopens the panel at the last path; overwrite skips it after confirming', async () => {
    const f = fakeHost();
    const c = new ExportController(f.host);
    f.dialogs.push('/out/Doc.html');
    expect(await c.export('html')).toBe(true);
    expect(f.platform.saveFileDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: '/notes/Doc.html' }));
    f.dialogs.push('/out/Doc v2.html');
    expect(await c.export(null, 'previous')).toBe(true);
    expect(f.platform.saveFileDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: '/out/Doc.html' }));
    expect(await c.export(null, 'overwrite')).toBe(true);
    expect(f.platform.saveFileDialog).toHaveBeenCalledTimes(2);
    expect(f.host.confirmOverwrite).toHaveBeenCalledWith('/out/Doc v2.html');
    expect(f.written.map((w) => w.path)).toEqual(['/out/Doc.html', '/out/Doc v2.html', '/out/Doc v2.html']);
  });
  it('cancel / keep both / do-not-ask-again', async () => {
    const answers = [
      { choice: 'cancel' as const, dontAsk: false },
      { choice: 'keep-both' as const, dontAsk: true },
    ];
    const f = fakeHost({ confirmOverwrite: vi.fn(async () => answers.shift()!) });
    const c = new ExportController(f.host);
    f.dialogs.push('/out/Doc.html');
    await c.export('html');
    expect(await c.export(null, 'overwrite')).toBe(false);
    expect(await c.export(null, 'overwrite')).toBe(true);
    expect(f.written[f.written.length - 1].path).toBe('/out/Doc 2.html');
    expect(f.settings.general.noOverwriteWarning).toBe(true);
    await c.export(null, 'overwrite');
    expect(f.host.confirmOverwrite).toHaveBeenCalledTimes(2);
  });
  it('default folder follows the settings', async () => {
    const f = fakeHost();
    f.host.updateExportSettings(migrateExportSettings({ general: { folder: 'custom', customFolder: '/exports' } }));
    const c = new ExportController(f.host);
    await c.export('pdf');
    expect(f.platform.saveFileDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: '/exports/Doc.pdf' }));
  });
  it('keepBothPath finds a free name', async () => {
    const taken = new Set(['/a/x 2.pdf']);
    expect(await keepBothPath('/a/x.pdf', async (p) => taken.has(p))).toBe('/a/x 3.pdf');
  });
});

describe('heading anchors', () => {
  it('maps slug / text fragments to heading ids and leaves unknown ones', async () => {
    const { linkHeadingAnchors, headingSlug } = await import('../export');
    expect(headingSlug('The End!  ok')).toBe('the-end--ok');
    const out = linkHeadingAnchors('<h1 id="b1">The End</h1><a href="#the-end">a</a><a href="#The%20End">b</a><a href="#nope">c</a><a href="#b1">d</a>');
    expect(out.match(/href="#b1"/g)).toHaveLength(3);
    expect(out).toContain('href="#nope"');
  });
});

describe('Pandoc exporters in the shared pipeline', () => {
  it('preflights a missing backend, then exports + repeats with previous/overwrite', async () => {
    const { registerPandocExporters } = await import('../export-actions');
    const f = fakeHost();
    const c = new ExportController(f.host);
    registerPandocExporters(c, { pandocPath: () => '', title: () => 'Doc', progress: () => () => undefined });
    expect(await c.export('pandoc:docx')).toBe(false);
    expect(f.notes[f.notes.length - 1]).toMatch(/needs Pandoc/);
    expect(f.platform.saveFileDialog).not.toHaveBeenCalled();
    const calls: string[] = [];
    (f.platform as unknown as { pandocExport: unknown }).pandocExport = vi.fn(async (_md: string, out: string) => {
      calls.push(out);
      f.files.add(out);
      return '';
    });
    f.dialogs.push('/out/Doc');
    expect(await c.export('pandoc:docx')).toBe(true);
    expect(calls).toEqual(['/out/Doc.docx']);
    expect(await c.export(null, 'overwrite')).toBe(true);
    expect(calls).toEqual(['/out/Doc.docx', '/out/Doc.docx']);
    expect(f.host.confirmOverwrite).toHaveBeenCalledWith('/out/Doc.docx');
    (f.platform as unknown as { pandocExport: unknown }).pandocExport = vi.fn(async () => {
      throw new Error('pandoc exited 1: boom');
    });
    expect(await c.export(null, 'overwrite')).toBe(false);
    expect(f.notes[f.notes.length - 1]).toMatch(/boom/);
  });
});

describe('pandoc options (#90)', () => {
  it('default to unset for every format and are validated', () => {
    const d = migrateExportSettings({});
    expect(Object.keys(d.pandoc).sort()).toEqual([...PANDOC_FORMAT_IDS].sort());
    expect(d.pandoc.docx).toEqual({ referenceDoc: '', template: '', css: '', epubChapterLevel: 0, extraArguments: '' });
    const m = migrateExportSettings({ pandoc: { epub: { css: 'a.css', epubChapterLevel: '9' }, docx: { referenceDoc: 5 }, bogus: {} } });
    expect(m.pandoc.epub.css).toBe('a.css');
    expect(m.pandoc.epub.epubChapterLevel).toBe(6);
    expect(m.pandoc.docx.referenceDoc).toBe('');
    expect('bogus' in m.pandoc).toBe(false);
  });

  it('fields follow Typora per-format table', () => {
    expect(PANDOC_FORMAT_FIELDS.docx).toEqual(['referenceDoc']);
    expect(PANDOC_FORMAT_FIELDS.odt).toEqual(['template']);
    expect(PANDOC_FORMAT_FIELDS.epub).toEqual(['css', 'epubChapterLevel']);
    for (const f of ['rtf', 'latex', 'mediawiki', 'rst', 'textile', 'opml'] as const) expect(PANDOC_FORMAT_FIELDS[f]).toEqual(['extraArguments']);
  });

  it('arguments preview mirrors the native argv', () => {
    const o = { referenceDoc: 'my ref.docx', template: '', css: '', epubChapterLevel: 0, extraArguments: '' };
    expect(pandocArgsPreview('docx', o)).toBe('-f markdown -t docx -o ${outputPath} --reference-doc "my ref.docx"');
    expect(pandocArgsPreview('epub', { ...o, referenceDoc: '', css: 'e.css', epubChapterLevel: 2 })).toBe('-f markdown -t epub -o ${outputPath} --css e.css --epub-chapter-level=2');
    expect(pandocArgsPreview('latex', { ...o, referenceDoc: '', extraArguments: '--toc' })).toBe('-f markdown -t latex -s -o ${outputPath} --toc');
  });
});

describe('Pandoc Abort in the shared pipeline (#90)', () => {
  it('aborted export: no error notice, settings options forwarded, not recorded as previous', async () => {
    const { registerPandocExporters } = await import('../export-actions');
    const f = fakeHost();
    f.host.updateExportSettings(migrateExportSettings({ pandoc: { docx: { referenceDoc: '/t/ref.docx' } } }));
    const c = new ExportController(f.host);
    let abort: (() => void) | undefined;
    registerPandocExporters(c, { pandocPath: () => '', title: () => 'Doc', progress: (_m, a) => ((abort = a), () => undefined) });
    let reject: (e: Error) => void = () => {};
    const seen: unknown[] = [];
    Object.assign(f.platform, {
      pandocExport: vi.fn((_md: string, _out: string, o: unknown) => {
        seen.push(o);
        return new Promise<string>((_, r) => (reject = r));
      }),
      pandocAbort: vi.fn(async () => (reject(new Error('Export aborted')), true)),
    });
    f.dialogs.push('/out/Doc.docx');
    const p = c.export('pandoc:docx');
    for (let i = 0; i < 10 && !abort; i++) await new Promise((r) => setTimeout(r, 0));
    abort!();
    expect(await p).toBe(false);
    expect(f.notes).toEqual([]);
    expect((seen[0] as { options: { referenceDoc: string } }).options.referenceDoc).toBe('/t/ref.docx');
    expect(c.last).toBeNull();
  });
});

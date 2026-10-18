import { expect, test, type Page } from '@playwright/test';
import { boot, queueDialog, ROOT } from './app-helpers';

/** Parity epic #95 — one test per surface (titles carry the surface id for the ledger). */

const run = (page: Page, id: string) => page.evaluate((id) => window.__margin!.run(id as never), id);
const lastExport = (page: Page) =>
  page.evaluate(() => {
    const e = window.__MARGIN_WEB__!.exports.at(-1)!;
    return { kind: e.kind, path: e.path, html: e.html, opts: e.opts ?? null, bytes: e.bytes ? Array.from(e.bytes.subarray(0, 32)) : null, size: e.bytes?.length ?? 0 };
  });
const exportCount = (page: Page) => page.evaluate(() => window.__MARGIN_WEB__!.exports.length);
const setExport = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((patch) => {
    const app = window.__margin!;
    const cur = app.settings.export as unknown as Record<string, Record<string, unknown>>;
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(patch)) next[k] = { ...cur[k], ...(v as object) };
    app.updateSettings({ export: next as never });
  }, patch);
const openDoc = (page: Page, path: string, md: string) =>
  page.evaluate(
    async ({ path, md }) => {
      await window.__MARGIN_WEB__!.writeTextFile(path, md);
      await window.__margin!.doc.open(path);
    },
    { path, md },
  );

test('export.pdf-options: PDF options: paper size/margins, header/footer, page breaks, bookmarks, internal links', async ({ page }) => {
  await boot(page);
  await openDoc(page, `${ROOT}/Report.md`, '# Report\n\nSee [the end](#the-end).\n\n## Middle\n\ntext\n\n# The End\n\ndone\n');
  await setExport(page, {
    pdf: { page: { paper: 'Letter', orientation: 'portrait', custom: [210, 297], margins: { top: 20, right: 15, bottom: 20, left: 15 } }, header: '${title}', footer: '${pageNo} / ${totalPages}', pageBreaks: 'h1', outline: true, author: 'Ann' },
  });
  await queueDialog(page, `${ROOT}/Report.pdf`);
  await run(page, 'exportPdf');
  await expect(page.locator('.toast').last()).toContainText('Exported Report.pdf');
  const e = await lastExport(page);
  expect(e.kind).toBe('pdf');
  expect(e.opts.paper.width).toBeCloseTo(612, 0);
  expect(e.opts.paper.height).toBeCloseTo(792, 0);
  expect(e.opts.paper.margins.top).toBeCloseTo(56.69, 1);
  expect(e.opts.header).toBe('Report');
  expect(e.opts.footer).toBe('${pageNo} / ${totalPages}');
  expect(e.opts.meta).toMatchObject({ title: 'Report', author: 'Ann' });
  expect(e.opts.outline.map((o: { level: number; text: string }) => [o.level, o.text])).toEqual([[1, 'Report'], [2, 'Middle'], [1, 'The End']]);
  // internal link target is one of the outline ids
  const ids = e.opts.outline.map((o: { id: string }) => o.id);
  const href = /href="#([^"]+)"/.exec(e.html)?.[1];
  expect(href && ids.includes(href)).toBeTruthy();
  expect(e.html).toContain('break-before: page');

  // Edge: YAML overrides the title/footer; bookmarks + breaks off.
  await openDoc(page, `${ROOT}/Yaml.md`, '---\ntitle: From YAML\nfooter: unset\n---\n# Heading\n');
  await setExport(page, { pdf: { outline: false, pageBreaks: 'none' } });
  await queueDialog(page, `${ROOT}/Yaml.pdf`);
  await run(page, 'exportPdf');
  await expect.poll(async () => (await lastExport(page)).path).toBe(`${ROOT}/Yaml.pdf`);
  const y = await lastExport(page);
  expect(y.opts.header).toBe('From YAML');
  expect(y.opts.footer).toBeUndefined();
  expect(y.opts.outline).toBeUndefined();
  expect(y.html).not.toContain('break-before: page');
});

test('export.settings: Export settings pane: per-format options, theme, default folder, after-export action, YAML overrides', async ({ page }) => {
  await boot(page);
  await run(page, 'exportSettings');
  const pane = page.locator('.pref-section[data-section=export]');
  await expect(pane).toBeVisible();
  await expect(page.locator('.pref-tab[data-section=export]')).toHaveAttribute('aria-selected', 'true');
  await pane.locator('select[data-export="general.afterExport"]').selectOption('open');
  await pane.locator('select[data-export="general.folder"]').selectOption('custom');
  await pane.locator('input[data-export="general.customFolder"]').fill('/Users/demo/Exports');
  await pane.locator('input[data-export="general.customFolder"]').blur();
  await pane.locator('select[data-export="html.theme"]').selectOption('night');
  await pane.locator('input[data-export="general.allowYamlOverrides"]').uncheck();
  await pane.locator('select[data-page="paper"]').selectOption('Legal');
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.export.pdf.page.paper)).toBe('Legal');
  const s = await page.evaluate(() => window.__margin!.settings.export);
  expect(s.general).toMatchObject({ afterExport: 'open', folder: 'custom', customFolder: '/Users/demo/Exports', allowYamlOverrides: false });
  expect(s.html.theme).toBe('night');
  await page.keyboard.press('Escape');

  // The settings drive the next export: default folder, theme, after-export action.
  await page.evaluate(() => {
    (window as unknown as { __dlg: unknown[] }).__dlg = [];
    const w = window.__MARGIN_WEB__!;
    w.dialogHook = (_kind, opts) => {
      (window as unknown as { __dlg: unknown[] }).__dlg.push(opts);
      return '/Users/demo/Exports/Welcome.html';
    };
  });
  await run(page, 'exportHtml');
  await expect(page.locator('.toast').last()).toContainText('Exported Welcome.html');
  const dlg = await page.evaluate(() => (window as unknown as { __dlg: { defaultPath: string }[] }).__dlg[0]);
  expect(dlg.defaultPath).toBe('/Users/demo/Exports/Welcome.md'.replace('.md', '.html'));
  const e = await lastExport(page);
  expect(e.html).toContain('color-scheme: dark');
  expect(await page.evaluate(() => window.__MARGIN_WEB__!.openedExports)).toEqual(['/Users/demo/Exports/Welcome.html']);

  // Persisted across reloads.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  expect(await page.evaluate(() => window.__margin!.settings.export.general.afterExport)).toBe('open');
});

test('export.previous: Export with Previous / Export and Overwrite with Previous', async ({ page }) => {
  await boot(page);
  await run(page, 'exportPrevious');
  await expect(page.locator('.toast').last()).toContainText('Nothing exported yet');
  await queueDialog(page, `${ROOT}/Out/Welcome.html`);
  await run(page, 'exportHtmlPlain');
  await expect.poll(() => exportCount(page)).toBe(1);
  // With previous: same kind, panel starts at the last path.
  await queueDialog(page, `${ROOT}/Out/Welcome copy.html`);
  await run(page, 'exportPrevious');
  await expect.poll(() => exportCount(page)).toBe(2);
  expect((await lastExport(page)).html).not.toContain('<style');
  // Overwrite: confirm dialog → Cancel writes nothing.
  void run(page, 'exportOverwrite');
  const dlg = page.locator('.export-overwrite');
  await expect(dlg).toContainText('Welcome copy.html');
  await dlg.locator('button[data-id=cancel]').click();
  await expect(dlg).toBeHidden();
  expect(await exportCount(page)).toBe(2);
  // Keep Both → "name 2".
  void run(page, 'exportOverwrite');
  await dlg.locator('button[data-id=keep-both]').click();
  await expect.poll(async () => (await lastExport(page)).path).toBe(`${ROOT}/Out/Welcome copy 2.html`);
  // Overwrite + "Do not ask again" → later overwrites skip the dialog and the panel.
  void run(page, 'exportOverwrite');
  await dlg.locator('input[data-id=dont-ask]').check();
  await dlg.locator('button[data-id=overwrite]').click();
  await expect.poll(() => exportCount(page)).toBe(4);
  expect((await lastExport(page)).path).toBe(`${ROOT}/Out/Welcome copy 2.html`);
  await run(page, 'exportOverwrite');
  await expect.poll(() => exportCount(page)).toBe(5);
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => window.__margin!.settings.export.general.noOverwriteWarning)).toBe(true);
});

test('menu.file.page-setup: File › Page Setup (paper size for print/PDF)', async ({ page }) => {
  await boot(page);
  void run(page, 'pageSetup');
  const dlg = page.locator('.page-setup');
  await expect(dlg).toBeVisible();
  await dlg.locator('select[data-page=paper]').selectOption('custom');
  await expect(dlg.locator('.page-custom')).toBeVisible();
  await dlg.locator('input[data-page=customWidth]').fill('100');
  await dlg.locator('input[data-page=customWidth]').dispatchEvent('change');
  await dlg.locator('button[data-id=cancel]').click();
  expect(await page.evaluate(() => window.__margin!.settings.export.pdf.page.paper)).toBe('A4');

  void run(page, 'pageSetup');
  await dlg.locator('select[data-page=paper]').selectOption('Letter');
  await dlg.locator('select[data-page=orientation]').selectOption('landscape');
  await dlg.locator('input[data-page=marginLeft]').fill('25');
  await dlg.locator('input[data-page=marginLeft]').dispatchEvent('change');
  await expect(dlg.locator('.page-size')).toHaveText('279.4 × 215.9 mm');
  await dlg.locator('button[data-id=ok]').click();
  const pg = await page.evaluate(() => window.__margin!.settings.export.pdf.page);
  expect(pg).toMatchObject({ paper: 'Letter', orientation: 'landscape', margins: { left: 25 } });
  // Print applies it as an @page rule; PDF export passes it as paper geometry.
  await run(page, 'print');
  await expect.poll(() => page.evaluate(() => document.getElementById('margin-print-page')?.textContent ?? '')).toContain('size: 279.4mm 215.9mm');
  await queueDialog(page, `${ROOT}/Welcome.pdf`);
  await run(page, 'exportPdf');
  await expect.poll(async () => (await lastExport(page)).kind).toBe('pdf');
  expect((await lastExport(page)).opts.paper.width).toBeCloseTo(792, 0);
});

test('export.html-plain: Export › HTML (without Styles)', async ({ page }) => {
  await boot(page);
  await setExport(page, { htmlPlain: { appendHead: '<link rel="stylesheet" href="site.css">', appendBody: '<footer>${title}</footer>' } });
  await queueDialog(page, `${ROOT}/Plain.html`);
  await run(page, 'exportHtmlPlain');
  await expect(page.locator('.toast').last()).toContainText('Exported Plain.html');
  const e = await lastExport(page);
  expect(e.html).not.toContain('<style');
  expect(e.html).not.toContain('--margin-accent');
  expect(e.html).toContain('<link rel="stylesheet" href="site.css">');
  expect(e.html).toContain('<footer>Welcome to Margin</footer>');
  expect(e.html).toMatch(/<h1 id="[^"]+">Welcome to Margin<\/h1>/);
  expect(e.html).toContain('<em>emphasis</em>');
  expect(e.html).not.toContain('md-meta');
  // Cancelled save panel: nothing written.
  await queueDialog(page, null);
  expect(await run(page, 'exportHtmlPlain')).toBe(false);
  expect(await exportCount(page)).toBe(1);
});

test('export.image: Export › Image (PNG/JPEG of the whole document)', async ({ page }) => {
  await boot(page);
  await setExport(page, { image: { width: 640, quality: 'high', format: 'png', fontSize: 16 } });
  await queueDialog(page, `${ROOT}/Welcome.png`);
  await run(page, 'exportImage');
  await expect(page.locator('.toast').last()).toContainText('Exported Welcome.png', { timeout: 15_000 });
  const png = await lastExport(page);
  expect(png.kind).toBe('image');
  expect(png.bytes!.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const dims = await page.evaluate(async () => {
    const m = await import('/src/app/export-image.ts');
    const b = window.__MARGIN_WEB__!.exports.at(-1)!.bytes!;
    const d = m.imageDimensions(b);
    // Non-blank: decode and look for dark (text) pixels.
    const bmp = await createImageBitmap(new Blob([b as BlobPart], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, Math.min(bmp.height, 400)).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 200) dark++;
    return { ...d, dark };
  });
  expect(dims.width).toBe(640);
  expect(dims.height).toBeGreaterThan(400);
  expect(dims.dark).toBeGreaterThan(100);
  // .jpg target → JPEG; Best quality doubles the pixels.
  await setExport(page, { image: { quality: 'best' } });
  await queueDialog(page, `${ROOT}/Welcome.jpg`);
  await run(page, 'exportImage');
  await expect.poll(async () => (await lastExport(page)).path).toBe(`${ROOT}/Welcome.jpg`);
  const jpg = await lastExport(page);
  expect(jpg.bytes!.slice(0, 2)).toEqual([0xff, 0xd8]);
  // Too large: a very long document at 4000px Best is refused with a clear message.
  await openDoc(page, `${ROOT}/Long.md`, Array.from({ length: 400 }, (_, i) => `Paragraph ${i}`).join('\n\n') + '\n');
  await setExport(page, { image: { width: 4000, quality: 'best' } });
  const before = await exportCount(page);
  await queueDialog(page, `${ROOT}/Long.png`);
  expect(await run(page, 'exportImage')).toBe(false);
  await expect(page.locator('.toast').last()).toContainText('too large');
  expect(await exportCount(page)).toBe(before);
});

type Stubbed = { pandocExport?: unknown; pandocImport?: unknown; runExportCommand?: unknown; __calls?: unknown[] };

test('export.pandoc: Export via Pandoc: docx/odt/rtf/epub/latex/mediawiki/rst/textile/opml', async ({ page }) => {
  await boot(page);
  // Web build: no Pandoc backend → clear error before any save panel.
  await run(page, 'exportOdt');
  await expect(page.locator('.toast[data-kind=error]').last()).toContainText('needs Pandoc');
  await page.evaluate(() => {
    const w = window.__MARGIN_WEB__! as unknown as Stubbed;
    w.__calls = [];
    w.pandocExport = async (md: string, out: string, o: { format: string }) => {
      w.__calls!.push({ out, format: o.format, md: md.slice(0, 20) });
      await window.__MARGIN_WEB__!.writeTextFile(out, 'converted');
      return '';
    };
  });
  const cases: [string, string, string][] = [
    ['exportDocx', 'docx', 'docx'], ['exportOdt', 'odt', 'odt'], ['exportRtf', 'rtf', 'rtf'], ['exportEpub', 'epub', 'epub'], ['exportLatex', 'latex', 'tex'],
    ['exportMediawiki', 'mediawiki', 'wiki'], ['exportRst', 'rst', 'rst'], ['exportTextile', 'textile', 'textile'], ['exportOpml', 'opml', 'opml'],
  ];
  for (const [action, , ext] of cases) {
    await queueDialog(page, `${ROOT}/Out/Welcome.${ext}`);
    expect(await run(page, action)).toBe(true);
  }
  const calls = await page.evaluate(() => (window.__MARGIN_WEB__! as unknown as Stubbed).__calls as { out: string; format: string; md: string }[]);
  expect(calls.map((c) => c.format)).toEqual(cases.map((c) => c[1]));
  expect(calls.map((c) => c.out)).toEqual(cases.map((c) => `${ROOT}/Out/Welcome.${c[2]}`));
  expect(calls[0].md).toContain('# Welcome to Margin');
  // Pandoc exports join "Export and Overwrite with Previous" (confirmed, same path, no panel).
  void run(page, 'exportOverwrite');
  await page.locator('.export-overwrite button[data-id=overwrite]').click();
  await expect.poll(async () => (await page.evaluate(() => ((window.__MARGIN_WEB__! as unknown as Stubbed).__calls as unknown[]).length))).toBe(cases.length + 1);
  const last = await page.evaluate(() => ((window.__MARGIN_WEB__! as unknown as Stubbed).__calls as { out: string; format: string }[]).at(-1)!);
  expect(last).toMatchObject({ out: `${ROOT}/Out/Welcome.opml`, format: 'opml' });
});

test('export.pandoc-options (#90): per-format Pandoc options in Preferences, Abort button', async ({ page }) => {
  await boot(page);
  await run(page, 'exportSettings');
  const pane = page.locator('.pref-section[data-section=export]');
  const ref = pane.locator('input[data-export="pandoc.docx.referenceDoc"]');
  await ref.fill('/Users/demo/ref.docx');
  await ref.blur();
  await expect(pane.locator('input[data-export="pandoc.docx.args"]')).toHaveValue('-f markdown -t docx -o ${outputPath} --reference-doc /Users/demo/ref.docx');
  await pane.locator('select[data-export="pandoc.epub.epubChapterLevel"]').selectOption('2');
  await expect(pane.locator('[data-format=odt] input[data-export="pandoc.odt.template"]')).toBeVisible();
  await expect(pane.locator('[data-format=docx] input[data-export="pandoc.docx.extraArguments"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.export.pandoc.epub.epubChapterLevel)).toBe(2);
  await page.keyboard.press('Escape');

  // The export receives the options and shows Typora's progress text with an Abort button.
  await page.evaluate(() => {
    const w = window.__MARGIN_WEB__! as unknown as Stubbed & { pandocAbort?: unknown; __reject?: (e: Error) => void };
    w.__calls = [];
    w.pandocExport = (_md: string, out: string, o: unknown) => {
      w.__calls!.push({ out, o });
      return new Promise((_, reject) => (w.__reject = reject));
    };
    w.pandocAbort = async (id: string) => {
      w.__calls!.push({ abort: id });
      w.__reject!(new Error('Export aborted'));
      return true;
    };
  });
  await queueDialog(page, `${ROOT}/Out/Welcome.docx`);
  const done = run(page, 'exportDocx');
  const notice = page.locator('.toast', { hasText: 'Exporting file using Pandoc. This may take some time.' });
  await expect(notice).toBeVisible();
  await notice.locator('button.toast-action', { hasText: 'Abort' }).click();
  expect(await done).toBe(false);
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.toast[data-kind=error]')).toHaveCount(0);
  const calls = await page.evaluate(() => (window.__MARGIN_WEB__! as unknown as Stubbed).__calls as { o?: { options: { referenceDoc: string }; exportId: string }; abort?: string }[]);
  expect(calls[0].o!.options.referenceDoc).toBe('/Users/demo/ref.docx');
  expect(calls[1].abort).toBe(calls[0].o!.exportId);
});

test('export.custom: Custom export commands and "run command after export"', async ({ page }) => {
  await boot(page);
  await run(page, 'exportCustom');
  await expect(page.locator('.toast').last()).toContainText('No custom export commands');
  await run(page, 'exportSettings');
  const pane = page.locator('.pref-section[data-section=export]');
  await pane.locator('select[data-custom=template]').selectOption({ label: 'Markdown copy' });
  await expect(pane.locator('.custom-export')).toHaveCount(1);
  await pane.locator('button[data-custom=add]').click();
  await expect(pane.locator('.custom-export')).toHaveCount(2);
  const second = pane.locator('.custom-export').nth(1);
  await second.locator('input[data-custom=name]').fill('Shout');
  await second.locator('input[data-custom=name]').dispatchEvent('change');
  await second.locator('input[data-custom=command]').fill('tr a-z A-Z');
  await second.locator('input[data-custom=command]').dispatchEvent('change');
  await second.locator('input[data-custom=saveDialog]').uncheck();
  // Delete asks first.
  await second.locator('button[data-custom=delete]').click();
  await page.locator('.dialog-card button[data-id=cancel]').click();
  await expect(pane.locator('.custom-export')).toHaveCount(2);
  await pane.locator('input[data-export="general.runAfterExport"]').fill('echo done ${outputPath}');
  await pane.locator('input[data-export="general.runAfterExport"]').blur();
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.export.general.runAfterExport)).toBe('echo done ${outputPath}');
  const custom = await page.evaluate(() => window.__margin!.settings.export.custom);
  expect(custom.map((c) => [c.name, c.command, c.saveDialog])).toEqual([['Markdown copy', 'tee ${outputPath}', true], ['Shout', 'tr a-z A-Z', false]]);
  await page.keyboard.press('Escape');

  // Web build without a command runner: refused with a clear message.
  await page.evaluate((id) => window.__margin!.exports.export(`custom:${id}`), custom[0].id);
  await expect(page.locator('.toast[data-kind=error]').last()).toContainText('desktop app');

  await page.evaluate(() => {
    const w = window.__MARGIN_WEB__! as unknown as Stubbed;
    w.__calls = [];
    w.runExportCommand = async (command: string, vars: Record<string, string>, stdin: string | null, cwd: string | null) => {
      w.__calls!.push({ command, outputPath: vars.outputPath, title: vars.title, stdin: stdin?.slice(0, 20) ?? null, cwd });
      return { stdout: '', stderr: '' };
    };
  });
  // Custom export via the palette picker: save panel → ${outputPath}; Markdown on stdin.
  await queueDialog(page, `${ROOT}/Out/copy`);
  void run(page, 'exportCustom');
  await page.locator('.palette-input').fill('markdown copy');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => ((window.__MARGIN_WEB__! as unknown as Stubbed).__calls as unknown[]).length)).toBe(2);
  const calls = await page.evaluate(() => (window.__MARGIN_WEB__! as unknown as Stubbed).__calls as { command: string; outputPath: string; stdin: string | null; cwd: string; title: string }[]);
  expect(calls[0]).toMatchObject({ command: 'tee ${outputPath}', outputPath: `${ROOT}/Out/copy.md`, stdin: '# Welcome to Margin\n', cwd: ROOT, title: 'Welcome to Margin' });
  // …followed by the run-after-export command with the same variables.
  expect(calls[1]).toMatchObject({ command: 'echo done ${outputPath}', outputPath: `${ROOT}/Out/copy.md`, stdin: null });
  // No-save-panel export: outputPath is empty.
  await page.evaluate((id) => window.__margin!.exports.export(`custom:${id}`), custom[1].id);
  await expect.poll(() => page.evaluate(() => ((window.__MARGIN_WEB__! as unknown as Stubbed).__calls as unknown[]).length)).toBe(4);
  const c3 = await page.evaluate(() => ((window.__MARGIN_WEB__! as unknown as Stubbed).__calls as { command: string; outputPath: string }[])[2]);
  expect(c3).toMatchObject({ command: 'tr a-z A-Z', outputPath: '' });
  // A failing command surfaces its error.
  await page.evaluate(() => {
    (window.__MARGIN_WEB__! as unknown as Stubbed).runExportCommand = async () => {
      throw new Error('Command failed (exit status: 2):\nboom');
    };
  });
  await queueDialog(page, `${ROOT}/Out/copy2.md`);
  expect(await page.evaluate((id) => window.__margin!.exports.export(`custom:${id}`), custom[0].id)).toBe(false);
  await expect(page.locator('.toast[data-kind=error]').last()).toContainText('boom');
});

test('export.import: File › Import (docx/html/… via Pandoc)', async ({ page }) => {
  await boot(page);
  await page.evaluate(async (root) => {
    await window.__MARGIN_WEB__!.writeTextFile(`${root}/In/page.html`, '<html><body><h1>Imported Title</h1><p>Some <strong>bold</strong> and <a href="https://example.com">a link</a>.</p><ul><li>one</li><li>two</li></ul></body></html>');
    await window.__MARGIN_WEB__!.writeTextFile(`${root}/In/report.docx`, 'binary');
  }, ROOT);
  // HTML imports without Pandoc via the built-in converter, as a new unsaved document.
  await queueDialog(page, `${ROOT}/In/page.html`);
  expect(await run(page, 'import')).toBe(true);
  await expect(page.locator('.toast').last()).toContainText('Imported page.html');
  const md = await page.evaluate(() => window.__margin!.editor.getMarkdown());
  expect(md).toContain('# Imported Title');
  expect(md).toContain('**bold**');
  expect(md).toContain('[a link](https://example.com)');
  expect(md).toMatch(/[-*] one/);
  const state = await page.evaluate(() => ({ path: window.__margin!.doc.path, dirty: window.__margin!.doc.dirty }));
  expect(state).toEqual({ path: null, dirty: true });
  // docx needs Pandoc: clear failure with a way to configure it; nothing replaced.
  await page.evaluate(() => {
    const d = window.__margin!.doc as unknown as { confirmLeave: () => Promise<boolean> };
    d.confirmLeave = async () => true;
  });
  await queueDialog(page, `${ROOT}/In/report.docx`);
  expect(await run(page, 'import')).toBe(false);
  const err = page.locator('.toast[data-kind=error]').last();
  await expect(err).toContainText('Pandoc is needed');
  await expect(err).toContainText('Set Pandoc Path');
  expect(await page.evaluate(() => window.__margin!.editor.getMarkdown())).toContain('# Imported Title');
  await expect(page.locator('.toast[data-kind=info]', { hasText: 'Importing' })).toHaveCount(0);
  // With a Pandoc backend, its Markdown is used.
  await page.evaluate(() => {
    (window.__MARGIN_WEB__! as unknown as Stubbed).pandocImport = async (p: string) => `# From Pandoc\n\nconverted ${p.split('/').pop()}\n`;
  });
  await queueDialog(page, `${ROOT}/In/report.docx`);
  expect(await run(page, 'import')).toBe(true);
  expect(await page.evaluate(() => window.__margin!.editor.getMarkdown())).toBe('# From Pandoc\n\nconverted report.docx\n');
  // Unsupported type / cancelled panel.
  await queueDialog(page, `${ROOT}/notes.txt`);
  expect(await run(page, 'import')).toBe(false);
  await expect(page.locator('.toast[data-kind=error]').last()).toContainText('not a supported import format');
  await queueDialog(page, null);
  expect(await run(page, 'import')).toBe(false);
});

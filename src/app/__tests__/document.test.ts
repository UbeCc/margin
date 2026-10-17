import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EditorHandle } from '../../contracts';
import { DocumentController, applyEol, detectEol, normalizeEol, suggestName, type DocumentHost } from '../document';
import { countStats, miniMarkdownToHtml } from '../dev-stubs';
import { WebPlatform } from '../../platform/web';
import { buildExportHtml, documentTitle, needsKatex } from '../export';

function fakeEditor(): EditorHandle & { type(s: string): void } {
  let md = '';
  const cbs = new Set<() => void>();
  return {
    setMarkdown: (x) => void (md = x),
    getMarkdown: () => md,
    onChange: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
    onSelectionChange: () => () => undefined,
    getOutline: () => [],
    getActiveHeadingId: () => null,
    scrollToHeading: () => undefined,
    exec: () => false,
    getStats: () => countStats(md),
    setSourceMode: () => undefined,
    isSourceMode: () => false,
    updateSettings: () => undefined,
    renderHTML: () => '',
    focus: () => undefined,
    destroy: () => undefined,
    type(s: string) {
      md += s;
      cbs.forEach((cb) => cb());
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 150));

/** The real in-browser platform over an in-memory fs (no persistence, no key listener). */
async function memPlatform(files: Record<string, string>) {
  const p = new WebPlatform({ persist: false, seed: false, keyboardShortcuts: false, useFileSystemAccess: false, watchDelay: 5 });
  for (const [path, text] of Object.entries(files)) await p.writeTextFile(path, text);
  const dialogQueue: (string | null)[] = [];
  p.dialogHook = () => dialogQueue.shift() ?? null;
  const read = (path: string) => p.readTextFile(path);
  return Object.assign(p, { dialogQueue, read });
}

describe('line endings', () => {
  it('detects, normalizes, re-applies', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc');
    expect(applyEol('a\nb', '\r\n')).toBe('a\r\nb');
  });
});

describe('DocumentController', () => {
  let platform: Awaited<ReturnType<typeof memPlatform>>;
  let editor: ReturnType<typeof fakeEditor>;
  let host: DocumentHost;
  let doc: DocumentController;
  let answer: 'save' | 'discard' | 'cancel';
  let reload: boolean;

  beforeEach(async () => {
    platform = await memPlatform({ '/n/a.md': '# A\n', '/n/b.md': 'B\r\nline\r\n' });
    editor = fakeEditor();
    answer = 'cancel';
    reload = false;
    host = {
      platform,
      editor,
      askUnsaved: vi.fn(async () => answer),
      askReloadDirty: vi.fn(async () => reload),
      notify: vi.fn(),
      autoSave: () => ({ enabled: false, delay: 50 }),
      willLoad: vi.fn(),
      onState: vi.fn(),
      onOpened: vi.fn(),
      defaultDir: () => '/n',
    };
    doc = new DocumentController(host);
  });

  it('opens, edits (dirty), saves (clean)', async () => {
    await doc.open('/n/a.md');
    expect(editor.getMarkdown()).toBe('# A\n');
    expect(doc.dirty).toBe(false);
    editor.type('more');
    expect(doc.dirty).toBe(true);
    expect(platform.documentEdited).toBe(false); // setDocumentEdited is the app's job via onState
    await doc.save();
    expect(await platform.read('/n/a.md')).toBe('# A\nmore');
    expect(doc.dirty).toBe(false);
  });

  it('preserves CRLF on save and LF in the editor', async () => {
    await doc.open('/n/b.md');
    expect(editor.getMarkdown()).toBe('B\nline\n');
    editor.type('x');
    await doc.save();
    expect(await platform.read('/n/b.md')).toBe('B\r\nline\r\nx');
  });

  it('undoing back to the saved text clears dirty', async () => {
    await doc.open('/n/a.md');
    editor.type('z');
    editor.setMarkdown('# A\n');
    editor.type('');
    await flush();
    expect(doc.dirty).toBe(false);
  });

  it('asks before leaving a dirty doc; cancel keeps it', async () => {
    await doc.open('/n/a.md');
    editor.type('!');
    answer = 'cancel';
    expect(await doc.open('/n/b.md')).toBe(false);
    expect(doc.path).toBe('/n/a.md');
    answer = 'discard';
    expect(await doc.open('/n/b.md')).toBe(true);
    expect(await platform.read('/n/a.md')).toBe('# A\n');
  });

  it('save-as on untitled uses the dialog and starts watching', async () => {
    await doc.newDocument();
    editor.type('# Hello world\n');
    platform.dialogQueue.push('/n/hello.md');
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('/n/hello.md');
    expect(await platform.read('/n/hello.md')).toBe('# Hello world\n');
    expect(host.onOpened).toHaveBeenCalledWith('/n/hello.md');
  });

  it('reloads silently on external change when clean, asks when dirty', async () => {
    await doc.open('/n/a.md');
    platform.externalWrite('/n/a.md', '# A changed\n');
    await flush();
    expect(editor.getMarkdown()).toBe('# A changed\n');
    expect(host.askReloadDirty).not.toHaveBeenCalled();

    editor.type('mine');
    reload = false;
    platform.externalWrite('/n/a.md', '# A again\n');
    await flush();
    expect(host.askReloadDirty).toHaveBeenCalled();
    expect(editor.getMarkdown()).toBe('# A changed\nmine');
    expect(doc.dirty).toBe(true);
  });

  it('ignores the echo of its own save', async () => {
    await doc.open('/n/a.md');
    editor.type('x');
    await doc.save();
    await flush();
    expect(host.askReloadDirty).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).toBe('# A\nx');
  });

  it('auto-saves after the delay when enabled', async () => {
    host.autoSave = () => ({ enabled: true, delay: 30 });
    await doc.open('/n/a.md');
    editor.type('auto');
    await flush();
    expect(await platform.read('/n/a.md')).toBe('# A\nauto');
    expect(doc.dirty).toBe(false);
  });

  it('marks missing on delete and follows renames', async () => {
    await doc.open('/n/a.md');
    platform.externalRemove('/n/a.md');
    await flush();
    expect(doc.missing).toBe(true);
    doc.renamed('/n/a.md', '/n/c.md');
    expect(doc.path).toBe('/n/c.md');
  });

  it('toggling EOL marks dirty and toggling back cleans', async () => {
    await doc.open('/n/a.md');
    doc.setEol('\r\n');
    expect(doc.dirty).toBe(true);
    doc.setEol('\n');
    expect(doc.dirty).toBe(false);
  });

  it('suggests names from the first line', () => {
    expect(suggestName('# My: Notes?\n')).toBe('My Notes');
    expect(suggestName('')).toBe('Untitled');
  });
});

describe('export & stats', () => {
  it('builds a standalone HTML document', () => {
    const html = buildExportHtml({ title: 'T <x>', body: '<p>hi</p>', themeCss: ':root{--margin-bg:#fff}' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>T &lt;x&gt;</title>');
    expect(html).toContain('<article class="margin-doc">');
    expect(html).toContain('--margin-bg:#fff');
  });
  it('detects katex and titles', () => {
    expect(needsKatex('<span class="katex">')).toBe(true);
    expect(needsKatex('<p>katex</p>')).toBe(false);
    expect(documentTitle('intro\n# Big **Title**\n', 'f.md')).toBe('Big Title');
    expect(documentTitle('none', 'f.md')).toBe('f');
  });
  it('counts CJK characters as words', () => {
    expect(countStats('hello world').words).toBe(2);
    expect(countStats('中文排版 ok').words).toBe(5);
    expect(countStats('a\nb').lines).toBe(2);
  });
  it('stub markdown renderer covers the basics', () => {
    const html = miniMarkdownToHtml('# H\n\ntext **b**\n\n- [x] done\n\n```js\n<a>\n```');
    expect(html).toContain('<h1 id="h-0">H</h1>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('checked');
    expect(html).toContain('&lt;a&gt;');
  });
});

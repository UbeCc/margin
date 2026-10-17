import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EditorHandle } from '../../contracts';
import { DocumentController, applyEol, detectEol, normalizeEol, suggestName, type DocumentHost } from '../document';
import { createMemoryPlatform, countStats, miniMarkdownToHtml } from '../dev-stubs';
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

const flush = () => new Promise((r) => setTimeout(r, 200));

describe('line endings', () => {
  it('detects, normalizes, re-applies', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc');
    expect(applyEol('a\nb', '\r\n')).toBe('a\r\nb');
  });
});

describe('DocumentController', () => {
  let platform: ReturnType<typeof createMemoryPlatform>;
  let editor: ReturnType<typeof fakeEditor>;
  let host: DocumentHost;
  let doc: DocumentController;
  let answer: 'save' | 'discard' | 'cancel';
  let reload: boolean;

  beforeEach(() => {
    platform = createMemoryPlatform({ '/n/a.md': '# A\n', '/n/b.md': 'B\r\nline\r\n' });
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
    expect(platform.control.edited).toBe(false); // setDocumentEdited is the app's job via onState
    await doc.save();
    expect(platform.control.files.get('/n/a.md')).toBe('# A\nmore');
    expect(doc.dirty).toBe(false);
  });

  it('preserves CRLF on save and LF in the editor', async () => {
    await doc.open('/n/b.md');
    expect(editor.getMarkdown()).toBe('B\nline\n');
    editor.type('x');
    await doc.save();
    expect(platform.control.files.get('/n/b.md')).toBe('B\r\nline\r\nx');
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
    expect(platform.control.files.get('/n/a.md')).toBe('# A\n');
  });

  it('save-as on untitled uses the dialog and starts watching', async () => {
    await doc.newDocument();
    editor.type('# Hello world\n');
    platform.control.dialogQueue.push('/n/hello.md');
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('/n/hello.md');
    expect(platform.control.files.get('/n/hello.md')).toBe('# Hello world\n');
    expect(host.onOpened).toHaveBeenCalledWith('/n/hello.md');
  });

  it('reloads silently on external change when clean, asks when dirty', async () => {
    await doc.open('/n/a.md');
    platform.control.writeExternal('/n/a.md', '# A changed\n');
    await flush();
    expect(editor.getMarkdown()).toBe('# A changed\n');
    expect(host.askReloadDirty).not.toHaveBeenCalled();

    editor.type('mine');
    reload = false;
    platform.control.writeExternal('/n/a.md', '# A again\n');
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
    expect(platform.control.files.get('/n/a.md')).toBe('# A\nauto');
    expect(doc.dirty).toBe(false);
  });

  it('marks missing on delete and follows renames', async () => {
    await doc.open('/n/a.md');
    platform.control.removeExternal('/n/a.md');
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

describe('memory platform', () => {
  it('stores pasted images relative to the doc', async () => {
    const p = createMemoryPlatform({ '/n/My Doc.md': '' });
    const src = await p.storeImage('/n/My Doc.md', { kind: 'relative', dir: './${filename}.assets' }, { bytes: new Uint8Array([1]), name: 'a b.png' });
    expect(src).toBe('My%20Doc.assets/a%20b.png');
    expect(p.control.files.has('/n/My Doc.assets/a b.png')).toBe(true);
    await expect(p.storeImage(null, { kind: 'relative', dir: './assets' }, { bytes: new Uint8Array([1]) })).rejects.toThrow();
  });
  it('quick open ranks under root', async () => {
    const p = createMemoryPlatform({ '/r/a/roadmap.md': '', '/r/x.txt': '', '/other/road.md': '' });
    expect(await p.quickOpen('/r', 'road')).toEqual(['/r/a/roadmap.md']);
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

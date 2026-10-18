import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsEvent, MenuAction } from '../contracts';
import { SAMPLE_DOCS, WEB_ROOT, WebPlatform } from './web';

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function fresh(opts: ConstructorParameters<typeof WebPlatform>[0] = {}) {
  return new WebPlatform({ persist: false, useFileSystemAccess: false, watchDelay: 10, ...opts });
}

beforeEach(() => localStorage.clear());

describe('WebPlatform filesystem', () => {
  it('is seeded with sample docs', async () => {
    const p = fresh();
    for (const [path, text] of Object.entries(SAMPLE_DOCS)) expect(await p.readTextFile(path)).toBe(text);
    const names = (await p.listDir(WEB_ROOT)).map((e) => e.name);
    expect(names[0]).toBe('Notes'); // directories first
    expect(names).toContain('Welcome.md');
  });

  it('rename / remove / createDir / reveal (file-tree extras, #21)', async () => {
    const p = fresh({ seed: false });
    const evs: FsEvent[] = [];
    await p.writeTextFile('/r/a.md', 'A');
    await p.writeTextFile('/r/b.md', 'B');
    await p.watch('/r', (e) => evs.push(...e));
    await p.rename('/r/a.md', '/r/c.md');
    expect(await p.readTextFile('/r/c.md')).toBe('A');
    expect(await p.stat('/r/a.md')).toBeNull();
    await expect(p.rename('/r/c.md', '/r/b.md')).rejects.toThrow(/EEXIST/);
    await p.createDir('/r/sub');
    await expect(p.createDir('/r/sub')).rejects.toThrow(/EEXIST/);
    await expect(p.rename('/r', '/r/sub/x')).rejects.toThrow(/itself/);
    await p.rename('/r/c.md', '/r/sub/c.md');
    await p.remove('/r/sub');
    expect(await p.stat('/r/sub/c.md')).toBeNull();
    await p.revealInFolder('/r/b.md');
    expect(p.revealed).toEqual(['/r/b.md']);
    await tick();
    expect(evs).toContainEqual({ kind: 'renamed', from: '/r/a.md', to: '/r/c.md' });
    expect(evs).toContainEqual({ kind: 'created', path: '/r/sub' });
    expect(evs).toContainEqual({ kind: 'removed', path: '/r/sub' });
  });

  it('reads, writes, stats and lists', async () => {
    const p = fresh({ seed: false });
    await p.writeTextFile('/a/b/c.md', 'hello');
    expect(await p.readTextFile('/a/b/c.md')).toBe('hello');
    const st = await p.stat('/a/b/c.md');
    expect(st).toMatchObject({ name: 'c.md', path: '/a/b/c.md', isDir: false, size: 5 });
    expect(await p.stat('/a/b')).toMatchObject({ isDir: true });
    expect(await p.stat('/nope')).toBeNull();
    await expect(p.readTextFile('/nope.md')).rejects.toThrow(/ENOENT/);
    await p.writeTextFile('/a/b/.hidden', 'x');
    await p.writeTextFile('/a/b/n10.md', '');
    await p.writeTextFile('/a/b/n2.md', '');
    expect((await p.listDir('/a/b')).map((e) => e.name)).toEqual(['c.md', 'n2.md', 'n10.md']);
  });

  it('persists to localStorage across instances', async () => {
    const a = new WebPlatform({ useFileSystemAccess: false });
    await a.writeTextFile(`${WEB_ROOT}/new.md`, 'persisted');
    const b = new WebPlatform({ useFileSystemAccess: false });
    expect(await b.readTextFile(`${WEB_ROOT}/new.md`)).toBe('persisted');
  });
});

describe('WebPlatform watch', () => {
  it('suppresses own modifications but reports creations and external changes', async () => {
    const p = fresh();
    const batches: FsEvent[][] = [];
    const off = await p.watch(WEB_ROOT, (e) => batches.push(e));
    await p.writeTextFile(`${WEB_ROOT}/Welcome.md`, 'edited by us');
    await p.writeTextFile(`${WEB_ROOT}/Fresh.md`, 'new');
    p.externalWrite(`${WEB_ROOT}/Notes/Todo.md`, 'changed elsewhere');
    p.externalRename(`${WEB_ROOT}/Notes/Ideas.md`, `${WEB_ROOT}/Notes/Plans.md`);
    p.externalRemove(`${WEB_ROOT}/README.txt`);
    p.externalWrite('/elsewhere/x.md', 'not watched');
    await tick();
    expect(batches.flat()).toEqual([
      { kind: 'created', path: `${WEB_ROOT}/Fresh.md` },
      { kind: 'modified', path: `${WEB_ROOT}/Notes/Todo.md` },
      { kind: 'renamed', from: `${WEB_ROOT}/Notes/Ideas.md`, to: `${WEB_ROOT}/Notes/Plans.md` },
      { kind: 'removed', path: `${WEB_ROOT}/README.txt` },
    ]);
    expect(batches.length).toBe(1); // batched
    expect(await p.readTextFile(`${WEB_ROOT}/Notes/Plans.md`)).toContain('# Ideas');
    off();
    p.externalWrite(`${WEB_ROOT}/Welcome.md`, 'after unsubscribe');
    await tick();
    expect(batches.length).toBe(1);
  });
});

describe('WebPlatform quickOpen', () => {
  it('ranks markdown first and fuzzy matches', async () => {
    const p = fresh();
    await p.writeTextFile(`${WEB_ROOT}/src/todo.js`, '');
    const r = await p.quickOpen(WEB_ROOT, 'todo');
    expect(r[0]).toBe(`${WEB_ROOT}/Notes/Todo.md`);
    expect(r).toContain(`${WEB_ROOT}/src/todo.js`);
    expect(await p.quickOpen(WEB_ROOT, 'wlcm')).toEqual([`${WEB_ROOT}/Welcome.md`]);
    expect((await p.quickOpen(WEB_ROOT, '', 2)).length).toBe(2);
  });
});

describe('WebPlatform storeImage', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('writes bytes next to the doc with a generated name', async () => {
    const p = fresh();
    const doc = `${WEB_ROOT}/My Doc.md`;
    const src = await p.storeImage(doc, { kind: 'relative', dir: './${filename}.assets' }, { bytes: png, mime: 'image/png' });
    expect(src).toMatch(/^My%20Doc\.assets\/image-\d{17}(?:-\d+)?\.png$/);
    const abs = `${WEB_ROOT}/${decodeURI(src)}`;
    expect(p.assetUrl(abs)).toMatch(/^data:image\/png;base64,/);
    expect(p.assetUrl(`${WEB_ROOT}/${src}`)).toMatch(/^data:image\/png/); // encoded form works too
  });

  it('copies (never moves) an existing image and dedupes names', async () => {
    const p = fresh();
    const first = await p.storeImage(null, { kind: 'absolute', dir: '/pics' }, { bytes: png, mime: 'image/png' });
    expect(first.startsWith('/pics/image-')).toBe(true);
    const doc = `${WEB_ROOT}/Notes/Ideas.md`;
    const rule = { kind: 'relative', dir: '../img' } as const;
    const a = await p.storeImage(doc, rule, { path: first });
    expect(a).toBe(`../img/${first.split('/').pop()}`);
    expect(await p.stat(first)).not.toBeNull(); // source kept
  });

  it('inlines for none rule / unsaved docs', async () => {
    const p = fresh();
    expect(await p.storeImage(null, { kind: 'relative', dir: './assets' }, { bytes: png, mime: 'image/png' })).toMatch(/^data:image\/png/);
    expect(await p.storeImage(`${WEB_ROOT}/x.md`, { kind: 'none' }, { path: 'https://example.com/a.png' })).toBe('https://example.com/a.png');
  });
});

describe('WebPlatform settings & themes', () => {
  it('returns defaults, round-trips and normalizes', async () => {
    const p = new WebPlatform({ useFileSystemAccess: false });
    const s = await p.loadSettings();
    expect(s.theme).toBe('paper');
    await p.saveSettings({ ...s, theme: 'night', fontSize: 500 });
    const t = await new WebPlatform({ useFileSystemAccess: false }).loadSettings();
    expect(t.theme).toBe('night');
    expect(t.fontSize).toBe(72);
    localStorage.setItem('margin.web.settings.v1', '{"colorScheme":"purple","extra":1}');
    const u = (await p.loadSettings()) as unknown as Record<string, unknown>;
    expect(u.colorScheme).toBe('system');
    expect(u.extra).toBe(1);
  });

  it('lists user themes from the themes dir', async () => {
    const p = fresh();
    const dir = await p.themesDir();
    await p.writeTextFile(`${dir}/mine.css`, 'body{color:red}');
    expect((await p.listThemes()).mine).toBe('body{color:red}');
  });
});

describe('WebPlatform window integration', () => {
  it('maps keyboard shortcuts to menu actions and swallows the event', () => {
    const p = fresh();
    const got: MenuAction[] = [];
    const off = p.onMenu((a) => got.push(a));
    const inner = vi.fn();
    document.body.addEventListener('keydown', inner);
    const fire = (init: KeyboardEventInit) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    fire({ code: 'KeyS', key: 's', metaKey: true });
    fire({ code: 'KeyS', key: 'S', metaKey: true, shiftKey: true });
    fire({ code: 'Digit0', key: ')', ctrlKey: true, shiftKey: true });
    fire({ code: 'Digit0', key: '0', ctrlKey: true });
    fire({ code: 'F8', key: 'F8' });
    fire({ code: 'KeyA', key: 'a' }); // plain typing passes through
    expect(got).toEqual(['save', 'saveAs', 'zoomReset', 'heading:0', 'toggleFocus']);
    expect(inner).toHaveBeenCalledTimes(1);
    off();
    fire({ code: 'KeyS', key: 's', metaKey: true });
    expect(got.length).toBe(5);
  });

  it('close requests can be vetoed', async () => {
    const p = fresh();
    let allow = false;
    p.onCloseRequested(async () => allow);
    expect(await p.requestClose()).toBe(false);
    allow = true;
    expect(await p.requestClose()).toBe(true);
  });

  it('dialog hook, open files, title, edited flag, external links', async () => {
    const p = fresh();
    p.dialogHook = (kind) => (kind === 'save' ? '/Margin/Saved.md' : null);
    expect(await p.saveFileDialog()).toBe('/Margin/Saved.md');
    expect(await p.openFileDialog()).toBeNull();
    const opened: string[][] = [];
    p.onOpenFiles((x) => opened.push(x));
    p.openFiles(['/Margin/./Welcome.md']);
    expect(opened).toEqual([['/Margin/Welcome.md']]);
    await p.setTitle('Doc — Margin');
    expect(document.title).toBe('Doc — Margin');
    await p.setDocumentEdited(true);
    expect(p.documentEdited).toBe(true);
    await expect(p.openExternal('file:///etc/passwd')).rejects.toThrow();
  });

  it('records exports', async () => {
    const p = fresh();
    await p.exportHtml('<h1>x</h1>', '/Margin/out.html');
    expect(await p.readTextFile('/Margin/out.html')).toBe('<h1>x</h1>');
    await p.exportPdf('<h1>x</h1>', '/Margin/out.pdf');
    expect(p.exports.map((e) => e.kind)).toEqual(['html', 'pdf']);
  });
});

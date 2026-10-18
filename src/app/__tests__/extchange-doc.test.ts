import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHandle } from '../../contracts';
import { DocumentController, hashText, type DocumentHost, type ExternalChange } from '../document';
import { countStats } from '../dev-stubs';
import { WebPlatform } from '../../platform/web';

function fakeEditor(): EditorHandle & { type(s: string): void; set(s: string): void } {
  let md = '';
  const cbs = new Set<() => void>();
  const fire = () => cbs.forEach((cb) => cb());
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
      fire();
    },
    set(s: string) {
      md = s;
      fire();
    },
  };
}

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe('hashText', () => {
  it('is stable and distinguishes content', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('a\r\n')).not.toBe(hashText('a\n'));
  });
});

describe('external change prompt (#82)', () => {
  let platform: WebPlatform;
  let editor: ReturnType<typeof fakeEditor>;
  let host: DocumentHost;
  let doc: DocumentController;
  let shown: (ExternalChange | null)[];
  let autoSave: boolean;
  const last = () => shown[shown.length - 1];

  beforeEach(async () => {
    platform = new WebPlatform({ persist: false, seed: false, keyboardShortcuts: false, useFileSystemAccess: false, watchDelay: 5 });
    await platform.writeTextFile('/n/a.md', '# A\n');
    editor = fakeEditor();
    shown = [];
    autoSave = false;
    host = {
      platform,
      editor,
      askUnsaved: vi.fn(async () => 'discard' as const),
      imageRule: () => ({ kind: 'relative', dir: './assets' }),
      askReloadDirty: vi.fn(async () => false),
      externalChange: (c) => void shown.push(c),
      notify: vi.fn(),
      autoSave: () => ({ enabled: autoSave, delay: 30 }),
      willLoad: vi.fn(),
      onState: vi.fn(),
      onOpened: vi.fn(),
      defaultDir: () => '/n',
    };
    doc = new DocumentController(host, { externalDebounceMs: 20 });
    await doc.open('/n/a.md');
  });

  it('dirty: non-blocking prompt; keep mine stays dirty and does not re-prompt for the same disk version', async () => {
    editor.type('mine');
    platform.externalWrite('/n/a.md', '# Disk\n');
    await wait();
    expect(host.askReloadDirty).not.toHaveBeenCalled();
    const c = last()!;
    expect(c.disk).toBe('# Disk\n');
    expect(c.mine()).toBe('# A\nmine');
    c.keepMine();
    expect(last()).toBeNull();
    expect(doc.dirty).toBe(true);
    expect(editor.getMarkdown()).toBe('# A\nmine');

    const n = shown.length;
    platform.externalWrite('/n/a.md', '# Disk\n'); // same version touched again
    await wait();
    expect(shown.length).toBe(n);

    await doc.save();
    expect(await platform.readTextFile('/n/a.md')).toBe('# A\nmine');
    await wait();
    expect(shown.length).toBe(n); // own write ignored
  });

  it('load disk replaces the buffer and the returned undo restores it', async () => {
    editor.type('mine');
    platform.externalWrite('/n/a.md', '# Disk\n');
    await wait();
    const undo = last()!.loadDisk();
    expect(editor.getMarkdown()).toBe('# Disk\n');
    expect(doc.dirty).toBe(false);
    expect(last()).toBeNull();
    undo!();
    expect(editor.getMarkdown()).toBe('# A\nmine');
    expect(doc.dirty).toBe(true);
    // A stale change object can no longer act.
    expect(shown.find((x) => x)!.loadDisk()).toBeNull();
  });

  it('debounces a burst of events into one prompt with the latest content', async () => {
    editor.type('mine');
    platform.externalWrite('/n/a.md', 'one\n');
    platform.externalWrite('/n/a.md', 'two\n');
    platform.externalWrite('/n/a.md', 'three\n');
    await wait();
    expect(shown.filter(Boolean)).toHaveLength(1);
    expect(last()!.disk).toBe('three\n');
  });

  it('a newer disk version while prompting updates the prompt', async () => {
    editor.type('mine');
    platform.externalWrite('/n/a.md', 'one\n');
    await wait();
    platform.externalWrite('/n/a.md', 'two\n');
    await wait();
    expect(shown.filter(Boolean).map((c) => c!.disk)).toEqual(['one\n', 'two\n']);
    shown[0]!.keepMine(); // stale
    expect(doc.dirty).toBe(true);
    last()!.keepMine();
    expect(last()).toBeNull();
  });

  it('clean doc reloads silently', async () => {
    platform.externalWrite('/n/a.md', '# Clean reload\n');
    await wait();
    expect(editor.getMarkdown()).toBe('# Clean reload\n');
    expect(shown).toEqual([]);
  });

  it('atomic save (remove + create) of identical content is not a deletion', async () => {
    platform.externalRemove('/n/a.md');
    platform.externalWrite('/n/a.md', '# A\n');
    await wait();
    expect(doc.missing).toBe(false);
    expect(doc.dirty).toBe(false);
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('deleted on disk while prompting: hides the prompt, notifies, stays dirty', async () => {
    editor.type('mine');
    platform.externalWrite('/n/a.md', '# Disk\n');
    await wait();
    platform.externalRemove('/n/a.md');
    await wait();
    expect(last()).toBeNull();
    expect(doc.missing).toBe(true);
    expect(doc.dirty).toBe(true);
    expect(host.notify).toHaveBeenCalledWith(expect.stringContaining('deleted'), 'warning');
  });

  it('undoing edits back to the baseline while prompting takes the disk version', async () => {
    editor.type('mine');
    platform.externalWrite('/n/a.md', '# Disk\n');
    await wait();
    editor.set('# A\n');
    await wait(200);
    expect(editor.getMarkdown()).toBe('# Disk\n');
    expect(last()).toBeNull();
  });

  it('auto-save does not overwrite an undecided disk change', async () => {
    autoSave = true;
    editor.type('mine');
    platform.externalWrite('/n/a.md', '# Disk\n');
    await wait();
    editor.type('!');
    await wait(100);
    expect(await platform.readTextFile('/n/a.md')).toBe('# Disk\n');
    last()!.keepMine();
    editor.type('?');
    await wait(100);
    expect(await platform.readTextFile('/n/a.md')).toBe('# A\nmine!?');
  });
});

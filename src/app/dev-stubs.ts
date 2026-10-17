/**
 * Development stand-ins used ONLY when the real editor core / platform modules
 * are absent (or forced with `?stub=all|editor|platform`). The integrator does
 * not need to touch this file: `wiring.ts` picks the real modules automatically.
 *
 *  - createStubEditor: a <textarea>-backed EditorHandle (source-only).
 *  - createMemoryPlatform: an in-memory filesystem Platform with a demo folder,
 *    controllable from tests through `window.__marginStub`.
 */
import type {
  AppSettings,
  CreateEditor,
  DirEntry,
  EditorCommand,
  EditorHandle,
  EditorSettings,
  EditorStats,
  FsEvent,
  Heading,
  ImageRule,
  MenuAction,
} from '../contracts';
import type { FullPlatform } from './platform-extras';
import { basename, dirname, isInside, join, relative, stripExt, isMarkdownPath, isAbsolute } from './util/path';
import { fuzzyFilter } from './util/fuzzy';
import { escapeHtml } from './util/dom';

// ------------------------------------------------------------------ editor

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

/** Word count: CJK ideographs/kana/hangul count one each; other runs of letters/digits count as words. */
export function countStats(md: string): EditorStats {
  const cjk = md.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g)?.length ?? 0;
  const latin =
    md
      .replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g, ' ')
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  return {
    words: cjk + latin,
    characters: [...md.replace(/\n/g, '')].length,
    lines: md ? md.split('\n').length : 0,
  };
}

function outlineOf(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  md.split('\n').forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = HEADING_RE.exec(line);
    if (m) out.push({ id: `h-${i}`, level: m[1].length as Heading['level'], text: m[2].replace(/[*_`~=]/g, '') });
  });
  return out;
}

/** Deliberately tiny markdown → HTML, good enough for exporting from the stub. */
export function miniMarkdownToHtml(md: string, resolve: (src: string) => string = (s) => s): string {
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => `<img alt="${alt}" src="${escapeHtml(resolve(src))}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  const lines = md.split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const flush = (): void => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const endList = (): void => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      flush();
      endList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) body.push(lines[i]);
      html.push(`<pre><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = HEADING_RE.exec(line);
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (hm) {
      flush();
      endList();
      html.push(`<h${hm[1].length} id="h-${i}">${inline(hm[2])}</h${hm[1].length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      endList();
      html.push('<hr>');
    } else if (line.startsWith('>')) {
      flush();
      endList();
      html.push(`<blockquote><p>${inline(line.replace(/^>\s?/, ''))}</p></blockquote>`);
    } else if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== kind) {
        endList();
        html.push(`<${kind}>`);
        list = kind;
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li[2]);
      html.push(
        task
          ? `<li class="task-list-item"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}</li>`
          : `<li>${inline(li[2])}</li>`,
      );
    } else if (!line.trim()) {
      flush();
      endList();
    } else {
      endList();
      para.push(line);
    }
  }
  flush();
  endList();
  return html.join('\n');
}

export const createStubEditor: CreateEditor = (host: HTMLElement, initial: EditorSettings): EditorHandle => {
  let settings: EditorSettings = { ...initial };
  let sourceMode = false;
  const ta = document.createElement('textarea');
  ta.className = 'stub-editor';
  ta.setAttribute('aria-label', 'Document');
  ta.spellcheck = settings.spellcheck;
  ta.placeholder = 'Start writing…';
  host.appendChild(ta);
  host.dataset.stub = 'true';

  const changeCbs = new Set<() => void>();
  const selCbs = new Set<() => void>();
  const autosize = (): void => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  const emitChange = (): void => {
    autosize();
    changeCbs.forEach((cb) => cb());
  };
  const emitSel = (): void => selCbs.forEach((cb) => cb());
  ta.addEventListener('input', emitChange);
  for (const ev of ['keyup', 'mouseup', 'focus', 'select']) ta.addEventListener(ev, emitSel);
  const onDocSel = (): void => {
    if (document.activeElement === ta) emitSel();
  };
  document.addEventListener('selectionchange', onDocSel);
  const ro = new ResizeObserver(autosize);
  ro.observe(host);

  const lineIndexAt = (pos: number): number => ta.value.slice(0, pos).split('\n').length - 1;
  const lineStart = (idx: number): number => {
    const lines = ta.value.split('\n');
    let p = 0;
    for (let i = 0; i < idx && i < lines.length; i++) p += lines[i].length + 1;
    return p;
  };
  const replaceRange = (start: number, end: number, text: string, selStart?: number, selEnd?: number): void => {
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand keeps the native undo stack intact.
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      emitChange();
    }
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
  };
  const scrollToLine = (idx: number): void => {
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    const scroller = host.closest('.editor-scroll') ?? document.scrollingElement;
    const top = ta.getBoundingClientRect().top - (scroller as Element).getBoundingClientRect().top + (scroller as Element).scrollTop;
    (scroller as Element).scrollTo({ top: top + idx * lh - 80 });
  };
  const marks: Record<string, [string, string]> = {
    strong: ['**', '**'],
    em: ['*', '*'],
    code: ['`', '`'],
    strike: ['~~', '~~'],
    highlight: ['==', '=='],
    link: ['[', '](https://)'],
  };
  const blocks: Record<string, string> = {
    quote: '> ',
    ul: '- ',
    ol: '1. ',
    task: '- [ ] ',
  };
  const inserts: Record<string, string> = {
    code: '```\n\n```\n',
    math: '$$\n\n$$\n',
    table: '| Column | Column |\n| --- | --- |\n|  |  |\n',
    hr: '---\n',
    toc: '[TOC]\n',
    front_matter: '---\ntitle: \n---\n',
  };
  let findFrom = -1;

  const exec = (cmd: EditorCommand): boolean => {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    switch (cmd.kind) {
      case 'heading': {
        const li = lineIndexAt(s);
        const ls = lineStart(li);
        const line = value.split('\n')[li] ?? '';
        const stripped = line.replace(/^#{1,6}\s+/, '');
        const prefix = cmd.level ? '#'.repeat(cmd.level) + ' ' : '';
        replaceRange(ls, ls + line.length, prefix + stripped, ls + prefix.length + stripped.length);
        return true;
      }
      case 'mark': {
        const [a, b] = marks[cmd.mark];
        const sel = value.slice(s, e);
        replaceRange(s, e, a + sel + b, s + a.length, s + a.length + sel.length);
        return true;
      }
      case 'block': {
        if (blocks[cmd.block]) {
          const li = lineIndexAt(s);
          const ls = lineStart(li);
          replaceRange(ls, ls, blocks[cmd.block], s + blocks[cmd.block].length);
        } else {
          const text = inserts[cmd.block];
          const ls = lineStart(lineIndexAt(s));
          const pre = s === ls ? '' : '\n';
          replaceRange(s, e, pre + text, s + pre.length + text.indexOf('\n') + 1);
        }
        return true;
      }
      case 'insertText':
        replaceRange(s, e, cmd.text);
        return true;
      case 'insertImage': {
        const t = `![${cmd.alt ?? ''}](${/\s/.test(cmd.src) ? `<${cmd.src}>` : cmd.src})`;
        replaceRange(s, e, t);
        return true;
      }
      case 'undo':
      case 'redo':
        ta.focus();
        return document.execCommand(cmd.kind);
      case 'selectAll':
        ta.focus();
        ta.select();
        return true;
      case 'find': {
        if (!cmd.query) return false;
        const hay = cmd.caseSensitive ? value : value.toLowerCase();
        const needle = cmd.caseSensitive ? cmd.query : cmd.query.toLowerCase();
        let at: number;
        if (cmd.backwards) {
          const from = (findFrom >= 0 ? Math.min(s, findFrom) : s) - 1;
          at = from >= 0 ? hay.lastIndexOf(needle, from) : -1;
          if (at < 0) at = hay.lastIndexOf(needle);
        } else {
          const from = value.slice(s, e).toLowerCase() === needle.toLowerCase() ? e : s;
          at = hay.indexOf(needle, from);
          if (at < 0) at = hay.indexOf(needle);
        }
        if (at < 0) return false;
        findFrom = at;
        ta.setSelectionRange(at, at + needle.length);
        scrollToLine(lineIndexAt(at));
        emitSel();
        return true;
      }
      case 'replace': {
        if (!cmd.query) return false;
        if (cmd.all) {
          if (!value.includes(cmd.query)) return false;
          replaceRange(0, value.length, value.split(cmd.query).join(cmd.replacement), s);
          return true;
        }
        if (value.slice(s, e) === cmd.query) {
          replaceRange(s, e, cmd.replacement, s + cmd.replacement.length);
        }
        return exec({ kind: 'find', query: cmd.query, caseSensitive: true });
      }
    }
  };

  return {
    setMarkdown(md) {
      ta.value = md;
      ta.setSelectionRange(0, 0);
      autosize();
      requestAnimationFrame(autosize);
    },
    getMarkdown: () => ta.value,
    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    onSelectionChange(cb) {
      selCbs.add(cb);
      return () => selCbs.delete(cb);
    },
    getOutline: () => outlineOf(ta.value),
    getActiveHeadingId() {
      const li = lineIndexAt(ta.selectionStart);
      let id: string | null = null;
      for (const hd of outlineOf(ta.value)) {
        if (Number(hd.id.slice(2)) <= li) id = hd.id;
        else break;
      }
      return id;
    },
    scrollToHeading(id) {
      const li = Number(id.replace(/^h-/, ''));
      if (!Number.isFinite(li)) return;
      const p = lineStart(li);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(p, p);
      scrollToLine(li);
      emitSel();
    },
    exec,
    getStats: () => countStats(ta.value),
    setSourceMode(on) {
      sourceMode = on;
      host.classList.toggle('stub-source', on);
    },
    isSourceMode: () => sourceMode,
    updateSettings(patch) {
      settings = { ...settings, ...patch };
      ta.spellcheck = settings.spellcheck;
      host.classList.toggle('stub-focus', settings.focusMode);
      host.classList.toggle('stub-typewriter', settings.typewriterMode);
    },
    renderHTML: () => miniMarkdownToHtml(ta.value, (s) => settings.resolveAsset(s)),
    focus: () => ta.focus(),
    destroy() {
      document.removeEventListener('selectionchange', onDocSel);
      ro.disconnect();
      ta.remove();
    },
  };
};

// ---------------------------------------------------------------- platform

export const DEMO_ROOT = '/Users/demo/Notes';

const WELCOME = `# Welcome to Margin

Margin is a quiet place to write **Markdown**. What you type is what you see — the syntax
fades away once your cursor leaves a block.

## Getting around

- Press \`⌘P\` to jump to any file in the folder.
- Press \`⌘⇧P\` for every command.
- Press \`⌘/\` to flip between rich and source view.

## Writing

> Simplicity is the ultimate sophistication.

Inline \`code\`, *emphasis*, ==highlights== and [links](https://example.com) all work.

\`\`\`ts
const greeting = 'hello, margin';
\`\`\`

### 中文排版

在 Margin 里，中英文混排也应该舒服：行高宽松，标点不挤，字体回退合理。

## Next steps

1. Open a folder from the sidebar.
2. Try the themes in Preferences.
`;

const SEED: Record<string, string> = {
  [`${DEMO_ROOT}/Welcome.md`]: WELCOME,
  [`${DEMO_ROOT}/Ideas/Roadmap.md`]: '# Roadmap\n\n## Q4\n\n- Export to PDF\n- Themes\n\n## Later\n\n- Sync\n',
  [`${DEMO_ROOT}/Ideas/Reading list.md`]: '# Reading list\n\n- [ ] The Elements of Typographic Style\n- [x] A Pattern Language\n',
  [`${DEMO_ROOT}/Journal/2026-10-17.md`]: '# Friday\n\nShipped the shell.\n',
  [`${DEMO_ROOT}/Journal/2026-10-16.md`]: '# Thursday\n\nSketched the sidebar.\n',
  [`${DEMO_ROOT}/notes.txt`]: 'plain text notes\r\nsecond line\r\n',
};

export interface StubControl {
  files: Map<string, string | Uint8Array>;
  /** Paths the next open/save dialogs will return (FIFO). `null` = cancel. */
  dialogQueue: (string | null)[];
  edited: boolean;
  title: string;
  exported: { kind: 'html' | 'pdf'; path: string; html: string }[];
  menu(action: MenuAction): void;
  openFiles(paths: string[]): void;
  requestClose(): Promise<boolean>;
  /** Simulate a change made by another program. */
  writeExternal(path: string, content: string): void;
  removeExternal(path: string): void;
}

declare global {
  interface Window {
    __marginStub?: StubControl;
  }
}

export function createMemoryPlatform(seed: Record<string, string> = SEED): FullPlatform & { control: StubControl } {
  const files = new Map<string, string | Uint8Array>(Object.entries(seed));
  const dirs = new Set<string>();
  const mtimes = new Map<string, number>();
  const addDirsFor = (p: string): void => {
    for (let d = dirname(p); d !== '/' && d !== '.' && !dirs.has(d); d = dirname(d)) dirs.add(d);
  };
  for (const p of files.keys()) addDirsFor(p);
  dirs.add(`${DEMO_ROOT}/Empty folder`);

  const watchers = new Set<{ root: string; cb: (e: FsEvent[]) => void }>();
  const emit = (events: FsEvent[]): void => {
    setTimeout(() => {
      for (const w of watchers) {
        const mine = events.filter((ev) =>
          ev.kind === 'renamed' ? isInside(w.root, ev.from) || isInside(w.root, ev.to) : isInside(w.root, ev.path),
        );
        if (mine.length) w.cb(mine);
      }
    }, 20);
  };
  const touch = (p: string): void => void mtimes.set(p, Date.now());
  const menuCbs = new Set<(a: MenuAction) => void>();
  const openCbs = new Set<(p: string[]) => void>();
  let closeCb: (() => Promise<boolean>) | null = null;
  const blobUrls = new Map<string, string>();
  const SETTINGS_KEY = 'margin.stub.settings';

  const nextDialog = (msg: string, def = ''): string | null => {
    if (control.dialogQueue.length) return control.dialogQueue.shift() ?? null;
    return window.prompt(msg, def);
  };
  const write = (path: string, content: string | Uint8Array): void => {
    const existed = files.has(path);
    files.set(path, content);
    addDirsFor(path);
    touch(path);
    emit([{ kind: existed ? 'modified' : 'created', path }]);
  };

  const control: StubControl = {
    files,
    dialogQueue: [],
    edited: false,
    title: '',
    exported: [],
    menu: (a) => menuCbs.forEach((cb) => cb(a)),
    openFiles: (p) => openCbs.forEach((cb) => cb(p)),
    requestClose: async () => (closeCb ? closeCb() : true),
    writeExternal: (path, content) => write(path, content),
    removeExternal: (path) => {
      files.delete(path);
      emit([{ kind: 'removed', path }]);
    },
  };

  const imageName = (input: { path?: string; name?: string; mime?: string }): string => {
    if (input.name) return input.name;
    if (input.path) return basename(input.path);
    const ext = (input.mime ?? 'image/png').split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    return `image-${stamp}.${ext}`;
  };

  const platform: FullPlatform & { control: StubControl } = {
    kind: 'web',
    control,
    async readTextFile(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async writeTextFile(path, content) {
      write(path, content);
    },
    async stat(path) {
      if (files.has(path)) {
        const v = files.get(path)!;
        return { name: basename(path), path, isDir: false, mtime: mtimes.get(path) ?? 0, size: v.length };
      }
      if (dirs.has(path)) return { name: basename(path), path, isDir: true, mtime: 0, size: 0 };
      return null;
    },
    async listDir(path) {
      const out: DirEntry[] = [];
      for (const d of dirs) if (dirname(d) === path) out.push({ name: basename(d), path: d, isDir: true, mtime: 0, size: 0 });
      for (const [p, v] of files)
        if (dirname(p) === path) out.push({ name: basename(p), path: p, isDir: false, mtime: mtimes.get(p) ?? 0, size: v.length });
      if (!out.length && !dirs.has(path)) throw new Error(`ENOENT: ${path}`);
      return out;
    },
    async watch(root, cb) {
      const w = { root, cb };
      watchers.add(w);
      return () => void watchers.delete(w);
    },
    async quickOpen(root, query, limit = 50) {
      const all = [...files.keys()].filter((p) => isInside(root, p));
      const ranked = fuzzyFilter(query, all, (p) => relative(root, p), Infinity).map((r) => r.item);
      ranked.sort((a, b) => Number(isMarkdownPath(b)) - Number(isMarkdownPath(a)));
      return ranked.slice(0, limit);
    },
    async storeImage(docPath, rule: ImageRule, input) {
      if (rule.kind === 'none') {
        if (input.path) return input.path;
        throw new Error('No image folder configured for pasted images');
      }
      const name = imageName(input);
      const bytes = input.bytes ?? (input.path && files.get(input.path)) ?? new Uint8Array();
      if (rule.kind === 'absolute') {
        const target = join(rule.dir, name);
        write(target, bytes);
        return target;
      }
      if (!docPath) throw new Error('Save the document before inserting images');
      const dir = rule.dir.replace(/\$\{filename\}/g, stripExt(basename(docPath)));
      const target = join(dirname(docPath), dir, name);
      write(target, bytes);
      const rel = relative(dirname(docPath), target);
      return rel.split('/').map(encodeURIComponent).join('/');
    },
    async openFileDialog(opts) {
      return nextDialog(opts?.directory ? 'Open folder (path):' : 'Open file (path):', opts?.directory ? DEMO_ROOT : `${DEMO_ROOT}/Welcome.md`);
    },
    async saveFileDialog(opts) {
      return nextDialog('Save as (path):', opts?.defaultPath ?? `${DEMO_ROOT}/Untitled.md`);
    },
    async exportHtml(html, outPath) {
      control.exported.push({ kind: 'html', path: outPath, html });
      write(outPath, html);
    },
    async exportPdf(html, outPath) {
      control.exported.push({ kind: 'pdf', path: outPath, html });
      write(outPath, '%PDF-stub\n');
    },
    async loadSettings() {
      try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as AppSettings;
      } catch {
        return {} as AppSettings;
      }
    },
    async saveSettings(s) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    },
    async listThemes() {
      return {};
    },
    async themesDir() {
      return '/Users/demo/Library/Application Support/Margin/themes';
    },
    assetUrl(path) {
      const v = files.get(path);
      if (v instanceof Uint8Array) {
        let u = blobUrls.get(path);
        if (!u) {
          u = URL.createObjectURL(new Blob([v as BlobPart]));
          blobUrls.set(path, u);
        }
        return u;
      }
      return isAbsolute(path) ? `file://${encodeURI(path)}` : path;
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },
    async setTitle(title) {
      control.title = title;
      document.title = title;
    },
    async setDocumentEdited(edited) {
      control.edited = edited;
    },
    onMenu(cb) {
      menuCbs.add(cb);
      return () => menuCbs.delete(cb);
    },
    onOpenFiles(cb) {
      openCbs.add(cb);
      return () => openCbs.delete(cb);
    },
    onCloseRequested(cb) {
      closeCb = cb;
      return () => {
        if (closeCb === cb) closeCb = null;
      };
    },
    // ---- extras
    async rename(from, to) {
      if (files.has(to) || dirs.has(to)) throw new Error(`${basename(to)} already exists`);
      const events: FsEvent[] = [{ kind: 'renamed', from, to }];
      for (const [p, v] of [...files]) {
        if (isInside(from, p)) {
          files.delete(p);
          files.set(to + p.slice(from.length), v);
        }
      }
      for (const d of [...dirs]) {
        if (isInside(from, d)) {
          dirs.delete(d);
          dirs.add(to + d.slice(from.length));
        }
      }
      emit(events);
    },
    async remove(path) {
      for (const p of [...files.keys()]) if (isInside(path, p)) files.delete(p);
      for (const d of [...dirs]) if (isInside(path, d)) dirs.delete(d);
      emit([{ kind: 'removed', path }]);
    },
    async createDir(path) {
      if (dirs.has(path) || files.has(path)) throw new Error(`${basename(path)} already exists`);
      dirs.add(path);
      addDirsFor(path);
      emit([{ kind: 'created', path }]);
    },
    async revealInFolder(path) {
      console.info('[stub] reveal', path);
    },
  };
  window.__marginStub = control;
  return platform;
}

import type { AppSettings, DirEntry, FsEvent, ImageRule, MenuAction, Platform } from '../contracts';
import {
  basename,
  builtinThemes,
  dirname,
  expandImageDir,
  extForImage,
  generatedImageName,
  joinPath,
  normalizePath,
  normalizeSettings,
  printHtmlInIframe,
  relativePath,
  toMarkdownSrc,
} from './common';
import { rankPaths } from './fuzzy';
import { matchShortcut } from './shortcuts';

/**
 * In-browser Platform used by `npm run dev` and the Playwright e2e tests.
 *
 * - An in-memory POSIX-like filesystem seeded with sample docs under `/Margin`,
 *   persisted to localStorage (except folders mounted from disk).
 * - When the File System Access API exists (and we are not under automation),
 *   Open / Open Folder / Save As use real files, mounted under `/Local/...`.
 * - Images are stored in the memfs as data URLs; `assetUrl()` returns them.
 * - Native menu accelerators are emulated with a capture-phase keydown listener.
 * - Test hooks: see {@link WebPlatform.debug} (also on `window.__MARGIN_WEB__`).
 */

interface FileNode {
  kind: 'file';
  /** Raw bytes (base64) when the file is not UTF-8 text (test hook for encodings). */
  bytes?: string;
  /** text, or a data: URL when `binary` */
  content: string;
  binary?: boolean;
  mtime: number;
}
interface DirNode {
  kind: 'dir';
  mtime: number;
}
type Node = FileNode | DirNode;

export const WEB_ROOT = '/Margin';
export const WEB_THEMES_DIR = '/Margin Themes';
const LOCAL_ROOT = '/Local';
const FS_KEY = 'margin.web.fs.v1';
const SETTINGS_KEY = 'margin.web.settings.v1';

export const SAMPLE_DOCS: Record<string, string> = {
  [`${WEB_ROOT}/Welcome.md`]: `# Welcome to Margin

Margin is a *what you see is what you mean* Markdown editor.

- Type Markdown and it renders in place.
- Press **⌘/** to see the source.
- Press **⌘P** to quick-open a file.

> Tip: the sidebar shows this sample folder.

\`\`\`js
console.log('hello, margin');
\`\`\`

| Feature | Shortcut |
| ------- | -------- |
| Bold    | ⌘B       |
| Italic  | ⌘I       |

$$
e^{i\\pi} + 1 = 0
$$
`,
  [`${WEB_ROOT}/Notes/Ideas.md`]: `# Ideas

1. A plain-text first editor
2. Inline math like $a^2 + b^2 = c^2$
3. [CommonMark](https://commonmark.org)
`,
  [`${WEB_ROOT}/Notes/Todo.md`]: `# Todo

- [x] Write the platform layer
- [ ] Ship it
`,
  [`${WEB_ROOT}/Diagrams.md`]: `# Diagrams

\`\`\`mermaid
graph TD
  A[Write] --> B[Preview]
  B --> C[Export]
\`\`\`
`,
  [`${WEB_ROOT}/README.txt`]: 'Sample folder for the in-browser build of Margin.\n',
};

type WatchEntry = { root: string; cb: (events: FsEvent[]) => void; queue: FsEvent[]; timer: ReturnType<typeof setTimeout> | null };

/* Minimal File System Access API typings (not in lib.dom for all TS versions). */
interface FsaWritable {
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
interface FsaFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsaWritable>;
}
interface FsaDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FsaFileHandle | FsaDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsaFileHandle>;
}
type FsaWindow = Window & {
  showOpenFilePicker?: (o?: unknown) => Promise<FsaFileHandle[]>;
  showSaveFilePicker?: (o?: unknown) => Promise<FsaFileHandle>;
  showDirectoryPicker?: (o?: unknown) => Promise<FsaDirHandle>;
};

export interface WebPlatformOptions {
  /** Persist the memfs + settings in localStorage (default true). */
  persist?: boolean;
  /** Seed sample docs when the store is empty (default true). */
  seed?: boolean;
  /** Use the File System Access API when present (default: true unless navigator.webdriver). */
  useFileSystemAccess?: boolean;
  /** Install the keydown → onMenu listener (default true). */
  keyboardShortcuts?: boolean;
  /** Watch batching delay in ms (default 30). */
  watchDelay?: number;
}

export type DialogHook = (kind: 'open' | 'openFolder' | 'save', opts?: unknown) => string | null | Promise<string | null>;

export class WebPlatform implements Platform {
  readonly kind = 'web' as const;
  private nodes = new Map<string, Node>();
  private watchers = new Set<WatchEntry>();
  private menuCbs = new Set<(a: MenuAction) => void>();
  private openCbs = new Set<(paths: string[]) => void>();
  private closeCbs = new Set<() => Promise<boolean>>();
  private fileHandles = new Map<string, FsaFileHandle>();
  private dirHandles = new Map<string, FsaDirHandle>();
  private blobUrls = new Map<string, string>();
  private edited = false;
  private keyListener: ((e: KeyboardEvent) => void) | null = null;
  private opts: Required<WebPlatformOptions>;
  /** Overridable dialog (e2e tests): return a path or null. */
  dialogHook: DialogHook | null = null;
  readonly exports: { kind: 'html' | 'pdf'; path: string; html: string }[] = [];
  title = '';

  constructor(options: WebPlatformOptions = {}) {
    const automated = typeof navigator !== 'undefined' && !!navigator.webdriver;
    this.opts = {
      persist: options.persist ?? true,
      seed: options.seed ?? true,
      useFileSystemAccess: options.useFileSystemAccess ?? !automated,
      keyboardShortcuts: options.keyboardShortcuts ?? true,
      watchDelay: options.watchDelay ?? 30,
    };
    this.nodes.set('/', { kind: 'dir', mtime: Date.now() });
    if (!this.restore() && this.opts.seed) this.seedSamples();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', (e) => {
        if (this.edited) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }
  }

  // ---------------------------------------------------------------- memfs core

  private seedSamples(): void {
    for (const [p, text] of Object.entries(SAMPLE_DOCS)) this.putFile(p, text, false);
    this.ensureDir(WEB_THEMES_DIR);
    this.persist();
  }

  private restore(): boolean {
    if (!this.opts.persist) return false;
    try {
      const raw = globalThis.localStorage?.getItem(FS_KEY);
      if (!raw) return false;
      const entries = JSON.parse(raw) as [string, Node][];
      for (const [p, n] of entries) this.nodes.set(p, n);
      this.nodes.set('/', { kind: 'dir', mtime: Date.now() });
      return true;
    } catch {
      return false;
    }
  }

  private persist(): void {
    if (!this.opts.persist) return;
    const entries = [...this.nodes].filter(([p]) => p !== '/' && !p.startsWith(LOCAL_ROOT + '/') && p !== LOCAL_ROOT);
    try {
      globalThis.localStorage?.setItem(FS_KEY, JSON.stringify(entries));
    } catch (e) {
      console.warn('[margin/web] could not persist filesystem', e);
    }
  }

  private ensureDir(dir: string): string[] {
    const created: string[] = [];
    const parts = normalizePath(dir).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const n = this.nodes.get(cur);
      if (!n) {
        this.nodes.set(cur, { kind: 'dir', mtime: Date.now() });
        created.push(cur);
      } else if (n.kind !== 'dir') throw new Error(`ENOTDIR: ${cur}`);
    }
    return created;
  }

  /** Returns the paths that did not exist before (parents + file). */
  private putFile(path: string, content: string, binary: boolean): string[] {
    const p = normalizePath(path);
    const existing = this.nodes.get(p);
    if (existing?.kind === 'dir') throw new Error(`EISDIR: ${p}`);
    const created = this.ensureDir(dirname(p));
    this.nodes.set(p, { kind: 'file', content, binary: binary || undefined, mtime: Date.now() });
    if (!existing) created.push(p);
    return created;
  }

  private emit(events: FsEvent[]): void {
    if (!events.length) return;
    for (const w of this.watchers) {
      const mine = events.filter((e) => {
        const paths = e.kind === 'renamed' ? [e.from, e.to] : [e.path];
        return paths.some((p) => p === w.root || p.startsWith(w.root === '/' ? '/' : w.root + '/')) && !paths.some((p) => /\/\./.test(p.slice(w.root.length)));
      });
      if (!mine.length) continue;
      w.queue.push(...mine);
      if (!w.timer) {
        w.timer = setTimeout(() => {
          const batch = w.queue.splice(0);
          w.timer = null;
          if (this.watchers.has(w)) w.cb(batch);
        }, this.opts.watchDelay);
      }
    }
  }

  private entry(p: string, n: Node): DirEntry {
    return {
      name: basename(p) || p,
      path: p,
      isDir: n.kind === 'dir',
      mtime: n.mtime,
      size: n.kind === 'file' ? (n.binary ? Math.floor((n.content.length - n.content.indexOf(',') - 1) * 0.75) : new Blob([n.content]).size) : 0,
    };
  }

  // ---------------------------------------------------------------- Platform: files

  async readTextFile(path: string): Promise<string> {
    const p = normalizePath(path);
    const n = this.nodes.get(p);
    if (!n) throw new Error(`ENOENT: ${path}`);
    if (n.kind === 'dir') throw new Error(`EISDIR: ${path}`);
    return n.binary ? '' : n.content;
  }

  /** Our own writes don't produce `modified` events (same as desktop); new files do produce `created`. */
  async writeTextFile(path: string, content: string): Promise<void> {
    const p = normalizePath(path);
    const created = this.putFile(p, content, false);
    this.persist();
    this.emit(created.map((c) => ({ kind: 'created', path: c })));
    await this.writeThrough(p, content);
  }

  async stat(path: string): Promise<DirEntry | null> {
    const p = normalizePath(path);
    const n = this.nodes.get(p);
    return n ? this.entry(p, n) : null;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const dir = normalizePath(path);
    const n = this.nodes.get(dir);
    if (!n) throw new Error(`ENOENT: ${path}`);
    if (n.kind !== 'dir') throw new Error(`ENOTDIR: ${path}`);
    const prefix = dir === '/' ? '/' : dir + '/';
    const out: DirEntry[] = [];
    for (const [p, node] of this.nodes) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/') || rest.startsWith('.')) continue;
      out.push(this.entry(p, node));
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || coll.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));
  }

  async watch(path: string, cb: (events: FsEvent[]) => void): Promise<() => void> {
    const w: WatchEntry = { root: normalizePath(path), cb, queue: [], timer: null };
    this.watchers.add(w);
    return () => {
      this.watchers.delete(w);
      if (w.timer) clearTimeout(w.timer);
    };
  }

  async quickOpen(root: string, query: string, limit = 50): Promise<string[]> {
    const r = normalizePath(root);
    const prefix = r === '/' ? '/' : r + '/';
    const rels: string[] = [];
    for (const [p, n] of this.nodes) {
      if (n.kind !== 'file' || !p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (rel.split('/').some((s) => s.startsWith('.') || s === 'node_modules')) continue;
      rels.push(rel);
    }
    return rankPaths(rels, query, limit).map((rel) => prefix + rel);
  }

  // ---------------------------------------------------------------- Platform: images

  async storeImage(
    docPath: string | null,
    rule: ImageRule,
    input: { bytes?: Uint8Array; mime?: string; path?: string; name?: string },
  ): Promise<string> {
    if (input.path && /^(https?:|data:|blob:)/.test(input.path)) return input.path;
    const srcNode = input.path ? this.nodes.get(normalizePath(input.path)) : undefined;
    let dataUrl: string | null = null;
    if (input.bytes) dataUrl = await bytesToDataUrl(input.bytes, input.mime ?? `image/${extForImage(input.mime, input.name)}`);
    else if (srcNode?.kind === 'file') dataUrl = srcNode.binary ? srcNode.content : `data:text/plain,${encodeURIComponent(srcNode.content)}`;
    else if (input.path) return toMarkdownSrc(docPath ? relativePath(dirname(docPath), normalizePath(input.path)) : input.path);
    if (!dataUrl) throw new Error('storeImage: need bytes or path');

    // `none` rule or unsaved document → inline data URL (nowhere sensible to write).
    if (rule.kind === 'none' || (rule.kind === 'relative' && !docPath)) {
      if (input.path && srcNode) return toMarkdownSrc(docPath ? relativePath(dirname(docPath), normalizePath(input.path)) : input.path);
      return dataUrl;
    }
    const expanded = expandImageDir(rule.dir, docPath);
    const targetDir =
      expanded.startsWith('/') ? normalizePath(expanded) : docPath ? joinPath(dirname(docPath), expanded) : joinPath(WEB_ROOT, expanded);
    let dest: string;
    if (input.path && srcNode) {
      const name = basename(input.path);
      dest = joinPath(targetDir, name);
      const existing = this.nodes.get(dest);
      if (normalizePath(input.path) !== dest && existing && !(existing.kind === 'file' && existing.content === dataUrl)) {
        const dot = name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        for (let i = 1; this.nodes.has(dest); i++) dest = joinPath(targetDir, `${stem}-${i}${ext}`);
      }
    } else {
      const ext = extForImage(input.mime, input.name);
      do dest = joinPath(targetDir, generatedImageName(ext));
      while (this.nodes.has(dest));
    }
    const created = this.nodes.get(dest) ? [] : this.putFile(dest, dataUrl, true);
    this.persist();
    this.emit(created.map((c) => ({ kind: 'created', path: c })));
    if (input.bytes) await this.writeThroughBytes(dest, input.bytes);
    const rel = rule.kind === 'absolute' || !docPath ? dest : relativePath(dirname(docPath), dest);
    return toMarkdownSrc(rel);
  }

  assetUrl(path: string): string {
    if (/^(https?:|data:|blob:)/.test(path)) return path;
    let p = path;
    try {
      p = decodeURI(path);
    } catch {
      /* keep raw */
    }
    p = normalizePath(p);
    const n = this.nodes.get(p);
    if (n?.kind === 'file' && n.binary) return n.content;
    return this.blobUrls.get(p) ?? path;
  }

  // ---------------------------------------------------------------- Platform: dialogs

  private hook(): DialogHook | null {
    return this.dialogHook ?? ((globalThis as { __MARGIN_DIALOG__?: DialogHook }).__MARGIN_DIALOG__ || null);
  }

  private fsa(): FsaWindow | null {
    return this.opts.useFileSystemAccess && typeof window !== 'undefined' ? (window as FsaWindow) : null;
  }

  async openFileDialog(opts?: { directory?: boolean }): Promise<string | null> {
    const kind = opts?.directory ? 'openFolder' : 'open';
    const hook = this.hook();
    if (hook) return hook(kind, opts);
    const w = this.fsa();
    try {
      if (opts?.directory && w?.showDirectoryPicker) return await this.mountDirectory(await w.showDirectoryPicker({ mode: 'readwrite' }));
      if (!opts?.directory && w?.showOpenFilePicker) {
        const [h] = await w.showOpenFilePicker({
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } }],
        });
        return h ? await this.mountFile(h) : null;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
    const all = [...this.nodes].filter(([, n]) => (opts?.directory ? n.kind === 'dir' : n.kind === 'file')).map(([p]) => p);
    const def = opts?.directory ? WEB_ROOT : all.find((p) => p.endsWith('.md')) ?? '';
    const ans = globalThis.prompt?.(`${opts?.directory ? 'Open folder' : 'Open file'} (in-browser filesystem):\n${all.slice(0, 30).join('\n')}`, def);
    return ans ? normalizePath(ans) : null;
  }

  async saveFileDialog(opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
    const hook = this.hook();
    if (hook) return hook('save', opts);
    const w = this.fsa();
    if (w?.showSaveFilePicker) {
      try {
        const h = await w.showSaveFilePicker({ suggestedName: opts?.defaultPath ? basename(opts.defaultPath) : 'Untitled.md' });
        return await this.mountFile(h, true);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return null;
        throw e;
      }
    }
    const def = opts?.defaultPath ? (opts.defaultPath.startsWith('/') ? opts.defaultPath : joinPath(WEB_ROOT, opts.defaultPath)) : `${WEB_ROOT}/Untitled.md`;
    const ans = globalThis.prompt?.('Save as (in-browser filesystem path):', def);
    return ans ? normalizePath(ans) : null;
  }

  // File System Access mounting --------------------------------------------------

  private uniqueMount(name: string): string {
    let p = `${LOCAL_ROOT}/${name}`;
    for (let i = 2; this.nodes.has(p); i++) p = `${LOCAL_ROOT}/${name} ${i}`;
    return p;
  }

  private async mountFile(h: FsaFileHandle, forWriting = false): Promise<string> {
    const dir = this.uniqueMount(h.name.replace(/\.[^.]+$/, '') || 'file');
    const p = `${dir}/${h.name}`;
    const text = forWriting ? '' : await (await h.getFile()).text();
    this.putFile(p, text, false);
    this.fileHandles.set(p, h);
    return p;
  }

  private async mountDirectory(h: FsaDirHandle): Promise<string> {
    const root = this.uniqueMount(h.name);
    this.ensureDir(root);
    this.dirHandles.set(root, h);
    let budget = 3000;
    const walk = async (dh: FsaDirHandle, at: string, depth: number) => {
      for await (const child of dh.values()) {
        if (budget-- <= 0 || child.name.startsWith('.') || child.name === 'node_modules') continue;
        const p = `${at}/${child.name}`;
        if (child.kind === 'directory') {
          this.ensureDir(p);
          this.dirHandles.set(p, child);
          if (depth < 8) await walk(child, p, depth + 1);
        } else {
          this.fileHandles.set(p, child);
          if (/\.(md|markdown|mdown|mkd|txt|css)$/i.test(child.name)) {
            this.putFile(p, await (await child.getFile()).text(), false);
          } else if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(child.name)) {
            const f = await child.getFile();
            this.blobUrls.set(p, URL.createObjectURL(f));
            // placeholder entry (listed in the sidebar); assetUrl() serves the blob URL
            this.nodes.set(p, { kind: 'file', content: '', mtime: f.lastModified });
          }
        }
      }
    };
    await walk(h, root, 0);
    return root;
  }

  private async handleFor(path: string): Promise<FsaFileHandle | null> {
    const existing = this.fileHandles.get(path);
    if (existing) return existing;
    const parent = this.dirHandles.get(dirname(path));
    if (!parent) return null;
    const h = await parent.getFileHandle(basename(path), { create: true });
    this.fileHandles.set(path, h);
    return h;
  }

  private async writeThrough(path: string, content: string | Blob | Uint8Array): Promise<void> {
    if (!path.startsWith(LOCAL_ROOT + '/')) return;
    const h = await this.handleFor(path);
    if (!h) return;
    const w = await h.createWritable();
    await w.write(content as string | Blob);
    await w.close();
  }

  private writeThroughBytes(path: string, bytes: Uint8Array): Promise<void> {
    return this.writeThrough(path, new Blob([bytes as BlobPart]));
  }

  // ---------------------------------------------------------------- Platform: export

  async exportHtml(html: string, outPath: string): Promise<void> {
    this.exports.push({ kind: 'html', path: outPath, html });
    await this.writeTextFile(outPath, html);
    if (!navigatorIsAutomated()) downloadBlob(new Blob([html], { type: 'text/html' }), basename(outPath) || 'export.html');
  }

  /** Browsers cannot write PDFs: opens the print dialog with the HTML (user picks "Save as PDF"). */
  async exportPdf(html: string, outPath: string): Promise<void> {
    this.exports.push({ kind: 'pdf', path: outPath, html });
    if (!navigatorIsAutomated() && typeof document !== 'undefined') await printHtmlInIframe(html);
  }

  async allowAssetDir(_path: string): Promise<void> {}

  /** Web stores unsaved-doc images as data: URLs, so nothing is parked to relocate. */
  async relocateImages(_docPath: string, _rule: ImageRule, _srcs: string[]): Promise<Record<string, string>> {
    return {};
  }

  // ---- optional file-tree operations (PlatformExtras, #21). Own operations emit
  // watch events like the desktop watcher does (rename → renamed, remove → removed).

  async rename(from: string, to: string): Promise<void> {
    const f = normalizePath(from);
    const t = normalizePath(to);
    if (!this.nodes.has(f)) throw new Error(`ENOENT: ${from}`);
    if (this.nodes.has(t) && f.toLowerCase() !== t.toLowerCase()) throw new Error(`EEXIST: ${to}`);
    if (t.startsWith(f + '/')) throw new Error(`EINVAL: cannot move a folder into itself`);
    if (f.startsWith(LOCAL_ROOT + '/')) throw new Error('unsupported: renaming files mounted from disk');
    this.externalRename(f, t);
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (!this.nodes.has(p)) throw new Error(`ENOENT: ${path}`);
    if (p.startsWith(LOCAL_ROOT + '/')) throw new Error('unsupported: deleting files mounted from disk');
    this.externalRemove(p);
  }

  async createDir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (this.nodes.has(p)) throw new Error(`EEXIST: ${path}`);
    if (p.startsWith(LOCAL_ROOT + '/')) throw new Error('unsupported: creating folders on disk');
    if (this.nodes.get(dirname(p))?.kind !== 'dir') throw new Error(`ENOENT: ${dirname(p)}`);
    const created = this.ensureDir(p);
    this.persist();
    this.emit(created.map((c) => ({ kind: 'created', path: c })));
  }

  /** File › New Window (#94): a second browser window on the same (localStorage) disk. */
  openedWindows: string[] = [];
  async openWindow(opts: { path?: string } = {}): Promise<void> {
    const q = new URLSearchParams({ window: 'new' });
    if (opts.path) q.set('open', normalizePath(opts.path));
    const url = `${location.pathname}?${q}`;
    this.openedWindows.push(url);
    this.persist();
    window.open(url, '_blank');
  }

  /** Raw bytes (#94 Reopen with Encoding). Text nodes may carry `bytes` seeded via {@link externalWriteBytes}. */
  async readFileBytes(path: string): Promise<Uint8Array> {
    const n = this.nodes.get(normalizePath(path));
    if (!n || n.kind === 'dir') throw new Error(`ENOENT: ${path}`);
    if (n.bytes) return Uint8Array.from(atob(n.bytes), (c) => c.charCodeAt(0));
    return new TextEncoder().encode(n.binary ? '' : n.content);
  }

  /** Test hook: put a non-UTF-8 file on disk (readTextFile decodes it lossily, like the desktop). */
  externalWriteBytes(path: string, bytes: number[]): void {
    const p = normalizePath(path);
    const u8 = Uint8Array.from(bytes);
    const created = this.putFile(p, new TextDecoder('utf-8').decode(u8), false);
    const n = this.nodes.get(p);
    if (n && n.kind === 'file') n.bytes = btoa(String.fromCharCode(...u8));
    this.persist();
    this.emit(created.length ? created.map((c) => ({ kind: 'created', path: c })) : [{ kind: 'modified', path: p }]);
  }

  /** Copy File Path: recorded for tests, and best-effort onto the real clipboard. */
  clipboardText: string | null = null;
  async writeClipboardText(text: string): Promise<void> {
    this.clipboardText = text;
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  /** No file manager in the browser: recorded for tests. */
  revealed: string[] = [];
  async revealInFolder(path: string): Promise<void> {
    this.revealed.push(normalizePath(path));
  }

  async print(): Promise<void> {
    if (!navigatorIsAutomated()) window.print();
  }

  // ---------------------------------------------------------------- Platform: settings & themes

  async loadSettings(): Promise<AppSettings> {
    let raw: unknown = null;
    try {
      const s = this.opts.persist ? globalThis.localStorage?.getItem(SETTINGS_KEY) : this.memSettings;
      raw = s ? JSON.parse(s) : null;
    } catch {
      raw = null;
    }
    return normalizeSettings(raw);
  }

  private memSettings: string | null = null;

  async saveSettings(s: AppSettings): Promise<void> {
    const text = JSON.stringify(normalizeSettings(s));
    if (this.opts.persist) globalThis.localStorage?.setItem(SETTINGS_KEY, text);
    else this.memSettings = text;
  }

  async listThemes(): Promise<Record<string, string>> {
    const out = builtinThemes();
    for (const [p, n] of this.nodes) {
      if (n.kind === 'file' && dirname(p) === WEB_THEMES_DIR && p.endsWith('.css')) out[basename(p).slice(0, -4)] = n.content;
    }
    return out;
  }

  async themesDir(): Promise<string> {
    this.ensureDir(WEB_THEMES_DIR);
    return WEB_THEMES_DIR;
  }

  // ---------------------------------------------------------------- Platform: window

  async openExternal(url: string): Promise<void> {
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error(`refusing to open non-web URL: ${url}`);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async setTitle(title: string): Promise<void> {
    this.title = title;
    if (typeof document !== 'undefined') document.title = title;
  }

  async setDocumentEdited(edited: boolean): Promise<void> {
    this.edited = edited;
  }

  onMenu(cb: (action: MenuAction) => void): () => void {
    this.menuCbs.add(cb);
    if (this.opts.keyboardShortcuts && !this.keyListener && typeof window !== 'undefined') {
      this.keyListener = (e: KeyboardEvent) => {
        if (e.isComposing) return;
        const action = matchShortcut(e);
        if (!action) return;
        e.preventDefault();
        e.stopImmediatePropagation(); // like a native menu accelerator: the page never sees it
        this.triggerMenu(action);
      };
      window.addEventListener('keydown', this.keyListener, true);
    }
    return () => {
      this.menuCbs.delete(cb);
      if (!this.menuCbs.size && this.keyListener) {
        window.removeEventListener('keydown', this.keyListener, true);
        this.keyListener = null;
      }
    };
  }

  onOpenFiles(cb: (paths: string[]) => void): () => void {
    this.openCbs.add(cb);
    // `?open=/Margin/Welcome.md` (repeatable) behaves like files passed on the command line.
    if (typeof location !== 'undefined') {
      const paths = new URLSearchParams(location.search).getAll('open').map(normalizePath).filter((p) => this.nodes.has(p));
      if (paths.length) queueMicrotask(() => cb(paths));
    }
    return () => this.openCbs.delete(cb);
  }

  onCloseRequested(cb: () => Promise<boolean>): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  // ---------------------------------------------------------------- test / dev hooks

  /** Dispatch a menu action as if chosen from the native menu. */
  triggerMenu(action: MenuAction): void {
    for (const cb of [...this.menuCbs]) cb(action);
  }

  /** Simulate Finder "Open With" / CLI. */
  openFiles(paths: string[]): void {
    for (const cb of [...this.openCbs]) cb(paths.map(normalizePath));
  }

  /** Simulate closing the window; resolves true if every handler allowed it. */
  async requestClose(): Promise<boolean> {
    for (const cb of [...this.closeCbs]) if (!(await cb())) return false;
    return true;
  }

  get documentEdited(): boolean {
    return this.edited;
  }

  /** Change a file "from another app": emits `modified`/`created` to watchers. */
  externalWrite(path: string, content: string): void {
    const p = normalizePath(path);
    const created = this.putFile(p, content, false);
    this.persist();
    this.emit(created.length ? created.map((c) => ({ kind: 'created', path: c })) : [{ kind: 'modified', path: p }]);
  }

  externalRemove(path: string): void {
    const p = normalizePath(path);
    for (const k of [...this.nodes.keys()]) if (k === p || k.startsWith(p + '/')) this.nodes.delete(k);
    this.persist();
    this.emit([{ kind: 'removed', path: p }]);
  }

  externalRename(from: string, to: string): void {
    const f = normalizePath(from);
    const t = normalizePath(to);
    this.ensureDir(dirname(t));
    for (const [k, n] of [...this.nodes]) {
      if (k === f || k.startsWith(f + '/')) {
        this.nodes.delete(k);
        this.nodes.set(t + k.slice(f.length), n);
      }
    }
    this.persist();
    this.emit([{ kind: 'renamed', from: f, to: t }]);
  }

  /** Wipe storage and re-seed (tests). */
  reset(seed = true): void {
    this.nodes.clear();
    this.nodes.set('/', { kind: 'dir', mtime: Date.now() });
    if (seed) this.seedSamples();
    else this.persist();
    if (this.opts.persist) globalThis.localStorage?.removeItem(SETTINGS_KEY);
    this.memSettings = null;
  }

  /** Everything tests usually need, also exposed as `window.__MARGIN_WEB__`. */
  get debug() {
    return this;
  }
}

function navigatorIsAutomated(): boolean {
  return typeof navigator === 'undefined' || !!navigator.webdriver || typeof window === 'undefined' || /jsdom/i.test(navigator.userAgent);
}

function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return `data:${mime};base64,${btoa(bin)}`;
}

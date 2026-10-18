import type { EditorHandle, FsEvent, Platform } from '../contracts';
import { basename, dirname, join } from './util/path';
import { debounce } from './util/dom';

export type Eol = '\n' | '\r\n';

/** Dominant line ending of a text (ties → LF). */
export function detectEol(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function applyEol(text: string, eol: Eol): string {
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}

export interface DocState {
  path: string | null;
  name: string;
  dirty: boolean;
  eol: Eol;
  /** Deleted / moved away on disk while open. */
  missing: boolean;
  savedAt: number | null;
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/**
 * The open file changed on disk while the buffer has unsaved edits (#82).
 * Handed to the host's non-blocking prompt; exactly one of keepMine/loadDisk resolves it.
 */
export interface ExternalChange {
  path: string;
  name: string;
  /** LF-normalized disk content. */
  disk: string;
  /** Current buffer (read lazily, e.g. when the diff is opened). */
  mine(): string;
  /** Keep the buffer (stays dirty; next save overwrites). This disk version won't prompt again. */
  keepMine(): void;
  /** Replace the buffer with the disk version. Returns an undo function (null if stale). */
  loadDisk(): (() => void) | null;
}

/** Cheap 53-bit FNV-1a style hash of a string (own-write / seen-version detection). */
export function hashText(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${s.length}`;
}

export interface DocumentHost {
  platform: Platform;
  editor: EditorHandle;
  /** Ask what to do with unsaved changes. */
  askUnsaved(name: string, reason: string): Promise<UnsavedChoice>;
  /** File changed on disk while we have edits. true = reload from disk. */
  askReloadDirty(name: string): Promise<boolean>;
  /**
   * Show (or, with null, hide) a non-blocking prompt for a disk change while dirty.
   * Optional: without it the blocking `askReloadDirty` is used.
   */
  externalChange?(change: ExternalChange | null): void;
  notify(msg: string, kind?: 'info' | 'success' | 'error' | 'warning'): void;
  autoSave(): { enabled: boolean; delay: number };
  /** Called before setMarkdown so the editor can know the new base dir. */
  willLoad(path: string | null): void;
  onState(state: DocState): void;
  onOpened(path: string): void;
  /** Folder to suggest in Save As for untitled documents. */
  defaultDir(): string | null;
}

/**
 * Single-document lifecycle (one document per window, like Typora): open, save,
 * save-as, auto-save, dirty tracking, external change detection.
 */
export class DocumentController {
  path: string | null = null;
  eol: Eol = '\n';
  /** LF-normalized content as last loaded/saved. */
  private saved = '';
  private savedEol: Eol = '\n';
  dirty = false;
  missing = false;
  savedAt: number | null = null;
  private unwatch: (() => void) | null = null;
  private saving: Promise<boolean> | null = null;
  private loading = false;
  private autoSaveTimer = debounce(() => void this.autoSaveNow(), 1500);
  /** Hash of the raw on-disk text we know about (loaded, written, or explicitly kept over). */
  private diskHash: string | null = null;
  /** Unresolved disk change while dirty. */
  private pending: { path: string; raw: string; hash: string } | null = null;
  private sawRemoved = false;
  private fsDebounce: ReturnType<typeof debounce<[]>>;

  constructor(
    private host: DocumentHost,
    opts: { externalDebounceMs?: number } = {},
  ) {
    host.editor.onChange(() => this.onEditorChange());
    this.fsDebounce = debounce(() => void this.reconcile(), opts.externalDebounceMs ?? 60);
  }

  get name(): string {
    return this.path ? basename(this.path) : 'Untitled';
  }

  get dir(): string | null {
    return this.path ? dirname(this.path) : null;
  }

  state(): DocState {
    return { path: this.path, name: this.name, dirty: this.dirty, eol: this.eol, missing: this.missing, savedAt: this.savedAt };
  }

  private emit(): void {
    this.host.onState(this.state());
  }

  private isModified(): boolean {
    // A document whose file vanished is unsaved until it is written again.
    return this.missing || this.eol !== this.savedEol || this.host.editor.getMarkdown() !== this.saved;
  }

  private recomputeDirty = debounce(() => {
    const d = this.isModified();
    if (d !== this.dirty) {
      this.dirty = d;
      this.emit();
    }
    // Edits undone back to the old baseline while a disk change waits: nothing to lose, take it.
    if (!d && this.pending && this.pending.path === this.path) {
      this.loadDisk();
      this.host.notify(`Reloaded ${this.name} (changed on disk)`, 'info');
    }
  }, 120);

  private onEditorChange(): void {
    if (this.loading) return;
    if (!this.dirty) {
      // Flip to dirty immediately for responsive UI; the debounced check may flip back (undo to clean).
      this.dirty = true;
      this.emit();
    }
    this.recomputeDirty();
    const as = this.host.autoSave();
    if (as.enabled && this.path) {
      this.autoSaveTimer.cancel();
      this.autoSaveTimer = debounce(() => void this.autoSaveNow(), as.delay);
      this.autoSaveTimer();
    }
  }

  private async autoSaveNow(): Promise<void> {
    // Never auto-overwrite a disk change the user hasn't decided about yet.
    if (!this.path || !this.dirty || !this.host.autoSave().enabled || this.pending) return;
    await this.save({ quiet: true });
  }

  /** Flush pending auto-save (e.g. on blur / before switching documents). */
  async flushAutoSave(): Promise<void> {
    this.autoSaveTimer.cancel();
    await this.autoSaveNow();
  }

  private load(path: string | null, text: string): void {
    this.loading = true;
    try {
      this.eol = detectEol(text);
      const md = normalizeEol(text);
      this.host.willLoad(path);
      this.path = path;
      this.saved = md;
      this.savedEol = this.eol;
      this.host.editor.setMarkdown(md);
      this.dirty = false;
      this.missing = false;
      this.savedAt = null;
      this.diskHash = path ? hashText(text) : null;
    } finally {
      this.loading = false;
    }
    this.clearPending();
    this.recomputeDirty.cancel();
    void this.host.platform.setDocumentEdited(false);
    this.emit();
  }

  private async rewatch(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    const p = this.path;
    if (!p) return;
    try {
      const un = await this.host.platform.watch(p, (evs) => void this.onFsEvents(evs));
      if (this.path === p) this.unwatch = un;
      else un();
    } catch {
      /* watching is best effort */
    }
  }

  /** Make sure unsaved changes are handled. Returns false if the user cancelled. */
  async confirmLeave(reason: string): Promise<boolean> {
    if (!this.dirty) return true;
    // Auto-save may write silently, but never resurrect a file deleted behind our back.
    if (this.path && this.host.autoSave().enabled && !this.missing && !this.pending) return this.save({ quiet: true });
    const choice = await this.host.askUnsaved(this.name, reason);
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.save();
    return true;
  }

  async newDocument(): Promise<boolean> {
    if (!(await this.confirmLeave('before creating a new document'))) return false;
    this.load(null, '');
    await this.rewatch();
    this.host.editor.focus();
    return true;
  }

  async open(path: string): Promise<boolean> {
    if (path === this.path) return true;
    if (!(await this.confirmLeave(`before opening ${basename(path)}`))) return false;
    let text: string;
    try {
      text = await this.host.platform.readTextFile(path);
    } catch (e) {
      this.host.notify(`Couldn't open ${basename(path)}: ${errMsg(e)}`, 'error');
      return false;
    }
    this.load(path, text);
    await this.rewatch();
    this.host.onOpened(path);
    return true;
  }

  async openDialog(): Promise<boolean> {
    const p = await this.host.platform.openFileDialog();
    return p ? this.open(p) : false;
  }

  async save(opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (!this.path) return this.saveAs();
    if (this.saving) await this.saving;
    this.saving = this.writeTo(this.path, opts.quiet ?? false);
    try {
      return await this.saving;
    } finally {
      this.saving = null;
    }
  }

  async saveAs(): Promise<boolean> {
    const dir = this.dir ?? this.host.defaultDir();
    const fname = `${suggestName(this.host.editor.getMarkdown())}.md`;
    const def = this.path ?? (dir ? join(dir, fname) : fname);
    const target = await this.host.platform.saveFileDialog({
      defaultPath: def,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (!target) return false;
    const ok = await this.writeTo(target, false);
    if (ok) {
      const changed = target !== this.path;
      this.host.willLoad(target);
      this.path = target;
      this.missing = false;
      this.emit();
      if (changed) {
        await this.rewatch();
        this.host.onOpened(target);
      }
    }
    return ok;
  }

  private async writeTo(path: string, quiet: boolean): Promise<boolean> {
    const md = this.host.editor.getMarkdown();
    const raw = applyEol(md, this.eol);
    // Remember what we write *before* the watcher can echo it back.
    const prevHash = this.diskHash;
    if (path === this.path) this.diskHash = hashText(raw);
    try {
      await this.host.platform.writeTextFile(path, raw);
    } catch (e) {
      this.diskHash = prevHash;
      this.host.notify(`Couldn't save ${basename(path)}: ${errMsg(e)}`, 'error');
      return false;
    }
    this.diskHash = hashText(raw);
    this.clearPending(); // our write supersedes the disk version we were asked about
    this.saved = md;
    this.savedEol = this.eol;
    this.savedAt = Date.now();
    this.missing = false;
    this.recomputeDirty.cancel();
    this.dirty = this.isModified();
    void this.host.platform.setDocumentEdited(this.dirty);
    this.emit();
    if (!quiet) this.host.notify(`Saved ${basename(path)}`, 'success');
    return true;
  }

  /** Close = replace with an empty untitled document. */
  async close(): Promise<boolean> {
    if (!(await this.confirmLeave('before closing'))) return false;
    this.unwatch?.();
    this.unwatch = null;
    this.load(null, '');
    return true;
  }

  async reloadFromDisk(): Promise<void> {
    if (!this.path) return;
    if (this.dirty && !(await this.host.askReloadDirty(this.name))) return;
    try {
      this.load(this.path, await this.host.platform.readTextFile(this.path));
    } catch (e) {
      this.host.notify(`Couldn't reload: ${errMsg(e)}`, 'error');
    }
  }

  setEol(eol: Eol): void {
    if (eol === this.eol) return;
    this.eol = eol;
    // Line endings are applied on save, so the doc may now differ from disk.
    this.dirty = this.isModified();
    void this.host.platform.setDocumentEdited(this.dirty);
    this.emit();
  }

  /** Path changed because the file/folder was renamed from the sidebar. */
  renamed(from: string, to: string): void {
    if (!this.path) return;
    if (this.path === from || this.path.startsWith(from + '/') || this.path.startsWith(from + '\\')) {
      this.path = to + this.path.slice(from.length);
      if (this.missing) {
        this.missing = false;
        this.dirty = this.isModified();
      }
      this.host.willLoad(this.path);
      this.emit();
      void this.rewatch();
    }
  }

  /** Watch events are coalesced (editors often write via remove+create or several modifies). */
  async onFsEvents(events: FsEvent[]): Promise<void> {
    const p = this.path;
    if (!p) return;
    let touched = false;
    for (const ev of events) {
      if (ev.kind === 'renamed') {
        if (ev.from === p) this.renamed(ev.from, ev.to);
        continue;
      }
      if (ev.path !== p) continue;
      if (ev.kind === 'removed') this.sawRemoved = true;
      touched = true;
    }
    if (touched) this.fsDebounce();
  }

  private markMissing(): void {
    if (this.missing) return;
    this.missing = true;
    this.clearPending();
    this.recomputeDirty.cancel();
    this.dirty = true;
    this.emit();
    this.host.notify(`${this.name} was deleted or moved on disk. Save to keep it.`, 'warning');
  }

  private clearPending(): void {
    if (!this.pending) return;
    this.pending = null;
    this.host.externalChange?.(null);
  }

  /** Settle the file's on-disk state after a burst of watch events. */
  private async reconcile(): Promise<void> {
    const p = this.path;
    if (!p) return;
    const removed = this.sawRemoved;
    this.sawRemoved = false;
    let text: string;
    try {
      text = await this.host.platform.readTextFile(p);
    } catch {
      if (removed && this.path === p) this.markMissing();
      return;
    }
    if (this.path !== p) return;
    const hash = hashText(text);
    const md = normalizeEol(text);
    if (this.missing) {
      this.missing = false;
      this.dirty = this.isModified();
      this.emit();
    }
    // Our own write echoing back, a version the user already chose to keep over, or the baseline.
    if (hash === this.diskHash || md === this.saved) {
      this.diskHash = hash;
      this.clearPending();
      return;
    }
    if (!this.dirty) {
      const scrollEl = document.querySelector('.editor-scroll');
      const top = scrollEl?.scrollTop ?? 0;
      this.load(p, text);
      if (scrollEl) scrollEl.scrollTop = top;
      this.host.notify(`Reloaded ${this.name} (changed on disk)`, 'info');
      return;
    }
    if (this.pending?.hash === hash) return; // already prompting for this version
    this.pending = { path: p, raw: text, hash };
    const change = this.externalChangeFor(this.pending);
    if (this.host.externalChange) {
      this.host.externalChange(change);
      return;
    }
    const reload = await this.host.askReloadDirty(this.name);
    if (this.pending?.hash !== hash) return;
    if (reload) change.loadDisk();
    else change.keepMine();
  }

  private externalChangeFor(pend: { path: string; raw: string; hash: string }): ExternalChange {
    const live = (): boolean => this.pending === pend && this.path === pend.path;
    return {
      path: pend.path,
      name: basename(pend.path),
      disk: normalizeEol(pend.raw),
      mine: () => this.host.editor.getMarkdown(),
      keepMine: () => {
        if (live()) this.keepMine();
      },
      loadDisk: () => (live() ? this.loadDisk() : null),
    };
  }

  /** Resolve the pending disk change by keeping the buffer; the doc stays dirty vs the disk version. */
  keepMine(): void {
    const pend = this.pending;
    if (!pend) return;
    this.saved = normalizeEol(pend.raw);
    this.diskHash = pend.hash;
    this.missing = false;
    this.clearPending();
    this.recomputeDirty.cancel();
    this.dirty = this.isModified();
    void this.host.platform.setDocumentEdited(this.dirty);
    this.emit();
  }

  /** Resolve the pending disk change by loading it. Returns an undo that restores the previous buffer. */
  loadDisk(): (() => void) | null {
    const pend = this.pending;
    if (!pend || pend.path !== this.path) return null;
    const prevMd = this.host.editor.getMarkdown();
    const prevEol = this.eol;
    this.load(pend.path, pend.raw);
    const path = pend.path;
    return () => {
      if (this.path !== path) return;
      this.loading = true;
      try {
        this.host.editor.setMarkdown(prevMd);
        this.eol = prevEol;
      } finally {
        this.loading = false;
      }
      this.recomputeDirty.cancel();
      this.dirty = this.isModified();
      void this.host.platform.setDocumentEdited(this.dirty);
      this.emit();
    };
  }

  dispose(): void {
    this.unwatch?.();
    this.autoSaveTimer.cancel();
    this.recomputeDirty.cancel();
    this.fsDebounce.cancel();
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Suggested file name from the first heading/line. */
export function suggestName(md: string): string {
  const first = md.split('\n').find((l) => l.trim()) ?? '';
  const t = first
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|#`*_~[\]()]/g, '')
    .trim()
    .slice(0, 60)
    .trim();
  return t || 'Untitled';
}

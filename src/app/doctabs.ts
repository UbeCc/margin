import type { EditorHandle, Platform } from '../contracts';
import { DocumentController, normalizeEol, type DocumentHost, type ExternalChange } from './document';
import type { TabView } from './tabs';
import { basename } from './util/path';
import { h } from './util/dom';

/**
 * One open document: its own editor instance (so undo history, caret, scroll and
 * source mode survive tab switches) and its own lifecycle controller.
 */
export interface DocTab {
  readonly id: string;
  /** `div.margin-doc.editor-host`; only the active tab's host is attached. */
  readonly host: HTMLElement;
  editor: EditorHandle;
  doc: DocumentController;
  scrollTop: number;
  /** DOM selection when the tab was left (nodes stay valid while detached). */
  range: Range | null;
  /** Unresolved external change waiting for the banner (#82). */
  ext: ExternalChange | null;
}

export type DocHostCallbacks = Omit<DocumentHost, 'platform' | 'editor'>;

export interface DocTabsHost {
  readonly platform: Platform;
  readonly page: HTMLElement;
  readonly scroller: HTMLElement;
  createEditor(host: HTMLElement, tab: DocTab): EditorHandle;
  docHost(tab: DocTab): DocHostCallbacks;
  /** The active tab changed (refresh title, outline, status, find bar…). */
  activated(tab: DocTab): void;
  /** Tab list or a tab's label/dirty state changed. */
  changed(): void;
  /** Preference "Save without asking when switching files". */
  saveOnSwitch(): boolean;
  notify(msg: string, kind?: 'info' | 'success' | 'error' | 'warning'): void;
}

/** Closed documents kept alive (undo history + caret) for Reopen Closed File (#94). */
export const MAX_FROZEN = 5;
export const MAX_CLOSED = 20;

interface Closed {
  path: string;
  index: number;
  /** Parked tab (clean when closed) or null when only the path is remembered. */
  tab: DocTab | null;
}

/** Multi-document model behind the tab bar. */
export class DocTabs {
  tabs: DocTab[] = [];
  active!: DocTab;
  private seq = 0;
  private closed: Closed[] = [];

  constructor(private host: DocTabsHost) {}

  /** Create a tab (not yet in the list). */
  private make(): DocTab {
    const id = `tab${++this.seq}`;
    const el = h('div.margin-doc.editor-host', { 'data-tab-id': id });
    const tab = { id, host: el, scrollTop: 0, range: null, ext: null } as unknown as DocTab;
    // Mount before creating the editor so widgets can measure themselves.
    const prev = this.host.page.firstElementChild;
    if (!prev) this.host.page.append(el);
    tab.editor = this.host.createEditor(el, tab);
    tab.doc = new DocumentController({ platform: this.host.platform, editor: tab.editor, ...this.host.docHost(tab) });
    return tab;
  }

  /** New empty tab after the active one (or first), activated. */
  newTab(): DocTab {
    const t = this.make();
    const i = this.active ? this.tabs.indexOf(this.active) + 1 : 0;
    this.tabs.splice(i, 0, t);
    this.activate(t);
    return t;
  }

  byPath(path: string): DocTab | undefined {
    return this.tabs.find((t) => t.doc.path === path);
  }

  byId(id: string): DocTab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  views(): TabView[] {
    return this.tabs.map((t) => ({ id: t.id, name: t.doc.name, path: t.doc.path, dirty: t.doc.dirty, missing: t.doc.missing }));
  }

  activate(tab: DocTab, focus = true): void {
    const prev = this.active;
    if (prev === tab && tab.host.parentElement === this.host.page) return;
    if (prev && prev !== tab) {
      prev.scrollTop = this.host.scroller.scrollTop;
      const sel = getSelection();
      prev.range = sel && sel.rangeCount && prev.host.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : prev.range;
      void prev.doc.flushAutoSave();
    }
    this.active = tab;
    this.host.page.replaceChildren(tab.host);
    this.host.scroller.scrollTop = tab.scrollTop;
    if (focus) this.restoreCaret(tab);
    this.host.activated(tab);
    this.host.changed();
  }

  private restoreCaret(tab: DocTab): void {
    const root = tab.host.querySelector<HTMLElement>('.md-editor');
    if (tab.range && root && !tab.editor.isSourceMode() && root.contains(tab.range.startContainer)) {
      root.focus({ preventScroll: true });
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(tab.range);
      this.host.scroller.scrollTop = tab.scrollTop;
      document.dispatchEvent(new Event('selectionchange'));
    } else if (tab.range || tab.editor.isSourceMode()) {
      tab.editor.focus();
      this.host.scroller.scrollTop = tab.scrollTop;
    }
  }

  /** Activate the next (+1) / previous (-1) tab, wrapping around. */
  cycle(dir: 1 | -1): void {
    const n = this.tabs.length;
    if (n < 2) return;
    this.activate(this.tabs[(this.tabs.indexOf(this.active) + dir + n) % n]);
  }

  move(id: string, to: number): void {
    const t = this.byId(id);
    if (!t) return;
    this.tabs.splice(this.tabs.indexOf(t), 1);
    this.tabs.splice(Math.max(0, Math.min(to, this.tabs.length)), 0, t);
    this.host.changed();
  }

  /**
   * Open `path`: an already-open document is just focused. 'replace' swaps the active
   * document (sidebar / quick open, asks about unsaved changes or saves on switch);
   * 'tab' opens beside it. A pristine untitled tab is always reused.
   */
  async openPath(path: string, mode: 'replace' | 'tab'): Promise<boolean> {
    const existing = this.byPath(path);
    if (existing) {
      this.activate(existing);
      return true;
    }
    const cur = this.active;
    const reuse = cur.doc.isPristine();
    if (mode === 'replace' && !reuse) {
      await cur.doc.flushAutoSave();
      if (cur.doc.dirty) {
        const quiet = this.host.saveOnSwitch() && !!cur.doc.path && !cur.doc.missing;
        const ok = quiet ? await cur.doc.save({ quiet: true }) : await cur.doc.confirmLeave(`before opening ${basename(path)}`);
        if (!ok) return false;
      }
    }
    const idx = this.tabs.indexOf(cur);
    const swap = reuse || mode === 'replace';
    const revived = await this.revive(path);
    let fresh: DocTab;
    if (revived) fresh = revived;
    else {
      fresh = this.make();
      this.tabs.splice(idx + 1, 0, fresh);
      this.activate(fresh, false);
      if (!(await fresh.doc.open(path))) {
        this.tabs.splice(this.tabs.indexOf(fresh), 1);
        this.activate(cur);
        this.destroy(fresh);
        return false;
      }
      this.tabs.splice(this.tabs.indexOf(fresh), 1);
    }
    this.tabs.splice(swap ? idx : idx + 1, swap ? 1 : 0, fresh);
    this.activate(fresh);
    if (swap) this.park(cur, idx);
    this.host.changed();
    return true;
  }

  /** Close a tab (asks about unsaved changes). The last tab becomes a new untitled one. */
  async close(tab: DocTab = this.active): Promise<boolean> {
    await tab.doc.flushAutoSave();
    if (!(await tab.doc.confirmLeave('before closing'))) return false;
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return false;
    if (this.tabs.length === 1) {
      if (tab.doc.isPristine()) return true;
      const t = this.make();
      this.tabs.splice(0, 1, t);
      this.activate(t);
    } else {
      this.tabs.splice(idx, 1);
      if (this.active === tab) this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)]);
      else this.host.changed();
    }
    this.park(tab, idx);
    return true;
  }

  /** Paths of recently closed documents, most recent first. */
  closedPaths(): string[] {
    return [...new Set(this.closed.map((c) => c.path).reverse())];
  }

  /** File › Reopen Closed File: newest closed document, with its undo history when unchanged on disk. */
  async reopenClosed(): Promise<boolean> {
    while (this.closed.length) {
      const e = this.closed[this.closed.length - 1];
      const open = this.byPath(e.path);
      if (open) {
        this.closed.pop();
        this.activate(open);
        return true;
      }
      if (await this.host.platform.stat(e.path).catch(() => null)) return this.openPath(e.path, 'tab');
      this.closed.pop();
      if (e.tab) this.destroy(e.tab);
    }
    this.host.notify('No recently closed file to reopen.', 'info');
    return false;
  }

  /** Save every modified document; untitled ones ask for a location. Returns the count, or false if cancelled. */
  async saveAll(): Promise<number | false> {
    let n = 0;
    for (const t of [...this.tabs]) {
      if (!t.doc.dirty) continue;
      if (!t.doc.path) this.activate(t);
      if (!(await t.doc.save({ quiet: true }))) return false;
      n++;
    }
    return n;
  }

  /** Before closing the window: every modified document is saved or explicitly discarded. */
  async confirmAll(reason: string): Promise<boolean> {
    for (const t of [...this.tabs]) {
      await t.doc.flushAutoSave();
      if (!t.doc.dirty) continue;
      this.activate(t);
      if (!(await t.doc.confirmLeave(reason))) return false;
    }
    return true;
  }

  /** A parked tab for `path` whose baseline still matches the disk, taken out of the closed list. */
  private async revive(path: string): Promise<DocTab | null> {
    const i = this.closed.map((c) => c.path).lastIndexOf(path);
    const e = i >= 0 ? this.closed[i] : null;
    if (!e?.tab) return null;
    this.closed.splice(i, 1);
    const tab = e.tab;
    let disk: string | null = null;
    try {
      disk = await this.host.platform.readTextFile(path);
    } catch {
      /* gone */
    }
    if (disk === null || normalizeEol(disk) !== tab.doc.savedText || tab.doc.path !== path) {
      this.destroy(tab);
      return null;
    }
    await tab.doc.resume();
    return tab;
  }

  /** Remember a closed tab: clean documents keep their editor (undo, caret) for a while. */
  private park(tab: DocTab, index: number): void {
    const path = tab.doc.path;
    if (!path) return this.destroy(tab);
    const keep = !tab.doc.dirty && !tab.doc.missing;
    if (keep) {
      tab.scrollTop = tab === this.active ? this.host.scroller.scrollTop : tab.scrollTop;
      tab.doc.suspend();
      tab.host.remove();
    } else this.destroy(tab);
    this.closed.push({ path, index, tab: keep ? tab : null });
    const frozen = this.closed.filter((c) => c.tab);
    for (const c of frozen.slice(0, Math.max(0, frozen.length - MAX_FROZEN))) {
      this.destroy(c.tab!);
      c.tab = null;
    }
    if (this.closed.length > MAX_CLOSED) for (const c of this.closed.splice(0, this.closed.length - MAX_CLOSED)) if (c.tab) this.destroy(c.tab);
  }

  private destroy(tab: DocTab): void {
    tab.doc.dispose();
    try {
      tab.editor.destroy();
    } catch {
      /* already gone */
    }
    tab.host.remove();
  }

  /** Every live editor (settings broadcast). Parked editors get settings when revived. */
  editors(): EditorHandle[] {
    return [...this.tabs, ...this.closed.filter((c) => c.tab).map((c) => c.tab!)].map((t) => t.editor);
  }
}

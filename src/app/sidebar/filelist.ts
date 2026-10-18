import type { DirEntry, Platform } from '../../contracts';
import { h, clearChildren } from '../util/dom';
import { basename, dirname, extname, relative, stripExt } from '../util/path';
import { showContextMenu } from '../ui/contextmenu';
import { extras } from '../platform-extras';
import { compareBy, DEFAULT_SORT, type SortOrder } from './sort';
import { collectDocs, dateLabel, LIST_LIMIT, summarize } from './walk';
import { makeDraggable } from './drag';

export interface FileListHost {
  platform: Platform;
  openFile(path: string): void;
}

/**
 * Articles list view (#101, `typora.sidebar.list-view`): every document under the
 * folder as a flat list of title + summary + date, capped at 400 entries, with an
 * optional "Group By Folder" layout.
 */
export class FileList {
  readonly el: HTMLElement;
  private root: string | null = null;
  private order: SortOrder = DEFAULT_SORT;
  private grouped = true;
  private docs: DirEntry[] = [];
  private oversize = false;
  private summaries = new Map<string, string>();
  private rows = new Map<string, HTMLElement>();
  private active: string | null = null;
  private gen = 0;
  loaded = false;

  constructor(private host: FileListHost) {
    this.el = h('div.file-list', { role: 'listbox', 'aria-label': 'Articles', tabindex: '0' });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  setRoot(root: string | null): void {
    this.root = root;
    this.loaded = false;
    this.summaries.clear();
    this.docs = [];
    clearChildren(this.el);
  }

  setActive(path: string | null): void {
    if (this.active) this.rows.get(this.active)?.classList.remove('active');
    this.active = path;
    if (path) this.rows.get(path)?.classList.add('active');
  }

  setSort(order: SortOrder): void {
    this.order = order;
    if (this.loaded) this.render();
  }

  setGrouped(on: boolean): void {
    this.grouped = on;
    if (this.loaded) this.render();
  }

  /** (Re)collect documents; summaries fill in asynchronously. */
  async reload(): Promise<void> {
    const gen = ++this.gen;
    if (!this.root) return;
    this.el.setAttribute('aria-busy', 'true');
    const { docs, oversize } = await collectDocs(this.host.platform, this.root, { limit: LIST_LIMIT, cancelled: () => gen !== this.gen });
    if (gen !== this.gen) return;
    this.docs = docs;
    this.oversize = oversize;
    this.loaded = true;
    this.render();
    await this.fillSummaries(gen);
    if (gen === this.gen) this.el.removeAttribute('aria-busy');
  }

  private async fillSummaries(gen: number): Promise<void> {
    const todo = this.docs.filter((d) => !this.summaries.has(d.path));
    const worker = async (): Promise<void> => {
      for (let d = todo.shift(); d && gen === this.gen; d = todo.shift()) {
        let s = '';
        try {
          s = summarize(await this.host.platform.readTextFile(d.path));
        } catch {
          /* unreadable: no summary */
        }
        this.summaries.set(d.path, s);
        const el = this.rows.get(d.path)?.querySelector('.list-summary');
        if (el) el.textContent = s;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  private render(): void {
    clearChildren(this.el);
    this.rows.clear();
    if (!this.docs.length) {
      this.el.appendChild(h('div.list-empty', { text: 'No Markdown files in this folder' }));
      return;
    }
    const sorted = [...this.docs].sort(compareBy<DirEntry>(this.order));
    // Folder headers only when some article lives outside the root folder itself.
    if (this.grouped && sorted.some((d) => dirname(d.path) !== this.root)) {
      const groups = new Map<string, DirEntry[]>();
      for (const d of sorted) {
        const dir = dirname(d.path);
        groups.set(dir, [...(groups.get(dir) ?? []), d]);
      }
      const dirs = [...groups.keys()].sort((a, b) => (a === this.root ? -1 : b === this.root ? 1 : a.localeCompare(b)));
      for (const dir of dirs) {
        const label = dir === this.root ? basename(this.root!) : relative(this.root!, dir);
        this.el.appendChild(h('div.list-group', { role: 'presentation', 'data-dir': dir, text: label }));
        for (const d of groups.get(dir)!) this.el.appendChild(this.row(d));
      }
    } else {
      for (const d of sorted) this.el.appendChild(this.row(d));
    }
    if (this.oversize) this.el.appendChild(h('div.list-oversize', { text: `Showing the first ${LIST_LIMIT} documents` }));
  }

  private row(d: DirEntry): HTMLElement {
    const ext = extname(d.name);
    const row = h(
      'div.list-item',
      { role: 'option', tabindex: '-1', 'data-path': d.path, title: d.path, 'aria-selected': String(d.path === this.active) },
      h('div.list-title', null, h('span.list-name', { text: ext ? stripExt(d.name) : d.name }), ext ? h('span.list-ext', { text: ext }) : null),
      h('div.list-meta', { text: dateLabel(d.mtime) }),
      h('div.list-summary', { text: this.summaries.get(d.path) ?? '' }),
    );
    if (d.path === this.active) row.classList.add('active');
    makeDraggable(row, d.path);
    row.addEventListener('click', () => {
      row.focus({ preventScroll: true });
      this.host.openFile(d.path);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = extras(this.host.platform);
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Open', run: () => this.host.openFile(d.path) },
        { separator: true },
        { label: 'Copy Path', run: () => void navigator.clipboard?.writeText(d.path) },
        { label: 'Reveal in Finder', run: () => void p.revealInFolder?.(d.path), disabled: !p.revealInFolder },
      ]);
    });
    this.rows.set(d.path, row);
    return row;
  }

  private onKey(e: KeyboardEvent): void {
    const rows = [...this.el.querySelectorAll<HTMLElement>('.list-item')];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') rows[Math.min(rows.length - 1, i + 1)].focus();
    else if (e.key === 'ArrowUp') rows[Math.max(0, i - 1)].focus();
    else if (e.key === 'Enter' && i >= 0) rows[i].click();
    else return;
    e.preventDefault();
  }
}

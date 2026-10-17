import type { DirEntry, FsEvent, Platform } from '../../contracts';
import { extras } from '../platform-extras';
import { h, icon, clearChildren } from '../util/dom';
import { basename, dirname, isInside, isMarkdownPath, isValidFileName, join, naturalCompare, uniqueName, extname } from '../util/path';
import { showContextMenu, type MenuItem } from '../ui/contextmenu';
import { confirmDialog, promptDialog } from '../ui/modal';

export interface FileTreeHost {
  platform: Platform;
  openFile(path: string): void;
  onRenamed(from: string, to: string): void;
  onDeleted(path: string): void;
  notify(msg: string, kind?: 'info' | 'success' | 'error' | 'warning'): void;
  openFolderDialog(): void;
  openFolder(path: string): void;
  recentFolders(): string[];
}

interface DirNode {
  path: string;
  loaded: boolean;
  expanded: boolean;
  loading: Promise<void> | null;
  children: DirEntry[];
  /** <ul> holding the children rows. */
  list: HTMLUListElement;
}

/** Sort: folders first, then natural name order; hide dotfiles. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.isDir === b.isDir ? naturalCompare(a.name, b.name) : a.isDir ? -1 : 1));
}

export class FileTree {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private header: HTMLElement;
  root: string | null = null;
  private dirs = new Map<string, DirNode>();
  private rows = new Map<string, HTMLElement>();
  private active: string | null = null;

  constructor(private host: FileTreeHost) {
    this.header = h('div.tree-header');
    this.body = h('div.tree-body', { role: 'tree', tabindex: '0', 'aria-label': 'Files' });
    this.el = h('div.file-tree', null, this.header, this.body);
    this.body.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.tree-row') || !this.root) return;
      e.preventDefault();
      this.showMenu(e.clientX, e.clientY, null);
    });
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.renderEmpty();
  }

  // ------------------------------------------------------------- root

  async setRoot(path: string | null): Promise<void> {
    this.root = path;
    this.dirs.clear();
    this.rows.clear();
    clearChildren(this.body);
    if (!path) return this.renderEmpty();
    this.renderHeader();
    const node = this.makeDirNode(path);
    node.expanded = true;
    node.list.classList.add('tree-root');
    this.body.appendChild(node.list);
    await this.load(node);
    if (this.active) this.setActive(this.active);
  }

  private renderHeader(): void {
    clearChildren(this.header);
    if (!this.root) return;
    this.header.append(
      h('span.tree-title', { title: this.root, text: basename(this.root) }),
      h(
        'span.tree-actions',
        null,
        h('button.icon-btn', { type: 'button', title: 'New File', 'aria-label': 'New File', onclick: () => void this.newFile(this.root!) }, icon('plus')),
        h('button.icon-btn', { type: 'button', title: 'Reveal Active File', 'aria-label': 'Reveal Active File', onclick: () => this.active && void this.reveal(this.active) }, icon('target')),
        h('button.icon-btn', { type: 'button', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => void this.refreshAll() }, icon('refresh')),
      ),
    );
  }

  private renderEmpty(): void {
    clearChildren(this.header);
    clearChildren(this.body);
    const recents = this.host.recentFolders().slice(0, 6);
    this.body.appendChild(
      h(
        'div.tree-empty',
        null,
        h('p.tree-empty-title', { text: 'No folder open' }),
        h('p.tree-empty-hint', { text: 'Open a folder to browse its Markdown files here.' }),
        h('button.btn.btn-primary', { type: 'button', text: 'Open Folder…', onclick: () => this.host.openFolderDialog() }),
        recents.length
          ? h(
              'div.tree-recents',
              null,
              h('div.tree-recents-title', { text: 'Recent folders' }),
              ...recents.map((p) =>
                h('button.tree-recent', { type: 'button', title: p, onclick: () => this.host.openFolder(p) }, icon('folder'), h('span', { text: basename(p) })),
              ),
            )
          : null,
      ),
    );
  }

  private makeDirNode(path: string): DirNode {
    const node: DirNode = { path, loaded: false, expanded: false, loading: null, children: [], list: h('ul.tree-list', { role: 'group' }) };
    this.dirs.set(path, node);
    return node;
  }

  private depthOf(path: string): number {
    if (!this.root) return 0;
    const rel = path.slice(this.root.length).split(/[\\/]/).filter(Boolean);
    return rel.length - 1;
  }

  private async load(node: DirNode): Promise<void> {
    if (node.loading) return node.loading;
    node.loading = (async () => {
      let entries: DirEntry[] = [];
      try {
        entries = sortEntries(await this.host.platform.listDir(node.path));
      } catch (e) {
        this.host.notify(`Couldn't list ${basename(node.path)}: ${e instanceof Error ? e.message : e}`, 'error');
      }
      node.children = entries;
      node.loaded = true;
      this.renderChildren(node);
    })();
    try {
      await node.loading;
    } finally {
      node.loading = null;
    }
  }

  private renderChildren(node: DirNode): void {
    clearChildren(node.list);
    for (const entry of node.children) node.list.appendChild(this.renderEntry(entry));
    if (!node.children.length && node.path !== this.root) node.list.appendChild(h('li.tree-placeholder', { text: 'Empty' }));
  }

  private renderEntry(entry: DirEntry): HTMLLIElement {
    const depth = this.depthOf(entry.path);
    const row = h(
      'div.tree-row',
      {
        role: 'treeitem',
        tabindex: '-1',
        'data-path': entry.path,
        'data-kind': entry.isDir ? 'dir' : 'file',
        title: entry.path,
        style: `--depth:${depth}`,
      },
      entry.isDir ? icon('chevron', 'tree-chevron') : h('span.tree-chevron-space'),
      icon(entry.isDir ? 'folder' : 'file', 'tree-icon'),
      h('span.tree-name', { text: entry.name }),
    );
    if (!entry.isDir && !isMarkdownPath(entry.name)) row.classList.add('tree-other');
    this.rows.set(entry.path, row);
    const li = h('li.tree-item', null, row);
    if (entry.isDir) {
      const existing = this.dirs.get(entry.path);
      const node = existing ?? this.makeDirNode(entry.path);
      row.setAttribute('aria-expanded', String(node.expanded));
      li.appendChild(node.list);
      node.list.hidden = !node.expanded;
      if (node.expanded) {
        if (node.loaded) this.renderChildren(node);
        else void this.load(node);
      }
    }
    if (entry.path === this.active) row.classList.add('active');
    row.addEventListener('click', () => {
      row.focus({ preventScroll: true });
      if (entry.isDir) void this.toggle(entry.path);
      else this.activate(entry);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      row.focus({ preventScroll: true });
      this.showMenu(e.clientX, e.clientY, entry);
    });
    return li;
  }

  private activate(entry: DirEntry): void {
    if (isMarkdownPath(entry.name)) this.host.openFile(entry.path);
    else this.host.notify(`${extname(entry.name) || entry.name} files open in other apps`, 'info');
  }

  async toggle(path: string, force?: boolean): Promise<void> {
    const node = this.dirs.get(path);
    if (!node) return;
    node.expanded = force ?? !node.expanded;
    this.rows.get(path)?.setAttribute('aria-expanded', String(node.expanded));
    node.list.hidden = !node.expanded;
    if (node.expanded && !node.loaded) await this.load(node);
  }

  // --------------------------------------------------------- active file

  setActive(path: string | null): void {
    if (this.active) this.rows.get(this.active)?.classList.remove('active');
    this.active = path;
    if (path) this.rows.get(path)?.classList.add('active');
  }

  /** Expand ancestors, highlight and scroll the active file into view. */
  async reveal(path: string): Promise<void> {
    if (!this.root || !isInside(this.root, path)) return;
    const chain: string[] = [];
    for (let d = dirname(path); isInside(this.root, d) && d !== this.root; d = dirname(d)) chain.unshift(d);
    for (const d of chain) {
      if (!this.dirs.get(d)) {
        // Parent listing not loaded yet; load it so this dir's node exists.
        const parent = this.dirs.get(dirname(d));
        if (parent && !parent.loaded) await this.load(parent);
      }
      await this.toggle(d, true);
    }
    this.setActive(path);
    const row = this.rows.get(path);
    row?.scrollIntoView({ block: 'nearest' });
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 700);
  }

  // ------------------------------------------------------- fs updates

  async refreshDir(path: string): Promise<void> {
    const node = this.dirs.get(path);
    if (!node || !node.loaded) return;
    node.loaded = false;
    await this.load(node);
    if (this.active) this.setActive(this.active);
  }

  async refreshAll(): Promise<void> {
    const loaded = [...this.dirs.values()].filter((n) => n.loaded).map((n) => n.path);
    for (const p of loaded) await this.refreshDir(p);
  }

  /** Re-list the parent folder of every changed path that we have loaded. */
  onFsEvents(events: FsEvent[]): void {
    const dirs = new Set<string>();
    for (const ev of events) {
      if (ev.kind === 'renamed') {
        dirs.add(dirname(ev.from));
        dirs.add(dirname(ev.to));
      } else if (ev.kind !== 'modified') dirs.add(dirname(ev.path));
    }
    for (const d of dirs) void this.refreshDir(d);
  }

  // ------------------------------------------------------- operations

  private async takenNames(dir: string): Promise<Set<string>> {
    try {
      return new Set((await this.host.platform.listDir(dir)).map((e) => e.name.toLowerCase()));
    } catch {
      return new Set();
    }
  }

  async newFile(dir: string): Promise<void> {
    const suggested = uniqueName('Untitled', '.md', await this.takenNames(dir));
    const name = await promptDialog({ title: 'New File', value: suggested, okLabel: 'Create', selectStem: true, validate: nameError });
    if (!name) return;
    const file = extname(name) ? name : `${name}.md`;
    const path = join(dir, file);
    if (await this.host.platform.stat(path)) return this.host.notify(`${file} already exists`, 'error');
    try {
      await this.host.platform.writeTextFile(path, '');
    } catch (e) {
      return this.host.notify(`Couldn't create ${file}: ${errMsg(e)}`, 'error');
    }
    await this.toggle(dir, true);
    await this.refreshDir(dir);
    this.host.openFile(path);
  }

  async newFolder(dir: string): Promise<void> {
    const createDir = extras(this.host.platform).createDir;
    if (!createDir) return;
    const suggested = uniqueName('New Folder', '', await this.takenNames(dir));
    const name = await promptDialog({ title: 'New Folder', value: suggested, okLabel: 'Create', validate: nameError });
    if (!name) return;
    try {
      await createDir.call(this.host.platform, join(dir, name));
    } catch (e) {
      return this.host.notify(`Couldn't create folder: ${errMsg(e)}`, 'error');
    }
    await this.toggle(dir, true);
    await this.refreshDir(dir);
  }

  async rename(entry: DirEntry): Promise<void> {
    const rename = extras(this.host.platform).rename;
    if (!rename) return;
    const name = await promptDialog({ title: `Rename ${entry.isDir ? 'Folder' : 'File'}`, value: entry.name, okLabel: 'Rename', selectStem: !entry.isDir, validate: nameError });
    if (!name || name === entry.name) return;
    const to = join(dirname(entry.path), name);
    try {
      await rename.call(this.host.platform, entry.path, to);
    } catch (e) {
      return this.host.notify(`Couldn't rename: ${errMsg(e)}`, 'error');
    }
    // Keep expansion state of renamed folders.
    for (const [p, node] of [...this.dirs]) {
      if (isInside(entry.path, p)) {
        this.dirs.delete(p);
        node.path = to + p.slice(entry.path.length);
        this.dirs.set(node.path, node);
        node.loaded = false;
      }
    }
    if (this.active && isInside(entry.path, this.active)) this.active = to + this.active.slice(entry.path.length);
    this.host.onRenamed(entry.path, to);
    await this.refreshDir(dirname(entry.path));
  }

  async delete(entry: DirEntry): Promise<void> {
    const remove = extras(this.host.platform).remove;
    if (!remove) return;
    const ok = await confirmDialog(
      `Move “${entry.name}” to the Trash?`,
      entry.isDir ? 'The folder and everything in it will be moved to the Trash.' : 'You can restore it from the Trash.',
      'Move to Trash',
      true,
    );
    if (!ok) return;
    try {
      await remove.call(this.host.platform, entry.path);
    } catch (e) {
      return this.host.notify(`Couldn't delete: ${errMsg(e)}`, 'error');
    }
    this.host.onDeleted(entry.path);
    await this.refreshDir(dirname(entry.path));
  }

  private showMenu(x: number, y: number, entry: DirEntry | null): void {
    const p = extras(this.host.platform);
    const dir = entry ? (entry.isDir ? entry.path : dirname(entry.path)) : this.root!;
    const items: MenuItem[] = [];
    if (entry && !entry.isDir) items.push({ label: 'Open', run: () => this.activate(entry) }, { separator: true });
    items.push(
      { label: 'New File…', run: () => void this.newFile(dir) },
      { label: 'New Folder…', run: () => void this.newFolder(dir), disabled: !p.createDir },
    );
    if (entry) {
      items.push(
        { separator: true },
        { label: 'Rename…', run: () => void this.rename(entry), disabled: !p.rename },
        { label: 'Move to Trash', run: () => void this.delete(entry), disabled: !p.remove, danger: true },
      );
    }
    items.push(
      { separator: true },
      { label: 'Copy Path', run: () => void navigator.clipboard?.writeText(entry?.path ?? this.root!) },
      { label: 'Reveal in Finder', run: () => void p.revealInFolder?.(entry?.path ?? this.root!), disabled: !p.revealInFolder },
      { label: 'Refresh', run: () => void (entry?.isDir ? this.refreshDir(entry.path) : this.refreshAll()) },
    );
    showContextMenu(x, y, items);
  }

  // ------------------------------------------------------- keyboard

  private visibleRows(): HTMLElement[] {
    return [...this.body.querySelectorAll<HTMLElement>('.tree-row')].filter((r) => r.offsetParent !== null);
  }

  private onKey(e: KeyboardEvent): void {
    const rows = this.visibleRows();
    if (!rows.length) return;
    const cur = (document.activeElement as HTMLElement)?.closest?.('.tree-row') as HTMLElement | null;
    const i = cur ? rows.indexOf(cur) : -1;
    const path = cur?.dataset.path;
    const isDir = cur?.dataset.kind === 'dir';
    switch (e.key) {
      case 'ArrowDown':
        rows[Math.min(rows.length - 1, i + 1)].focus();
        break;
      case 'ArrowUp':
        rows[Math.max(0, i - 1)].focus();
        break;
      case 'ArrowRight':
        if (path && isDir) void this.toggle(path, true);
        break;
      case 'ArrowLeft':
        if (path && isDir && this.dirs.get(path)?.expanded) void this.toggle(path, false);
        else if (path) this.rows.get(dirname(path))?.focus();
        break;
      case 'Enter':
        cur?.click();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}

function nameError(v: string): string | null {
  return isValidFileName(v) ? null : 'Names can’t be empty or contain / \\ : * ? " < > |';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

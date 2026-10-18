import type { FsEvent } from '../../contracts';
import { h, icon, debounce } from '../util/dom';
import { showContextMenu, type MenuItem } from '../ui/contextmenu';
import type { MarginSettings } from '../settings';
import { FileTree, type FileTreeHost, type FilesMode } from './filetree';
import { FileList } from './filelist';
import { SidebarSearch } from './search';
import { SORT_OPTIONS, type SortOrder } from './sort';

export interface FilesPanelHost extends FileTreeHost {
  settings(): MarginSettings;
  updateSettings(patch: Partial<MarginSettings>): void;
  /** Open `path` and run a find for `query` once it is loaded. */
  openAt(path: string, query: string | null, caseSensitive: boolean): void;
}

/**
 * The Files sidebar panel (#101): one header (folder title + actions) over three
 * bodies — the lazy file tree, the flat Articles list, and full-text search.
 */
export class FilesPanel {
  readonly tree: FileTree;
  readonly list: FileList;
  readonly search: SidebarSearch;
  private listDirty = true;
  private reloadListSoon = debounce(() => void this.reloadList(), 400);

  constructor(private host: FilesPanelHost) {
    this.tree = new FileTree({ ...host, extraActions: () => this.actions(), refreshMode: () => this.refreshMode() });
    this.list = new FileList({ platform: host.platform, openFile: (p) => host.openFile(p) });
    this.search = new SidebarSearch({ platform: host.platform, openAt: (p, q, cs) => host.openAt(p, q, cs) });
    const s = host.settings();
    this.tree.setSort(s.sidebarSort);
    this.list.setSort(s.sidebarSort);
    this.list.setGrouped(s.sidebarGroupByFolder);
    this.tree.mountPanel(this.list.el);
    this.tree.mountPanel(this.search.el);
    this.tree.setMode(s.sidebarFileView);
    this.search.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.search.input.value) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeSearch();
    });
  }

  get el(): HTMLElement {
    return this.tree.el;
  }

  get mode(): FilesMode {
    return this.tree.mode;
  }

  async setRoot(path: string | null): Promise<void> {
    this.list.setRoot(path);
    this.search.setRoot(path);
    this.listDirty = true;
    await this.tree.setRoot(path);
    if (this.mode === 'list') await this.reloadList();
  }

  setActive(path: string | null): void {
    this.tree.setActive(path);
    this.list.setActive(path);
  }

  onFsEvents(events: FsEvent[]): void {
    this.tree.onFsEvents(events);
    this.listDirty = true;
    if (this.mode === 'list') this.reloadListSoon();
  }

  private async reloadList(): Promise<void> {
    this.listDirty = false;
    await this.list.reload();
  }

  /** Switch the files body; 'search' is transient and not persisted. */
  async setMode(mode: FilesMode): Promise<void> {
    if (mode !== 'search') this.host.updateSettings({ sidebarFileView: mode });
    this.tree.setMode(mode);
    if (mode === 'list' && (this.listDirty || !this.list.loaded)) await this.reloadList();
  }

  async openSearch(seed?: string): Promise<void> {
    await this.setMode('search');
    this.search.focus(seed);
  }

  closeSearch(): void {
    void this.setMode(this.host.settings().sidebarFileView);
  }

  setSort(order: SortOrder): void {
    this.host.updateSettings({ sidebarSort: order });
    this.tree.setSort(order);
    this.list.setSort(order);
  }

  setGrouped(on: boolean): void {
    this.host.updateSettings({ sidebarGroupByFolder: on });
    this.list.setGrouped(on);
  }

  private refreshMode(): void {
    if (this.mode === 'list') void this.reloadList();
    else void this.search.run();
  }

  showSortMenu(x: number, y: number): void {
    const cur = this.host.settings().sidebarSort;
    const items: MenuItem[] = SORT_OPTIONS.map((o) => ({ label: o.label, checked: o.id === cur, run: () => this.setSort(o.id) }));
    if (this.mode === 'list') {
      const grouped = this.host.settings().sidebarGroupByFolder;
      items.push({ separator: true }, { label: 'Group By Folder', checked: grouped, run: () => this.setGrouped(!grouped) });
    }
    showContextMenu(x, y, items);
  }

  private actions(): HTMLElement[] {
    const mode = this.mode;
    const sort = h('button.icon-btn.sort-btn', { type: 'button', title: 'Sort', 'aria-label': 'Sort' }, icon('down'));
    sort.addEventListener('click', () => {
      const r = sort.getBoundingClientRect();
      this.showSortMenu(r.left, r.bottom + 2);
    });
    const toList = mode !== 'list';
    const view = h(
      'button.icon-btn.view-switch',
      {
        type: 'button',
        title: toList ? 'Switch to File List view' : 'Switch to File Tree view',
        'aria-label': 'Switch File List/Tree View',
        'aria-pressed': String(mode === 'list'),
        onclick: () => void this.setMode(toList ? 'list' : 'tree'),
      },
      icon(toList ? 'list' : 'folder'),
    );
    const search = h(
      'button.icon-btn.search-btn',
      {
        type: 'button',
        title: 'Search',
        'aria-label': 'Search',
        'aria-pressed': String(mode === 'search'),
        onclick: () => (mode === 'search' ? this.closeSearch() : void this.openSearch()),
      },
      icon('search'),
    );
    return [sort, view, search];
  }
}

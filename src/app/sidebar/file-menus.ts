/**
 * Sidebar file context menus in Typora's exact order (#142,
 * fe-sidebar-statusbar-find §6): tree / Articles-list / search-result menus
 * share one ops surface implemented by FileTree.
 */
import type { DirEntry, Platform } from '../../contracts';
import { extras } from '../platform-extras';
import { h } from '../util/dom';
import { basename, dirname } from '../util/path';
import type { MenuItem } from '../ui/contextmenu';
import { openModal } from '../ui/modal';
import { copyName } from './filetree';

/** Everything the tree / list menus can do; absent entries render disabled. */
export interface SideFileOps {
  platform: Platform;
  open(entry: DirEntry): void;
  openInNewWindow?(path: string): void;
  newFile(dir: string): void;
  newFolder?(dir: string): void;
  /** Sidebar "Search" view. */
  search(): void;
  setView(mode: 'tree' | 'list'): void;
  duplicate?(entry: DirEntry): void;
  rename?(entry: DirEntry): void;
  getInfo(entry: DirEntry): void;
  remove(entry: DirEntry): void;
  copyPath(path: string): void;
  reveal?(path: string): void;
  /** The undoable sidebar op recorded for `dir`, if any ("Undo Rename %@" / "Undo Move %@"). */
  undoFor(dir: string): { label: string; undo(): Promise<void> } | null;
}

const sep: MenuItem = { separator: true };

/** "Copy File Path" / "Reveal in Finder" tail shared by every sidebar menu. */
function tail(ops: SideFileOps, path: string): MenuItem[] {
  const reveal = extras(ops.platform).revealInFolder;
  return [
    { label: 'Copy File Path', run: () => ops.copyPath(path) },
    { label: 'Reveal in Finder', run: () => void reveal?.call(ops.platform, path), disabled: !reveal },
  ];
}

function viewItems(ops: SideFileOps, active: 'tree' | 'list', long: boolean): MenuItem[] {
  return [
    { label: long ? 'Articles (List View)' : 'Articles', checked: active === 'list', run: () => ops.setView('list') },
    { label: long ? 'File Tree (Tree View)' : 'File Tree', checked: active === 'tree', run: () => ops.setView('tree') },
  ];
}

function newItems(ops: SideFileOps, dir: string): MenuItem[] {
  return [
    { label: 'New File', run: () => ops.newFile(dir) },
    { label: 'New Folder', run: () => ops.newFolder?.(dir), disabled: !ops.newFolder },
  ];
}

/** One undoable step, inserted before the first separator with its own separator after it. */
function undoItems(ops: SideFileOps, dir: string): MenuItem[] {
  const op = ops.undoFor(dir);
  if (!op) return [];
  return [{ label: `Undo ${op.label}`, run: () => void op.undo().catch(() => undefined) }, sep];
}

/**
 * Build a Typora-order sidebar menu.
 * - `entry === null`: the tree root / empty area below it.
 * - `view`: assembling view ('tree' or the Articles 'list'); `active` = shown view.
 */
export function fileMenu(o: { ops: SideFileOps; entry: DirEntry | null; view: 'tree' | 'list'; active: 'tree' | 'list' | 'search'; rootDir: string }): MenuItem[] {
  const { ops, entry, view } = o;
  const dir = entry ? (entry.isDir ? entry.path : dirname(entry.path)) : o.rootDir;
  const items: MenuItem[] = [];
  if (entry) {
    if (!entry.isDir) items.push({ label: 'Open', run: () => ops.open(entry) });
    if (ops.openInNewWindow) items.push({ label: 'Open in New Window', run: () => ops.openInNewWindow!(entry.path) });
    // Quick Look after Open (#131): tree + Articles, files only.
    if (entry && !entry.isDir) {
      const ql = extras(ops.platform).quickLook;
      items.push({ label: 'Quick Look', run: () => void ql?.call(ops.platform, entry.path), disabled: !ql });
    }
    items.push(...undoItems(ops, dir));
  }
  if (view === 'list') {
    if (!entry) return [];
    // Articles item: New File only, then Search, view items, Get Info…, Rename…, Duplicate
    items.push(sep, { label: 'New File', run: () => ops.newFile(dir) }, sep, { label: 'Search', run: () => ops.search() }, sep, ...viewItems(ops, o.active === 'list' ? 'list' : 'tree', false), sep);
    if (ops.getInfo) items.push({ label: 'Get Info…', run: () => ops.getInfo(entry) });
    if (ops.rename) items.push({ label: 'Rename…', run: () => ops.rename!(entry) });
    if (ops.duplicate) items.push({ label: 'Duplicate', run: () => ops.duplicate!(entry) });
    items.push(sep, { label: 'Delete…', danger: true, run: () => ops.remove(entry) }, sep, ...tail(ops, entry.path));
    return items;
  }
  // Tree: file | folder | root share the head; the file adds Duplicate before Rename….
  items.push(sep, ...newItems(ops, dir), sep, { label: 'Search', run: () => ops.search() }, sep, ...viewItems(ops, o.active === 'list' ? 'list' : 'tree', true), sep);
  if (entry) {
    if (!entry.isDir && ops.duplicate) items.push({ label: 'Duplicate', run: () => ops.duplicate!(entry) });
    if (ops.rename) items.push({ label: 'Rename…', run: () => ops.rename!(entry) });
    items.push(sep, { label: 'Get Info…', run: () => ops.getInfo(entry) }, { label: 'Delete…', danger: true, run: () => ops.remove(entry) }, sep);
  }
  items.push(...tail(ops, entry ? entry.path : o.rootDir));
  return items;
}

export function showInfo(entry: DirEntry): void {
  const fmt = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');
  const size = entry.isDir ? '—' : fmtSize(entry.size);
  const body = h(
    'div.file-info',
    null,
    h('h3', { text: entry.name }),
    h('dl', null,
      h('dt', { text: 'Kind' }), h('dd', { text: entry.isDir ? 'Folder' : 'File' }),
      h('dt', { text: 'Where' }), h('dd', { text: dirname(entry.path) }),
      h('dt', { text: 'Size' }), h('dd', { text: size }),
      h('dt', { text: 'Created' }), h('dd', { text: fmt(entry.ctime) }),
      h('dt', { text: 'Modified' }), h('dd', { text: fmt(entry.mtime) }),
    ),
    h('div.modal-buttons', null, h('button', { type: 'button', 'data-id': 'ok', onclick: () => close() }, 'OK')),
  );
  const { close } = openModal(body, { className: 'info-dialog', label: `Info: ${entry.name}` });
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** "Duplicate": copy a text file next to itself as "name (copy).ext" (first free). */
export async function duplicateFile(platform: Platform, entry: DirEntry, taken: Set<string>, notify: (m: string, k?: 'info' | 'error' | 'success') => void, refresh: () => void): Promise<void> {
  if (entry.isDir) return;
  let name = copyName(entry.name);
  while (taken.has(name.toLowerCase())) name = copyName(name);
  const to = `${dirname(entry.path)}/${name}`;
  try {
    const text = await platform.readTextFile(entry.path);
    await platform.writeTextFile(to, text);
  } catch (e) {
    return notify(`Couldn't duplicate ${basename(entry.path)}: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
  notify(`Duplicated as ${name}`, 'success');
  refresh();
}

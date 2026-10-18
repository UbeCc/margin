import type { DirEntry } from '../../contracts';
import { naturalCompare } from '../util/path';

/**
 * File tree / Articles list ordering (#101, `typora.sidebar.sort`). Labels follow
 * Typora's sort buttons. Typora's code −3 is shared by "natural descending" and
 * "creation date descending" (natural descending is unreachable there); Margin
 * keeps all eight orders distinct on purpose.
 */
export type SortKey = 'name' | 'natural' | 'created' | 'modified';
export type SortOrder = `${SortKey}-${'asc' | 'desc'}`;

export const DEFAULT_SORT: SortOrder = 'natural-asc';

export const SORT_OPTIONS: { id: SortOrder; label: string }[] = [
  { id: 'name-asc', label: 'Sort by Name (Ascending)' },
  { id: 'name-desc', label: 'Sort by Name (Descending)' },
  { id: 'natural-asc', label: 'Sort Naturally (Ascending)' },
  { id: 'natural-desc', label: 'Sort Naturally (Descending)' },
  { id: 'created-asc', label: 'Sort by Creation Date (Ascending)' },
  { id: 'created-desc', label: 'Sort by Creation Date (Descending)' },
  { id: 'modified-asc', label: 'Sort by Modification Date (Ascending)' },
  { id: 'modified-desc', label: 'Sort by Modification Date (Descending)' },
];

export function isSortOrder(v: unknown): v is SortOrder {
  return SORT_OPTIONS.some((o) => o.id === v);
}

const base = (n: string): string => {
  const i = n.indexOf('.');
  return i < 0 ? n : n.slice(0, i);
};
const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Typora's name order (fe-sidebar-statusbar-find §3): lower-cased, the part before
 * the first "." first, the full name only breaks ties. No numeric collation ("a10" < "a2").
 */
export function nameCompare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return cmpStr(base(x), base(y)) || cmpStr(x, y) || cmpStr(a, b);
}

/** Natural order: same base-name-first rule, embedded numbers compared numerically. */
export function naturalNameCompare(a: string, b: string): number {
  return naturalCompare(base(a), base(b)) || naturalCompare(a, b);
}

interface Sortable {
  name: string;
  mtime: number;
  ctime?: number;
}

/** Comparator for one direction-less key; ties fall back to natural name order. */
function keyCompare(key: SortKey, a: Sortable, b: Sortable): number {
  switch (key) {
    case 'name':
      return nameCompare(a.name, b.name);
    case 'natural':
      return naturalNameCompare(a.name, b.name);
    case 'created':
      // No birth time from the platform → creation order is unknown; use mtime.
      return (a.ctime ?? a.mtime) - (b.ctime ?? b.mtime) || naturalNameCompare(a.name, b.name);
    case 'modified':
      return a.mtime - b.mtime || naturalNameCompare(a.name, b.name);
  }
}

export function compareBy<T extends Sortable>(order: SortOrder): (a: T, b: T) => number {
  const [key, dir] = order.split('-') as [SortKey, 'asc' | 'desc'];
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => sign * keyCompare(key, a, b);
}

/**
 * Tree order: hide dotfiles; with "Group By Folder" (default) folders come first
 * and each group is sorted on its own, otherwise folders and files interleave.
 */
export function sortEntries(entries: DirEntry[], order: SortOrder = DEFAULT_SORT, groupFolders = true): DirEntry[] {
  const cmp = compareBy<DirEntry>(order);
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (!groupFolders || a.isDir === b.isDir ? cmp(a, b) : a.isDir ? -1 : 1));
}

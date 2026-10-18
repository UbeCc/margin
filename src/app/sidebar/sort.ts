import type { DirEntry } from '../../contracts';
import { naturalCompare } from '../util/path';

/**
 * File tree / Articles list ordering (#101, `typora.sidebar.sort`). Labels follow
 * Typora's "Sort" submenu. Folders always stay above files in the tree; the
 * direction flips only the order inside each group.
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

/** Plain (non-numeric) name order: "a10" < "a2". Case-insensitive, then case-sensitive tiebreak. */
export function nameCompare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
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
      return naturalCompare(a.name, b.name);
    case 'created':
      // No birth time from the platform → creation order is unknown; use mtime.
      return (a.ctime ?? a.mtime) - (b.ctime ?? b.mtime) || naturalCompare(a.name, b.name);
    case 'modified':
      return a.mtime - b.mtime || naturalCompare(a.name, b.name);
  }
}

export function compareBy<T extends Sortable>(order: SortOrder): (a: T, b: T) => number {
  const [key, dir] = order.split('-') as [SortKey, 'asc' | 'desc'];
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => sign * keyCompare(key, a, b);
}

/** Tree order: hide dotfiles, folders first, then `order` inside each group. */
export function sortEntries(entries: DirEntry[], order: SortOrder = DEFAULT_SORT): DirEntry[] {
  const cmp = compareBy<DirEntry>(order);
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.isDir === b.isDir ? cmp(a, b) : a.isDir ? -1 : 1));
}

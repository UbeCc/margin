import type { DirEntry, Platform } from '../../contracts';
import { isTextBundlePath } from '../textbundle';
import { extname } from '../util/path';

/**
 * Recursive document walk for the Articles list and sidebar search (#101).
 * Mirrors Typora's library enumeration (files-windows-settings §6.3): skip
 * `node_modules` and dot-folders, keep only files the editor opens, and stop
 * once more than 399 documents were found ("oversize").
 */
export const LIST_LIMIT = 400;

/** Extensions the sidebar lists (fe-sidebar-statusbar-find §2), plus extension-less files. */
const LISTED_EXT = new Set(['md', 'markdown', 'mmd', 'mkd', 'mdwn', 'mdown', 'mdx', 'mdtxt', 'mdtext', 'apib', 'rmarkdown', 'rmd', 'qmd', 'txt', 'text']);

export function isListedDoc(name: string): boolean {
  if (name.startsWith('.')) return false;
  const ext = extname(name).slice(1).toLowerCase();
  return !ext || LISTED_EXT.has(ext);
}

export function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

export interface WalkResult {
  docs: DirEntry[];
  /** More documents exist than `limit`; the list is truncated. */
  oversize: boolean;
}

export interface WalkOpts {
  limit?: number;
  /** Abort early (new search / folder change). */
  cancelled?: () => boolean;
  /** Skip files larger than this (folder search skips > 2 MB). */
  maxBytes?: number;
}

/** Breadth-first walk (shallow files first, like a flat list reads best). */
export async function collectDocs(platform: Platform, root: string, opts: WalkOpts = {}): Promise<WalkResult> {
  const limit = opts.limit ?? LIST_LIMIT;
  const docs: DirEntry[] = [];
  const queue = [root];
  while (queue.length) {
    if (opts.cancelled?.()) break;
    const dir = queue.shift()!;
    let entries: DirEntry[];
    try {
      entries = await platform.listDir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDir) {
        // A `.textbundle` is one document (fe-sidebar §1), not a folder to walk into.
        if (isTextBundlePath(e.path) && !shouldSkipDir(e.name)) {
          if (docs.length >= limit) return { docs, oversize: true };
          docs.push(e);
        } else if (!isTextBundlePath(e.path) && !shouldSkipDir(e.name)) queue.push(e.path);
      } else if (isListedDoc(e.name) && (opts.maxBytes === undefined || e.size <= opts.maxBytes)) {
        if (docs.length >= limit) return { docs, oversize: true };
        docs.push(e);
      }
    }
  }
  return { docs, oversize: false };
}

/** Bytes read for a list summary (fe-sidebar-statusbar-find §4: "~600 bytes"). */
export const SUMMARY_BYTES = 600;

const FM_KEYS = ['title', 'subtitle'];
const FM_DESC = ['overview', 'summary', 'description', 'excerpt'];

/** `title`, `subtitle` and the first of overview/summary/description/excerpt from a front matter block. */
function frontMatterValues(fm: string): string[] {
  const get = (k: string): string | null => {
    const m = new RegExp(`^${k}\\s*:\\s*(.+)$`, 'mi').exec(fm);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
  };
  const out = FM_KEYS.map(get).filter((v): v is string => !!v);
  const desc = FM_DESC.map(get).find((v) => !!v);
  if (desc) out.push(desc);
  return out;
}

/** Strip block markers / inline syntax from body text (one line). */
function plain(line: string): string {
  return line
    .replace(/^ {0,3}(?:#{1,6}(?=\s)|>|[-*+](?=\s)|\d+[.)](?=\s))\s*(?:\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`$=]/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * List summary of a document head (§4): front matter title/subtitle/description
 * first (body text appended when fewer than 3 values), then body lines with
 * markers stripped; newlines are kept as line breaks.
 */
export function summarize(text: string, maxChars = 200): string {
  let t = text.slice(0, SUMMARY_BYTES).replace(/^\uFEFF/, '');
  const parts: string[] = [];
  const fm = /^---\r?\n([\s\S]*?)(?:\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)|$)/.exec(t);
  if (fm) {
    parts.push(...frontMatterValues(fm[1]));
    t = t.slice(fm[0].length);
  }
  if (parts.length < 3) {
    for (const line of t.split(/\r?\n/)) {
      if (/^ {0,3}(?:```|~~~)/.test(line)) continue;
      const p = plain(line);
      if (p) parts.push(p);
    }
  }
  const s = parts.join('\n');
  return s.length > maxChars ? s.slice(0, maxChars).trimEnd() + '…' : s;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** Modified-date label of an Articles row (§4, including the original "1 minutes ago"). */
export function dateLabel(mtime: number, now = Date.now()): string {
  const d = new Date(mtime);
  const n = new Date(now);
  const diff = now - mtime;
  const sameDay = d.toDateString() === n.toDateString();
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return '1 minutes ago';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} minutes ago`;
  if (diff < 5 * 3_600_000 && sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now - 86_400_000);
  if (diff < 48 * 3_600_000 && d.toDateString() === y.toDateString()) return 'Yesterday';
  if (diff < 6 * 86_400_000 && !sameDay) return `${Math.max(1, Math.floor(diff / 86_400_000))} days ago`;
  if (d.getFullYear() === n.getFullYear()) return `${MONTHS[d.getMonth()]} ${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

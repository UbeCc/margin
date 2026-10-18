import type { DirEntry, Platform } from '../../contracts';
import { isMarkdownPath } from '../util/path';

/**
 * Recursive document walk for the Articles list and sidebar search (#101).
 * Mirrors Typora's library enumeration (files-windows-settings §6.3): skip
 * `node_modules` and dot-folders, keep only files the editor opens, and stop
 * once more than 399 documents were found ("oversize").
 */
export const LIST_LIMIT = 400;

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
        if (!shouldSkipDir(e.name)) queue.push(e.path);
      } else if (!e.name.startsWith('.') && isMarkdownPath(e.name)) {
        if (docs.length >= limit) return { docs, oversize: true };
        docs.push(e);
      }
    }
  }
  return { docs, oversize: false };
}

/** Bytes Typora reads for a list summary. */
export const SUMMARY_BYTES = 800;

/**
 * Plain-text summary of a document head: drop front matter, fences' markers,
 * heading/list/quote markers, emphasis, links/images (keep link text), HTML
 * tags; collapse whitespace.
 */
export function summarize(text: string, maxChars = 200): string {
  let t = text.slice(0, SUMMARY_BYTES);
  t = t.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?(?:\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)|$)/, '');
  t = t
    .replace(/^ {0,3}(?:```|~~~).*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/(\*\*|__|~~|==|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > maxChars ? t.slice(0, maxChars).trimEnd() + '…' : t;
}

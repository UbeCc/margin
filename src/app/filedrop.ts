/**
 * Files / folders dragged onto the window from the OS (#23).
 *
 * Routing (Margin's reading of Typora's behaviour, files-windows-settings prose is silent on
 * the details — see the PR notes):
 * - folders open in the sidebar, Markdown / text files open as documents (tabs, or the
 *   already-open tab is focused) wherever they are dropped;
 * - over the editor, images are inserted at the drop point (stored with the image rule, as a
 *   paste would), other files are inserted as links relative to the document;
 * - other files dropped outside the editor are ignored with a hint.
 */
import type { EditorHandle, FileDrop, Platform } from '../contracts';
import { basename, isImagePath, isMarkdownPath, relativeFrom, stripExt } from './util/path';

export interface FileDropDeps {
  platform: Pick<Platform, 'stat'>;
  editor(): EditorHandle;
  /** The active document's editor host (null when hidden). */
  editorHost(): HTMLElement | null;
  /** Directory of the active document (null when untitled). */
  docDir(): string | null;
  storeImage(input: { path: string; name: string }): Promise<string | null>;
  openPaths(paths: string[]): Promise<void>;
  notify(message: string): void;
}

function inside(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Markdown link destination: spaces encoded, `<…>` when parentheses would break it. */
export function linkDest(src: string): string {
  const s = src.replace(/\\/g, '/').replace(/ /g, '%20');
  return /[()<>]/.test(s) ? `<${s.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : s;
}

function label(text: string): string {
  return text.replace(/[[\]]/g, '');
}

export async function handleFileDrop(d: FileDropDeps, drop: FileDrop): Promise<void> {
  const overEditor = inside(d.editorHost(), drop.x, drop.y);
  const toOpen: string[] = [];
  const parts: string[] = [];
  let ignored = 0;
  for (const p of drop.paths) {
    const st = await d.platform.stat(p).catch(() => null);
    if (!st) continue;
    if (st.isDir || isMarkdownPath(p)) toOpen.push(p);
    else if (!overEditor) ignored++;
    else if (isImagePath(p)) {
      const src = await d.storeImage({ path: p, name: basename(p) });
      // storeImage returns a src, or (#99) a complete snippet (`![alt](src)` / `<img …>`) to insert verbatim.
      if (src) parts.push(/^(?:!\[|<img\b)/i.test(src.trim()) ? src.trim() : `![${label(stripExt(basename(p)))}](${linkDest(src)})`);
    } else {
      const dir = d.docDir();
      parts.push(`[${label(basename(p))}](${linkDest(dir ? relativeFrom(dir, p) : p)})`);
    }
  }
  if (parts.length) d.editor().exec({ kind: 'insertMarkdownAt', markdown: parts.join(' '), x: drop.x, y: drop.y });
  if (toOpen.length) await d.openPaths(toOpen);
  if (ignored && !parts.length && !toOpen.length) d.notify('Drop files onto the document to insert them; only Markdown files and folders can be opened.');
}

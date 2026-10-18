import type { Platform } from '../../contracts';
import { extras } from '../platform-extras';
import { findImageRefs } from '../upload';
import { basename } from '../util/path';
import { locate, type Located } from './tools';

/** All rendered images of the editor, in document order (inline images and HTML-block previews). */
const IMG_SEL = '.md-image img.md-img, .mb-html-block img';

/**
 * The markdown occurrence of a rendered `img`: inline images carry their exact source
 * in `.md-src`; HTML-block images are matched by occurrence order among the refs that
 * render to the same URL.
 */
export function refForImage(img: HTMLImageElement, root: HTMLElement, md: string, resolve: (src: string) => string): Located | null {
  const refs = findImageRefs(md).map(locate);
  const raw = img.closest('.md-image')?.querySelector('.md-src')?.textContent ?? null;
  const all = [...root.querySelectorAll<HTMLImageElement>(IMG_SEL)];
  if (raw !== null) {
    const same = all.filter((x) => x.closest('.md-image')?.querySelector('.md-src')?.textContent === raw);
    const k = same.indexOf(img);
    const cands = refs.filter((r) => r.raw === raw);
    return cands[Math.max(0, k)] ?? cands[0] ?? null;
  }
  const url = img.getAttribute('src') ?? '';
  const same = all.filter((x) => !x.closest('.md-image') && x.getAttribute('src') === url);
  const k = same.indexOf(img);
  const cands = refs.filter((r) => r.raw.trimStart().toLowerCase().startsWith('<img') && (resolve(r.src) === url || r.src === url));
  return cands[Math.max(0, k)] ?? cands[0] ?? null;
}

/**
 * Copy the rendered image to the clipboard as PNG (#136): native copy of the file
 * bytes first, canvas re-encode only for non-PNG or remote sources.
 */
export async function copyImageContent(img: HTMLImageElement, abs?: string | null, native?: (path: string) => Promise<boolean>): Promise<boolean> {
  try {
    if (abs && native && (await native(abs))) return true;
    const blob = await (await fetch(img.src)).blob();
    let png = blob;
    if (blob.type !== 'image/png') {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      png = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Rename or Move Image to…" (#141): a save dialog choosing the destination folder
 * and the new name; delegates to the image tools' copy/move.
 */
export function moveImageDialog(openSave: { saveFileDialog(o?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> }, tools: { absOf(src: string): string | null; copyOne(r: Located, dir: string, move: boolean, name?: string): Promise<boolean> }, r: Located): Promise<void> {
  const abs = tools.absOf(r.src);
  const ext = (abs ? basename(abs) : r.src).split('.').pop() || 'png';
  return openSave
    .saveFileDialog({ defaultPath: abs ?? basename(r.src), filters: [{ name: 'Images', extensions: [ext] }] })
    .then((p) => (p ? tools.copyOne(r, p.slice(0, p.lastIndexOf('/')) || '/', true, basename(p)) : null))
    .then(() => undefined);
}

/**
 * "Save %@ As…" (#138): local file bytes (or a fetched remote) written through the
 * platform's binary export. Used for images, videos and remote downloads.
 */
export async function saveMediaAs(host: { platform: Platform; notify(m: string, k: 'info' | 'error' | 'success'): void }, abs: string | null, src: string, kind: 'Image' | 'Video'): Promise<void> {
  const p = host.platform;
  const ex = extras(p);
  try {
    let bytes: Uint8Array | null = null;
    if (abs && ex.readFileBytes) bytes = await ex.readFileBytes(abs);
    else if (!abs) bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    if (!bytes) throw new Error('no readable source');
    const name = abs ? basename(abs) : src.split('/').pop() || `untitled.${kind === 'Image' ? 'png' : 'mp4'}`;
    const ext = name.split('.').pop() || (kind === 'Image' ? 'png' : 'mp4');
    const out = await p.saveFileDialog({ defaultPath: name, filters: [{ name: kind, extensions: [ext] }] });
    if (out) await ex.exportBinary!(bytes, out);
  } catch (e) {
    host.notify(`Could not save the ${kind.toLowerCase()}: ${String(e)}`, 'error');
  }
}

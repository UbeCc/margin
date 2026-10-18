import type { Platform } from '../../contracts';
import { extras } from '../platform-extras';
import { showContextMenu, tidy, type MenuItem } from '../ui/contextmenu';
import { findImageRefs } from '../upload';
import { basename, isUrlLike } from '../util/path';
import { REMOTE_RE } from './rules';
import { parseImage, zoomChoices, zoomOf } from './syntax';
import { locate, type ImageTools, type Located } from './tools';

/** Shell callbacks the image context menu needs. */
export interface ImageMenuHost {
  tools: ImageTools;
  platform: Platform;
  upload(src: string): void;
  uploadAll(): void;
  uploading(): boolean;
  notify(m: string, k: 'info' | 'error' | 'success'): void;
}

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

export async function copyImageContent(img: HTMLImageElement, abs?: string | null, native?: (path: string) => Promise<boolean>): Promise<boolean> {
  try {
    // Native copy of the file bytes first (#136) when the platform offers it.
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

/** Right-click on a rendered image → Typora's image menu. Returns a detach function. */
export function attachImageMenu(root: HTMLElement, host: ImageMenuHost, md: () => string, resolve: (src: string) => string): () => void {
  const onMenu = (e: MouseEvent): void => {
    const img = e.target instanceof Element ? e.target.closest('img') : null;
    if (!img || !root.contains(img) || !img.matches(IMG_SEL)) return;
    const r = refForImage(img as HTMLImageElement, root, md(), resolve);
    if (!r) return;
    e.preventDefault();
    void buildMenu(host, r, img as HTMLImageElement).then((items) => showContextMenu(e.clientX, e.clientY, items));
  };
  root.addEventListener('contextmenu', onMenu);
  return () => root.removeEventListener('contextmenu', onMenu);
}

export async function buildMenu(host: ImageMenuHost, r: Located, img: HTMLImageElement): Promise<MenuItem[]> {
  const t = host.tools;
  const ex = extras(host.platform);
  const native = ex as { writeClipboardImage?: (path: string) => Promise<boolean> };
  const abs = t.absOf(r.src);
  const remote = REMOTE_RE.test(r.src);
  const local = !!abs && !remote && !isUrlLike(r.src);
  const ok = img.complete && img.naturalWidth > 0;
  const html = parseImage(r.raw)?.html ?? false;
  const scale = local && ex.imageScale ? await ex.imageScale(abs!).catch(() => 1) : 1;
  const zoomNow = zoomOf(r.raw);
  const target = t.targetFolder();

  const zoomMenu = (): void => {
    const rect = img.getBoundingClientRect();
    showContextMenu(rect.left + 8, rect.top + 8, zoomChoices(scale).map((z) => ({ label: `Zoom Image to ${z}${zoomNow === z ? ' ✓' : ''}`, run: () => void t.zoom(r, z) })));
  };

  // fe-contextmenus-tools §1.2/§1.3: reveal, Copy to <folder>, Copy Image to…,
  // Move to <folder>, Rename or Move Image to…, Upload Image | Copy Image
  // Content | Zoom ▸, Switch Syntax ▸, Delete Image File / Delete Image |
  // Save Image As… (error images keep reveal / zoom / syntax / delete only).
  const items: MenuItem[] = [];
  if (remote) items.push({ label: 'Open Image in Browser', run: () => void host.platform.openExternal(r.src.trim()) });
  else if (local) items.push({ label: 'Open Image Location', disabled: !ex.revealInFolder, run: () => void ex.revealInFolder?.(abs!) });
  if (ok) {
    if (target && !(abs ?? '').startsWith(target + '/')) {
      items.push({ label: `Copy to ${target}`, run: () => void t.copyOne(r, target, false) });
      if (local) items.push({ label: `Move to ${target}`, run: () => void t.copyOne(r, target, true) });
    }
    items.push(
      { label: 'Copy Image to…', run: () => void host.platform.openFileDialog({ directory: true }).then((d) => (d ? t.copyOne(r, d, false) : null)) },
      { label: 'Rename or Move Image to…', disabled: !local, run: () => void moveImageDialog(host, r) },
      { label: 'Upload Image', disabled: host.uploading(), run: () => host.upload(r.src) },
    );
  }
  if (ok) items.push({ separator: true });
  if (ok) items.push({ label: 'Copy Image Content', run: () => void copyImageContent(img, abs, native.writeClipboardImage).then((done) => host.notify(done ? 'Image copied.' : 'Could not copy the image.', done ? 'success' : 'error')) });
  items.push(
    { label: 'Zoom Image', run: zoomMenu },
    { label: html ? 'Switch Image Syntax › Markdown Style' : 'Switch Image Syntax › HTML Style', run: () => void t.switchSyntax(r, html ? 'markdown' : 'html') },
  );
  if (local) items.push({ label: 'Delete Image File', danger: true, run: () => void t.deleteImageFile(r) });
  else items.push({ label: 'Delete Image', danger: false, run: () => void t.deleteImage(r) });
  items.push({ separator: true }, { label: 'Save Image As…', disabled: !ok, run: () => void saveMediaAs(host, abs, r.src, 'Image') });
  items.push({ separator: true }, { label: 'Upload All Local Images', disabled: host.uploading(), run: () => host.uploadAll() });
  return tidy(items);
}

/** "Rename or Move Image to…": a save dialog choosing the destination (and new name). */
export function moveImageDialog(host: ImageMenuHost, r: Located): Promise<void> {
  const abs = host.tools.absOf(r.src);
  const ext = (abs ? basename(abs) : r.src).split('.').pop() || 'png';
  return host.platform
    .saveFileDialog({ defaultPath: abs ?? basename(r.src), filters: [{ name: 'Images', extensions: [ext] }] })
    .then((p) => (p ? host.tools.copyOne(r, p.slice(0, p.lastIndexOf('/')) || '/', true, basename(p)) : null))
    .then(() => undefined);
}

/** "Save %@ As…" (#138): local file bytes (or a fetched remote) written through the platform's binary export. */
export async function saveMediaAs(host: Pick<ImageMenuHost, 'platform' | 'notify'>, abs: string | null, src: string, kind: 'Image' | 'Video'): Promise<void> {
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

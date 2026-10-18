import { showContextMenu, type MenuItem } from '../ui/contextmenu';
import { findImageRefs } from '../upload';
import { basename, isUrlLike } from '../util/path';
import { REMOTE_RE } from './rules';
import { parseImage, zoomChoices, zoomOf } from './syntax';
import { locate, type ImageTools, type Located } from './tools';

/** Shell callbacks the image context menu needs. */
export interface ImageMenuHost {
  tools: ImageTools;
  platform: {
    openFileDialog(opts?: { directory?: boolean }): Promise<string | null>;
    saveFileDialog(opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    revealInFolder?(path: string): Promise<void>;
    imageScale?(path: string): Promise<number>;
    uploadImages?: unknown;
  };
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
  // #136: Typora writes the image natively (clipboard.writeImage → PNG+TIFF);
  // WKWebView fetch() of a file asset URL can fail, so try native first when the
  // platform offers it and the src is a local file.
  if (abs && native && (await native(abs).catch(() => false))) return true;
  try {
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
  const abs = t.absOf(r.src);
  const remote = REMOTE_RE.test(r.src);
  const local = !!abs && !remote && !isUrlLike(r.src);
  const html = parseImage(r.raw)?.html ?? false;
  const scale = local && host.platform.imageScale ? await host.platform.imageScale(abs!).catch(() => 1) : 1;
  const zoomNow = zoomOf(r.raw);
  const target = t.targetFolder();
  const name = abs ? basename(abs) : '';

  const zoomMenu = (): void => {
    const rect = img.getBoundingClientRect();
    showContextMenu(rect.left + 8, rect.top + 8, zoomChoices(scale).map((z) => ({ label: `Zoom Image to ${z}${zoomNow === z ? ' ✓' : ''}`, run: () => void t.zoom(r, z) })));
  };
  const items: MenuItem[] = [
    { label: 'Zoom Image', run: zoomMenu },
    { label: html ? 'Switch Image Syntax › Markdown Style' : 'Switch Image Syntax › HTML Style', run: () => void t.switchSyntax(r, html ? 'markdown' : 'html') },
    { separator: true },
    { label: 'Copy Image Content', run: () => void copyImageContent(img).then((ok) => host.notify(ok ? 'Image copied.' : 'Could not copy the image.', ok ? 'success' : 'error')) },
  ];
  if (remote) items.push({ label: 'Open Image in Browser', run: () => void host.platform.openExternal(r.src.trim()) });
  if (local) {
    items.push({ label: 'Open Image Location', disabled: !host.platform.revealInFolder, run: () => void host.platform.revealInFolder?.(abs!) });
    items.push({ separator: true });
    if (target && !abs!.startsWith(target + '/'))
      items.push(
        { label: `Copy to ${target}`, run: () => void t.copyOne(r, target, false) },
        { label: `Move to ${target}`, run: () => void t.copyOne(r, target, true) },
      );
    items.push(
      {
        label: 'Copy Image to…',
        run: () => void host.platform.openFileDialog({ directory: true }).then((d) => (d ? t.copyOne(r, d, false) : false)),
      },
      {
        label: 'Rename or Move Image to…',
        run: () =>
          void host.platform.saveFileDialog({ defaultPath: abs!, filters: [{ name: 'Images', extensions: [name.split('.').pop() || 'png'] }] }).then((p) => {
            if (p) void t.copyOne(r, p.slice(0, p.lastIndexOf('/')) || '/', true, basename(p));
          }),
      },
    );
  }
  items.push({ separator: true });
  items.push({
    label: 'Upload Image',
    disabled: !local || host.uploading(),
    hint: local ? undefined : 'Not a local image',
    run: () => host.upload(r.src),
  });
  items.push({ label: 'Upload All Local Images', disabled: host.uploading(), run: () => host.uploadAll() });
  items.push({ separator: true });
  items.push({ label: 'Delete Image', danger: false, run: () => void t.deleteImage(r) });
  if (local) items.push({ label: 'Delete Image File', danger: true, run: () => void t.deleteImageFile(r) });
  return items;
}

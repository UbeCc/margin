import type { EditorHandle, ImageMenuAction, ImageRule } from '../../contracts';
import type { FullPlatform } from '../platform-extras';
import type { ImageUploader } from '../upload-actions';
import { dirname, isUrlLike, relative } from '../util/path';
import type { ImageCtxOps } from '../ctxmenu/items';
import { copyImageContent, moveImageDialog, refForImage, saveMediaAs } from './context-menu';
import { insertImage, type ImageInput } from './insert';
import { REMOTE_RE, resolveWithRoot, rootDirOf, setFrontMatterValue } from './rules';
import { ImageTools, type Located } from './tools';
import { parseImage, zoomOf } from './syntax';

/** §1.2 context-menu zoom presets (differs from Format › Image: no 80%, grouped 25–67 | 100–200). */
const ZOOM_CTX_PRESETS = ['25%', '33%', '50%', '67%', '100%', '150%', '200%'];

type Kind = 'info' | 'warning' | 'error' | 'success';

export interface ImageFeatureHost {
  platform: FullPlatform;
  editor(): EditorHandle;
  editorRoot(): HTMLElement;
  docPath(): string | null;
  settings(): { imageRule: ImageRule } & object;
  uploader: ImageUploader;
  notify(message: string, kind: Kind, action?: { label: string; run: () => void }): void;
  saveAs(): void;
  openImagePreferences(): void;
  /** The shell's EditorSettings.resolveAsset (to match rendered HTML-block images). */
  resolveAsset(src: string): string;
}

/**
 * The shell's image pipeline (#99 / #92): insertion rules, Format › Image actions,
 * the image context menu, and `typora-root-url` aware asset resolution.
 */
export class ImageFeature {
  readonly tools: ImageTools;
  private rootDir: string | null = null;
  private rootKey = '';

  constructor(private host: ImageFeatureHost) {
    const ed = (): EditorHandle => host.editor();
    this.tools = new ImageTools({
      platform: host.platform,
      editor: ed,
      docPath: () => host.docPath(),
      markdown: () => ed().getMarkdown(),
      settings: () => host.settings(),
      sourceMode: () => ed().isSourceMode(),
      notify: (m, k, a) => host.notify(m, k, a),
      upload: (paths) => host.uploader.uploadFiles(paths),
      saveAs: () => host.saveAs(),
      refreshAssets: () => this.refreshImages(),
    });
  }

  /** EditorSettings.storeImage: the snippet to insert for a pasted / dropped image. */
  store(input: ImageInput): Promise<string | null> {
    return insertImage(
      {
        platform: this.host.platform,
        docPath: () => this.host.docPath(),
        markdown: () => this.host.editor().getMarkdown(),
        settings: () => this.host.settings(),
        sourceMode: () => this.host.editor().isSourceMode(),
        notify: (m, k, a) => this.host.notify(m, k, a),
        upload: (paths) => this.host.uploader.uploadFiles(paths),
        saveAs: () => this.host.saveAs(),
      },
      input,
    );
  }

  /** Absolute path for a src when the document sets `typora-root-url`; undefined = default resolution. */
  resolvePath(src: string): string | null | undefined {
    if (!this.rootDir) return undefined;
    return resolveWithRoot(src, this.rootDir);
  }

  /** Recompute the root url after edits / document switches; re-render images when it changed. */
  sync(): void {
    const doc = this.host.docPath();
    const md = this.host.editor().getMarkdown();
    const root = rootDirOf(md.slice(0, 8192), doc ? dirname(doc) : null);
    const key = `${doc}\x00${root}`;
    if (key === this.rootKey) return;
    const changed = root !== this.rootDir;
    this.rootKey = key;
    this.rootDir = root;
    if (changed) this.refreshImages();
  }

  /**
   * Re-resolve rendered inline images in place (root url changed). Done on the DOM so
   * the caret / selection survive; widgets re-resolve on their next render.
   */
  refreshImages(): void {
    const root = this.host.editorRoot();
    root.querySelectorAll<HTMLElement>('.md-image').forEach((w) => {
      const raw = w.querySelector('.md-src')?.textContent ?? '';
      const p = parseImage(raw);
      const img = w.querySelector<HTMLImageElement>('img.md-img');
      if (!p || !img) return;
      const url = this.host.resolveAsset(p.src);
      if (img.getAttribute('src') !== url) img.src = url;
    });
  }

  /**
   * Editor right-clicks on images are handled by the editor context menu
   * (`EditorContextMenu` + `ctxOps`); kept as a no-op detach for callers.
   */
  attach(page: HTMLElement): () => void {
    // Right-clicks are owned by the editor context menu; this hook only marks
    // failed-load images so they keep a clickable placeholder box (any tab host).
    const mark = () =>
      page.querySelectorAll<HTMLImageElement>('.md-image img.md-img').forEach((img) => {
        const m = () => img.classList.toggle('md-img-loaded', img.complete && img.naturalWidth > 0);
        if (!img.dataset.loadHook) {
          img.dataset.loadHook = '1';
          img.addEventListener('load', m);
          img.addEventListener('error', m);
        }
        m();
      });
    mark();
    const mo = new MutationObserver(mark);
    mo.observe(page, { subtree: true, childList: true });
    return () => mo.disconnect();
  }

  /** Editor-context-menu ops for one right-clicked image (#141): builds on the same tools as the image menu. */
  ctxOps(img: HTMLImageElement): ImageCtxOps | null {
    const ref = refForImage(img, this.host.editorRoot(), this.host.editor().getMarkdown(), (s) => this.host.resolveAsset(s));
    if (!ref) return null;
    const t = this.tools;
    const zoomNow = zoomOf(ref.raw);
    return {
      copyTo: (move) =>
        void (move
          ? moveImageDialog(this.host.platform, t, ref)
          : this.host.platform.openFileDialog({ directory: true }).then((d) => (d ? t.copyOne(ref, d, false) : null))),
      target: () => {
        const dir = t.targetFolder();
        const abs = t.absOf(ref.src);
        if (!dir || (abs ?? '').startsWith(dir + '/')) return null;
        const local = !!abs && !REMOTE_RE.test(ref.src) && !isUrlLike(ref.src);
        return { label: dir, canMove: local, run: (move) => void t.copyOne(ref, dir, move) };
      },
      zoom: () => ({
        zoomNow,
        presets: ZOOM_CTX_PRESETS,
        set: (v) => void t.zoom(ref, v),
      }),
      syntax: () => {
        const html = parseImage(ref.raw)?.html === true;
        return { isHtml: html, switchTo: (to) => void t.switchSyntax(ref, to) };
      },
      saveAs: () => void saveMediaAs({ platform: this.host.platform, notify: (m, k) => this.host.notify(m, k) }, t.absOf(ref.src), ref.src, 'Image'),
      remove: (withFile) => void (withFile ? t.deleteImageFile(ref) : t.deleteImage(ref)),
    };
  }

  /** The image at the caret (expanded inline image or the selected / focused rendered image). */
  currentImage(): { img: HTMLImageElement; ref: Located } | null {
    const root = this.host.editorRoot();
    const sel = root.ownerDocument.getSelection();
    const node = sel?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    const img =
      (el?.closest('.md-image')?.querySelector('img.md-img') as HTMLImageElement | null) ??
      (el?.closest('.mb-html-block')?.querySelector('img') as HTMLImageElement | null) ??
      root.querySelector<HTMLImageElement>('.md-image.md-expand img.md-img');
    if (!img || !root.contains(img)) return null;
    const ref = refForImage(img, root, this.host.editor().getMarkdown(), (s) => this.host.resolveAsset(s));
    return ref ? { img, ref } : null;
  }

  /** Format › Image entries (Typora's menu tree; per-image entries use the image at the caret). */
  async run(action: ImageMenuAction): Promise<boolean> {
    const t = this.tools;
    const p = this.host.platform;
    switch (action) {
      case 'insert':
        t.insertEmpty();
        return true;
      case 'insertLocal':
        return (await t.insertLocal()) > 0;
      case 'copyAll':
        return t.copyAll(false);
      case 'moveAll':
        return t.copyAll(true);
      case 'uploadAll':
        return (await this.host.uploader.uploadAll()).ok;
      case 'reloadAll':
        this.refreshImages();
        t.reloadAll(this.host.editorRoot());
        return true;
      case 'insertCopyToFolder':
        return this.setDocumentRule('folder');
      case 'insertUpload':
        return this.setDocumentRule('upload');
      case 'rootPath':
        return this.toggleRootPath();
      case 'settings':
        this.host.openImagePreferences();
        return true;
    }
    const cur = this.currentImage();
    if (!cur) {
      this.host.notify('Place the caret on an image first.', 'info');
      return false;
    }
    const { img, ref } = cur;
    const abs = t.absOf(ref.src);
    if (action.startsWith('zoom-')) return t.zoom(ref, action.slice(5) + '%');
    switch (action) {
      case 'openLocation':
        if (!abs || !p.revealInFolder) return false;
        await p.revealInFolder(abs);
        return true;
      case 'copyContent':
        return copyImageContent(img);
      case 'syntaxMarkdown':
        return t.switchSyntax(ref, 'markdown');
      case 'syntaxHtml':
        return t.switchSyntax(ref, 'html');
      case 'deleteFile':
        return t.deleteImageFile(ref);
      case 'copyTo': {
        const d = await p.openFileDialog({ directory: true });
        return !!d && t.copyOne(ref, d, false);
      }
      case 'moveTo': {
        if (!abs) return false;
        const dest = await p.saveFileDialog({ defaultPath: abs, filters: [{ name: 'Images', extensions: [abs.split('.').pop() || 'png'] }] });
        if (!dest) return false;
        const cut = dest.lastIndexOf('/');
        return t.copyOne(ref, dest.slice(0, cut) || '/', true, dest.slice(cut + 1));
      }
      case 'upload':
        return (await this.host.uploader.uploadSrcs([ref.src])).ok;
    }
    return false;
  }

  /** When Insert Local Image ▸ Copy Image File to Folder… / Upload Image: per-document `typora-copy-images-to`. */
  private async setDocumentRule(kind: 'folder' | 'upload'): Promise<boolean> {
    const doc = this.host.docPath();
    let value = 'upload';
    if (kind === 'folder') {
      if (!doc) return (this.host.notify('Save the document first.', 'warning'), false);
      const d = await this.host.platform.openFileDialog({ directory: true });
      if (!d) return false;
      value = relative(dirname(doc), d);
      if (!value.startsWith('.')) value = './' + value;
    }
    return this.writeFrontMatter('typora-copy-images-to', value);
  }

  /** Use Image Root Path: set (pick a folder) or, when already set, remove `typora-root-url`. */
  private async toggleRootPath(): Promise<boolean> {
    if (this.rootDir) return this.writeFrontMatter('typora-root-url', null);
    return this.tools.setRootPath();
  }

  private writeFrontMatter(key: string, value: string | null): boolean {
    const ed = this.host.editor();
    const md = ed.getMarkdown();
    const next = setFrontMatterValue(md, key, value);
    if (next === md) return true;
    let i = 0;
    while (i < md.length && i < next.length && md[i] === next[i]) i++;
    let j = 0;
    while (j < md.length - i && j < next.length - i && md[md.length - 1 - j] === next[next.length - 1 - j]) j++;
    const ok = ed.exec({ kind: 'replaceRange', from: i, to: md.length - j, text: next.slice(i, next.length - j) });
    if (ok) this.sync();
    return ok;
  }
}

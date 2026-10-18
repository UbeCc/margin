import type { EditorHandle, ImageMenuAction, ImageRule } from '../../contracts';
import type { FullPlatform } from '../platform-extras';
import type { ImageUploader } from '../upload-actions';
import { dirname, relative } from '../util/path';
import { attachImageMenu, copyImageContent, refForImage } from './context-menu';
import { insertImage, type ImageInput } from './insert';
import { resolveWithRoot, rootDirOf, setFrontMatterValue } from './rules';
import { ImageTools, type Located } from './tools';
import { parseImage } from './syntax';

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
  /** #136: called when the active document's root url changed — the shell bumps the
   *  editors' `assetKey` so image-bearing widgets (html blocks) re-render. */
  assetsChanged(): void;
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
    if (changed) {
      this.refreshImages();
      this.host.assetsChanged();
    }
  }

  /**
   * Re-resolve rendered inline images in place (root url changed). Done on the DOM so
   * the caret / selection survive; image-bearing widgets re-render via `assetsChanged`.
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

  attach(root: HTMLElement): () => void {
    return attachImageMenu(
      root,
      this.menuHost(),
      () => this.host.editor().getMarkdown(),
      (src) => this.host.resolveAsset(src),
    );
  }

  private menuHost() {
    return {
      tools: this.tools,
      platform: this.host.platform,
      upload: (src: string) => void this.host.uploader.uploadSrcs([src]),
      uploadAll: () => void this.host.uploader.uploadAll(),
      uploading: () => this.host.uploader.uploading,
      notify: (m: string, k: 'info' | 'error' | 'success') => this.host.notify(m, k),
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
      case 'copyContent': {
        const write = p.writeClipboardImage;
        return copyImageContent(img, abs, write ? (path) => write.call(p, path) : undefined);
      }
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

import type { EditorHandle, ImageRule } from '../../contracts';
import { confirmDialog } from '../ui/modal';
import { findImageRefs, withSrc, type ImageRef } from '../upload';
import { basename, dirname, isUrlLike, relative } from '../util/path';
import type { FullPlatform } from '../platform-extras';
import { absOfSrc, insertImage, type InsertHost } from './insert';
import { formatImageSrc, imageOptionsOf, imageTarget, REMOTE_RE, rootDirOf, setFrontMatterValue } from './rules';
import { setZoom, switchSyntax } from './syntax';

/** Shell services for Image Tools (#99). */
export interface ToolsHost extends InsertHost {
  editor(): EditorHandle;
  /** Re-resolve every rendered image src (root url changed, Reload All Images). */
  refreshAssets(): void;
}

type Kind = 'info' | 'warning' | 'error' | 'success';

/** One image occurrence in the markdown: its raw text and offsets. */
export interface Located extends ImageRef {
  end: number;
}

export const locate = (r: ImageRef): Located => ({ ...r, end: r.index + r.raw.length });

/**
 * Format › Image actions and the image context menu's actions. Every document edit
 * is a single `replaceRange` (one undo step); file operations go through the
 * platform (copy / move / trash) and never clobber existing files.
 */
export class ImageTools {
  constructor(private host: ToolsHost) {}

  private get p(): FullPlatform {
    return this.host.platform;
  }

  private notify(m: string, k: Kind): void {
    this.host.notify(m, k);
  }

  private docDir(): string | null {
    const d = this.host.docPath();
    return d ? dirname(d) : null;
  }

  /** Write `newAbs` the way a newly inserted image would be written (relative / root url / escape). */
  srcFor(newAbs: string): string {
    const md = this.host.markdown();
    const docDir = this.docDir();
    return formatImageSrc(newAbs, { docDir, rootDir: rootDirOf(md, docDir), options: imageOptionsOf(this.host.settings()) });
  }

  /** Absolute file of an image src in the current document (root url aware). */
  absOf(src: string): string | null {
    const docDir = this.docDir();
    const root = rootDirOf(this.host.markdown(), docDir);
    if (root && !isUrlLike(src)) return absOfSrc(src.trim().replace(/^<|>$/g, '').replace(/^\/+/, ''), root);
    return absOfSrc(src, docDir);
  }

  private edit(from: number, to: number, text: string): boolean {
    const ok = this.host.editor().exec({ kind: 'replaceRange', from, to, text });
    if (!ok) this.notify(this.host.sourceMode() ? 'Image Tools are not available in source code mode.' : 'Could not update the image.', 'error');
    return ok;
  }

  /** Apply per-ref replacements as one edit spanning first..last changed ref. */
  private rewrite(repl: Map<Located, string>): boolean {
    const list = [...repl].sort((a, b) => a[0].index - b[0].index);
    if (!list.length) return true;
    const md = this.host.editor().getMarkdown();
    const from = list[0][0].index;
    const to = list[list.length - 1][0].end;
    let out = '';
    let at = from;
    for (const [r, text] of list) {
      out += md.slice(at, r.index) + text;
      at = r.end;
    }
    return this.edit(from, to, out);
  }

  refs(): Located[] {
    return findImageRefs(this.host.editor().getMarkdown()).map(locate);
  }

  // ---------------------------------------------------------------- Format › Image

  /** Insert Image: an empty `![]()` at the caret. */
  insertEmpty(): void {
    this.host.editor().exec({ kind: 'insertText', text: '![]()' });
  }

  /** Insert Local Images…: pick files, store each by the rules, insert at the caret. */
  async insertLocal(): Promise<number> {
    const paths = this.p.openImagesDialog ? await this.p.openImagesDialog() : [await this.p.openFileDialog()].filter((x): x is string => !!x);
    const snippets: string[] = [];
    for (const path of paths) {
      const s = await insertImage(this.host, { path, name: basename(path) });
      if (s) snippets.push(s);
    }
    if (snippets.length) this.host.editor().exec({ kind: 'insertText', text: snippets.join('\n') });
    return snippets.length;
  }

  /** Copy / Move All Images to…: every local image file into one folder, srcs rewritten. */
  async copyAll(move: boolean, dir?: string | null): Promise<boolean> {
    if (!this.p.copyImage) return (this.notify('Copying images is only available in the desktop app.', 'error'), false);
    const local = this.refs().filter((r) => !REMOTE_RE.test(r.src) && !isUrlLike(r.src) && this.absOf(r.src));
    if (!local.length) return (this.notify('No local images found.', 'info'), false);
    const target = dir === undefined ? await this.p.openFileDialog({ directory: true }) : dir;
    if (!target) return false;
    const done = new Map<string, string>();
    const repl = new Map<Located, string>();
    const failed: string[] = [];
    for (const r of local) {
      const abs = this.absOf(r.src)!;
      if (!done.has(abs)) {
        try {
          done.set(abs, await this.p.copyImage(abs, target, { move }));
        } catch (e) {
          failed.push(`${r.src}: ${e instanceof Error ? e.message : String(e)}`);
          done.set(abs, '');
        }
      }
      const dest = done.get(abs);
      if (dest) repl.set(r, withSrc(r, this.srcFor(dest)));
    }
    const ok = this.rewrite(repl);
    if (failed.length) this.notify(`Failed to Copy Image to Target Folder.\n${failed.join('\n')}`, 'error');
    else if (ok) this.notify(move ? `Images moved to ${target}.` : `Images copied to ${target}.`, 'success');
    return ok && !failed.length;
  }

  /** Use Image Root Path…: write `typora-root-url` (relative to the document) into the front matter. */
  async setRootPath(dir?: string | null): Promise<boolean> {
    const docDir = this.docDir();
    if (!docDir) return (this.notify('Cannot use root path. Save the document first.', 'error'), false);
    const pick = dir === undefined ? await this.p.openFileDialog({ directory: true }) : dir;
    if (!pick) return false;
    const md = this.host.editor().getMarkdown();
    const next = setFrontMatterValue(md, 'typora-root-url', relative(docDir, pick));
    const ok = this.replaceFrontMatter(md, next);
    if (ok) this.host.refreshAssets();
    return ok;
  }

  private replaceFrontMatter(md: string, next: string): boolean {
    // Only the changed prefix is replaced so the edit stays local (one undo step).
    let i = 0;
    while (i < md.length && i < next.length && md[i] === next[i]) i++;
    let j = 0;
    while (j < md.length - i && j < next.length - i && md[md.length - 1 - j] === next[next.length - 1 - j]) j++;
    return this.edit(i, md.length - j, next.slice(i, next.length - j));
  }

  /** Reload All Images: re-request every rendered image (cache-busted). */
  reloadAll(root: HTMLElement): number {
    let n = 0;
    root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      const src = img.getAttribute('src') ?? '';
      if (!src || /^(?:data|blob):/i.test(src)) return;
      const clean = src.replace(/([?&])margin-reload=\d+&?/, '$1').replace(/[?&]$/, '');
      img.src = clean + (clean.includes('?') ? '&' : '?') + 'margin-reload=' + Date.now();
      n++;
    });
    return n;
  }

  // ---------------------------------------------------------------- one image

  zoom(r: Located, value: string): boolean {
    const next = setZoom(r.raw, value);
    return next === r.raw || this.edit(r.index, r.end, next);
  }

  switchSyntax(r: Located, to: 'markdown' | 'html'): boolean {
    const next = switchSyntax(r.raw, to);
    return next === r.raw || this.edit(r.index, r.end, next);
  }

  /** Delete Image: remove the reference (undoable). */
  deleteImage(r: Located): boolean {
    return this.edit(r.index, r.end, '');
  }

  /** Delete Image File: move the file to the Trash and remove the reference. */
  async deleteImageFile(r: Located, confirm = (t: string, m: string) => confirmDialog(t, m, 'Delete', true)): Promise<boolean> {
    const abs = this.absOf(r.src);
    if (!abs || !this.p.remove) return (this.notify('Only local image files can be deleted.', 'error'), false);
    const name = basename(abs);
    if (!(await confirm(`Delete ${name}`, `Are you sure you want to delete ${name}? You can restore from the Trash.`))) return false;
    try {
      await this.p.remove(abs);
    } catch (e) {
      this.notify(`Couldn't delete ${name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return false;
    }
    return this.deleteImage(r);
  }

  /** Copy / Move one image into `dir` and point the reference at the copy. */
  async copyOne(r: Located, dir: string, move: boolean, name?: string): Promise<boolean> {
    const abs = this.absOf(r.src);
    if (!abs || !this.p.copyImage) return (this.notify('Only local images can be copied.', 'error'), false);
    try {
      const dest = await this.p.copyImage(abs, dir, { move, ...(name ? { name } : {}) });
      return this.edit(r.index, r.end, withSrc(r, this.srcFor(dest)));
    } catch (e) {
      this.notify(`Failed to Copy Image to Target Folder. ${e instanceof Error ? e.message : String(e)}`, 'error');
      return false;
    }
  }

  /** Copy Image File to Folder…: copy the file only (the document is unchanged). */
  async copyFileOnly(r: Located, dir: string): Promise<string | null> {
    const abs = this.absOf(r.src);
    if (!abs || !this.p.copyImage) return null;
    try {
      const dest = await this.p.copyImage(abs, dir, {});
      this.notify(`Images copied to ${dir}.`, 'success');
      return dest;
    } catch (e) {
      this.notify(`Failed to Copy Image to Target Folder. ${e instanceof Error ? e.message : String(e)}`, 'error');
      return null;
    }
  }

  /** The folder new images go to for this document (for "Copy to %@" / "Move to %@"), or null. */
  targetFolder(): string | null {
    const docDir = this.docDir();
    if (!docDir) return null;
    const t = imageTarget({ markdown: this.host.markdown(), globalRule: this.host.settings().imageRule as ImageRule, options: imageOptionsOf(this.host.settings()) });
    if (t.kind !== 'copy' || t.rule.kind === 'none') return null;
    const stem = basename(this.host.docPath()!).replace(/\.[^.]+$/, '');
    const dir = t.rule.dir.replace(/\$\{filename\}/g, stem);
    return absOfSrc(dir.replace(/\/+$/, '') || '.', docDir);
  }
}

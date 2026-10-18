import type { EditorHandle, Platform } from '../contracts';
import { showContextMenu } from './ui/contextmenu';
import { applyUrls, findImageRefs, localImages, uploadConfig, uploadSettingsOf, type LocalImage, type UploadPlatform } from './upload';

/** What the uploader needs from the shell (kept small so it is easy to fake in tests). */
export interface UploadHost {
  platform: Platform & UploadPlatform;
  editor(): EditorHandle;
  /** Directory of the current document (null = unsaved). */
  baseDir(): string | null;
  settings(): object;
  notify(message: string, kind: 'info' | 'error' | 'success'): void;
}

export type UploadOutcome = { ok: true; uploaded: number } | { ok: false; error: string };

/**
 * "Upload Image" / "Upload All Local Images". Every path resolves (never throws):
 * on any failure the local image stays in the document and an error is shown.
 */
export class ImageUploader {
  private busy = false;

  constructor(private host: UploadHost) {}

  get uploading(): boolean {
    return this.busy;
  }

  /** Upload every local image referenced by the document. */
  uploadAll(): Promise<UploadOutcome> {
    const refs = findImageRefs(this.host.editor().getMarkdown());
    return this.run(localImages(refs, this.host.baseDir()), 'This document has no local images to upload.');
  }

  /** Upload the images with these srcs (as written in the markdown). */
  uploadSrcs(srcs: string[]): Promise<UploadOutcome> {
    const want = new Set(srcs);
    const refs = findImageRefs(this.host.editor().getMarkdown()).filter((r) => want.has(r.src));
    return this.run(localImages(refs, this.host.baseDir()), 'Only local images can be uploaded.');
  }

  private fail(error: string): UploadOutcome {
    this.host.notify(error, 'error');
    return { ok: false, error };
  }

  private async run(images: LocalImage[], emptyMessage: string): Promise<UploadOutcome> {
    if (this.busy) return this.fail('An upload is already in progress.');
    const upload = this.host.platform.uploadImages;
    if (!upload) return this.fail('Image upload is only available in the desktop app.');
    const config = uploadConfig(uploadSettingsOf(this.host.settings()));
    if (typeof config === 'string') return this.fail(config);
    if (!images.length) return this.fail(emptyMessage);
    this.busy = true;
    try {
      this.host.notify(`Uploading ${images.length} image${images.length > 1 ? 's' : ''}…`, 'info');
      let urls: string[];
      try {
        urls = await upload.call(this.host.platform, images.map((i) => i.path), config);
      } catch (e) {
        return this.fail(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!Array.isArray(urls) || urls.length !== images.length || urls.some((u) => typeof u !== 'string' || !/^https?:\/\/\S+$/.test(u))) {
        return this.fail('Upload failed: the uploader did not return one URL per image.');
      }
      const map = new Map(images.map((img, i) => [img.src, urls[i]]));
      const failed = applyUrls(this.host.editor(), map);
      if (failed.length) return this.fail(`Uploaded, but couldn't update ${failed.length} image reference(s): ${failed.join(', ')}`);
      this.host.notify(`Uploaded ${images.length} image${images.length > 1 ? 's' : ''}.`, 'success');
      return { ok: true, uploaded: images.length };
    } finally {
      this.busy = false;
    }
  }

  /** Right-click on a rendered image in the editor → "Upload Image". Returns a detach function. */
  attachContextMenu(root: HTMLElement): () => void {
    const onMenu = (e: MouseEvent): void => {
      const src = imageSrcAt(e.target);
      if (src === null) return;
      e.preventDefault();
      const local = localImages([{ raw: '', index: 0, src, srcOffset: 0 }], this.host.baseDir()).length > 0;
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Upload Image',
          disabled: !local || this.busy,
          hint: local ? undefined : 'Not a local image',
          run: () => void this.uploadSrcs([src]),
        },
        { label: 'Upload All Local Images', disabled: this.busy, run: () => void this.uploadAll() },
      ]);
    };
    root.addEventListener('contextmenu', onMenu);
    return () => root.removeEventListener('contextmenu', onMenu);
  }
}

/** The markdown src of the rendered image under `target` (core renders `![…](src)` in a hidden `.md-src`). */
export function imageSrcAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const img = target.closest('img');
  if (!img) return null;
  const wrap = img.closest('.md-image');
  const raw = wrap?.querySelector('.md-src')?.textContent ?? img.outerHTML;
  const ref = findImageRefs(raw)[0];
  return ref ? ref.src : null;
}

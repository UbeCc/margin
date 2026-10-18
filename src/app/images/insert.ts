import type { ImageRule } from '../../contracts';
import { basename, isAbsolute, isUrlLike, join, normalize, stripExt } from '../util/path';
import { docBaseDir, isTextBundlePath } from '../textbundle';
import {
  decodeSrcPath,
  formatImageSrc,
  imageOptionsOf,
  imageSnippet,
  imageTarget,
  rootDirOf,
  shouldApplyRule,
  type ImageOptions,
} from './rules';
import type { FullPlatform } from '../platform-extras';

export type ImageInput = { bytes?: Uint8Array; mime?: string; path?: string; name?: string };

/** What the insertion pipeline needs from the shell. */
export interface InsertHost {
  platform: FullPlatform;
  docPath(): string | null;
  markdown(): string;
  /** MarginSettings (imageRule + image option keys). */
  settings(): { imageRule: ImageRule } & object;
  sourceMode(): boolean;
  notify(message: string, kind: 'info' | 'warning' | 'error' | 'success', action?: { label: string; run: () => void }): void;
  /** Upload local files (absolute paths) → one URL per path; throws on failure. */
  upload(paths: string[]): Promise<string[]>;
  saveAs(): void;
}

/** Absolute local path of a src as written in a document in `docDir` (null for URLs / unresolvable). */
export function absOfSrc(src: string, docDir: string | null): string | null {
  let s = src.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  if (!s || isUrlLike(s) || s.startsWith('#')) return null;
  s = decodeSrcPath(s.replace(/[?#].*$/, ''));
  if (isAbsolute(s)) return normalize(s);
  return docDir ? join(docDir, s) : null;
}

function altFor(input: ImageInput): string {
  const n = input.name ?? (input.path && !isUrlLike(input.path) ? basename(input.path) : '') ?? '';
  return stripExt(n);
}

/**
 * Store an inserted / pasted / dropped image following Typora's rules and return the
 * complete snippet to insert (or null when nothing should be inserted).
 */
export async function insertImage(host: InsertHost, input: ImageInput): Promise<string | null> {
  const opts: ImageOptions = imageOptionsOf(host.settings());
  const md = host.markdown();
  const docPath = host.docPath();
  const docDir = docPath ? docBaseDir(docPath) : null;
  const target = imageTarget({ markdown: md, globalRule: host.settings().imageRule, options: opts, sourceMode: host.sourceMode(), docPath });
  if (target.warning) host.notify(target.warning, 'warning');
  const ctx = { docDir, rootDir: host.sourceMode() ? null : rootDirOf(md, docDir), options: opts };
  const alt = altFor(input);
  const write = (src: string): string => {
    if (/^(?:data|blob):/i.test(src) || isUrlLike(src)) return imageSnippet(src, alt, opts.imageSyntax);
    const abs = absOfSrc(src, docDir);
    return imageSnippet(abs ? formatImageSrc(abs, ctx) : src, alt, opts.imageSyntax);
  };
  const local = input.path && !isUrlLike(input.path) ? normalize(input.path) : null;
  const store = (rule: ImageRule) => host.platform.storeImage(docPath, rule, input);

  try {
    if (!input.bytes && input.path && !shouldApplyRule(input.path, opts, isTextBundlePath(docPath))) return write(local ?? input.path);
    if (input.bytes && local && !opts.imageApplyLocal && !isTextBundlePath(docPath)) return write(local);

    if (target.kind === 'keep') return write(await store({ kind: 'none' }));

    if (target.kind === 'upload') {
      if (input.path && isUrlLike(input.path)) return write(input.path); // already online
      // Pasted data is parked first (the local copy is kept when the upload fails).
      const parked = local ?? absOfSrc(await store({ kind: 'none' }), docDir);
      if (!parked) return write(await store({ kind: 'none' }));
      if (!host.platform.uploadImages) {
        host.notify('Image upload is only available in the desktop app; the local image was inserted.', 'warning');
        return write(parked);
      }
      try {
        host.notify('Uploading in progress…', 'info', { label: 'Cancel', run: () => void host.platform.cancelUpload?.() });
        const [url] = await host.upload([parked]);
        return imageSnippet(url, alt, opts.imageSyntax);
      } catch (e) {
        host.notify(`Failed to upload image. Error Message: ${e instanceof Error ? e.message : String(e)}`, 'error');
        return write(parked);
      }
    }

    return write(await store(target.rule));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!docPath && target.kind === 'copy' && target.rule.kind === 'relative') {
      if (local) return write(local); // keep the original file until saved
      host.notify('Save the document first so pasted images can be stored next to it.', 'warning', { label: 'Save As…', run: () => host.saveAs() });
    } else host.notify(`Failed to Copy Image to Target Folder. ${msg}`, 'error');
    return null;
  }
}

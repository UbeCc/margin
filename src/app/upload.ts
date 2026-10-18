import type { EditorHandle, Platform, UploadConfig } from '../contracts';
import { isUrlLike, resolveDocPath } from './util/path';

/**
 * Image upload (#80): settings, finding local images in markdown, and rewriting
 * their srcs to uploaded URLs. The native side (`upload_images`) runs the user's
 * command as argv (never a shell) or talks to PicGo on 127.0.0.1.
 */

export type UploaderKind = 'none' | 'command' | 'picgo';

/** Shell keys stored alongside MarginSettings (unknown keys are persisted verbatim). */
export interface UploadSettings {
  uploader: UploaderKind;
  /** Program and arguments, e.g. `picgo upload` or `'/Applications/uPic.app/Contents/MacOS/uPic' -o url -u`. */
  uploadCommand: string;
  picgoPort: number;
  /** Seconds per image (Typora: 20; a batch is capped at 60 s natively, or at this value when larger). */
  uploadTimeout: number;
}

export const UPLOAD_DEFAULTS: Readonly<UploadSettings> = Object.freeze({
  uploader: 'none',
  uploadCommand: '',
  picgoPort: 36677,
  uploadTimeout: 20,
});

export type { UploadConfig };

/** Optional platform capability (desktop only). */
export type UploadPlatform = Pick<Platform, 'uploadImages'>;

const int = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function uploadSettingsOf(s: object): UploadSettings {
  const r = s as Record<string, unknown>;
  const kind = r.uploader;
  return {
    uploader: kind === 'command' || kind === 'picgo' ? kind : 'none',
    uploadCommand: typeof r.uploadCommand === 'string' ? r.uploadCommand : '',
    picgoPort: int(r.picgoPort, UPLOAD_DEFAULTS.picgoPort, 1, 65535),
    uploadTimeout: int(r.uploadTimeout, UPLOAD_DEFAULTS.uploadTimeout, 1, 300),
  };
}

/** Native config, or an error message explaining what to set up. */
export function uploadConfig(u: UploadSettings): UploadConfig | string {
  if (u.uploader === 'picgo') return { kind: 'picgo', port: u.picgoPort, timeoutSecs: u.uploadTimeout };
  if (u.uploader === 'command') {
    if (!u.uploadCommand.trim()) return 'Set an upload command in Preferences › Images first.';
    return { kind: 'command', command: u.uploadCommand.trim(), timeoutSecs: u.uploadTimeout };
  }
  return 'Choose an image uploader in Preferences › Images first.';
}

// ---------------------------------------------------------------- markdown scanning

export interface ImageRef {
  /** The whole image syntax as written, e.g. `![a](x.png "t")` or `<img src="x.png">`. */
  raw: string;
  /** Offset of `raw` in the markdown. */
  index: number;
  /** The src exactly as written (without `<>` brackets). */
  src: string;
  /** Offset of `src` inside `raw`. */
  srcOffset: number;
}

const MD_IMAGE = /!\[(?:\\.|[^\]\\\n])*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*("[^"]*"|'[^']*')[^>]*>/gi;

/** Image references outside fenced code blocks and inline code spans. */
export function findImageRefs(md: string): ImageRef[] {
  const out: ImageRef[] = [];
  const lines = md.split(/(?<=\n)/);
  let pos = 0;
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
    } else if (m) {
      fence = m[1];
    } else {
      scanLine(line, pos, out);
    }
    pos += line.length;
  }
  return out;
}

function scanLine(line: string, base: number, out: ImageRef[]): void {
  // Blank out inline code spans so images inside them are ignored (offsets kept).
  const masked = line.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length));
  for (const re of [MD_IMAGE, HTML_IMAGE]) {
    re.lastIndex = 0;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
      const raw = line.slice(m.index, m.index + m[0].length);
      let src = m[1];
      let srcOffset = m[0].lastIndexOf(src);
      if (src.startsWith('<') || src.startsWith('"') || src.startsWith("'")) {
        src = src.slice(1, -1);
        srcOffset += 1;
      }
      out.push({ raw, index: base + m.index, src, srcOffset });
    }
  }
}

export interface LocalImage {
  src: string;
  path: string;
}

/** Distinct local images (resolved absolute paths); URLs and unresolvable srcs are skipped. */
export function localImages(refs: ImageRef[], baseDir: string | null): LocalImage[] {
  const seen = new Set<string>();
  const out: LocalImage[] = [];
  for (const r of refs) {
    if (seen.has(r.src) || isUrlLike(r.src)) continue;
    const path = resolveDocPath(r.src, baseDir);
    if (!path) continue;
    seen.add(r.src);
    out.push({ src: r.src, path });
  }
  return out;
}

export function withSrc(ref: ImageRef, url: string): string {
  return ref.raw.slice(0, ref.srcOffset) + url + ref.raw.slice(ref.srcOffset + ref.src.length);
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Point every reference to an uploaded src at its URL, through the editor's own
 * (undoable) replace-all. Returns the srcs that could not be rewritten safely —
 * e.g. when the core's case-insensitive replace would also hit other text.
 */
export function applyUrls(editor: EditorHandle, urls: Map<string, string>): string[] {
  const md = editor.getMarkdown();
  const failed = new Set<string>();
  const done = new Set<string>();
  for (const ref of findImageRefs(md)) {
    const url = urls.get(ref.src);
    if (!url || done.has(ref.raw)) continue;
    done.add(ref.raw);
    const now = editor.getMarkdown();
    if (count(now.toLowerCase(), ref.raw.toLowerCase()) !== count(now, ref.raw)) {
      failed.add(ref.src);
      continue;
    }
    if (!editor.exec({ kind: 'replace', query: ref.raw, replacement: withSrc(ref, url), all: true })) failed.add(ref.src);
  }
  return [...failed];
}

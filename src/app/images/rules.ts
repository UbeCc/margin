import type { ImageRule } from '../../contracts';
import { isAbsolute, join, normalize, relative } from '../util/path';
import { isTextBundlePath, TEXTBUNDLE_ASSETS } from '../textbundle';

/**
 * Image insertion rules (#99), modelled on Typora's behaviour (typora-re images §3):
 * which folder a newly inserted image is copied to (front matter
 * `typora-copy-images-to` → global preference), whether it is copied at all
 * (local / online scope toggles), and how its src is written back
 * (relative / `./` / `typora-root-url` / URL escaping). Pure functions only.
 */

/** Shell settings keys (persisted verbatim next to AppSettings). */
export interface ImageOptions {
  /** "Apply above rules to local images" (Typora default: on). */
  imageApplyLocal: boolean;
  /** "Apply above rules to online images" (Typora default: off) — downloads remote images. */
  imageApplyOnline: boolean;
  /** "Use relative path if possible". */
  imageUseRelative: boolean;
  /** "Add ./ for relative path". */
  imageDotPrefix: boolean;
  /** "Auto escape image URL when insert". */
  imageAutoEscape: boolean;
  /** "Allow upload images automatically based on YAML settings" (`typora-copy-images-to: upload`). */
  imageAllowYamlUpload: boolean;
  /** Global "Upload image" insert action: upload instead of copying (#92). */
  imageUploadOnInsert: boolean;
  /** "Preferred Image Syntax" used for newly inserted images. */
  imageSyntax: 'markdown' | 'html';
}

export const IMAGE_OPTION_DEFAULTS: Readonly<ImageOptions> = Object.freeze({
  imageApplyLocal: true,
  imageApplyOnline: false,
  imageUseRelative: true,
  imageDotPrefix: false,
  imageAutoEscape: true,
  imageAllowYamlUpload: false,
  imageUploadOnInsert: false,
  imageSyntax: 'markdown',
});

export function imageOptionsOf(s: object): ImageOptions {
  const r = s as Record<string, unknown>;
  const d = IMAGE_OPTION_DEFAULTS;
  const b = (k: keyof ImageOptions): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (d[k] as boolean));
  return {
    imageApplyLocal: b('imageApplyLocal'),
    imageApplyOnline: b('imageApplyOnline'),
    imageUseRelative: b('imageUseRelative'),
    imageDotPrefix: b('imageDotPrefix'),
    imageAutoEscape: b('imageAutoEscape'),
    imageAllowYamlUpload: b('imageAllowYamlUpload'),
    imageUploadOnInsert: b('imageUploadOnInsert'),
    imageSyntax: r.imageSyntax === 'html' ? 'html' : 'markdown',
  };
}

// ---------------------------------------------------------------- front matter

/** Text of the leading `---` YAML block (without fences), or null. */
export function frontMatterBody(md: string): string | null {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
  if (m) return m[1];
  return /^﻿?---[ \t]*\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(md) ? '' : null;
}

/** Scalar value of a top-level front matter key (quotes stripped), or null. */
export function frontMatterValue(md: string, key: string): string | null {
  const body = frontMatterBody(md);
  if (body === null) return null;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(body);
  if (!m) return null;
  let v = m[1].replace(/\s+#.*$/, '').trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
  return v;
}

/**
 * Set (or remove, when value is null) a top-level front matter key, creating the
 * block when needed. Returns the full new markdown.
 */
export function setFrontMatterValue(md: string, key: string, value: string | null): string {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const line = value === null ? null : `${key}: ${/^[\w./~${}-]*$/.test(value) && value ? value : JSON.stringify(value)}`;
  const m = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n)((?:---|\.\.\.)[ \t]*(?:\r?\n|$))/.exec(md);
  if (!m) {
    if (line === null) return md;
    return `---${eol}${line}${eol}---${eol}${md.length && !/^\r?\n/.test(md) ? eol : ''}${md}`;
  }
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}[ \\t]*:.*$`, 'm');
  let body = m[2];
  if (re.test(body)) body = line === null ? body.replace(new RegExp(`^${esc}[ \\t]*:.*(?:\\r?\\n|$)`, 'm'), '').replace(/\r?\n$/, '') : body.replace(re, line);
  else if (line !== null) body = body.length ? body + eol + line : line;
  return m[1] + body + (body.length ? m[3] : '') + m[4] + md.slice(m[0].length);
}

// ---------------------------------------------------------------- target folder

export type ImageTarget =
  | { kind: 'copy'; rule: ImageRule; source: 'textbundle' | 'yaml' | 'settings' }
  | { kind: 'upload'; source: 'yaml' | 'settings' }
  | { kind: 'keep' };

export interface TargetContext {
  markdown: string;
  globalRule: ImageRule;
  options: ImageOptions;
  sourceMode?: boolean;
  /** Path of the current document: a `.textbundle` fixes the target folder (images §3.1). */
  docPath?: string | null;
}

export type TargetResult = ImageTarget & { warning?: string };

/** Typora's `getTargetImageStorageFolder` order: TextBundle → front matter → global preference. */
export function imageTarget(ctx: TargetContext): TargetResult {
  if (isTextBundlePath(ctx.docPath))
    return { kind: 'copy', rule: { kind: 'relative', dir: TEXTBUNDLE_ASSETS }, source: 'textbundle' };
  const yaml = ctx.sourceMode ? null : frontMatterValue(ctx.markdown, 'typora-copy-images-to');
  let warning: string | undefined;
  if (yaml) {
    if (/^(?:upload|ipic)$/i.test(yaml)) {
      if (ctx.options.imageAllowYamlUpload || ctx.options.imageUploadOnInsert) return { kind: 'upload', source: 'yaml' };
      warning = 'The option `Allow upload images automatically based on YAML settings` must be enabled first to automatically upload images.';
    } else {
      const dir = yaml;
      return isAbsolute(dir) ? { kind: 'copy', rule: { kind: 'absolute', dir }, source: 'yaml' } : { kind: 'copy', rule: { kind: 'relative', dir }, source: 'yaml' };
    }
  }
  if (ctx.options.imageUploadOnInsert) return { kind: 'upload', source: 'settings', ...(warning ? { warning } : {}) };
  if (ctx.globalRule.kind === 'none') return { kind: 'keep', ...(warning ? { warning } : {}) };
  return { kind: 'copy', rule: ctx.globalRule, source: 'settings', ...(warning ? { warning } : {}) };
}

export const REMOTE_RE = /^\s*(?:https?|ftp):\/\//i;

/**
 * Typora's `shouldTriggerMove` scope checks (folder equality is checked natively).
 * A TextBundle document copies even remote images (images §3.2).
 */
export function shouldApplyRule(src: string | undefined, o: ImageOptions, textBundle = false): boolean {
  if (!src) return true; // pasted image data is always stored
  if (/^\s*data:/i.test(src)) return false;
  if (REMOTE_RE.test(src)) return textBundle || o.imageApplyOnline;
  return textBundle || o.imageApplyLocal;
}

// ---------------------------------------------------------------- src formatting

/** Typora-style escapeURL: characters that break markdown destinations or URL parsing. */
export function escapeImageUrl(s: string): string {
  return s.replace(/[ %#?'"()<>\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** Decode a written src back to a filesystem path segment-wise (handles %23, %3F, …). */
export function decodeSrcPath(src: string): string {
  return src
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

export interface SrcContext {
  docDir: string | null;
  /** Absolute `typora-root-url` directory, if the document sets one. */
  rootDir: string | null;
  options: ImageOptions;
}

/** `resolveImagePath`: how an absolute image path is written into the document. */
export function formatImageSrc(absPath: string, ctx: SrcContext): string {
  const abs = normalize(absPath);
  const o = ctx.options;
  const explicit = !!ctx.rootDir;
  const root = ctx.rootDir ?? (o.imageUseRelative ? ctx.docDir : null);
  let out = abs;
  if (root) {
    let rel = relative(root, abs);
    if (o.imageDotPrefix && !rel.startsWith('.')) rel = './' + rel;
    // Root-url mode writes site-root paths; images outside the root stay `../`-relative
    // to the root (relative srcs resolve against the root when rendering).
    if (explicit && !rel.startsWith('.')) rel = '/' + rel;
    out = rel;
  }
  if (/^[a-zA-Z]:[\\/]/.test(abs)) out = out.replace(/\\/g, '/');
  return o.imageAutoEscape ? escapeImageUrl(out) : out;
}

/** Absolute directory of `typora-root-url` (resolved against the document), or null. */
export function rootDirOf(markdown: string, docDir: string | null): string | null {
  const v = frontMatterValue(markdown, 'typora-root-url');
  if (!v) return null;
  const p = decodeSrcPath(v.replace(/^file:\/\//i, ''));
  if (isAbsolute(p)) return normalize(p);
  return docDir ? join(docDir, p) : null;
}

/** Rendering: resolve a src with the document's root url (absolute `/x` and relative `x` are root-relative). */
export function resolveWithRoot(src: string, rootDir: string): string | null {
  const s = src.trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.startsWith('#')) return null;
  return join(rootDir, decodeSrcPath(s.replace(/[?#].*$/, '')).replace(/^\/+/, ''));
}

/** The markdown snippet inserted for a new image. */
export function imageSnippet(src: string, alt: string, syntax: 'markdown' | 'html'): string {
  const a = alt.replace(/[[\]]/g, '');
  if (syntax === 'html') return `<img src="${src.replace(/"/g, '%22')}" alt="${a.replace(/"/g, '&quot;')}" />`;
  return `![${a}](${/[\s()]/.test(src) ? `<${src}>` : src})`;
}

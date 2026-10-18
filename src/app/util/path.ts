/**
 * Small POSIX/Windows-tolerant path helpers. Paths coming from the platform are
 * absolute native paths; we keep whatever separator the input used.
 */

const WIN_ABS = /^[a-zA-Z]:[\\/]/;

export function sepOf(p: string): '/' | '\\' {
  return !p.includes('/') && p.includes('\\') ? '\\' : '/';
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || WIN_ABS.test(p);
}

function trimTrailing(p: string): string {
  if (p.length <= 1) return p;
  if (/^[a-zA-Z]:[\\/]$/.test(p)) return p;
  return p.replace(/[\\/]+$/, '') || p[0];
}

export function basename(p: string): string {
  const t = trimTrailing(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i < 0 ? t : t.slice(i + 1);
}

export function dirname(p: string): string {
  const t = trimTrailing(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i < 0) return '.';
  if (i === 0) return t[0];
  const d = t.slice(0, i);
  return /^[a-zA-Z]:$/.test(d) ? d + t[i] : d;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

export function stripExt(name: string): string {
  const e = extname(name);
  return e ? name.slice(0, -e.length) : name;
}

/** Normalize `.` / `..` segments. Keeps the leading root. */
export function normalize(p: string): string {
  const sep = sepOf(p);
  let root = '';
  let rest = p;
  const m = /^([a-zA-Z]:)?[\\/]/.exec(p);
  if (m) {
    root = m[0].replace(/\\|\//, sep);
    rest = p.slice(m[0].length);
  }
  const out: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join(sep);
  return root + joined || (root ? root : '.');
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((x) => x.length > 0);
  if (!filtered.length) return '.';
  const sep = sepOf(filtered[0]);
  let acc = '';
  for (const part of filtered) {
    if (isAbsolute(part)) acc = part;
    else acc = acc ? acc.replace(/[\\/]+$/, '') + sep + part : part;
  }
  return normalize(acc);
}

/** Relative path from directory `from` to `to` (both absolute). Uses '/' separators. */
export function relative(from: string, to: string): string {
  const a = normalize(from).split(/[\\/]+/).filter(Boolean);
  const b = normalize(to).split(/[\\/]+/).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  return [...up, ...b.slice(i)].join('/') || '.';
}

/** Is `child` equal to or inside `parent`? */
export function isInside(parent: string, child: string): boolean {
  const p = normalize(parent).replace(/[\\/]+$/, '');
  const c = normalize(child);
  if (c === p) return true;
  return c.startsWith(p + '/') || c.startsWith(p + '\\') || (p === '/' && c.startsWith('/'));
}

const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext', '.txt', '.text', '.rmd', '.qmd']);

export function isMarkdownPath(p: string): boolean {
  return MD_EXT.has(extname(p).toLowerCase());
}

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico', '.tif', '.tiff']);
export function isImagePath(p: string): boolean {
  return IMG_EXT.has(extname(p).toLowerCase());
}

/** True for URLs the webview can load as-is (or that are not local paths). */
export function isUrlLike(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)/i.test(src) && !WIN_ABS.test(src);
}

/**
 * Resolve a markdown image/link src against the document directory to an absolute local path.
 * Returns null when the src is a URL (should be used as-is) or cannot be resolved (unsaved doc).
 */
export function resolveDocPath(src: string, baseDir: string | null): string | null {
  let s = src.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  if (!s || s.startsWith('#') || isUrlLike(s)) return null;
  s = s.replace(/[?#].*$/, '');
  try {
    s = decodeURI(s);
  } catch {
    /* keep raw */
  }
  if (s.startsWith('~/')) return null;
  if (isAbsolute(s)) return normalize(s);
  if (!baseDir) return null;
  return join(baseDir, s);
}

/** Display a path relative to a root when inside it, else shortened with ~ for home dirs. */
export function displayPath(p: string, root?: string | null): string {
  if (root && isInside(root, p) && p !== root) return relative(root, p);
  return p.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** Choose a non-colliding name: "Untitled.md", "Untitled 2.md"… */
export function uniqueName(base: string, ext: string, taken: Set<string>): string {
  let name = base + ext;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}${ext}`;
  return name;
}

/** Natural, case-insensitive compare ("file2" < "file10"). */
export const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function isValidFileName(name: string): boolean {
  return !!name.trim() && !/[\\/:*?"<>|\x00]/.test(name) && name !== '.' && name !== '..';
}

/**
 * Fold macOS firmlinks so lexically different spellings of one folder compare equal
 * (`/private/tmp` ≡ `/tmp`, also `/var`, `/etc`). Native dialogs and the file watcher
 * report canonical paths while the user may have opened the `/tmp/...` spelling.
 */
export function foldFirmlinks(p: string): string {
  return p.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');
}

/** Relative path from directory `fromDir` to `to`, tolerant of firmlink spellings. */
export function relativeFrom(fromDir: string, to: string): string {
  return relative(foldFirmlinks(fromDir), foldFirmlinks(to));
}

/**
 * File URL of a native path (WebArchive base for rich copy, #115); segments
 * percent-encoded like NSURL fileURLWithPath. Empty path → `untitled.md`
 * (Typora uses the same default for unsaved documents, §3.4).
 */
export function fileUrl(p: string | null | undefined): string {
  if (!p) return 'untitled.md';
  const segs = p.split(/[\\/]/);
  const body = segs.map((s, i) => (/^[A-Za-z]:$/.test(s) && i === 0 ? s : encodeURIComponent(s))).join('/');
  return 'file:///' + body.replace(/^\/+/, '');
}

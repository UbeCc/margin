/// <reference types="vite/client" />
import type { AppSettings, ImageRule } from '../contracts';

/** Built-in theme CSS bundled from `src/themes/*.css` (owned by app). */
const builtinModules = import.meta.glob('../themes/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function builtinThemes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, css] of Object.entries(builtinModules)) {
    const name = file.split('/').pop()!.replace(/\.css$/, '');
    out[name] = css;
  }
  return out;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'paper',
  colorScheme: 'system',
  fontSize: 16,
  autoSave: false,
  imageRule: { kind: 'relative', dir: './assets' },
  spellcheck: false,
  recentFiles: [],
  recentFolders: [],
  lastFolder: null,
};

const MAX_RECENT = 20;

function validRule(r: unknown): r is ImageRule {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (o.kind === 'none') return true;
  return (o.kind === 'relative' || o.kind === 'absolute') && typeof o.dir === 'string';
}

/**
 * Same rules as `src-tauri/src/settings.rs`: defaults for missing/invalid known
 * keys, unknown keys preserved, fontSize clamped, recents capped.
 */
export function normalizeSettings(input: unknown): AppSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out as unknown as AppSettings;
  const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const checks: Record<string, (v: unknown) => boolean> = {
    theme: (v) => typeof v === 'string',
    colorScheme: (v) => v === 'light' || v === 'dark' || v === 'system',
    fontSize: (v) => typeof v === 'number' && Number.isFinite(v),
    autoSave: (v) => typeof v === 'boolean',
    imageRule: validRule,
    spellcheck: (v) => typeof v === 'boolean',
    recentFiles: strArr,
    recentFolders: strArr,
    lastFolder: (v) => v === null || typeof v === 'string',
  };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'settingsVersion') continue;
    const check = checks[k];
    if (!check || check(v)) out[k] = v;
  }
  out.fontSize = Math.min(72, Math.max(8, out.fontSize as number));
  out.recentFiles = (out.recentFiles as string[]).slice(0, MAX_RECENT);
  out.recentFolders = (out.recentFolders as string[]).slice(0, MAX_RECENT);
  return out as unknown as AppSettings;
}

// ------------------------------------------------------------------ paths (POSIX)

export function normalizePath(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

export function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? '';
}

export function joinPath(a: string, b: string): string {
  return b.startsWith('/') ? normalizePath(b) : normalizePath(`${a}/${b}`);
}

export function relativePath(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split('/').filter(Boolean);
  const b = normalizePath(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Same escaping as Rust `to_markdown_src`: forward slashes, `%20` etc. */
export function toMarkdownSrc(p: string): string {
  return p.replace(/\\/g, '/').replace(/[ %()<>#?]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

export function expandImageDir(template: string, docPath: string | null): string {
  const name = docPath ? basename(docPath) : 'untitled';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return template.split('${filename}').join(stem);
}

export function extForImage(mime?: string, name?: string): string {
  const byMime: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/avif': 'avif',
  };
  if (mime && byMime[mime.toLowerCase()]) return byMime[mime.toLowerCase()];
  const ext = name?.split('.').pop()?.toLowerCase();
  if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return 'png';
}

/** `image-YYYYMMDD-HHMMSS-xxx.ext` */
export function generatedImageName(ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rnd = '';
  for (let i = 0; i < 3; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  return `image-${stamp}-${rnd}.${ext}`;
}

/** Best-effort print of an HTML string through a hidden iframe. */
export function printHtmlInIframe(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = html;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } finally {
        setTimeout(() => frame.remove(), 1000);
        resolve();
      }
    };
    document.body.appendChild(frame);
  });
}

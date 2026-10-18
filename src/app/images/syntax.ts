/**
 * Image syntax helpers (#99, typora-re images §4.6): switch between `![]()` and
 * `<img>`, and set / clear the `zoom` style (zooming a markdown image converts it
 * to HTML first, `100%` removes the zoom). All functions map one image's raw
 * source text to new raw text.
 */

export interface ParsedImage {
  html: boolean;
  src: string;
  alt: string;
  title: string | null;
  /** Other attributes of an <img>, in source order (name → raw value without quotes). */
  attrs: [string, string][];
}

const MD = /^!\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+("[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)$/;
const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

export function parseImage(raw: string): ParsedImage | null {
  const m = MD.exec(raw.trim());
  if (m) {
    const src = m[2].startsWith('<') ? m[2].slice(1, -1) : m[2];
    return { html: false, src, alt: m[1].replace(/\\(.)/g, '$1'), title: m[3] ? m[3].slice(1, -1) : null, attrs: [] };
  }
  const h = /^<img\b([^>]*?)\/?>$/i.exec(raw.trim());
  if (!h) return null;
  const attrs: [string, string][] = [];
  ATTR.lastIndex = 0;
  for (let a = ATTR.exec(h[1]); a; a = ATTR.exec(h[1])) {
    let v = a[2] ?? '';
    if (/^["']/.test(v)) v = v.slice(1, -1);
    attrs.push([a[1].toLowerCase(), v]);
  }
  const get = (k: string) => attrs.find(([n]) => n === k)?.[1];
  const src = get('src');
  if (src === undefined) return null;
  return {
    html: true,
    src,
    alt: get('alt') ?? '',
    title: get('title') ?? null,
    attrs: attrs.filter(([n]) => n !== 'src' && n !== 'alt' && n !== 'title'),
  };
}

const q = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function renderHtml(p: ParsedImage): string {
  let s = `<img src="${p.src.replace(/"/g, '%22')}" alt="${q(p.alt)}"`;
  if (p.title !== null) s += ` title="${q(p.title)}"`;
  for (const [n, v] of p.attrs) s += ` ${n}="${q(v)}"`;
  return s + ' />';
}

export function renderMarkdown(p: ParsedImage): string {
  const alt = p.alt.replace(/([[\]\\])/g, '\\$1');
  const src = /[\s()<>]/.test(p.src) ? `<${p.src}>` : p.src;
  const title = p.title !== null ? ` "${p.title.replace(/"/g, '\\"')}"` : '';
  return `![${alt}](${src}${title})`;
}

/** Switch Image Syntax → Markdown Style / HTML Style. Unknown syntax is returned unchanged. */
export function switchSyntax(raw: string, to: 'markdown' | 'html'): string {
  const p = parseImage(raw);
  if (!p || p.html === (to === 'html')) return raw;
  return to === 'html' ? renderHtml(p) : renderMarkdown({ ...p, attrs: [] });
}

function styleOf(p: ParsedImage): string {
  return p.attrs.find(([n]) => n === 'style')?.[1] ?? '';
}

/** Current zoom (e.g. "50%"), or null. */
export function zoomOf(raw: string): string | null {
  const p = parseImage(raw);
  if (!p) return null;
  const m = /(?:^|;)\s*zoom\s*:\s*([^;]+)/i.exec(styleOf(p));
  return m ? m[1].trim() : null;
}

/** `zoomAction`: write `zoom:<v>;` into the style (converting to <img>); "100%" removes it. */
export function setZoom(raw: string, value: string): string {
  const p = parseImage(raw);
  if (!p) return raw;
  const decls = styleOf(p)
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^zoom\s*:/i.test(d));
  const reset = value.trim() === '100%';
  if (!reset) decls.unshift(`zoom:${value.trim()}`);
  const attrs = p.attrs.filter(([n]) => n !== 'style');
  if (decls.length) attrs.push(['style', decls.join(';') + ';']);
  if (!p.html && reset) return raw;
  return renderHtml({ ...p, attrs });
}

/** Typora's Format › Image › Zoom Image presets. */
export const ZOOM_PRESETS = ['25%', '33%', '50%', '67%', '80%', '100%', '150%', '200%'];

/** Zoom menu entries: 1/scale first (Retina screenshots → "50%"), then the presets. */
export function zoomChoices(scale: number | null): string[] {
  const presets = ZOOM_PRESETS;
  if (!scale || !Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-3) return presets;
  const fit = `${Math.round(100 / scale)}%`;
  return [fit, ...presets.filter((x) => x !== fit)];
}

import { escapeHtml } from './util/dom';

const KATEX_FONT_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/fonts/';

/** KaTeX stylesheet with font URLs pointed at a CDN (relative URLs break once exported). */
export async function loadKatexCss(): Promise<string> {
  try {
    const mod = (await import('katex/dist/katex.min.css?raw')) as { default: string };
    return mod.default.replace(/url\((['"]?)fonts\//g, `url($1${KATEX_FONT_BASE}`);
  } catch {
    return '';
  }
}

export function needsKatex(html: string): boolean {
  return /class="[^"]*\bkatex\b/.test(html);
}

/** Strip editor-only theme rules that make no sense in a standalone page. */
const EXPORT_BASE_CSS = `
html { background: var(--margin-bg); }
body { margin: 0; background: var(--margin-bg); color: var(--margin-fg); }
.margin-doc { max-width: var(--margin-doc-width, 760px); margin: 0 auto; padding: 56px 32px 96px; box-sizing: border-box; }
@media print {
  html, body { background: #fff !important; }
  .margin-doc { padding: 0; max-width: none; }
  .margin-doc pre, .margin-doc blockquote, .margin-doc table, .margin-doc img { break-inside: avoid; }
  .margin-doc h1, .margin-doc h2, .margin-doc h3 { break-after: avoid; }
}
`;

export function buildExportHtml(opts: {
  title: string;
  body: string;
  themeCss: string;
  extraCss?: string;
  lang?: string;
  /** Raw HTML appended to <head> / <body> (export settings, #95). */
  appendHead?: string;
  appendBody?: string;
  /** Extra class names on <body>. */
  bodyClass?: string;
}): string {
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Margin">
<title>${escapeHtml(opts.title)}</title>
<style>
${opts.themeCss}
${EXPORT_BASE_CSS}
${opts.extraCss ?? ''}
</style>
${opts.appendHead ?? ''}
</head>
<body${opts.bodyClass ? ` class="${escapeHtml(opts.bodyClass)}"` : ''}>
<article class="margin-doc">
${opts.body}
</article>
${opts.appendBody ?? ''}
</body>
</html>
`;
}

/** Export › HTML (without Styles): bare semantic HTML, no theme or editor CSS (#95). */
export function buildPlainHtml(opts: { title: string; body: string; lang?: string; appendHead?: string; appendBody?: string }): string {
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${opts.appendHead ?? ''}
</head>
<body>
${opts.body}
${opts.appendBody ?? ''}
</body>
</html>
`;
}

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces → '-'. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Same-document links written against heading text (`[x](#the-end)`,
 * `[x](#The End)`) → the heading element's real id, so they jump inside HTML
 * and PDF exports. Unknown fragments are left alone.
 */
export function linkHeadingAnchors(body: string): string {
  if (!body.includes('href="#')) return body;
  const tpl = document.createElement('template');
  tpl.innerHTML = body;
  const map = new Map<string, string>();
  const ids = new Set<string>();
  for (const h of tpl.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (!h.id) continue;
    ids.add(h.id);
    const text = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (const k of [headingSlug(text), text.toLowerCase()]) if (k && !map.has(k)) map.set(k, h.id);
  }
  let changed = false;
  for (const a of tpl.content.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    let frag = a.getAttribute('href')!.slice(1);
    try {
      frag = decodeURIComponent(frag);
    } catch {
      /* keep raw */
    }
    if (ids.has(frag) || tpl.content.getElementById?.(frag)) continue;
    const id = map.get(frag.toLowerCase()) ?? map.get(headingSlug(frag));
    if (id) {
      a.setAttribute('href', `#${id}`);
      changed = true;
    }
  }
  return changed ? tpl.innerHTML : body;
}

/** Headings of an export body in document order (for PDF bookmarks / internal links). */
export function exportHeadings(body: string): { level: number; text: string; id: string }[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = body;
  return [...tpl.content.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(),
    id: h.id,
  })).filter((h) => h.text);
}

/** First H1 text, else file stem, else "Untitled". */
export function documentTitle(markdown: string, fileName: string | null): string {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
  if (m) return m[1].replace(/[*_`~=]/g, '').trim();
  return fileName ? fileName.replace(/\.[^.]+$/, '') : 'Untitled';
}

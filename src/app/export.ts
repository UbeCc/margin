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

export function buildExportHtml(opts: { title: string; body: string; themeCss: string; extraCss?: string; lang?: string }): string {
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
</head>
<body>
<article class="margin-doc">
${opts.body}
</article>
</body>
</html>
`;
}

/** First H1 text, else file stem, else "Untitled". */
export function documentTitle(markdown: string, fileName: string | null): string {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
  if (m) return m[1].replace(/[*_`~=]/g, '').trim();
  return fileName ? fileName.replace(/\.[^.]+$/, '') : 'Untitled';
}

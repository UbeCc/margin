/**
 * Clipboard flavours for rich copy and the paste priority order (#79).
 *
 * Copy writes three DataTransfer flavours:
 *  - `text/plain`            markdown source of the selection
 *  - `text/html`             rendered HTML, wrapped in `<div data-margin-md="…">`
 *                            whose attribute carries the markdown again (WebKit
 *                            only exposes custom MIME types to same-origin
 *                            pages, so this is the cross-process fallback)
 *  - `text/x-margin-markdown` private lossless flavour
 * and, where the platform supports it (macOS), RTF via a native call.
 *
 * Paste priority: private flavour > markdown embedded in Margin HTML >
 * foreign HTML (converted) > plain text.
 */
import { esc } from './html';

export const MARGIN_MIME = 'text/x-margin-markdown';
export const MARGIN_HTML_ATTR = 'data-margin-md';
export const MARGIN_COPY_ATTR = 'data-margin-copy';

export interface CopyFlavors {
  plain: string;
  html: string;
  markdown: string;
}

/** HTML flavour: rendered fragment inside a marker div that carries the markdown. */
export function wrapMarginHtml(renderedHtml: string, md: string, nonce?: string): string {
  const id = nonce ? ` ${MARGIN_COPY_ATTR}="${esc(nonce)}"` : '';
  return `<div ${MARGIN_HTML_ATTR}="${esc(md)}"${id}>${renderedHtml}</div>`;
}

/** `nonce` tags this copy so native code can tell when WebKit has written it. */
export function buildCopyFlavors(md: string, renderedHtml: string, nonce?: string): CopyFlavors {
  return { plain: md, html: wrapMarginHtml(renderedHtml, md, nonce), markdown: md };
}

export function writeFlavors(dt: DataTransfer, f: CopyFlavors): void {
  dt.setData('text/plain', f.plain);
  dt.setData('text/html', f.html);
  try {
    dt.setData(MARGIN_MIME, f.markdown);
  } catch {
    /* some engines reject unknown types; the HTML marker still carries it */
  }
}

/**
 * Markdown embedded in a Margin HTML flavour, or null. Returns '' only when the
 * marker exists without a value (old Margin builds: their text/plain is the md).
 */
export function embeddedMarkdown(html: string): string | null {
  if (!html.includes(MARGIN_HTML_ATTR)) return null;
  if (typeof DOMParser !== 'undefined') {
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector(`[${MARGIN_HTML_ATTR}]`);
    return el ? (el.getAttribute(MARGIN_HTML_ATTR) ?? '') : null;
  }
  const m = new RegExp(`${MARGIN_HTML_ATTR}="([^"]*)"`).exec(html);
  if (!m) return null;
  return m[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
}

export type PasteSource = 'margin' | 'margin-html' | 'html' | 'plain';

const RICH_HTML = /<(?:p|h[1-6]|ul|ol|li|strong|b|em|i|a|img|pre|code|table|blockquote|br)\b/i;

/**
 * Pick the markdown to insert from clipboard data, in priority order.
 * `htmlToMd` converts foreign HTML; its failure falls back to plain text.
 */
export function pickPasteMarkdown(
  get: (type: string) => string,
  htmlToMd: (html: string) => string,
): { md: string; source: PasteSource } {
  let priv = '';
  try {
    priv = get(MARGIN_MIME);
  } catch {
    priv = '';
  }
  if (priv) return { md: priv, source: 'margin' };
  const html = get('text/html');
  const text = get('text/plain');
  if (html) {
    const emb = embeddedMarkdown(html);
    if (emb) return { md: emb, source: 'margin-html' };
    if (emb === null && RICH_HTML.test(html)) {
      try {
        const md = htmlToMd(html);
        if (md) return { md, source: 'html' };
      } catch {
        /* fall through to plain text */
      }
    }
  }
  return { md: text, source: 'plain' };
}

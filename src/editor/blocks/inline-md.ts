/**
 * Minimal inline-markdown → HTML renderer used where the core's inline renderer is
 * not available (table cells when not being edited, TOC entries, export).
 * Supports: escapes, `code`, **strong**, *em* / _em_, ~~strike~~, ==mark==,
 * [link](url), ![img](src), $math$ (via callback), <br>, autolinks.
 */
import { escapeHtml } from './util/dom';
import { isSafeUrl } from './sanitize';

export interface InlineOptions {
  renderMath?: (tex: string) => string;
  resolveAsset?: (src: string) => string;
}

const PATTERNS: [RegExp, (m: RegExpExecArray, o: InlineOptions, r: (s: string) => string) => string][] = [
  [/^\\([\\`*_{}[\]()#+\-.!|$~=<>])/, (m) => escapeHtml(m[1])],
  [/^(`+)([\s\S]*?[^`])\1(?!`)/, (m) => `<code>${escapeHtml(m[2].replace(/^ (.*) $/, '$1'))}</code>`],
  [/^\$(?!\s)((?:\\.|[^$\\])+?)(?<!\s)\$(?!\d)/, (m, o) => (o.renderMath ? o.renderMath(m[1]) : `<span class="mb-imath">${escapeHtml(m[1])}</span>`)],
  [/^<br\s*\/?>/i, () => '<br>'],
  [/^<(https?:\/\/[^\s>]+)>/, (m) => `<a href="${escapeHtml(m[1])}">${escapeHtml(m[1])}</a>`],
  [
    /^!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"([^"]*)")?\s*\)/,
    (m, o) => {
      const src = isSafeUrl(m[2], 'src') ? (o.resolveAsset ? o.resolveAsset(m[2]) : m[2]) : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(m[1])}"${m[3] ? ` title="${escapeHtml(m[3])}"` : ''}>`;
    },
  ],
  [
    /^\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"([^"]*)")?\s*\)/,
    (m, _o, r) => {
      const href = isSafeUrl(m[2]) ? m[2] : '';
      return `<a href="${escapeHtml(href)}"${m[3] ? ` title="${escapeHtml(m[3])}"` : ''}>${r(m[1])}</a>`;
    },
  ],
  [/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, (m, _o, r) => `<strong>${r(m[2])}</strong>`],
  [/^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_])/, (m, _o, r) => `<em>${r(m[2])}</em>`],
  [/^~~(?=\S)([\s\S]*?\S)~~/, (m, _o, r) => `<del>${r(m[1])}</del>`],
  [/^==(?=\S)([\s\S]*?\S)==/, (m, _o, r) => `<mark>${r(m[1])}</mark>`],
];

export function renderInlineMarkdown(src: string, opts: InlineOptions = {}): string {
  const r = (s: string) => renderInlineMarkdown(s, opts);
  let out = '';
  let i = 0;
  let text = '';
  outer: while (i < src.length) {
    const rest = src.slice(i);
    // fast path: plain chars
    if (!/^[\\`$<!\[*_~=]/.test(rest)) {
      text += src[i++];
      continue;
    }
    // intraword underscores are not emphasis
    if (rest[0] === '_' && i > 0 && /\w/.test(src[i - 1])) {
      text += src[i++];
      continue;
    }
    for (const [re, fn] of PATTERNS) {
      const m = re.exec(rest);
      if (m) {
        out += escapeHtml(text);
        text = '';
        out += fn(m, opts, r);
        i += m[0].length;
        continue outer;
      }
    }
    text += src[i++];
  }
  return out + escapeHtml(text);
}

/** Strip inline markers to plain text (for TOC entries etc.). */
export function inlineToText(src: string): string {
  const div = document.createElement('div');
  div.innerHTML = renderInlineMarkdown(src);
  return div.textContent || '';
}

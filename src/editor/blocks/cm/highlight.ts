/**
 * Static (non-editor) syntax highlighting with the same `tok-*` classes CodeMirror
 * uses via classHighlighter — used for lazy fence placeholders and export HTML.
 */
import { highlightTree, classHighlighter } from '@lezer/highlight';
import { LanguageSupport } from '@codemirror/language';
import { escapeHtml } from '../util/dom';

export function highlightToHtml(code: string, support: LanguageSupport | null): string {
  if (!support) return escapeHtml(code);
  let tree;
  try {
    tree = support.language.parser.parse(code);
  } catch {
    return escapeHtml(code);
  }
  let out = '';
  let pos = 0;
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > pos) out += escapeHtml(code.slice(pos, from));
    out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
    pos = to;
  });
  if (pos < code.length) out += escapeHtml(code.slice(pos));
  return out;
}

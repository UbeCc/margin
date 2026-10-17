/** math_block (`$$ … $$`) widget and inline math renderer, both via KaTeX. */
import katex from 'katex';
import type { BlockWidget, RenderInlineMath } from '../../contracts';
import { makeRawPreviewWidget, Parsed } from './raw-preview';
import { buildMathRaw, MathParts, parseMathBlock } from './util/delimited';
import { escapeHtml, h } from './util/dom';

export interface MathOptions {
  /** Auto-number display equations without an explicit \tag (CSS counter). */
  numbering?: boolean;
  /** Shared KaTeX macros (persist \gdef across blocks). */
  macros?: Record<string, string>;
}

const sharedMacros: Record<string, string> = {};

export function renderTex(tex: string, displayMode: boolean, macros: Record<string, string> = sharedMacros): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: true,
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml',
    macros,
  });
}

/** Render, returning an error-annotated fallback instead of throwing. */
export function renderTexSafe(tex: string, displayMode: boolean, macros?: Record<string, string>): { html: string; error: string | null } {
  try {
    return { html: renderTex(tex, displayMode, macros), error: null };
  } catch (e) {
    const msg = String((e as Error)?.message || e).replace(/^KaTeX parse error:\s*/, '');
    return { html: escapeHtml(tex), error: msg };
  }
}

type MathParsed = Parsed & { parts: MathParts };

export function createMathBlockWidget(opts: MathOptions = {}): BlockWidget {
  const macros = opts.macros ?? sharedMacros;
  return makeRawPreviewWidget<MathParsed>({
    type: 'math_block',
    className: 'mb-math-block',
    parse(raw) {
      const parts = parseMathBlock(raw);
      return { parts, body: parts.body, build: (b) => buildMathRaw(parts, b) };
    },
    language: () => 'latex',
    label: () => '$$',
    placeholder: 'Enter a TeX formula',
    debounceMs: 60,
    editorPosition: 'above',
    render(preview, p) {
      const { html, error } = renderTexSafe(p.body, true, macros);
      const numbered = !!opts.numbering && !/\\(tag|notag|nonumber)\b/.test(p.body);
      preview.classList.toggle('mb-numbered', numbered);
      if (error) {
        preview.replaceChildren(h('div', { class: 'mb-math-src' }, p.body), h('div', { class: 'mb-error' }, error));
      } else {
        preview.innerHTML = html;
      }
    },
    renderHTML(p) {
      const { html, error } = renderTexSafe(p.body, true, macros);
      return error
        ? `<div class="md-math-block mb-math-error"><pre>${escapeHtml(p.body)}</pre></div>`
        : `<div class="md-math-block">${html}</div>`;
    },
  });
}

/** Inline `$…$` renderer for the core. Errors show the source with a tooltip. */
export const renderInlineMath: RenderInlineMath = (tex, el) => {
  const { html, error } = renderTexSafe(tex, false);
  el.classList.add('mb-inline-math');
  el.classList.toggle('mb-math-error', !!error);
  if (error) {
    el.textContent = tex;
    el.title = error;
  } else {
    el.innerHTML = html;
    el.removeAttribute('title');
  }
};

/** Inline math as an HTML string (export / table cells). */
export function inlineMathHTML(tex: string): string {
  const { html, error } = renderTexSafe(tex, false);
  return error ? `<span class="mb-inline-math mb-math-error" title="${escapeHtml(error)}">${escapeHtml(tex)}</span>` : `<span class="mb-inline-math">${html}</span>`;
}

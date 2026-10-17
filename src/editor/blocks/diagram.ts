/** diagram widget: ```mermaid / ```sequence / ```flow fences rendered via mermaid. */
import type { BlockWidget } from '../../contracts';
import { makeRawPreviewWidget, Parsed } from './raw-preview';
import { buildRaw, FenceParts, parseFence } from './util/delimited';
import { escapeHtml, h } from './util/dom';
import { toMermaid } from './diagram-translate';

type MermaidApi = typeof import('mermaid').default;

let mermaidP: Promise<MermaidApi> | null = null;
let currentTheme: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let idSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidP) mermaidP = import('mermaid').then((m) => m.default);
  return mermaidP;
}

export interface DiagramResult {
  svg: string | null;
  error: string | null;
}

/** Render a diagram to SVG (serialized through a queue; mermaid config is global). */
export function renderDiagram(lang: string, src: string, dark: boolean): Promise<DiagramResult> {
  const job = queue.then(async (): Promise<DiagramResult> => {
    const mermaid = await loadMermaid();
    const theme = dark ? 'dark' : 'default';
    if (theme !== currentTheme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        fontFamily: 'var(--margin-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif)',
      });
      currentTheme = theme;
    }
    const code = toMermaid(lang, src);
    const id = `mb-mermaid-${++idSeq}`;
    try {
      await mermaid.parse(code);
      const { svg } = await mermaid.render(id, code);
      return { svg, error: null };
    } catch (e) {
      return { svg: null, error: String((e as Error)?.message || e) };
    } finally {
      // mermaid leaves temporary containers behind on failure
      document.getElementById(id)?.remove();
      document.getElementById('d' + id)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

type DiagramParsed = Parsed & { parts: FenceParts };

export function createDiagramWidget(): BlockWidget {
  const lastSvg = new WeakMap<HTMLElement, string>();
  return makeRawPreviewWidget<DiagramParsed>({
    type: 'diagram',
    className: 'mb-diagram',
    parse(raw) {
      const parts = parseFence(raw);
      return { parts, body: parts.body, build: (b) => buildRaw(parts, b) };
    },
    language: () => '',
    label: (p) => p.parts.lang || 'mermaid',
    placeholder: 'Enter mermaid source, e.g. graph TD; A-->B',
    debounceMs: 350,
    lineWrapping: false,
    editorPosition: 'above',
    async render(preview, p, settings, env) {
      preview.classList.add('mb-diagram-loading');
      const res = await renderDiagram(p.parts.lang || 'mermaid', p.body, settings.colorScheme === 'dark');
      if (env.stale()) return;
      preview.classList.remove('mb-diagram-loading');
      if (res.svg) {
        lastSvg.set(preview, res.svg);
        const box = h('div', { class: 'mb-diagram-svg' });
        box.innerHTML = res.svg;
        preview.replaceChildren(box);
      } else {
        const prev = lastSvg.get(preview);
        const kids: Node[] = [h('div', { class: 'mb-error' }, h('strong', null, 'Diagram error: '), (res.error || '').split('\n').slice(0, 6).join('\n'))];
        if (prev) {
          const box = h('div', { class: 'mb-diagram-svg mb-stale' });
          box.innerHTML = prev;
          kids.push(box);
        } else if (!env.editing) kids.push(h('pre', { class: 'mb-diagram-src' }, p.body));
        preview.replaceChildren(...kids);
      }
    },
    renderHTML(p, _s, preview) {
      const svg = lastSvg.get(preview);
      if (svg && preview.querySelector('.mb-diagram-svg:not(.mb-stale)')) return `<div class="md-diagram">${svg}</div>`;
      return `<pre class="md-fences md-diagram-src"><code>${escapeHtml(p.body)}</code></pre>`;
    },
  });
}

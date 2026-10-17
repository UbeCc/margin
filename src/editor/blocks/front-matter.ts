/** front_matter widget: collapsed YAML summary box; CodeMirror (yaml) editor on focus. */
import type { BlockWidget } from '../../contracts';
import { makeRawPreviewWidget, Parsed } from './raw-preview';
import { buildRaw, Envelope, parseFrontMatter } from './util/delimited';
import { h } from './util/dom';

type FmParsed = Parsed & { parts: Envelope };

/** Top-level keys of a YAML mapping (cheap scan, no YAML parser). */
export function yamlTopKeys(yaml: string): string[] {
  const keys: string[] = [];
  for (const line of yaml.split('\n')) {
    const m = /^([A-Za-z_][\w.-]*|"[^"]+"|'[^']+')\s*:(\s|$)/.exec(line);
    if (m) keys.push(m[1].replace(/^["']|["']$/g, ''));
  }
  return keys;
}

export function createFrontMatterWidget(): BlockWidget {
  return makeRawPreviewWidget<FmParsed>({
    type: 'front_matter',
    className: 'mb-front-matter',
    parse(raw) {
      const parts = parseFrontMatter(raw);
      return { parts, body: parts.body, build: (b) => buildRaw(parts, b) };
    },
    language: () => 'yaml',
    label: () => 'Front Matter (YAML)',
    placeholder: 'key: value',
    debounceMs: 50,
    hidePreviewWhileEditing: true,
    lineWrapping: true,
    render(preview, p) {
      const keys = yamlTopKeys(p.body);
      const lines = p.body.split('\n');
      const first = lines.slice(0, 3).join('\n');
      preview.replaceChildren(
        h(
          'div',
          { class: 'mb-fm-head' },
          h('span', { class: 'mb-fm-badge' }, 'YAML'),
          h('span', { class: 'mb-fm-keys' }, keys.length ? keys.join(' · ') : `${lines.length} line${lines.length === 1 ? '' : 's'}`),
        ),
        h('pre', { class: 'mb-fm-body' }, first + (lines.length > 3 ? '\n…' : '')),
      );
    },
    renderHTML() {
      return '';
    },
  });
}

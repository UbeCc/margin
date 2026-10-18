/** html_block widget: sanitized live preview, CodeMirror (html) source on focus. */
import type { BlockWidget } from '../../contracts';
import { makeRawPreviewWidget, Parsed } from './raw-preview';
import { buildHtmlRaw, Envelope, parseHtmlBlock } from './util/delimited';
import { h } from './util/dom';
import { isInvisibleHtml, sanitizeHtml } from './sanitize';

type HtmlParsed = Parsed & { parts: Envelope };

function isRelative(url: string) {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(url.trim());
}

export function createHtmlBlockWidget(): BlockWidget {
  return makeRawPreviewWidget<HtmlParsed>({
    type: 'html_block',
    className: 'mb-html-block',
    parse(raw) {
      const parts = parseHtmlBlock(raw);
      return { parts, body: parts.body, build: (b) => buildHtmlRaw(parts, b) };
    },
    language: () => 'html',
    label: () => 'HTML',
    placeholder: 'Enter HTML',
    debounceMs: 150,
    editorPosition: 'above',
    render(preview, p, settings) {
      if (isInvisibleHtml(p.body)) {
        const isComment = /^\s*<!--/.test(p.body);
        preview.replaceChildren(h('span', { class: 'mb-placeholder mb-html-hidden' }, isComment ? '<!-- comment -->' : '</> HTML'));
        return;
      }
      preview.innerHTML = sanitizeHtml(p.body, {
        resolveUrl: (u) => (isRelative(u) ? settings.resolveAsset(u) : u),
      });
    },
    // #136: re-render (re-resolve <img> srcs) when the shell's asset resolution changes.
    settingsKey: (s) => s.assetKey ?? '',
    renderHTML(p) {
      // Exported HTML is opened in browsers / printed to PDF: run it through the same
      // allowlist as the preview so scripts and event handlers never reach the file (#8).
      return sanitizeHtml(p.body);
    },
  });
}

/**
 * Small allowlist HTML sanitizer (DOMParser based) used for html_block previews.
 * Anything not on the allowlist is dropped (dangerous containers) or unwrapped
 * (unknown tags keep their children). URLs are restricted to safe schemes.
 */

const ALLOWED_TAGS = new Set(
  (
    'a abbr address article aside b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt ' +
    'em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p picture pre q rp rt ruby ' +
    's samp section small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video audio wbr ' +
    // svg (inline diagrams / icons)
    'svg g path circle ellipse line polyline polygon rect text tspan defs use title desc lineargradient radialgradient stop clippath mask symbol marker'
  ).split(' '),
);

/** Removed together with their content. */
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'applet', 'base', 'link', 'meta', 'noscript', 'template', 'form', 'input', 'button', 'textarea', 'select', 'option', 'dialog', 'portal', 'foreignobject']);

const GLOBAL_ATTRS = new Set(['title', 'lang', 'dir', 'align', 'valign', 'width', 'height', 'style', 'role', 'aria-label', 'aria-hidden', 'hidden']);

const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'srcset', 'loading'],
  source: ['src', 'srcset', 'type', 'media'],
  video: ['src', 'poster', 'controls', 'loop', 'muted', 'playsinline', 'preload'],
  audio: ['src', 'controls', 'loop', 'muted', 'preload'],
  td: ['colspan', 'rowspan', 'headers', 'bgcolor'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'bgcolor'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  details: ['open'],
  font: ['color', 'face', 'size'],
  time: ['datetime'],
  q: ['cite'],
  blockquote: ['cite'],
  table: ['border', 'cellpadding', 'cellspacing', 'bgcolor'],
};
const SVG_ATTRS = new Set(
  (
    'viewbox xmlns fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity fill-opacity stroke-opacity ' +
    'd x y x1 y1 x2 y2 cx cy r rx ry points transform font-size font-family text-anchor dominant-baseline offset stop-color ' +
    'gradientunits gradienttransform id class preserveaspectratio href xlink:href marker-end marker-start refx refy markerwidth markerheight orient'
  ).split(' '),
);
const SVG_TAGS = new Set('svg g path circle ellipse line polyline polygon rect text tspan defs use title desc lineargradient radialgradient stop clippath mask symbol marker'.split(' '));

const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite', 'xlink:href']);

export function isSafeUrl(url: string, attr = 'href'): boolean {
  const u = url.trim().replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
  if (!u || u.startsWith('#') || u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(u);
  if (!scheme) return true; // relative
  const s = scheme[1];
  if (s === 'http' || s === 'https' || s === 'mailto' || s === 'tel' || s === 'asset' || s === 'tauri' || s === 'file') return true;
  if (s === 'data' && attr !== 'href') return /^data:image\/(png|gif|jpe?g|webp|svg\+xml|avif);/.test(u);
  return false;
}

function cleanStyle(style: string): string {
  return style
    .split(';')
    .filter((d) => {
      const v = d.toLowerCase();
      return !/url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding/.test(v) && !/position\s*:\s*(fixed|sticky)/.test(v);
    })
    .join(';');
}

export interface SanitizeOptions {
  /** Rewrite relative src/href (e.g. EditorSettings.resolveAsset). */
  resolveUrl?: (url: string, attr: string) => string;
}

function cleanNode(node: Node, opts: SanitizeOptions, doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8 /* comment */) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.localName.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      cleanNode(el, opts, doc);
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    const isSvg = SVG_TAGS.has(tag);
    const allowed = TAG_ATTRS[tag] || [];
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const ok = GLOBAL_ATTRS.has(name) || allowed.includes(name) || (isSvg && SVG_ATTRS.has(name)) || /^aria-[a-z]+$/.test(name);
      if (!ok || name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) || name === 'srcset') {
        if (name === 'srcset') {
          const parts = attr.value.split(',').map((p) => p.trim()).filter((p) => isSafeUrl(p.split(/\s+/)[0], 'src'));
          el.setAttribute(attr.name, parts.join(', '));
          continue;
        }
        if (!isSafeUrl(attr.value, name)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (opts.resolveUrl && (name === 'src' || name === 'poster')) el.setAttribute(attr.name, opts.resolveUrl(attr.value, name));
      }
      if (name === 'style') el.setAttribute('style', cleanStyle(attr.value));
    }
    if (tag === 'a' && el.getAttribute('target')) el.setAttribute('rel', 'noopener noreferrer');
    if (el.localName === 'use') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (!href.startsWith('#')) el.remove();
    }
    cleanNode(el, opts, doc);
  }
}

/** Sanitize an HTML fragment and return the safe HTML string. */
export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
  const once = (s: string, o: SanitizeOptions) => {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${s}`, 'text/html');
    cleanNode(doc.body, o, doc);
    return doc.body.innerHTML;
  };
  // Serializing and re-parsing can mutate the tree (namespace / raw-text confusion,
  // "mutation XSS"). Re-sanitize until the output is a fixed point; if it never
  // settles, fall back to escaped text.
  let out = once(html, opts);
  for (let i = 0; i < 4; i++) {
    const next = once(out, {});
    if (next === out) return out;
    out = next;
  }
  return out.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** True if the HTML has nothing visible (only comments / whitespace / dropped tags). */
export function isInvisibleHtml(html: string): boolean {
  const s = sanitizeHtml(html);
  return s.trim() === '' || (/^\s*(<br\s*\/?>\s*)*$/.test(s) && !/<img|<svg|<hr|<video|<audio/.test(s));
}

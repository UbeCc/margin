/**
 * Inline rendering of a text leaf's content into the contenteditable DOM.
 * Syntax characters become `<span class="md-meta">` so `readText(el)` gives
 * back the exact source; rendered extras (images, math, entities, the hr
 * rule) live in `[data-ns]` elements that carry no source text.
 */
import type { Leaf } from './types';
import { parseInline, inlinePlain, type INode, type RefMap } from './parser/inline';
import type { RenderInlineMath } from '../../contracts';

export interface InlineCtx {
  refs: RefMap;
  resolveAsset(src: string): string;
  inlineMath: RenderInlineMath | null;
  /** #127 "Use LaTeX Source": render inline math as its `$…$` source instead of KaTeX HTML. */
  mathSource?: boolean;
}

/** Split a leaf content into [leading block meta, inline body, trailing block meta]. */
export function splitBlockMeta(leaf: Pick<Leaf, 'type' | 'setext'>, c: string): [string, string, string] {
  if (leaf.type === 'heading') {
    if (leaf.setext) {
      const k = c.lastIndexOf('\n');
      return k < 0 ? ['', '', c] : ['', c.slice(0, k), c.slice(k)];
    }
    const m = /^( {0,3}#{1,6})(?:[ \t]+|$|(?=[^#\s]))/.exec(c);
    const pre = m ? m[0] : '';
    let body = c.slice(pre.length);
    const t = /(?:^|[ \t]+)#+[ \t]*$|[ \t]+$/.exec(body);
    const post = t ? body.slice(t.index) : '';
    body = body.slice(0, body.length - post.length);
    return [pre, body, post];
  }
  if (leaf.type === 'footnote') {
    const m = /^ {0,3}\[\^[^\]\s]+\]:[ \t]*/.exec(c);
    return m ? [m[0], c.slice(m[0].length), ''] : ['', c, ''];
  }
  return ['', c, ''];
}

/** Plain text of a heading (for the outline). */
export function headingText(leaf: Leaf, c: string, refs: RefMap): string {
  const body = splitBlockMeta(leaf, c)[1];
  return inlinePlain(parseInline(body, refs)).replace(/\s+/g, ' ').trim();
}

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const meta = (v: string, extra = '') => el('span', 'md-meta' + (extra ? ' ' + extra : ''), v);

/** Render content of a text leaf into `host` (replacing its children). */
export function renderContent(host: HTMLElement, leaf: Leaf, c: string, ctx: InlineCtx): void {
  host.textContent = '';
  const f = document.createDocumentFragment();
  if (leaf.type === 'hr') {
    f.append(meta(c, 'md-bmeta'));
    const hr = el('span', 'md-hr-rule');
    hr.setAttribute('data-ns', '');
    hr.contentEditable = 'false';
    f.append(hr);
  } else if (leaf.type === 'indented_code' || leaf.type === 'def') {
    f.append(document.createTextNode(c));
  } else {
    const [pre, body, post] = splitBlockMeta(leaf, c);
    if (pre) f.append(meta(pre, 'md-bmeta'));
    nodes(f, parseInline(body, ctx.refs), ctx, pre.length);
    if (post) f.append(meta(post, 'md-bmeta'));
  }
  host.append(f);
  if (!c || c.endsWith('\n')) {
    const br = document.createElement('br');
    br.className = 'md-tail';
    host.append(br);
  }
}

function nodes(parent: Node, list: INode[], ctx: InlineCtx, start: number): number {
  let p = start;
  for (const n of list) p = node(parent, n, ctx, p);
  return p;
}

function node(parent: Node, n: INode, ctx: InlineCtx, s: number): number {
  switch (n.k) {
    case 'text':
      parent.appendChild(document.createTextNode(n.v));
      return s + n.v.length;
    case 'meta':
      parent.appendChild(meta(n.v));
      return s + n.v.length;
    case 'br':
      parent.appendChild(meta(n.v, 'md-br'));
      return s + n.v.length;
    case 'html': {
      // #99: an inline `<img …>` (Typora's HTML image syntax, e.g. after "Zoom Image") renders as an image.
      const im = htmlImage(n.v);
      if (im) {
        const w = wrap('image', s, s + n.v.length);
        w.classList.add('md-html-image');
        w.append(meta(n.v, 'md-src'));
        const img = ns('img', 'md-img') as HTMLImageElement;
        img.alt = im.alt;
        if (im.title) img.title = im.title;
        for (const k of ['width', 'height'] as const) if (im[k]) img.setAttribute(k, im[k]!);
        if (im.style) img.setAttribute('style', im.style);
        img.src = ctx.resolveAsset(im.src);
        img.draggable = false;
        w.append(img);
        parent.appendChild(w);
        return s + n.v.length;
      }
      parent.appendChild(el('span', n.v.startsWith('<!--') ? 'md-html md-comment' : /^<br\s*\/?>$/i.test(n.v) ? 'md-html md-html-br' : 'md-html', n.v));
      return s + n.v.length;
    }
    case 'entity': {
      const w = wrap('entity', s, s + n.v.length);
      w.append(meta(n.v), ns('span', 'md-entity-char', n.ch));
      parent.appendChild(w);
      return s + n.v.length;
    }
    case 'wrap': {
      const w = wrap(n.tag, s, 0);
      if (n.href !== undefined) w.dataset.href = n.href;
      if (n.title) w.title = n.title;
      const e = nodes(w, n.ch, ctx, s);
      w.dataset.e = String(e);
      parent.appendChild(w);
      return e;
    }
    case 'image': {
      const w = wrap('image', s, s + n.raw.length);
      w.append(meta(n.raw, 'md-src'));
      const img = ns('img', 'md-img') as HTMLImageElement;
      img.alt = n.alt;
      if (n.title) img.title = n.title;
      img.src = ctx.resolveAsset(n.src);
      img.draggable = false;
      w.append(img);
      parent.appendChild(w);
      return s + n.raw.length;
    }
    case 'math': {
      const w = wrap('math', s, s + n.raw.length);
      w.append(meta(n.raw, 'md-src'));
      const r = ns('span', 'md-math-render');
      if (ctx.inlineMath) {
        try {
          ctx.inlineMath(n.tex, r);
        } catch {
          r.textContent = n.tex;
        }
      } else r.textContent = n.tex;
      w.append(r);
      parent.appendChild(w);
      return s + n.raw.length;
    }
  }
}

function wrap(tag: string, s: number, e: number): HTMLElement {
  const w = el('span', 'md-wrap md-' + tag);
  w.dataset.s = String(s);
  w.dataset.e = String(e);
  return w;
}

function ns(tag: string, cls: string, text?: string): HTMLElement {
  const e = el(tag, cls, text);
  e.setAttribute('data-ns', '');
  e.contentEditable = 'false';
  return e;
}

/** Toggle `md-expand` on inline wraps containing source offset `off` (null = none). */
export function expandAt(host: HTMLElement, off: number | null): void {
  host.querySelectorAll<HTMLElement>('.md-wrap').forEach((w) => {
    const on = off !== null && +w.dataset.s! <= off && off <= +w.dataset.e!;
    w.classList.toggle('md-expand', on);
  });
}

/** Attributes of a lone `<img …>` tag (safe subset), or null. */
function htmlImage(tag: string): { src: string; alt: string; title?: string; width?: string; height?: string; style?: string } | null {
  const m = /^<img\b([^>]*?)\/?>$/i.exec(tag);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
    let v = a[2] ?? '';
    if (/^["']/.test(v)) v = v.slice(1, -1);
    attrs[a[1].toLowerCase()] = v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  if (attrs.src === undefined || /^\s*javascript:/i.test(attrs.src)) return null;
  const style = (attrs.style ?? '')
    .split(';')
    .filter((d) => /^\s*(zoom|width|height|max-width|max-height)\s*:\s*[\w.%\s-]+$/i.test(d))
    .join(';');
  return { src: attrs.src, alt: attrs.alt ?? '', title: attrs.title, width: attrs.width, height: attrs.height, style: style || undefined };
}

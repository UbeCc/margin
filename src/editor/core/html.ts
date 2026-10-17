/**
 * Static HTML rendering of the document (export / copy): proper nesting of
 * lists and quotes, headings with `id = block id`, widgets via their
 * `renderHTML()` (or an escaped `<pre>` when not mounted).
 */
import type { Doc } from './model';
import { leafContent, widgetRaw } from './model';
import type { Container, Leaf } from './types';
import { parseInline, type INode } from './parser/inline';
import { splitBlockMeta, type InlineCtx } from './render-inline';

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const TAG: Record<string, string> = { em: 'em', strong: 'strong', del: 'del', mark: 'mark', code: 'code' };

function safeHref(h: string): string {
  return /^\s*javascript:/i.test(h) ? '#' : h;
}

export function inlineHTML(nodes: INode[], ctx: InlineCtx): string {
  let s = '';
  for (const n of nodes) {
    switch (n.k) {
      case 'text':
        s += esc(n.v).replace(/\n/g, '\n');
        break;
      case 'meta':
        break;
      case 'br':
        s += '<br>';
        break;
      case 'html':
        s += n.v;
        break;
      case 'entity':
        s += esc(n.ch);
        break;
      case 'image':
        s += `<img src="${esc(ctx.resolveAsset(n.src))}" alt="${esc(n.alt)}"${n.title ? ` title="${esc(n.title)}"` : ''}>`;
        break;
      case 'math': {
        if (ctx.inlineMath && typeof document !== 'undefined') {
          const e = document.createElement('span');
          try {
            ctx.inlineMath(n.tex, e);
            s += e.outerHTML;
            break;
          } catch {
            /* fall through */
          }
        }
        s += `<span class="md-math">${esc(n.tex)}</span>`;
        break;
      }
      case 'wrap': {
        const inner = inlineHTML(n.ch, ctx);
        if (n.tag === 'link') s += `<a href="${esc(safeHref(n.href ?? ''))}"${n.title ? ` title="${esc(n.title)}"` : ''}>${inner}</a>`;
        else if (n.tag === 'fnref') s += `<sup class="md-fnref">${inner}</sup>`;
        else s += `<${TAG[n.tag]}>${inner}</${TAG[n.tag]}>`;
        break;
      }
    }
  }
  return s;
}

function leafHTML(l: Leaf, ctx: InlineCtx, widgetHTML: (l: Leaf) => string | null): string {
  const c = leafContent(l);
  switch (l.type) {
    case 'paragraph':
      return c.trim() ? `<p>${inlineHTML(parseInline(c.replace(/^[ \t]+/gm, ''), ctx.refs), ctx)}</p>` : '';
    case 'heading': {
      const body = splitBlockMeta(l, c)[1].trim();
      return `<h${l.level} id="${esc(l.id)}">${inlineHTML(parseInline(body, ctx.refs), ctx)}</h${l.level}>`;
    }
    case 'hr':
      return '<hr>';
    case 'indented_code':
      return `<pre><code>${esc(c.replace(/^(?: {4}|\t)/gm, ''))}</code></pre>`;
    case 'def':
      return '';
    case 'footnote': {
      const [pre, body] = splitBlockMeta(l, c);
      return `<div class="md-footnote"><sup>${esc(pre.replace(/[[\]^:\s]/g, ''))}</sup> ${inlineHTML(parseInline(body, ctx.refs), ctx)}</div>`;
    }
    default: {
      const h = widgetHTML(l);
      return h ?? `<pre><code>${esc(widgetRaw(l))}</code></pre>`;
    }
  }
}

/** Render leaves [from, to) with container nesting. */
export function docHTML(doc: Doc, ctx: InlineCtx, widgetHTML: (l: Leaf) => string | null, from = 0, to = doc.leaves.length): string {
  const out: string[] = [];
  const open: Container[] = [];
  const close = (c: Container, lastOfList: boolean) => {
    if (c.kind === 'quote') out.push('</blockquote>');
    else out.push(lastOfList ? `</li></${c.ordered ? 'ol' : 'ul'}>` : '</li>');
  };
  for (let i = from; i < to; i++) {
    const l = doc.leaves[i];
    // common prefix of open containers that continue on this leaf
    let k = 0;
    while (k < open.length && k < l.chain.length && open[k].key === l.chain[k].key && k < l.openFrom) k++;
    for (let j = open.length - 1; j >= k; j--) {
      const c = open[j];
      const nc = l.chain[j];
      const sameList = c.kind === 'item' && nc?.kind === 'item' && nc.listKey === c.listKey && j === k;
      close(c, !sameList);
    }
    open.length = k;
    for (let j = k; j < l.chain.length; j++) {
      const c = l.chain[j];
      if (c.kind === 'quote') out.push('<blockquote>');
      else {
        const prevSame = i > from && doc.leaves[i - 1].chain.some((x) => x.kind === 'item' && x.listKey === c.listKey && x.key !== c.key);
        if (!prevSame) {
          const tag = c.ordered ? 'ol' : 'ul';
          out.push(`<${tag}${c.ordered && c.start !== 1 ? ` start="${c.start}"` : ''}${c.task !== null ? ' class="contains-task-list"' : ''}>`);
        }
        out.push(c.task !== null ? `<li class="task-list-item"><input type="checkbox" disabled${c.task !== ' ' ? ' checked' : ''}> ` : '<li>');
      }
      open.push(c);
    }
    out.push(leafHTML(l, ctx, widgetHTML));
  }
  for (let j = open.length - 1; j >= 0; j--) close(open[j], true);
  return out.join('\n');
}

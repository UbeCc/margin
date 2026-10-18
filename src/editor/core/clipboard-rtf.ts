/**
 * Small HTML → RTF converter for rich copy (#79). Input is the clean semantic
 * HTML produced by `docHTML` (paragraphs, headings, lists, quotes, code,
 * tables, links); anything unknown degrades to its text content. Output is a
 * self-contained RTF 1 document (ANSI header, non-ASCII as `\uN?`).
 */

const HEADING_SIZE: Record<string, number> = { h1: 48, h2: 40, h3: 32, h4: 28, h5: 24, h6: 24 }; // half-points
const BODY_SIZE = 24;
const INDENT = 360; // twips per nesting level

/** Escape text for RTF: `\ { }`, newlines dropped, non-ASCII as signed 16-bit `\uN?` per UTF-16 unit. */
export function rtfEscape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c || c === 0x7b || c === 0x7d) out += '\\' + s[i];
    else if (c === 0x09) out += '\\tab ';
    else if (c === 0x0a || c === 0x0d) out += ' ';
    else if (c < 0x20) continue;
    else if (c < 0x80) out += s[i];
    else out += `\\u${c > 0x7fff ? c - 0x10000 : c}?`;
  }
  return out;
}

interface Ctx {
  indent: number; // nesting level for lists / quotes
  pre: boolean;
}

type Parts = string[];

function inline(node: Node, ctx: Ctx, out: Parts): void {
  if (node.nodeType === 3) {
    const t = node.nodeValue ?? '';
    if (ctx.pre) out.push(t.split('\n').map(rtfEscape).join('\\line '));
    else out.push(rtfEscape(t.replace(/\s+/g, ' ')));
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const kids = (c: Ctx = ctx) => el.childNodes.forEach((n) => inline(n, c, out));
  const wrap = (open: string) => {
    out.push(`{${open} `);
    kids();
    out.push('}');
  };
  switch (tag) {
    case 'strong':
    case 'b':
      return wrap('\\b');
    case 'em':
    case 'i':
      return wrap('\\i');
    case 'u':
      return wrap('\\ul');
    case 'del':
    case 's':
    case 'strike':
      return wrap('\\strike');
    case 'mark':
      return wrap('\\highlight2');
    case 'sup':
      return wrap('\\super');
    case 'sub':
      return wrap('\\sub');
    case 'code':
    case 'kbd':
    case 'samp':
      return wrap('\\f1');
    case 'br':
      out.push('\\line ');
      return;
    case 'img': {
      const alt = el.getAttribute('alt');
      if (alt) out.push(rtfEscape(alt));
      return;
    }
    case 'a': {
      const href = el.getAttribute('href');
      if (!href || href === '#') return kids();
      const url = href.replace(/["\\{}]/g, (c) => (c === '"' ? '%22' : '\\' + c));
      out.push(`{\\field{\\*\\fldinst{HYPERLINK "${rtfEscape(url)}"}}{\\fldrslt{\\ul\\cf1 `);
      kids();
      out.push('}}}');
      return;
    }
    case 'script':
    case 'style':
    case 'template':
      return;
    default:
      return kids();
  }
}

function para(fmt: string, body: string): string {
  return `{\\pard\\plain\\f0\\fs${BODY_SIZE}${fmt} ${body}\\par}\n`;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'div', 'section', 'figure', 'details', 'dl']);

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()));
}

function inlineOf(nodes: Node[], ctx: Ctx): string {
  const out: Parts = [];
  for (const n of nodes) inline(n, ctx, out);
  return out.join('').trim();
}

function indentFmt(level: number, hanging = 0): string {
  return level || hanging ? `\\li${level * INDENT + hanging}\\fi-${hanging}` : '';
}

function block(el: Element, ctx: Ctx, out: Parts): void {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      out.push(para(`${indentFmt(ctx.indent)}\\sb240\\sa120\\b\\fs${HEADING_SIZE[tag]}`, inlineOf([...el.childNodes], ctx)));
      return;
    case 'p':
      out.push(para(`${indentFmt(ctx.indent)}\\sa120`, inlineOf([...el.childNodes], ctx)));
      return;
    case 'pre':
      out.push(para(`${indentFmt(ctx.indent)}\\sa120\\f1\\fs20`, inlineOf([...el.childNodes], { ...ctx, pre: true })));
      return;
    case 'hr':
      out.push(para('\\qc\\sa120', '\\u8212?\\u8212?\\u8212?'));
      return;
    case 'blockquote':
      blocks(el, { ...ctx, indent: ctx.indent + 1 }, out);
      return;
    case 'ul':
    case 'ol': {
      const start = Number(el.getAttribute('start') ?? 1) || 1;
      let n = start;
      for (const li of Array.from(el.children)) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const box = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
        const mark = box ? ((box as HTMLInputElement).hasAttribute('checked') ? '\\u9745?' : '\\u9744?') : tag === 'ol' ? `${n}.` : '\\u8226?';
        n++;
        listItem(li, mark, ctx, out);
      }
      return;
    }
    case 'table':
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        const cells = Array.from(tr.children).map((c) => inlineOf([...c.childNodes], ctx));
        const head = tr.parentElement?.tagName.toLowerCase() === 'thead' || tr.querySelector('th') !== null;
        out.push(para(`${indentFmt(ctx.indent)}${head ? '\\b' : ''}`, cells.join('\\tab ')));
      }
      return;
    default:
      if (hasBlockChild(el)) blocks(el, ctx, out);
      else {
        const body = inlineOf([...el.childNodes], ctx);
        if (body) out.push(para(`${indentFmt(ctx.indent)}\\sa120`, body));
      }
  }
}

function listItem(li: Element, mark: string, ctx: Ctx, out: Parts): void {
  const inner = { ...ctx, indent: ctx.indent + 1 };
  const fmt = `${indentFmt(ctx.indent, INDENT)}\\sa60`;
  const lead: Node[] = [];
  const rest: Element[] = [];
  for (const n of Array.from(li.childNodes)) {
    if (n.nodeType === 1 && (n as Element).tagName.toLowerCase() === 'input') continue;
    if (rest.length || (n.nodeType === 1 && BLOCK_TAGS.has((n as Element).tagName.toLowerCase()))) {
      if (n.nodeType === 1) rest.push(n as Element);
    } else lead.push(n);
  }
  // a loose item's first paragraph becomes the marker line
  if (!inlineOf(lead, ctx) && rest[0]?.tagName.toLowerCase() === 'p') lead.push(...Array.from(rest.shift()!.childNodes).filter((n) => !(n.nodeType === 1 && (n as Element).tagName.toLowerCase() === 'input')));
  out.push(para(fmt, `${mark}\\tab ${inlineOf(lead, ctx)}`));
  for (const b of rest) block(b, inner, out);
}

function blocks(parent: Element, ctx: Ctx, out: Parts): void {
  let run: Node[] = [];
  const flush = () => {
    const body = inlineOf(run, ctx);
    if (body) out.push(para(`${indentFmt(ctx.indent)}\\sa120`, body));
    run = [];
  };
  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === 1 && BLOCK_TAGS.has((n as Element).tagName.toLowerCase())) {
      flush();
      block(n as Element, ctx, out);
    } else run.push(n);
  }
  flush();
}

const HEADER =
  '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1' +
  '{\\fonttbl{\\f0\\fswiss Helvetica;}{\\f1\\fmodern Menlo;}}' +
  '{\\colortbl;\\red9\\green105\\blue218;\\red255\\green240\\blue120;}\n';

/** Convert an HTML fragment to an RTF document. Requires `DOMParser` (browser / jsdom). */
export function htmlToRtf(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out: Parts = [];
  blocks(doc.body, { indent: 0, pre: false }, out);
  return HEADER + out.join('') + '}';
}

/**
 * Inline parser. Produces a tree whose leaves concatenate back to the exact
 * source (`inlineSource(parseInline(s)) === s`): syntax characters are `meta`
 * nodes, everything else `text`.
 */

export type WrapTag = 'em' | 'strong' | 'del' | 'mark' | 'code' | 'link' | 'fnref' | 'u' | 'sub' | 'sup';

import { syntaxOptions as OPT, EMOJI, remapOn } from './options';

export type INode =
  | { k: 'text'; v: string }
  | { k: 'meta'; v: string }
  | { k: 'wrap'; tag: WrapTag; href?: string; title?: string; ch: INode[] }
  | { k: 'image'; raw: string; src: string; alt: string; title?: string }
  | { k: 'math'; raw: string; tex: string }
  | { k: 'html'; v: string }
  | { k: 'br'; v: string }
  | { k: 'entity'; v: string; ch: string };

interface Delim {
  k: 'delim';
  ch: string;
  n: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
}

type Item = INode | Delim;

export type RefMap = ReadonlyMap<string, { href: string; title?: string }>;

export const normLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

const meta = (v: string): INode => ({ k: 'meta', v });

export function decodeEntity(v: string): string {
  const m = /^&#(?:[xX]([0-9a-fA-F]+)|(\d+));$/.exec(v);
  if (m) {
    const cp = m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10);
    try { return String.fromCodePoint(cp || 0xfffd); } catch { return '�'; }
  }
  if (typeof document !== 'undefined') {
    const t = document.createElement('textarea');
    t.innerHTML = v;
    return t.value;
  }
  return v;
}

/** Index of the `]` matching the `[` at `i`, or -1. */
function matchBracket(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(j))![0];
      const close = s.indexOf(run, j + run.length);
      if (close > 0) j = close + run.length - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

/** #133 remap: opening curly quote → its closing partner (link titles). */
const CURLY_TITLE_CLOSE: Record<string, string> = { '‘': '’', '“': '”', '’': '’', '”': '”' };
/** Parse `(dest "title")` at s[i] === '('. Returns end index (exclusive) or -1. */
function parseDest(s: string, i: number): { end: number; href: string; title?: string } | null {
  let j = i + 1;
  const skip = () => { while (j < s.length && /[ \t\n]/.test(s[j])) j++; };
  skip();
  let href = '';
  if (s[j] === '<') {
    const e = s.indexOf('>', j);
    if (e < 0 || s.slice(j, e).includes('\n')) return null;
    href = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let depth = 0;
    const st = j;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      j++;
    }
    href = s.slice(st, j);
  }
  const beforeTitle = j;
  skip();
  let title: string | undefined;
  const q = s[j];
  const close = q === '(' ? ')' : remapOn() ? CURLY_TITLE_CLOSE[q] : undefined;
  if ((q === '"' || q === "'" || q === '(' || close) && j > beforeTitle) {
    const end = close ?? q;
    let e = j + 1;
    while (e < s.length && s[e] !== end) e += s[e] === '\\' ? 2 : 1;
    if (e >= s.length) return null;
    title = s.slice(j + 1, e);
    j = e + 1;
    skip();
  }
  if (s[j] !== ')') return null;
  return { end: j + 1, href: href.replace(/\\([!-/:-@[-`{-~])/g, '$1'), title };
}

/** [start, end) of the `</tag>` closing the `<tag>` opened before `from` (same-tag nesting counted), or null. */
function matchTag(s: string, from: number, tag: string): [number, number] | null {
  const re = new RegExp(`<(/?)${tag}>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    depth += m[1] ? -1 : 1;
    if (!depth) return [m.index, m.index + m[0].length];
  }
  return null;
}

export function parseInline(s: string, refs: RefMap = new Map()): INode[] {
  const items: Item[] = [];
  let buf = '';
  const flush = () => { if (buf) { items.push({ k: 'text', v: buf }); buf = ''; } };
  const put = (n: Item) => { flush(); items.push(n); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === '\\') {
      if (s[i + 1] === '\n') { put({ k: 'br', v: '\\' }); buf += '\n'; i += 2; continue; }
      if (i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { put(meta('\\')); buf += s[i + 1]; i += 2; continue; }
    } else if (c === '`') {
      const run = /^`+/.exec(rest)![0];
      let close = -1;
      for (let j = i + run.length; j < s.length; ) {
        if (s[j] !== '`') { j++; continue; }
        let e = j;
        while (s[e] === '`') e++;
        if (e - j === run.length) { close = j; break; }
        j = e;
      }
      if (close >= 0) {
        put({ k: 'wrap', tag: 'code', ch: [meta(run), { k: 'text', v: s.slice(i + run.length, close) }, meta(run)] });
        i = close + run.length;
        continue;
      }
      buf += run; i += run.length; continue;
    } else if (c === '$' && OPT.inlineMath && s[i + 1] !== '$' && s[i - 1] !== '$') {
      const m = /^\$([^\s$](?:[^$\\]|\\.)*?)\$(?!\d)/.exec(rest);
      if (m && !/\s$/.test(m[1])) {
        put({ k: 'math', raw: m[0], tex: m[1] });
        i += m[0].length;
        continue;
      }
    } else if (c === '<') {
      // paired formatting tags written by Format › Underline / Superscript / Subscript
      const ft = /^<(u|sub|sup)>/i.exec(rest);
      const fe = ft ? matchTag(s, i + ft[0].length, ft[1]) : null;
      if (ft && fe) {
        put({ k: 'wrap', tag: ft[1].toLowerCase() as WrapTag, ch: [meta(ft[0]), ...parseInline(s.slice(i + ft[0].length, fe[0]), refs), meta(s.slice(fe[0], fe[1]))] });
        i = fe[1];
        continue;
      }
      const a = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*)>/.exec(rest);
      if (a) {
        const href = a[1].includes(':') ? a[1] : 'mailto:' + a[1];
        put({ k: 'wrap', tag: 'link', href, ch: [meta('<'), { k: 'text', v: a[1] }, meta('>')] });
        i += a[0].length; continue;
      }
      const h = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!--[\s\S]*?-->)/.exec(rest);
      if (h) { put({ k: 'html', v: h[0] }); i += h[0].length; continue; }
    } else if (c === '&') {
      const m = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(rest);
      if (m) {
        const ch = decodeEntity(m[0]);
        if (ch !== m[0]) { put({ k: 'entity', v: m[0], ch }); i += m[0].length; continue; }
      }
    } else if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const img = c === '!';
      const b = img ? i + 1 : i;
      const fn = !img && /^\[\^([^\]\s]+)\]/.exec(rest);
      if (fn) {
        put({ k: 'wrap', tag: 'fnref', href: '#fn-' + fn[1], ch: [meta('[^'), { k: 'text', v: fn[1] }, meta(']')] });
        i += fn[0].length; continue;
      }
      const e = matchBracket(s, b);
      if (e > 0) {
        const label = s.slice(b + 1, e);
        let end = -1;
        let href = '';
        let title: string | undefined;
        if (s[e + 1] === '(') {
          const d = parseDest(s, e + 1);
          if (d) ({ end, href, title } = d);
        }
        if (end < 0) {
          const full = /^\[((?:[^\]\\]|\\.)*)\]/.exec(s.slice(e + 1));
          const key = normLabel(full && full[1] ? full[1] : label);
          const ref = refs.get(key);
          if (ref) { end = full ? e + 1 + full[0].length : e + 1; href = ref.href; title = ref.title; }
        }
        if (end > 0) {
          const raw = s.slice(i, end);
          if (img) put({ k: 'image', raw, src: href, alt: label, title });
          else put({ k: 'wrap', tag: 'link', href, title, ch: [meta('['), ...parseInline(label, refs), meta(s.slice(e, end))] });
          i = end; continue;
        }
      }
    } else if (c === ' ' && /^ {2,}\n/.test(rest)) {
      const m = /^ {2,}/.exec(rest)![0];
      put({ k: 'br', v: m }); buf += '\n'; i += m.length + 1; continue;
    } else if (c === ':' && OPT.emoji && /^:[\w+-]+:/.test(rest)) {
      const m = /^:([\w+-]+):/.exec(rest)!;
      const ch = EMOJI[m[1]];
      if (ch) { put({ k: 'entity', v: m[0], ch }); i += m[0].length; continue; }
    } else if (c === '*' || c === '_' || c === '~' || (c === '=' && OPT.highlight) || (c === '^' && OPT.superscript)) {
      const run = new RegExp('^\\' + c + '+').exec(rest)![0];
      const n = run.length;
      if ((c === '=' && n !== 2) || (c === '~' && n > 2) || (c === '^' && n !== 1)) { buf += run; i += n; continue; }
      const prev = i > 0 ? s[i - 1] : ' ';
      const next = i + n < s.length ? s[i + n] : ' ';
      const left = !WS.test(next) && (!PUNCT.test(next) || WS.test(prev) || PUNCT.test(prev));
      const right = !WS.test(prev) && (!PUNCT.test(prev) || WS.test(next) || PUNCT.test(next));
      const canOpen = c === '_' ? left && (!right || PUNCT.test(prev)) : left;
      const canClose = c === '_' ? right && (!left || PUNCT.test(next)) : right;
      put({ k: 'delim', ch: c, n, orig: n, canOpen, canClose });
      i += n; continue;
    } else if ((c === 'h' || c === 'w') && (i === 0 || !/[\w/]/.test(s[i - 1]))) {
      const m = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:*_~'")\]]/.exec(rest);
      if (m) {
        const href = m[0].startsWith('www.') ? 'http://' + m[0] : m[0];
        put({ k: 'wrap', tag: 'link', href, ch: [meta(''), { k: 'text', v: m[0] }, meta('')] });
        i += m[0].length; continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  processEmphasis(items);
  return finalize(items);
}

function processEmphasis(items: Item[]): void {
  for (let ci = 0; ci < items.length; ci++) {
    const c = items[ci];
    if (c.k !== 'delim' || !c.canClose || c.n === 0) continue;
    let found = -1;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const o = items[oi];
      if (o.k !== 'delim' || o.ch !== c.ch || !o.canOpen || o.n === 0) continue;
      if ((c.ch === '*' || c.ch === '_') && (o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && (o.orig % 3 !== 0 || c.orig % 3 !== 0)) continue;
      if ((c.ch === '~' || c.ch === '^') && o.n !== c.n) continue;
      found = oi;
      break;
    }
    if (found < 0) continue;
    const o = items[found] as Delim;
    const use = c.ch === '~' || c.ch === '^' ? c.n : c.ch === '=' ? 2 : o.n >= 2 && c.n >= 2 ? 2 : 1;
    const tag: WrapTag =
      c.ch === '~' ? (use === 1 && OPT.subscript ? 'sub' : 'del') : c.ch === '^' ? 'sup' : c.ch === '=' ? 'mark' : use === 2 ? 'strong' : 'em';
    o.n -= use;
    c.n -= use;
    const mk = c.ch.repeat(use);
    const node: INode = { k: 'wrap', tag, ch: [meta(mk), ...finalize(items.slice(found + 1, ci)), meta(mk)] };
    items.splice(found + 1, ci - found - 1, node);
    ci = c.n > 0 ? found + 1 : found + 2;
  }
}

function finalize(items: Item[]): INode[] {
  const out: INode[] = [];
  for (const it of items) {
    const n: INode = it.k === 'delim' ? { k: 'text', v: it.ch.repeat(it.n) } : it;
    if (n.k === 'text') {
      if (!n.v) continue;
      const prev = out[out.length - 1];
      if (prev && prev.k === 'text') { out[out.length - 1] = { k: 'text', v: prev.v + n.v }; continue; }
    }
    out.push(n);
  }
  return out;
}

/** Concatenated source of an inline tree (must equal the parsed input). */
export function inlineSource(nodes: INode[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.k === 'wrap') s += inlineSource(n.ch);
    else if (n.k === 'image' || n.k === 'math') s += n.raw;
    else s += n.v;
  }
  return s;
}

/** Plain text (markers stripped) of an inline tree. */
export function inlinePlain(nodes: INode[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.k === 'text') s += n.v;
    else if (n.k === 'wrap') s += inlinePlain(n.ch);
    else if (n.k === 'image') s += n.alt;
    else if (n.k === 'math') s += n.tex;
    else if (n.k === 'entity') s += n.ch;
    else if (n.k === 'br') s += '';
  }
  return s;
}

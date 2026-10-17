/**
 * Clipboard HTML → Markdown (paste). Small and forgiving: headings, paragraphs,
 * emphasis, code, links, images, lists (nested, tasks), quotes, pre, hr, tables.
 * Knows the quirks of Google Docs (styled spans, a `<b style="font-weight:normal">`
 * wrapper around everything) and Word (`MsoListParagraph` pseudo lists).
 */

const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|MAIN|NAV|ASIDE|DL|DT|DD)$/;

const isBlockEl = (n: Node): n is HTMLElement => n.nodeType === 1 && BLOCK.test((n as Element).tagName);
/** Inline element that (wrongly but commonly) wraps block content, e.g. the Google Docs `<b>`. */
const hasBlockChild = (e: Element): boolean => Array.from(e.children).some((c) => BLOCK.test(c.tagName) || hasBlockChild(c));
const isWordList = (e: Element) => /MsoListParagraph/i.test(e.getAttribute('class') ?? '') || /mso-list:\s*l\d/i.test(e.getAttribute('style') ?? '');
const ignored = (e: Element) => /mso-list:\s*Ignore/i.test(e.getAttribute('style') ?? '');

function inline(n: Node): string {
  let s = '';
  n.childNodes.forEach((c) => (s += inl(c)));
  return s;
}

function wrapMark(m: string, inner: string): string {
  const t = inner.trim();
  if (!t) return inner;
  const lead = inner.slice(0, inner.indexOf(t[0]));
  const tail = inner.slice(inner.lastIndexOf(t[t.length - 1]) + 1);
  return lead + m + t + m + tail;
}

/** Emphasis expressed through inline styles (Google Docs, many web editors). */
function styled(e: HTMLElement, inner: string): string {
  const st = e.style;
  if (!st) return inner;
  const w = st.fontWeight;
  if (w === 'bold' || w === 'bolder' || Number(w) >= 600) inner = wrapMark('**', inner);
  if (st.fontStyle === 'italic') inner = wrapMark('*', inner);
  if (/line-through/.test(st.textDecoration || st.textDecorationLine || '')) inner = wrapMark('~~', inner);
  return inner;
}

function inl(n: Node): string {
  if (n.nodeType === 3) return (n as Text).data.replace(/\s+/g, ' ');
  if (n.nodeType !== 1) return '';
  const e = n as HTMLElement;
  const tag = e.tagName;
  if (e.style?.display === 'none' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TITLE' || tag === 'META' || ignored(e)) return '';
  if (BLOCK.test(tag) || hasBlockChild(e)) return blocks(e).trim();
  switch (tag) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B': {
      const w = e.style?.fontWeight;
      // Google Docs wraps the whole fragment in <b style="font-weight:normal">
      return w && (w === 'normal' || Number(w) < 600) ? styled(e, inline(e)) : wrapMark('**', inline(e));
    }
    case 'EM':
    case 'I':
      return wrapMark('*', inline(e));
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrapMark('~~', inline(e));
    case 'MARK':
      return wrapMark('==', inline(e));
    case 'CODE': {
      const t = e.textContent ?? '';
      const fence = t.includes('`') ? '`` ' : '`';
      return fence + t + fence.split('').reverse().join('');
    }
    case 'A': {
      const href = e.getAttribute('href') ?? '';
      const t = inline(e).trim();
      return href ? `[${t || href}](${href.replace(/ /g, '%20').replace(/\)/g, '%29')})` : t;
    }
    case 'IMG':
      return `![${e.getAttribute('alt') ?? ''}](${(e.getAttribute('src') ?? '').replace(/ /g, '%20')})`;
    default:
      return styled(e, inline(e));
  }
}

function prefixLines(s: string, first: string, rest: string): string {
  return s
    .split('\n')
    .map((l, i) => (i === 0 ? first : l ? rest : rest.trimEnd()) + l)
    .join('\n');
}

const LIST_START = /\n\n(?=(?:[-*+]|\d{1,9}[.)]) )/g;

function list(e: HTMLElement): string {
  const ordered = e.tagName === 'OL';
  let n = Number(e.getAttribute('start') ?? 1) || 1;
  const items: string[] = [];
  for (const li of Array.from(e.children)) {
    if (li.tagName !== 'LI') continue;
    const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]') as HTMLInputElement | null;
    let body = blocks(li).trim();
    // a single-paragraph item followed by a nested list stays tight
    if (li.querySelectorAll(':scope > p').length <= 1) body = body.replace(LIST_START, '\n');
    if (box) body = (box.checked ? '[x] ' : '[ ] ') + body.replace(/^\s+/, '');
    const mk = ordered ? `${n++}. ` : '- ';
    items.push(prefixLines(body, mk, ' '.repeat(mk.length)));
  }
  return items.join('\n');
}

function table(e: HTMLElement): string {
  const rows = Array.from(e.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children).map((c) => blocks(c).trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')),
  );
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(line)].join('\n');
}

/** A run of Word `MsoListParagraph` paragraphs → markdown list lines. */
function wordList(ps: HTMLElement[]): string {
  return ps
    .map((p) => {
      const marker = Array.from(p.querySelectorAll('span'))
        .filter(ignored)
        .map((s) => s.textContent ?? '')
        .join('')
        .trim();
      const level = Number(/level(\d+)/.exec(p.getAttribute('style') ?? '')?.[1] ?? 1);
      const ord = /^[0-9a-zA-Z]{1,4}[.)]$/.test(marker);
      return '   '.repeat(Math.max(0, level - 1)) + (ord ? '1. ' : '- ') + inline(p).trim();
    })
    .join('\n');
}

function blocks(root: Node): string {
  const out: string[] = [];
  let buf = '';
  let wl: HTMLElement[] = [];
  const flush = () => {
    const t = buf.replace(/[ \t]+\n/g, '\n').trim();
    if (t) out.push(t);
    buf = '';
    if (wl.length) out.push(wordList(wl));
    wl = [];
  };
  root.childNodes.forEach((c) => {
    if (c.nodeType === 1 && isWordList(c as Element)) {
      if (buf.trim()) flush();
      buf = '';
      wl.push(c as HTMLElement);
      return;
    }
    if (wl.length && (c.nodeType === 8 || (c.nodeType === 3 && !(c as Text).data.trim()))) return;
    if (isBlockEl(c) || (c.nodeType === 1 && hasBlockChild(c as Element))) {
      flush();
      const e = c as HTMLElement;
      const tag = e.tagName;
      if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ' + inline(e).trim().replace(/\n/g, ' '));
      else if (tag === 'UL' || tag === 'OL') out.push(list(e));
      else if (tag === 'BLOCKQUOTE') out.push(prefixLines(blocks(e).trim(), '> ', '> '));
      else if (tag === 'PRE') {
        const lang = /language-([\w+-]+)/.exec(e.querySelector('code')?.className ?? '')?.[1] ?? '';
        out.push('```' + lang + '\n' + (e.textContent ?? '').replace(/\n$/, '') + '\n```');
      } else if (tag === 'HR') out.push('---');
      else if (tag === 'TABLE') out.push(table(e));
      else {
        const t = blocks(e).trim();
        if (t) out.push(t);
      }
    } else buf += inl(c);
  });
  flush();
  return out.join('\n\n');
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return blocks(doc.body).replace(/\n{3,}/g, '\n\n');
}

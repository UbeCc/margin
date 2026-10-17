/**
 * Clipboard HTML → Markdown (paste). Small and forgiving: headings, paragraphs,
 * emphasis, code, links, images, lists (nested, tasks), quotes, pre, hr, tables.
 */

const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|MAIN)$/;

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

function inl(n: Node): string {
  if (n.nodeType === 3) return (n as Text).data.replace(/\s+/g, ' ');
  if (n.nodeType !== 1) return '';
  const e = n as HTMLElement;
  const tag = e.tagName;
  if (e.style?.display === 'none' || tag === 'STYLE' || tag === 'SCRIPT') return '';
  switch (tag) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return wrapMark('**', inline(e));
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
      return href ? `[${t || href}](${href.replace(/ /g, '%20')})` : t;
    }
    case 'IMG':
      return `![${e.getAttribute('alt') ?? ''}](${(e.getAttribute('src') ?? '').replace(/ /g, '%20')})`;
    default:
      return BLOCK.test(tag) ? blocks(e).trim() : inline(e);
  }
}

function prefixLines(s: string, first: string, rest: string): string {
  return s
    .split('\n')
    .map((l, i) => (i === 0 ? first : l ? rest : rest.trimEnd()) + l)
    .join('\n');
}

function list(e: HTMLElement): string {
  const ordered = e.tagName === 'OL';
  let n = Number(e.getAttribute('start') ?? 1) || 1;
  const items: string[] = [];
  for (const li of Array.from(e.children)) {
    if (li.tagName !== 'LI') continue;
    const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]') as HTMLInputElement | null;
    let body = blocks(li).trim();
    if (box) body = (box.checked ? '[x] ' : '[ ] ') + body.replace(/^\s+/, '');
    const mk = ordered ? `${n++}. ` : '- ';
    items.push(prefixLines(body, mk, ' '.repeat(mk.length)));
  }
  return items.join('\n');
}

function table(e: HTMLElement): string {
  const rows = Array.from(e.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children).map((c) => inline(c).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')),
  );
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(line)].join('\n');
}

function blocks(root: Node): string {
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.replace(/[ \t]+\n/g, '\n').trim();
    if (t) out.push(t);
    buf = '';
  };
  root.childNodes.forEach((c) => {
    if (c.nodeType === 1 && BLOCK.test((c as Element).tagName)) {
      flush();
      const e = c as HTMLElement;
      const tag = e.tagName;
      if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ' + inline(e).trim());
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

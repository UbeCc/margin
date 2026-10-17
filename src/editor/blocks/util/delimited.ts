/**
 * Lossless "envelope" parsing for delimited raw blocks (code fences, `$$` math,
 * `---` front matter, HTML blocks).
 *
 *   raw === head + body' + sep + tail
 *
 * where body' is `body` with the block indent re-applied and `sep` is "\n" when the
 * block has a closing line and body is non-empty. Widgets edit only `body`;
 * `buildRaw(parts, body)` returns `parts.raw` verbatim when body is unchanged.
 */

export interface Envelope {
  /** Exact original raw source. */
  raw: string;
  /** Everything up to and including the opening line's newline. */
  head: string;
  /** Editable content, with the block indent stripped from each line. */
  body: string;
  /** Closing delimiter line + anything after (trailing blank lines). */
  tail: string;
  /** True if the block has a closing delimiter line. */
  closed: boolean;
  /** Indent (spaces) of the opening line, removed from content lines. */
  indent: string;
}

export interface FenceParts extends Envelope {
  /** "`" or "~" */
  char: '`' | '~';
  /** Fence length (>= 3). */
  length: number;
  /** Info string exactly as written after the fence (may have leading spaces). */
  info: string;
  /** First word of the info string, lowercased ('' when absent). */
  lang: string;
}

function stripIndent(line: string, indent: number): string {
  let i = 0;
  while (i < indent && i < line.length && line[i] === ' ') i++;
  return line.slice(i);
}

function addIndent(body: string, indent: string): string {
  if (!indent) return body;
  return body
    .split('\n')
    .map((l) => (l.length ? indent + l : l))
    .join('\n');
}

/** Line start offsets of `raw` (always includes 0). */
function lineStarts(raw: string): number[] {
  const out = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') out.push(i + 1);
  return out;
}

function lineAt(raw: string, starts: number[], i: number): string {
  const s = starts[i];
  const e = i + 1 < starts.length ? starts[i + 1] - 1 : raw.length;
  return raw.slice(s, e);
}

/**
 * Generic envelope parse. `isClose(line)` decides the closing line (searched from the
 * second line). Content between is the body.
 */
export function parseEnvelope(raw: string, indent: string, isClose: ((line: string) => boolean) | null): Envelope {
  const starts = lineStarts(raw);
  const firstNl = raw.indexOf('\n');
  const head = firstNl < 0 ? raw : raw.slice(0, firstNl + 1);
  const bodyStart = head.length;
  let closeLine = -1;
  if (isClose && firstNl >= 0) {
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] >= raw.length && i === starts.length - 1) break; // virtual empty last line
      if (isClose(lineAt(raw, starts, i))) {
        closeLine = i;
        break;
      }
    }
  }
  let bodyRaw: string;
  let tail: string;
  if (closeLine >= 0) {
    const cs = starts[closeLine];
    bodyRaw = cs > bodyStart ? raw.slice(bodyStart, cs - 1) : '';
    tail = raw.slice(cs);
  } else {
    bodyRaw = raw.slice(bodyStart);
    tail = '';
    // Unclosed block: trailing newline(s) are the block terminator, not content.
    const m = /\n*$/.exec(bodyRaw);
    if (m && m[0]) {
      tail = m[0];
      bodyRaw = bodyRaw.slice(0, bodyRaw.length - m[0].length);
    }
  }
  const n = indent.length;
  const body = n ? bodyRaw.split('\n').map((l) => stripIndent(l, n)).join('\n') : bodyRaw;
  return { raw, head, body, tail, closed: closeLine >= 0, indent };
}

/** Rebuild raw source for a new body. Returns the original raw when unchanged. */
export function buildRaw(p: Envelope, body: string): string {
  if (body === p.body) return p.raw;
  let head = p.head;
  if (body !== '' && !head.endsWith('\n')) head += '\n';
  if (p.closed) return head + (body === '' ? '' : addIndent(body, p.indent) + '\n') + p.tail;
  return head + addIndent(body, p.indent) + p.tail;
}

// ------------------------------------------------------------------ code fences

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

export function parseFence(raw: string): FenceParts {
  const first = raw.split('\n', 1)[0];
  const m = FENCE_OPEN.exec(first);
  if (!m) {
    // Not a fence (shouldn't happen) — treat everything as body of an unclosed fence.
    const env = parseEnvelope(raw, '', null);
    return { ...env, char: '`', length: 3, info: '', lang: '' };
  }
  const indent = m[1];
  const marker = m[2];
  const char = marker[0] as '`' | '~';
  const length = marker.length;
  const info = m[3];
  const closeRe = new RegExp(`^ {0,3}${char === '`' ? '`' : '~'}{${length},}[ \\t]*$`);
  const env = parseEnvelope(raw, indent, (l) => closeRe.test(l));
  return { ...env, char, length, info, lang: fenceLang(info) };
}

/** Language id from an info string: first word, braces/dots stripped, lowercased. */
export function fenceLang(info: string): string {
  const w = info.trim().split(/\s+/, 1)[0] || '';
  return w.replace(/^\{?\.?/, '').replace(/[{}]/g, '').toLowerCase();
}

/** Replace the info string of a fence, keeping fence chars / indent / body / tail. */
export function withFenceInfo(p: FenceParts, info: string): string {
  if (info === p.info) return p.raw;
  // GFM: backtick fences may not contain backticks in the info string.
  const safe = p.char === '`' ? info.replace(/`/g, '') : info;
  const nl = p.head.endsWith('\n') ? '\n' : '';
  const head = p.indent + p.char.repeat(p.length) + safe + nl;
  return head + p.raw.slice(p.head.length);
}

/** Pick a fence length longer than any backtick/tilde run inside body. */
export function makeFence(body: string, info = '', char: '`' | '~' = '`'): string {
  let len = 3;
  const re = char === '`' ? /`{3,}/g : /~{3,}/g;
  for (const m of body.match(re) || []) len = Math.max(len, m.length + 1);
  const f = char.repeat(len);
  return `${f}${info}\n${body}${body ? '\n' : ''}${f}\n`;
}

// ------------------------------------------------------------------ math blocks

export interface MathParts extends Envelope {
  /** True for the single-line form `$$ x $$`. */
  inline: boolean;
}

export function parseMathBlock(raw: string): MathParts {
  const first = raw.split('\n', 1)[0];
  const m = /^( {0,3})\$\$(.*)$/.exec(first);
  const indent = m ? m[1] : '';
  // Single-line `$$ ... $$`
  if (m) {
    const rest = m[2];
    const close = rest.lastIndexOf('$$');
    if (close >= 0 && rest.slice(close + 2).trim() === '') {
      const afterFirst = raw.slice(first.length);
      return {
        raw,
        head: indent + '$$',
        body: rest.slice(0, close),
        tail: rest.slice(close) + afterFirst,
        closed: true,
        indent: '',
        inline: true,
      };
    }
  }
  const env = parseEnvelope(raw, indent, (l) => /^ {0,3}\$\$[ \t]*$/.test(l));
  return { ...env, inline: false };
}

export function buildMathRaw(p: MathParts, body: string): string {
  if (body === p.body) return p.raw;
  if (p.inline) {
    if (!body.includes('\n')) return p.head + body + p.tail;
    // grew into multiple lines: convert to block form
    const after = p.tail.replace(/^\$\$[ \t]*/, '');
    return `${p.head}\n${body}\n$$${after}`;
  }
  return buildRaw(p, body);
}

// ------------------------------------------------------------------ front matter

export function parseFrontMatter(raw: string): Envelope {
  return parseEnvelope(raw, '', (l) => /^(---|\.\.\.)[ \t]*$/.test(l));
}

// ------------------------------------------------------------------ html blocks

/** HTML blocks: whole raw minus trailing newlines is the body. */
export function parseHtmlBlock(raw: string): Envelope {
  const m = /\n*$/.exec(raw)!;
  const body = raw.slice(0, raw.length - m[0].length);
  return { raw, head: '', body, tail: m[0], closed: false, indent: '' };
}

export function buildHtmlRaw(p: Envelope, body: string): string {
  if (body === p.body) return p.raw;
  return body + (p.tail || '\n');
}

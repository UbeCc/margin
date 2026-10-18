/** Block-start recognisers (operate on the line rest after container prefixes). */
import { indentCols, consumeCols } from './lines';
import { syntaxOptions, remapOn } from './options';

/** ATX heading level; outside Strict Mode `#Heading` (no space) also counts (#102).
 *  #133 remap: full-width `＃` counts like `#`. */
const ATX_STRICT = [/^ {0,3}(#{1,6})(?:[ \t]|$)/, /^ {0,3}([#＃]{1,6})(?:[ \t]|$)/];
const ATX_LOOSE = [/^ {0,3}(#{1,6})(?:[ \t]|$|(?=[^#\s]))/, /^ {0,3}([#＃]{1,6})(?:[ \t]|$|(?=[^#\s＃]))/];
export function atxLevel(s: string): number {
  const m = (syntaxOptions.strict ? ATX_STRICT : ATX_LOOSE)[remapOn() ? 1 : 0].exec(s);
  return m ? m[1].length : 0;
}

export interface FenceOpen {
  char: '`' | '~';
  len: number;
  lang: string;
}

export function fenceOpen(s: string): FenceOpen | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(s);
  if (!m) return null;
  const char = m[1][0] as '`' | '~';
  if (char === '`' && m[2].includes('`')) return null;
  const lang = (m[2].trim().split(/[\s{]/)[0] || '').toLowerCase();
  return { char, len: m[1].length, lang };
}

export function isFenceClose(s: string, f: FenceOpen): boolean {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(s);
  return !!m && m[1][0] === f.char && m[1].length >= f.len;
}

/** `$$` opener. Returns 'closed' when the block also closes on the same line. */
export function mathOpen(s: string): null | 'open' | 'closed' {
  const m = /^ {0,3}\$\$(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[1].trimEnd();
  return rest.length >= 2 && rest.endsWith('$$') ? 'closed' : 'open';
}

export function isMathClose(s: string): boolean {
  return s.trimEnd().endsWith('$$');
}

/** Thematic break; #133 remap: en/em dashes (`–—`) count like `---`. */
const THEMATIC = [
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:[-–—][ \t]*){3,}|(?:_[ \t]*){3,})$/,
];
export function isThematic(s: string): boolean {
  return THEMATIC[remapOn() ? 1 : 0].test(s);
}

export function setextLevel(s: string): number {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(s);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RE_HTML6 = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:[ \\t>]|/>|$)`, 'i');
const RE_HTML7 =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;

/** HTML block start kind (CommonMark 1–7) or 0. */
export function htmlStart(s: string): number {
  if (/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(s)) return 1;
  if (/^ {0,3}<!--/.test(s)) return 2;
  if (/^ {0,3}<\?/.test(s)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(s)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(s)) return 5;
  if (RE_HTML6.test(s)) return 6;
  if (RE_HTML7.test(s)) return 7;
  return 0;
}

/** True if `s` ends an HTML block of kind 1–5 (kinds 6/7 end at a blank line). */
export function htmlEnds(kind: number, s: string): boolean {
  switch (kind) {
    case 1:
      return /<\/(?:script|pre|style|textarea)>/i.test(s);
    case 2:
      return s.includes('-->');
    case 3:
      return s.includes('?>');
    case 4:
      return s.includes('>');
    case 5:
      return s.includes(']]>');
    default:
      return false;
  }
}

export const isToc = (s: string) => /^ {0,3}(?:\[toc\]|【toc】)[ \t]*$/i.test(s); // 【toc】 always on (typora-re editor-core §289)
export const isFootnoteDef = (s: string) => /^ {0,3}\[\^[^\]\s]+\]:/.test(s);
export const isLinkDef = (s: string) => /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*\S/.test(s);

export function quoteStart(s: string): number {
  // #133 remap: `〉`/`》` start a blockquote like `>` (the original chars stay in the source).
  const m = remapOn() ? /^ {0,3}(?:>|〉|》)/.exec(s) : /^ {0,3}>/.exec(s);
  if (!m) return 0;
  let n = m[0].length;
  if (s[n] === ' ' || s[n] === '\t') n++;
  return n;
}

export interface ListStart {
  /** chars consumed (marker + spacing + optional task box). */
  consumed: number;
  ordered: boolean;
  delim: string;
  start: number;
  markerText: string;
  width: number;
  task: null | string;
  /** Nothing after the marker. */
  empty: boolean;
}

export function listStart(s: string, col0 = 0): ListStart | null {
  // #133 remap: full-width markers (－＋＊), full-width digits with ASCII/full-width
  // delimiters, and CJK task boxes 【x】/【 】 — the original characters stay in the source.
  const remap = remapOn();
  const m = (remap
    ? /^( {0,3})([-+*－＋＊]|\d{1,9}[.)．）]|[０-９]{1,9}[.)．）])(?=[ \t]|$)/
    : /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)/
  ).exec(s);
  if (!m) return null;
  if (isThematic(s)) return null;
  const ordered = /[\d０-９]/.test(m[2][0]);
  const after = s.slice(m[0].length);
  const empty = /^[ \t]*$/.test(after);
  const base = indentCols(s, col0) + m[2].length;
  let spaceCols = indentCols(after, col0 + base);
  let spaceChars: number;
  if (empty) {
    spaceChars = after.length;
    spaceCols = 1;
  } else if (spaceCols >= 5) {
    spaceChars = consumeCols(after, 1, col0 + base);
    spaceCols = 1;
  } else {
    spaceChars = consumeCols(after, spaceCols, col0 + base);
  }
  let consumed = m[0].length + spaceChars;
  const markerText = s.slice(0, consumed);
  let task: null | string = null;
  const rest = s.slice(consumed);
  const t = remap
    ? /^(?:\[([ xX])\]|【([ xX])】)(?:[ \t]|$)/.exec(rest)
    : /^\[([ xX])\](?:[ \t]|$)/.exec(rest);
  if (t && !empty) {
    task = t[1] ?? t[2];
    consumed += t[0].length;
  }
  return {
    consumed,
    ordered,
    delim: ordered ? m[2].slice(-1) : m[2],
    start: ordered ? parseInt(m[2].normalize('NFKC'), 10) : 1,
    markerText,
    width: base + spaceCols,
    task,
    empty,
  };
}

/** Split a table row into cells (unescaped pipes; outer pipes optional). */
export function splitRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && i + 1 < t.length) {
      cur += t[i] + t[i + 1];
      i++;
    } else if (t[i] === '|') {
      cells.push(cur);
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

export function isDelimRow(s: string): boolean {
  if (!s.includes('-') || !/^ {0,3}[|:\- \t]+$/.test(s)) return false;
  return splitRow(s).every((c) => /^:?-+:?$/.test(c));
}

/** Header + delimiter rows form a table. */
export function isTableStart(header: string, delim: string): boolean {
  if (!header.includes('|') || !isDelimRow(delim)) return false;
  return splitRow(header).length === splitRow(delim).length;
}

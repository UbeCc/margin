/** Line splitting and column helpers shared by the block parser. */

export interface RawLine {
  text: string;
  eol: string;
}

/** Split into lines keeping each line ending. A trailing empty segment is dropped. */
export function splitLines(src: string): RawLine[] {
  const out: RawLine[] = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({ text: src.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), eol: '' });
  return out;
}

/** Most common line ending of a document ('\n' default). */
export function detectEol(src: string): string {
  const crlf = (src.match(/\r\n/g) || []).length;
  const lf = (src.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function isBlank(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** Visual column width of leading whitespace of `s` starting at column `col0`. */
export function indentCols(s: string, col0 = 0): number {
  let col = col0;
  for (const ch of s) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col - col0;
}

/**
 * Consume `cols` columns of leading whitespace. Returns the number of chars
 * consumed (a tab is consumed whole even if it overshoots).
 */
export function consumeCols(s: string, cols: number, col0 = 0): number {
  let col = col0;
  let i = 0;
  while (i < s.length && col - col0 < cols) {
    const ch = s[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
    i++;
  }
  return i;
}

export function columnOf(s: string, upto: number): number {
  let col = 0;
  for (let i = 0; i < upto && i < s.length; i++) col += s[i] === '\t' ? 4 - (col % 4) : 1;
  return col;
}

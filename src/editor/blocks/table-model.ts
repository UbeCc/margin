/**
 * GFM pipe-table model: parse raw markdown into cells, serialize back to a
 * well-formatted pipe table. Unchanged tables serialize to their original raw.
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface TableModel {
  /** rows[0] is the header row. Every row has `align.length` cells. Cell text is raw inline markdown. */
  rows: string[][];
  align: Align[];
}

export interface ParsedTable extends TableModel {
  raw: string;
  /** Indent of the first line (0-3 spaces), re-applied when serializing. */
  indent: string;
  /** Trailing blank lines / newline after the last table row. */
  tail: string;
}

/** Split one table row into cells on unescaped `|` (GFM semantics). Cells are trimmed. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  // strip a trailing unescaped pipe
  if (s.endsWith('|') && !isEscaped(s, s.length - 1)) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

const DELIM_CELL = /^:?-+:?$/;

export function isDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c.replace(/\s+/g, '')));
}

function parseAlign(cell: string): Align {
  const c = cell.replace(/\s+/g, '');
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
}

export function parseTable(raw: string): ParsedTable {
  const m = /\n*$/.exec(raw)!;
  const tail = m[0];
  const lines = raw.slice(0, raw.length - tail.length).split('\n');
  const indent = /^ {0,3}/.exec(lines[0] ?? '')![0];
  const header = splitRow(lines[0] ?? '');
  let align: Align[];
  let bodyLines: string[];
  if (lines.length > 1 && isDelimiterRow(lines[1])) {
    align = splitRow(lines[1]).map(parseAlign);
    bodyLines = lines.slice(2);
  } else {
    align = header.map(() => null);
    bodyLines = lines.slice(1);
  }
  const ncol = Math.max(header.length, align.length);
  const norm = (r: string[]) => {
    const out = r.slice(0, ncol);
    while (out.length < ncol) out.push('');
    return out;
  };
  while (align.length < ncol) align.push(null);
  align = align.slice(0, ncol);
  const rows = [norm(header), ...bodyLines.map((l) => norm(splitRow(l)))];
  return { raw, indent, tail, rows, align };
}

/** Display width: East Asian wide / fullwidth characters count as 2 columns. */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )
      w += 2;
    else if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || (cp >= 0xfe00 && cp <= 0xfe0f)) w += 0;
    else w += 1;
  }
  return w;
}

/** Escape unescaped pipes and flatten newlines so a cell can't break the row. */
export function escapeCell(text: string): string {
  let out = '';
  const s = text.replace(/\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      out += c + s[i + 1];
      i++;
    } else if (c === '|') out += '\\|';
    else out += c;
  }
  return out.trim();
}

function pad(s: string, width: number, align: Align): string {
  const gap = width - strWidth(s);
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}

function delim(width: number, a: Align): string {
  const w = Math.max(3, width);
  if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
  if (a === 'right') return '-'.repeat(w - 1) + ':';
  if (a === 'left') return ':' + '-'.repeat(w - 1);
  return '-'.repeat(w);
}

/** Format a model as an aligned pipe table (no trailing newline). */
export function formatTable(model: TableModel, indent = ''): string {
  const ncol = model.align.length;
  const rows = model.rows.map((r) => {
    const out = r.slice(0, ncol).map(escapeCell);
    while (out.length < ncol) out.push('');
    return out;
  });
  const widths = model.align.map((_, c) => Math.max(3, ...rows.map((r) => strWidth(r[c]))));
  const line = (cells: string[]) => indent + '| ' + cells.join(' | ') + ' |';
  const out: string[] = [];
  rows.forEach((r, i) => {
    out.push(line(r.map((c, j) => pad(c, widths[j], model.align[j]))));
    if (i === 0) out.push(line(model.align.map((a, j) => delim(widths[j], a))));
  });
  return out.join('\n');
}

export function modelsEqual(a: TableModel, b: TableModel): boolean {
  if (a.align.length !== b.align.length || a.rows.length !== b.rows.length) return false;
  if (a.align.some((x, i) => x !== b.align[i])) return false;
  return a.rows.every((r, i) => r.length === b.rows[i].length && r.every((c, j) => c === b.rows[i][j]));
}

/** Serialize: original raw if nothing changed, else a freshly formatted table + original tail. */
export function serializeTable(orig: ParsedTable, model: TableModel): string {
  if (modelsEqual(orig, model)) return orig.raw;
  return formatTable(model, orig.indent) + (orig.tail || '\n');
}

export function cloneModel(m: TableModel): TableModel {
  return { rows: m.rows.map((r) => r.slice()), align: m.align.slice() };
}

// ------------------------------------------------------------ structural edits

export function insertRow(m: TableModel, at: number): TableModel {
  const n = cloneModel(m);
  n.rows.splice(Math.max(1, at), 0, n.align.map(() => ''));
  return n;
}

export function deleteRow(m: TableModel, at: number): TableModel {
  const n = cloneModel(m);
  if (at === 0) {
    // deleting the header promotes the first body row (or clears the header)
    if (n.rows.length > 1) n.rows.splice(0, 1);
    else n.rows[0] = n.align.map(() => '');
  } else n.rows.splice(at, 1);
  return n;
}

export function insertCol(m: TableModel, at: number): TableModel {
  const n = cloneModel(m);
  n.align.splice(at, 0, null);
  n.rows.forEach((r) => r.splice(at, 0, ''));
  return n;
}

export function deleteCol(m: TableModel, at: number): TableModel {
  const n = cloneModel(m);
  if (n.align.length <= 1) return n;
  n.align.splice(at, 1);
  n.rows.forEach((r) => r.splice(at, 1));
  return n;
}

export function moveRow(m: TableModel, from: number, to: number): TableModel {
  const n = cloneModel(m);
  if (from < 1 || to < 1 || to >= n.rows.length) return n;
  const [r] = n.rows.splice(from, 1);
  n.rows.splice(to, 0, r);
  return n;
}

export function moveCol(m: TableModel, from: number, to: number): TableModel {
  const n = cloneModel(m);
  if (to < 0 || to >= n.align.length) return n;
  const mv = <T>(a: T[]) => {
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x);
  };
  mv(n.align);
  n.rows.forEach(mv);
  return n;
}

export function setAlign(m: TableModel, col: number, a: Align): TableModel {
  const n = cloneModel(m);
  n.align[col] = a;
  return n;
}

/** A fresh empty table with given size (rows includes header). */
export function emptyTable(rows: number, cols: number): TableModel {
  return { rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')), align: Array(cols).fill(null) };
}

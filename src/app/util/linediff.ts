/**
 * Line diff (Myers O(ND)) for the external-change prompt (#82).
 *
 * Common prefix/suffix are trimmed first, lines are interned to ints, and the edit
 * distance search is capped (`maxEdits`): past the cap the remaining middle is reported
 * as one delete block + one insert block, so huge unrelated files stay fast.
 */

export type DiffOp =
  | { kind: 'eq'; text: string; a: number; b: number }
  | { kind: 'del'; text: string; a: number }
  | { kind: 'add'; text: string; b: number };

export interface DiffOptions {
  /** Max edit distance explored by Myers before falling back to a block replace. */
  maxEdits?: number;
}

/** Split into lines; a trailing newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Diff two texts line by line: `a` = old (disk), `b` = new (buffer). Line numbers are 0-based. */
export function diffLines(aText: string, bText: string, opts: DiffOptions = {}): DiffOp[] {
  return diffLineArrays(splitLines(aText), splitLines(bText), opts);
}

export function diffLineArrays(a: string[], b: string[], opts: DiffOptions = {}): DiffOp[] {
  const maxEdits = opts.maxEdits ?? 2000;
  const ops: DiffOp[] = [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  for (let i = 0; i < pre; i++) ops.push({ kind: 'eq', text: a[i], a: i, b: i });

  const aEnd = a.length - suf;
  const bEnd = b.length - suf;
  const mid = myers(a, pre, aEnd, b, pre, bEnd, maxEdits);
  if (mid) ops.push(...mid);
  else {
    for (let i = pre; i < aEnd; i++) ops.push({ kind: 'del', text: a[i], a: i });
    for (let j = pre; j < bEnd; j++) ops.push({ kind: 'add', text: b[j], b: j });
  }

  for (let k = 0; k < suf; k++) ops.push({ kind: 'eq', text: a[aEnd + k], a: aEnd + k, b: bEnd + k });
  return ops;
}

/** Myers forward search with per-step V snapshots; null when the cap is exceeded. */
function myers(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number, cap: number): DiffOp[] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  const out: DiffOp[] = [];
  if (n === 0 && m === 0) return out;
  if (n === 0 || m === 0) {
    for (let i = a0; i < a1; i++) out.push({ kind: 'del', text: a[i], a: i });
    for (let j = b0; j < b1; j++) out.push({ kind: 'add', text: b[j], b: j });
    return out;
  }
  // Intern lines so comparisons are integer compares.
  const ids = new Map<string, number>();
  const intern = (s: string): number => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const A = new Int32Array(n);
  const B = new Int32Array(m);
  for (let i = 0; i < n; i++) A[i] = intern(a[a0 + i]);
  for (let j = 0; j < m; j++) B[j] = intern(b[b0 + j]);

  const max = Math.min(n + m, cap);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        found = d;
        break outer;
      }
    }
    trace.push(v.slice(off - d - 1, off + d + 2));
  }
  if (found < 0) return null;

  // Backtrack. trace[d][i] holds V[k] for k = i - d - 1.
  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number): number => prev[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      rev.push({ kind: 'eq', text: a[a0 + x], a: a0 + x, b: b0 + y });
    }
    if (down) {
      y--;
      rev.push({ kind: 'add', text: b[b0 + y], b: b0 + y });
    } else {
      x--;
      rev.push({ kind: 'del', text: a[a0 + x], a: a0 + x });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ kind: 'eq', text: a[a0 + x], a: a0 + x, b: b0 + y });
  }
  for (let i = rev.length - 1; i >= 0; i--) out.push(rev[i]);
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.kind === 'add') added++;
    else if (o.kind === 'del') removed++;
  }
  return { added, removed };
}

export type DiffRow = DiffOp | { kind: 'skip'; count: number };

/** Collapse unchanged runs longer than 2×context into a `skip` row (for display). */
export function foldContext(ops: DiffOp[], context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind !== 'eq') {
      rows.push(ops[i++]);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].kind === 'eq') j++;
    const run = j - i;
    const head = i === 0 ? 0 : context;
    const tail = j === ops.length ? 0 : context;
    if (run > head + tail + 1) {
      for (let k = 0; k < head; k++) rows.push(ops[i + k]);
      rows.push({ kind: 'skip', count: run - head - tail });
      for (let k = j - tail; k < j; k++) rows.push(ops[k]);
    } else for (let k = i; k < j; k++) rows.push(ops[k]);
    i = j;
  }
  return rows;
}

import { describe, expect, it } from 'vitest';
import { diffLines, diffLineArrays, diffStats, foldContext, splitLines, type DiffOp } from '../util/linediff';

/** Rebuild both sides from the ops; must equal the inputs. */
function sides(ops: DiffOp[]): { a: string[]; b: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  for (const o of ops) {
    if (o.kind !== 'add') a.push(o.text);
    if (o.kind !== 'del') b.push(o.text);
  }
  return { a, b };
}

function lcsLen(a: string[], b: string[]): number {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

describe('splitLines', () => {
  it('handles empty, trailing newline and CRLF', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('empty vs empty / empty vs text', () => {
    expect(diffLines('', '')).toEqual([]);
    expect(diffLines('', 'a\nb\n').map((o) => o.kind)).toEqual(['add', 'add']);
    expect(diffLines('a\nb\n', '').map((o) => o.kind)).toEqual(['del', 'del']);
  });

  it('identical inputs are all eq', () => {
    const ops = diffLines('x\ny\nz\n', 'x\ny\nz\n');
    expect(ops.every((o) => o.kind === 'eq')).toBe(true);
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0 });
  });

  it('finds a minimal edit for a middle change', () => {
    const ops = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    expect(ops.map((o) => `${o.kind}:${o.text}`)).toEqual(['eq:a', 'del:b', 'add:B', 'eq:c', 'eq:d', 'add:e']);
    expect(ops[1]).toMatchObject({ a: 1 });
    expect(ops[2]).toMatchObject({ b: 1 });
  });

  it('is an optimal LCS on random inputs (seeded)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)]);
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)]);
      const ops = diffLineArrays(a, b);
      expect(sides(ops)).toEqual({ a, b });
      expect(ops.filter((o) => o.kind === 'eq').length).toBe(lcsLen(a, b));
    }
  });

  it('large inputs with few edits are fast', () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const b = a.slice();
    for (let i = 100; i < 50_000; i += 997) b[i] = `changed ${i}`;
    b.splice(25_000, 0, 'inserted');
    const t0 = performance.now();
    const ops = diffLineArrays(a, b);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(sides(ops)).toEqual({ a, b });
    expect(diffStats(ops)).toEqual({ added: 52, removed: 51 });
  });

  it('large unrelated inputs fall back to a block replace quickly', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 20_000 }, (_, i) => `b${i}`);
    const t0 = performance.now();
    const ops = diffLineArrays(a, b, { maxEdits: 500 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(sides(ops)).toEqual({ a, b });
  });
});

describe('foldContext', () => {
  it('collapses long unchanged runs but keeps context', () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const b = a.slice();
    b[20] = 'X';
    const rows = foldContext(diffLineArrays(a, b), 3);
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe('skip');
    expect(kinds.filter((k) => k === 'skip').length).toBe(2);
    expect(rows.filter((r) => r.kind === 'eq').length).toBe(6);
  });

  it('keeps short runs intact', () => {
    const rows = foldContext(diffLines('a\nb\n', 'a\nc\n'), 3);
    expect(rows.map((r) => r.kind)).toEqual(['eq', 'del', 'add']);
  });
});

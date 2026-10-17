/**
 * Seeded property tests for the DOM-free editing layer: random sequences of
 * structural edits must keep the incremental model identical to a fresh parse
 * of its own text, keep docPos/locate consistent, and undo (via History diffs)
 * back to the original document.
 */
import { describe, it, expect } from 'vitest';
import { Doc, leafContent } from './model';
import { History } from './history';
import * as E from './edit';
import type { Leaf } from './types';
import { rng, modelProblems } from './test-util';

/** More runs locally: FUZZ_RUNS=2000 npx vitest run src/editor/core/fuzz.test.ts */
const RUNS = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_RUNS ?? 60);
const checkModel = (d: Doc, ctx: string) => expect(modelProblems(d), ctx).toEqual([]);

const SNIPS = ['a', 'bc', ' ', '# ', '- ', '1. ', '> ', '[ ] ', '**', '`', '---', '* ', '|a|b|', 'x\ny', '  ', '\t', '中文', '😀', '$$', '```'];
const SEEDS = [
  '',
  'hello\n',
  '# H\n\npara one\npara two\n\n- a\n- b\n  - c\n- [ ] t\n\n1. x\n2. y\n\n> q\n> r\n',
  '> - a\n>   b\n> - c\n\n---\n\ntext',
  '```js\ncode\n```\n\n$$\nx\n$$\n\n|a|b|\n|-|-|\n|1|2|\n',
  '- a\n\n  para\n\n- b\n',
  'a\r\nb\r\n\r\n- c\r\n',
];

function step(d: Doc, r: () => number, log: string[]): string {
  const n = d.leaves.length;
  const pick = (k: number) => Math.floor(r() * k);
  const textIdx = d.leaves.map((l, i) => (E.isTextLeaf(l) ? i : -1)).filter((i) => i >= 0);
  const op = pick(9);
  if (!n || !textIdx.length || op === 0) {
    const t = d.text();
    // never split a CRLF pair
    const fix = (x: number) => (t[x - 1] === '\r' && t[x] === '\n' ? x + 1 : x);
    const a = fix(pick(t.length + 1));
    const b = fix(Math.min(t.length, a + pick(4)));
    const s = SNIPS[pick(SNIPS.length)];
    d.replace(a, b, s);
    return `replace(${a},${b},${JSON.stringify(s)})`;
  }
  const i = textIdx[pick(textIdx.length)];
  const l = d.leaves[i] as Leaf;
  const c = leafContent(l);
  const off = pick(c.length + 1);
  switch (op) {
    case 1:
    case 2: {
      const s = SNIPS[pick(SNIPS.length)].replace('\n', '');
      d.setContent(i, c.slice(0, off) + s + c.slice(off));
      return `type(${i},${off},${JSON.stringify(s)})`;
    }
    case 3:
      d.setContent(i, c.slice(0, Math.max(0, off - 1)) + c.slice(off));
      return `delchar(${i},${off})`;
    case 4:
    {
      const soft = r() < 0.2;
      const n0 = d.leaves.length;
      const plain = l.type === 'paragraph' && !l.chain.length && c.trim() && off === c.length && !c.includes('\n');
      const caret = E.enter(d, i, off, soft);
      if (plain && !soft && !/^ {0,3}(?:```|~~~|\$\$|\|)/.test(c)) expect(d.leaves.length, `${log.join(' ')} enter(${i},${off}) adds a block`).toBeGreaterThan(n0);
      if ('pos' in caret && l.type !== 'indented_code') {
        const at = d.locate(caret.pos);
        // the caret lands in content, and a hard Enter moves it to a later block
        expect(d.docPos(at.i, at.off), `${log.join(' ')} enter(${i},${off}${soft ? ',soft' : ''}) caret off-content`).toBe(caret.pos);
      }
      return `enter(${i},${off}${soft ? ',soft' : ''})`;
    }
    case 5:
    {
      const o = r() < 0.7 ? 0 : off;
      E.backspace(d, i, o) ?? d.setContent(i, c.slice(0, Math.max(0, o - 1)) + c.slice(o));
      return `backspace(${i},${o})`;
    }
    case 6:
    {
      const o = r() < 0.7 ? c.length : off;
      E.del(d, i, o) ?? d.setContent(i, c.slice(0, o) + c.slice(o + 1));
      return `del(${i},${o})`;
    }
    case 7:
    {
      const out = r() < 0.5;
      E.indent(d, i, off, out);
      return `indent(${i},${out ? 'out' : 'in'})`;
    }
    default:
      E.toggleTask(d, i);
      return `toggle(${i})`;
  }
}

describe('fuzz: structural edits keep the model consistent', () => {
  SEEDS.forEach((src, si) => {
    it(`seed doc ${si}`, () => {
      for (let run = 0; run < RUNS; run++) {
        const r = rng(1000 * si + run);
        const d = new Doc(src);
        const h = new History();
        const log: string[] = [`#${si}.${run}`];
        for (let k = 0; k < 30; k++) {
          const before = d.text();
          log.push(step(d, r, log));
          h.record(before, d.text(), null, null, null);
          h.break();
          checkModel(d, `seed ${si} run ${run}: ${log.join(' ')}`);
        }
        // undo everything through the history diffs
        let e;
        while ((e = h.popUndo())) d.replace(e.from, e.from + e.after.length, e.before);
        expect(d.text()).toBe(src);
        checkModel(d, 'after undo');
      }
    });
  });
});

/**
 * Document model: a flat list of leaves with stable ids. The serialized
 * markdown is the concatenation of all lines. Edits are expressed either as a
 * text range replacement on the whole document (followed by a re-parse that
 * keeps ids of unchanged / positionally matching leaves) or as a local content
 * update of a single text leaf.
 */
import type { Container, Leaf, ParsedLeaf, Line } from './types';
import { isTextType } from './types';
import { parseBlocks, serializeLeaves } from './parser/block';
import { detectEol, isBlank } from './parser/lines';
import { normLabel, RefMap } from './parser/inline';

export interface Edit {
  from: number;
  to: number;
  /** Replaced text (old). */
  before: string;
  /** Inserted text (new). */
  after: string;
}

const HOLD_TYPES = new Set(['hr', 'code_fence', 'math_block', 'html_block', 'front_matter', 'toc', 'def', 'footnote']);
const HOLD_RE = /^ {0,3}(?:#{1,6}|[-+*]|\d{1,9}[.)]|>)$/;

export const leafRaw = (l: { lines: Line[] }) => serializeLeaves([l]);
export const leafContent = (l: Leaf) => l.lines.slice(0, l.n).map((x) => x.text).join('\n');

/** Raw handed to widgets: lines without container prefixes, '\n' line endings. */
export function widgetRaw(l: Leaf): string {
  return l.lines.map((x) => x.text + (x.eol ? '\n' : '')).join('');
}

/** Prefix used for synthesized continuation lines inside `chain`. */
export function contPrefix(chain: Container[], blank = false): string {
  let s = '';
  for (const c of chain) s += c.kind === 'quote' ? '> ' : ' '.repeat(c.width);
  return blank ? s.replace(/[ ]+$/, '') : s;
}

export class Doc {
  leaves: Leaf[] = [];
  eol = '\n';
  private seq = 0;
  private starts: number[] | null = null;
  private byId = new Map<string, number>();
  private refsCache: Map<string, { href: string; title?: string }> | null = null;

  constructor(md = '') {
    this.set(md);
  }

  set(md: string): void {
    this.eol = detectEol(md);
    this.leaves = parseBlocks(md).map((l) => ({ ...l, id: this.newId() }));
    this.touch();
  }

  newId(): string {
    return 'b' + ++this.seq;
  }

  text(): string {
    return serializeLeaves(this.leaves);
  }

  private touch(): void {
    this.starts = null;
    this.refsCache = null;
    this.byId.clear();
    this.leaves.forEach((l, i) => this.byId.set(l.id, i));
  }

  indexOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  get(id: string): Leaf | undefined {
    const i = this.indexOf(id);
    return i < 0 ? undefined : this.leaves[i];
  }

  start(i: number): number {
    if (!this.starts) {
      this.starts = [];
      let p = 0;
      for (const l of this.leaves) {
        this.starts.push(p);
        p += leafRaw(l).length;
      }
      this.starts.push(p);
    }
    return this.starts[Math.max(0, Math.min(i, this.leaves.length))];
  }

  /** Document offset of content offset `off` in leaf `i`. */
  docPos(i: number, off: number): number {
    const l = this.leaves[i];
    if (!l) return this.start(this.leaves.length);
    let p = this.start(i);
    for (let k = 0; k < l.lines.length; k++) {
      const ln = l.lines[k];
      if (k >= l.n || off <= ln.text.length) return p + ln.prefix.length + Math.min(Math.max(off, 0), ln.text.length);
      off -= ln.text.length + 1;
      p += ln.prefix.length + ln.text.length + ln.eol.length;
    }
    return p;
  }

  /** Leaf index + content offset for a document offset. */
  locate(pos: number): { i: number; off: number } {
    const n = this.leaves.length;
    if (!n) return { i: 0, off: 0 };
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.start(mid) <= pos) lo = mid;
      else hi = mid - 1;
    }
    const l = this.leaves[lo];
    let p = this.start(lo);
    let off = 0;
    for (let k = 0; k < l.lines.length; k++) {
      const ln = l.lines[k];
      if (k >= l.n) return { i: lo, off: off - 1 };
      const ts = p + ln.prefix.length;
      const end = ts + ln.text.length;
      if (pos <= end || k === l.n - 1) return { i: lo, off: off + Math.max(0, Math.min(pos, end) - ts) };
      off += ln.text.length + 1;
      p = end + ln.eol.length;
    }
    return { i: lo, off: Math.max(0, off - 1) };
  }

  /** Replace document range; re-parse and keep ids where possible. */
  replace(from: number, to: number, text: string): Edit {
    const old = this.text();
    const before = old.slice(from, to);
    this.reparse(old.slice(0, from) + text + old.slice(to));
    return { from, to, before, after: text };
  }

  /** Re-parse `md` and reconcile ids with the current leaves. */
  reparse(md: string): void {
    const next = parseBlocks(md);
    const old = this.leaves;
    const key = (l: ParsedLeaf) => l.type + '\u0000' + leafRaw(l);
    let p = 0;
    while (p < old.length && p < next.length && key(old[p]) === key(next[p])) p++;
    let s = 0;
    while (s < old.length - p && s < next.length - p && key(old[old.length - 1 - s]) === key(next[next.length - 1 - s])) s++;
    const used = new Set<string>();
    this.leaves = next.map((l, j) => {
      let id: string | undefined;
      if (j < p) id = old[j].id;
      else if (j >= next.length - s) id = old[old.length - (next.length - j)].id;
      else {
        const o = old[j];
        if (o && j < old.length - s && (o.type === l.type || (isTextType(o.type) && isTextType(l.type)))) id = o.id;
      }
      if (!id || used.has(id)) id = this.newId();
      used.add(id);
      return { ...l, id };
    });
    this.touch();
  }

  /**
   * Update the content of text leaf `i` (lines joined with '\n'). Applies the
   * change locally, then re-parses the document when the leaf's syntax changed
   * (e.g. `# ` typed → heading), unless the change is an incomplete trigger.
   */
  setContent(i: number, content: string): Edit {
    const l = this.leaves[i];
    const from = this.start(i);
    const oldRaw = leafRaw(l);
    const wasEmpty = l.n === 1 && isBlank(l.lines[0].text);
    const oldTexts = l.lines.slice(0, l.n).map((x) => x.text);
    const texts = content.split('\n');
    const trail = l.lines.slice(l.n);
    const hasNext = i + 1 < this.leaves.length;
    const lines = this.buildLines(l, texts, trail.length > 0 || hasNext || l.lines[l.n - 1].eol !== '');
    const extra: Line[] = [];
    if (wasEmpty && content && hasNext && !trail.length && !isBlankLeafText(this.leaves[i + 1])) {
      extra.push({ prefix: contPrefix(l.chain, true), text: '', eol: this.eol });
    }
    l.lines = [...lines, ...extra, ...trail];
    l.n = lines.length;
    if (!content && l.type === 'heading' && !l.setext) {
      // Last `#` deleted: an empty ATX heading is an empty paragraph (kept as caret target).
      l.type = 'paragraph';
      delete l.level;
    }
    this.touch();
    const newRaw = leafRaw(l);
    const edit = { from, to: from + oldRaw.length, before: oldRaw, after: newRaw };
    // A filled blank leaf may leave (or join) the containers it was parsed into.
    const regroup = wasEmpty && l.chain.length > 0 && !HOLD_RE.test(content.split('\n')[0]);
    if (regroup || this.containerSyntaxChanged(l, oldTexts) || this.needsReparse(l, content)) this.reparse(this.text());
    return edit;
  }

  /**
   * Content edits whose meaning depends on the surrounding containers, which
   * the leaf-local check in needsReparse cannot see: changed leading blanks
   * (list-marker spacing, `> ` padding, lazy lines becoming continuation or
   * indented code), `[ ] ` right after a list marker (task item), and a soft
   * line starting with a list / quote marker inside a container.
   */
  private containerSyntaxChanged(l: Leaf, oldTexts: string[]): boolean {
    const lead = (t: string | undefined) => (t === undefined ? '' : /^[ \t]*/.exec(t)![0]);
    for (let k = 0; k < l.n; k++) if (lead(l.lines[k].text) !== lead(oldTexts[k])) return true;
    if (!l.chain.length) return false;
    const inner = l.chain[l.chain.length - 1];
    if (l.openFrom <= l.chain.length - 1 && inner.kind === 'item' && inner.task === null && /^\[[ xX]\](?:[ \t]|$)/.test(l.lines[0].text)) return true;
    for (let k = 1; k < l.n; k++) if (/^ {0,3}(?:[-+*>]|\d{1,9}[.)])(?:[ \t]|$)/.test(l.lines[k].text)) return true;
    return false;
  }

  private needsReparse(l: Leaf, content: string): boolean {
    const alone = parseBlocks(content);
    const first = alone[0];
    const consistent =
      alone.length === 1 && first.chain.length === 0 && first.type === l.type && (first.level ?? 0) === (l.level ?? 0);
    if (consistent) return false;
    if (!content) return false;
    if (!first) return false;
    if (HOLD_TYPES.has(first.type) && first.type !== l.type) return false;
    if (HOLD_RE.test(content.split('\n')[0])) return false;
    return true;
  }

  /** Replace the source of a widget leaf with widget raw (no prefixes, '\n' endings). */
  setWidgetRaw(i: number, raw: string): Edit {
    const l = this.leaves[i];
    const from = this.start(i);
    const oldRaw = leafRaw(l);
    const finalEol = raw.endsWith('\n');
    const texts = (finalEol ? raw.slice(0, -1) : raw).split('\n');
    // Trailing blank lines align with the old trailing lines from the end.
    let t = 0;
    while (t < texts.length - 1 && isBlank(texts[texts.length - 1 - t])) t++;
    const body = texts.slice(0, texts.length - t);
    const oldTrail = l.lines.slice(l.n);
    const lines = this.buildLines(l, body, true);
    for (let j = 0; j < t; j++) {
      const o = oldTrail[oldTrail.length - t + j];
      const text = texts[body.length + j];
      lines.push({ prefix: o ? o.prefix : contPrefix(l.chain, true), text, eol: o?.eol || this.eol });
    }
    if (!(finalEol || i + 1 < this.leaves.length)) lines[lines.length - 1].eol = '';
    const newRaw = serializeLeaves([{ lines }]);
    if (newRaw === oldRaw) return { from, to: from, before: '', after: '' };
    return this.replace(from, from + oldRaw.length, newRaw);
  }

  /**
   * Lines for `texts`, reusing old content-line prefixes / endings by index.
   * Extra lines copy the last old continuation prefix (or synthesize one).
   */
  buildLines(l: Leaf, texts: string[], finalEol: boolean, reuse = l.n): Line[] {
    const cont = reuse >= 2 ? l.lines[reuse - 1].prefix : null;
    return texts.map((text, k) => {
      const o = k < reuse ? l.lines[k] : undefined;
      const prefix = o ? o.prefix : cont !== null && !isBlank(text) ? cont : contPrefix(l.chain, text === '');
      const last = k === texts.length - 1;
      const eol = last && !finalEol ? '' : o?.eol || this.eol;
      return { prefix, text, eol };
    });
  }

  /** Link reference definitions. */
  refs(): RefMap {
    if (this.refsCache) return this.refsCache;
    const m = new Map<string, { href: string; title?: string }>();
    for (const l of this.leaves) {
      if (l.type !== 'def') continue;
      const r = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:\s*<?([^\s>]*)>?(?:\s+["'(](.*)["')])?\s*$/.exec(leafContent(l));
      if (r && !m.has(normLabel(r[1]))) m.set(normLabel(r[1]), { href: r[2], title: r[3] });
    }
    this.refsCache = m;
    return m;
  }
}

const isBlankLeafText = (l: Leaf) => l.type === 'paragraph' && l.n === 1 && isBlank(l.lines[0].text);

/**
 * Find-bar match bookkeeping over the editor DOM (no contract API for counts, #23):
 * every occurrence inside the editable text (`.md-content`, whose text is the block's
 * markdown source) is collected as a Range, painted with the CSS Custom Highlight API
 * when available, and the current match is the one equal to the editor selection.
 */

const HL_ALL = 'margin-find';
const HL_CUR = 'margin-find-current';

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
const registry = (): HighlightRegistry | null =>
  (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;
const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

export interface FindOpts {
  caseSensitive: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/** Same matcher as the editor core's find (#96): escaped literal or regex, optional whole-word guard. */
export function queryRegExp(query: string, o: FindOpts): RegExp | null {
  if (!query) return null;
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, 'gu' + (o.caseSensitive ? '' : 'i') + (o.regex ? 'm' : ''));
  } catch {
    return null;
  }
}

/** Collect ranges of `query` in the text containers under `root`, in document order. */
export function findRanges(root: ParentNode, query: string, opts: boolean | FindOpts): Range[] {
  const o: FindOpts = typeof opts === 'boolean' ? { caseSensitive: opts } : opts;
  const re = queryRegExp(query, o);
  if (!re) return [];
  const out: Range[] = [];
  for (const box of root.querySelectorAll('.md-content')) {
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = '';
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      nodes.push(n);
      starts.push(text.length);
      text += n.data;
    }
    if (!nodes.length) continue;
    const at = (pos: number, end: boolean): [Text, number] => {
      let k = nodes.length - 1;
      while (k > 0 && (starts[k] > pos || (end && starts[k] === pos))) k--;
      return [nodes[k], pos - starts[k]];
    };
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      const r = document.createRange();
      r.setStart(...at(m.index, false));
      r.setEnd(...at(m.index + m[0].length, true));
      out.push(r);
    }
  }
  return out;
}

const samePoint = (a: Range, b: Range) =>
  a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;

/** Index of the range matching `sel` (same text span), or -1. */
export function currentIndex(ranges: Range[], sel: Range | null): number {
  if (!sel) return -1;
  const i = ranges.findIndex((r) => samePoint(r, sel));
  if (i >= 0) return i;
  // Boundary points may differ (end of one text node vs start of the next): compare text spans.
  return ranges.findIndex((r) => r.toString() === sel.toString() && r.compareBoundaryPoints(Range.START_TO_START, sel) <= 0 && r.compareBoundaryPoints(Range.END_TO_END, sel) >= 0);
}

export function paintMatches(all: Range[], current: Range | null): void {
  const reg = registry();
  if (!reg || !HighlightCtor) return;
  if (all.length) reg.set(HL_ALL, new HighlightCtor(...all)); else reg.delete(HL_ALL);
  if (current) reg.set(HL_CUR, new HighlightCtor(current));
  else reg.delete(HL_CUR);
}

export function clearMatches(): void {
  const reg = registry();
  reg?.delete(HL_ALL);
  reg?.delete(HL_CUR);
}

export function matchStatus(count: number, index: number): string {
  if (!count) return 'No results';
  return index >= 0 ? `${index + 1} of ${count}` : count === 1 ? '1 match' : `${count} matches`;
}

/**
 * Subsequence fuzzy matcher for Quick Open / command palette.
 * Scores: consecutive runs, word-boundary hits, basename hits, and short targets win.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the target string of matched characters (ascending). */
  indices: number[];
}

const BOUNDARY = /[\s/\\_\-.:()[\]]/;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (BOUNDARY.test(prev)) return true;
  // camelCase boundary
  const c = text[i];
  return prev === prev.toLowerCase() && c !== c.toLowerCase() && c === c.toUpperCase();
}

/**
 * Match `query` against `text`. Whitespace in the query is ignored.
 * Returns null when not every query char appears in order.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const n = t.length;
  const m = q.length;
  if (m > n) return null;

  // Quick reject.
  {
    let j = 0;
    for (let i = 0; i < n && j < m; i++) if (t[i] === q[j]) j++;
    if (j < m) return null;
  }

  // DP over (query idx, text idx) keeping best score ending with a match at text idx.
  const NEG = -1e9;
  const lastSep = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  const score: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let j = 0; j < m; j++) {
    score.push(new Float64Array(n).fill(NEG));
    from.push(new Int32Array(n).fill(-1));
  }
  const charBonus = (i: number): number => {
    let b = 1;
    if (isBoundary(text, i)) b += 6;
    if (i > lastSep) b += 2; // in basename
    return b;
  };
  for (let i = 0; i < n; i++) {
    if (t[i] !== q[0]) continue;
    score[0][i] = charBonus(i) - Math.min(i, 20) * 0.15;
  }
  for (let j = 1; j < m; j++) {
    let best = NEG;
    let bestK = -1;
    for (let i = j; i < n; i++) {
      // best predecessor among k < i (excluding i-1, handled as consecutive)
      const k = i - 2;
      if (k >= 0 && score[j - 1][k] > best) {
        best = score[j - 1][k];
        bestK = k;
      }
      if (t[i] !== q[j]) continue;
      const bonus = charBonus(i);
      let s = NEG;
      let f = -1;
      if (score[j - 1][i - 1] > NEG) {
        s = score[j - 1][i - 1] + bonus + 5; // consecutive
        f = i - 1;
      }
      if (bestK >= 0) {
        const gap = i - bestK - 1;
        const s2 = best + bonus - Math.min(gap, 10) * 0.3 - 1;
        if (s2 > s) {
          s = s2;
          f = bestK;
        }
      }
      score[j][i] = s;
      from[j][i] = f;
    }
  }
  let bestI = -1;
  let bestS = NEG;
  for (let i = 0; i < n; i++) {
    if (score[m - 1][i] > bestS) {
      bestS = score[m - 1][i];
      bestI = i;
    }
  }
  if (bestI < 0) return null;
  const indices: number[] = new Array(m);
  for (let j = m - 1, i = bestI; j >= 0; j--) {
    indices[j] = i;
    i = from[j][i];
  }
  // Prefer shorter targets and exact-case substring hits.
  let total = bestS - n * 0.02;
  if (text.includes(query.trim())) total += 3;
  return { score: total, indices };
}

/** Filter + sort items by fuzzy score. Stable for equal scores. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  limit = Infinity,
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; idx: number }[] = [];
  items.forEach((item, idx) => {
    const match = fuzzyMatch(query, key(item));
    if (match) out.push({ item, match, idx });
  });
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score || a.idx - b.idx);
  return out.slice(0, limit).map(({ item, match }) => ({ item, match }));
}

/** Split text into segments for highlighting. */
export function highlightSegments(text: string, indices: readonly number[]): { text: string; hit: boolean }[] {
  const set = new Set(indices);
  const segs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = segs[segs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else segs.push({ text: text[i], hit });
  }
  return segs;
}

/** Render highlighted text into an element using <mark> for hits. */
export function renderHighlighted(el: HTMLElement, text: string, indices: readonly number[]): void {
  el.textContent = '';
  for (const seg of highlightSegments(text, indices)) {
    if (seg.hit) {
      const m = document.createElement('mark');
      m.textContent = seg.text;
      el.appendChild(m);
    } else el.appendChild(document.createTextNode(seg.text));
  }
}

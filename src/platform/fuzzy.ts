/**
 * Fuzzy file ranking for Quick Open. Same algorithm as `src-tauri/src/quick_open.rs`
 * so the web build behaves like the desktop app.
 */

const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|txt)$/i;

export function isMarkdownPath(p: string): boolean {
  return MD_EXT.test(p);
}

/** Case-fold one char; a longer lowercase form (`İ` → `i̇`) keeps its first char. */
const fold = (c: string): string => Array.from(c.toLowerCase())[0] ?? c;

/** NFC (macOS/zip names are often NFD), no whitespace, case-folded chars. */
export function foldQuery(query: string): string[] {
  return Array.from(query.normalize('NFC').replace(/\s+/g, '')).map(fold);
}

function isBoundary(prev: string | undefined, cur: string): boolean {
  if (prev === undefined) return true;
  if ('/\\_-. '.includes(prev)) return true;
  return prev !== prev.toUpperCase() && cur !== cur.toLowerCase(); // camelCase hump
}

function scoreIn(q: string[], text: string): number | null {
  const chars = Array.from(text);
  const lower = chars.map(fold);
  let qi = 0;
  let end = -1;
  for (let i = 0; i < lower.length; i++) {
    if (qi < q.length && lower[i] === q[qi]) {
      qi++;
      if (qi === q.length) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const pos = new Array<number>(q.length);
  let qj = q.length;
  for (let i = end; qj > 0 && i >= 0; i--) {
    if (lower[i] === q[qj - 1]) pos[--qj] = i;
  }
  let s = 0;
  for (let k = 0; k < pos.length; k++) {
    const p = pos[k];
    s += 10;
    if (isBoundary(p === 0 ? undefined : chars[p - 1], chars[p])) s += 8;
    if (k > 0) {
      const gap = p - pos[k - 1] - 1;
      s += gap === 0 ? 12 : -Math.min(gap, 10);
    }
  }
  s -= Math.trunc(Math.min(pos[0], 15) / 3);
  s -= Math.trunc(chars.length / 20);
  return s;
}

/** Score `candidate` (a relative path) for lowercase query chars; null = no match. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = foldQuery(query);
  candidate = candidate.normalize('NFC');
  const nameStart = candidate.lastIndexOf('/') + 1;
  const name = candidate.slice(nameStart);
  const inName = scoreIn(q, name);
  if (inName !== null) {
    const dot = name.lastIndexOf('.');
    const stem = Array.from(dot > 0 ? name.slice(0, dot) : name).map(fold).join('');
    return inName + 40 + (stem === q.join('') ? 100 : 0);
  }
  return scoreIn(q, candidate);
}

const depth = (p: string) => p.split('/').length - 1;

/** Markdown first, then score, then shallower/shorter paths. */
export function rankPaths(files: string[], query: string, limit = 50): string[] {
  const q = query.replace(/\s+/g, '');
  const scored: { md: boolean; s: number; f: string }[] = [];
  for (const f of files) {
    const s = q ? fuzzyScore(q, f) : 0;
    if (s !== null) scored.push({ md: isMarkdownPath(f), s, f });
  }
  scored.sort(
    (a, b) =>
      Number(b.md) - Number(a.md) ||
      b.s - a.s ||
      depth(a.f) - depth(b.f) ||
      a.f.length - b.f.length ||
      (a.f < b.f ? -1 : a.f > b.f ? 1 : 0),
  );
  return scored.slice(0, limit).map((x) => x.f);
}

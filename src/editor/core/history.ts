/**
 * Undo/redo: each entry is the minimal text replacement between two document
 * states plus the caret before/after. Typing in the same block within
 * `COALESCE_MS` is merged into one entry.
 */
export type Sel = { anchor: number; focus: number } | null;

export interface Entry {
  from: number;
  before: string;
  after: string;
  selBefore: Sel;
  selAfter: Sel;
  t: number;
  key: string | null;
}

export const COALESCE_MS = 1500;
const LIMIT = 1000;

/** Minimal replacement turning `a` into `b`. */
export function diff(a: string, b: string): { from: number; before: string; after: string } | null {
  if (a === b) return null;
  let s = 0;
  const n = Math.min(a.length, b.length);
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { from: s, before: a.slice(s, a.length - e), after: b.slice(s, b.length - e) };
}

export class History {
  undos: Entry[] = [];
  redos: Entry[] = [];
  private seal = false;

  clear(): void {
    this.undos = [];
    this.redos = [];
  }

  /** Break coalescing (caret moved, command executed…). */
  break(): void {
    this.seal = true;
  }

  /**
   * Record the change textBefore → textAfter. `hint` (a known replaced region,
   * e.g. one leaf's source) bounds the diff so typing stays O(edited block).
   */
  record(
    textBefore: string,
    textAfter: string,
    selBefore: Sel,
    selAfter: Sel,
    key: string | null,
    now = Date.now(),
    hint?: { from: number; before: string; after: string },
  ): void {
    let d: { from: number; before: string; after: string } | null;
    if (hint) {
      const r = diff(hint.before, hint.after);
      d = r && { ...r, from: r.from + hint.from };
    } else d = diff(textBefore, textAfter);
    if (!d) return;
    this.redos = [];
    const last = this.undos[this.undos.length - 1];
    if (key && last && !this.seal && last.key === key && now - last.t < COALESCE_MS) {
      // Merge in textBefore (= state after `last`) coordinates.
      const r1s = last.from;
      const r1e = last.from + last.after.length;
      const r2s = d.from;
      const r2e = d.from + d.before.length;
      const u0 = Math.min(r1s, r2s);
      const u1 = Math.max(r1e, r2e);
      last.before = textBefore.slice(u0, r1s) + last.before + textBefore.slice(r1e, u1);
      last.after = textAfter.slice(u0, u1 + d.after.length - d.before.length);
      last.from = u0;
      last.selAfter = selAfter;
      last.t = now;
      return;
    }
    this.seal = false;
    this.undos.push({ ...d, selBefore, selAfter, t: now, key });
    if (this.undos.length > LIMIT) this.undos.shift();
  }

  popUndo(): Entry | undefined {
    const e = this.undos.pop();
    if (e) this.redos.push(e);
    this.seal = true;
    return e;
  }

  popRedo(): Entry | undefined {
    const e = this.redos.pop();
    if (e) this.undos.push(e);
    this.seal = true;
    return e;
  }
}

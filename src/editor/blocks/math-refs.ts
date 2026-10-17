/**
 * Equation labels, numbers and references (#7).
 *
 * KaTeX knows neither `\label` nor `\ref`/`\eqref`, so they are handled here:
 * `\label{x}` is stripped before rendering and recorded for its math block;
 * `\ref{x}` / `\eqref{x}` are substituted with the label's equation number.
 * A block's number is its `\tag{…}` or, with numbering on, its position among
 * the numbered blocks in document order. Numbers are written to `data-eq` on the
 * preview (shown by CSS) and references re-render when the label map changes.
 */

interface Entry {
  el: HTMLElement;
  labels: string[];
  tag: string | null;
  numbered: boolean;
  number: string | null;
}

const entries = new Map<HTMLElement, Entry>();
const refListeners = new Map<HTMLElement, () => void>();
let labelMap = new Map<string, string>();
let signature = '';
let scheduled = false;

const LABEL_RE = /\\label\s*\{([^{}]*)\}/g;
const REF_RE = /\\(eq)?ref\s*\{([^{}]*)\}/g;
const TAG_RE = /\\tag\*?\s*\{([^{}]*)\}/;

/** Remove `\label{…}` commands; returns the cleaned TeX and the label names. */
export function stripLabels(tex: string): { tex: string; labels: string[] } {
  const labels: string[] = [];
  const out = tex.replace(LABEL_RE, (_m, name: string) => {
    labels.push(name.trim());
    return '';
  });
  return { tex: out, labels };
}

export function hasRefs(tex: string): boolean {
  REF_RE.lastIndex = 0;
  return REF_RE.test(tex);
}

const texText = (s: string) => s.replace(/[\\{}$&#^_%~]/g, '');

/** Replace `\ref{x}` / `\eqref{x}` with the number of label x (`??` when unknown). */
export function substituteRefs(tex: string, lookup: (name: string) => string | null = resolveLabel): string {
  return tex.replace(REF_RE, (_m, eq: string | undefined, name: string) => {
    const n = texText(lookup(name.trim()) ?? '??');
    return eq ? `\\text{(${n})}` : `\\text{${n}}`;
  });
}

export function resolveLabel(name: string): string | null {
  return labelMap.get(name) ?? null;
}

/** Record the labels/tag of a math block whose preview element is `el`. */
export function registerEquation(el: HTMLElement, tex: string, numbered: boolean): string[] {
  const { labels } = stripLabels(tex);
  const tag = TAG_RE.exec(tex)?.[1]?.trim() ?? null;
  const prev = entries.get(el);
  entries.set(el, { el, labels, tag, numbered: numbered && tag === null, number: prev?.number ?? null });
  schedule();
  return labels;
}

/** Re-render callback for something that contains references (null to remove). */
export function onLabelsChanged(el: HTMLElement, fn: (() => void) | null): void {
  if (fn) refListeners.set(el, fn);
  else refListeners.delete(el);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(recompute, 0);
}

/** Recompute numbers and labels now (also called by export). */
export function recompute(): void {
  scheduled = false;
  const list = [...entries.values()].filter((e) => {
    if (e.el.isConnected) return true;
    entries.delete(e.el);
    return false;
  });
  list.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  let n = 0;
  const map = new Map<string, string>();
  for (const e of list) {
    e.number = e.tag ?? (e.numbered ? String(++n) : null);
    if (e.number !== null) e.el.dataset.eq = e.number;
    else delete e.el.dataset.eq;
    for (const l of e.labels) if (e.number !== null && !map.has(l)) map.set(l, e.number);
  }
  const sig = JSON.stringify([...map]);
  labelMap = map;
  if (sig === signature) return;
  signature = sig;
  for (const [el, fn] of [...refListeners]) {
    if (el.isConnected) fn();
    else refListeners.delete(el);
  }
}

/** Current number of a registered equation preview (null when unnumbered). */
export function equationNumber(el: HTMLElement): string | null {
  return entries.get(el)?.number ?? null;
}

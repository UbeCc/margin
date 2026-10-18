/** Tiny DOM helpers shared by the block widgets. */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> | null = null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Trailing-edge debounce with `flush`/`cancel`. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const d = (...a: A) => {
    last = a;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      const args = last!;
      last = null;
      fn(...args);
    }, ms);
  };
  d.flush = () => {
    if (t && last) {
      clearTimeout(t);
      t = null;
      const args = last;
      last = null;
      fn(...args);
    }
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
    last = null;
  };
  return d;
}

/**
 * Keep editing keystrokes inside a widget from reaching the core's contenteditable
 * handlers. Keys with Cmd/Ctrl/Alt bubble on (app shortcuts such as Cmd+S) unless
 * the widget already handled them (defaultPrevented).
 */
export function isolateEvents(root: HTMLElement): void {
  const stop = (e: Event) => e.stopPropagation();
  for (const t of ['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'cut', 'copy', 'drop', 'keypress', 'keyup']) {
    root.addEventListener(t, stop);
  }
  root.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey || e.altKey)) e.stopPropagation();
  });
}

/** Text offset inside `container` for a click at (x, y), or null. */
export function offsetAtPoint(container: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null; caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  let node: Node | null = null;
  let off = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) [node, off] = [p.offsetNode, p.offset];
  } else if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) [node, off] = [r.startContainer, r.startOffset];
  }
  if (!node || !container.contains(node)) return null;
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, off);
  return r.toString().length;
}

/**
 * Copy plain text synchronously through a `copy` event (works inside the user
 * gesture of a menu / key / click), falling back to the async Clipboard API.
 */
export function copyText(text: string): void {
  let done = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData.setData('text/plain', text);
    done = true;
  };
  document.addEventListener('copy', onCopy, { capture: true });
  try {
    document.execCommand('copy');
  } catch {
    /* refused */
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true });
  }
  if (!done) void navigator.clipboard?.writeText(text).catch(() => undefined);
}

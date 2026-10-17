/**
 * Text ↔ DOM offset mapping inside a block's `.md-content` element.
 *
 * The source text of a block is the concatenation of its text nodes, except
 * nodes inside `[data-ns]` ("non-source": rendered images, math, checkboxes),
 * where `<br>` counts as '\n' (unless it is the `.md-tail` filler) and a
 * browser-inserted block element (div/p) starts a new line.
 */

const BLOCKISH = new Set(['DIV', 'P', 'LI']);

const isNS = (n: Node) => n.nodeType === 1 && (n as Element).hasAttribute('data-ns');
const isTail = (n: Node) => n.nodeName === 'BR' && (n as Element).classList.contains('md-tail');

/** Visit source pieces of `root` in order. Stops when `fn` returns true. */
function walk(root: Node, fn: (n: Node, text: string) => boolean | void): void {
  let first = true;
  const rec = (n: Node): boolean => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (fn(c, (c as Text).data)) return true;
        first = false;
      } else if (c.nodeType === 1) {
        if (isNS(c)) {
          if (fn(c, '')) return true;
          continue;
        }
        if (c.nodeName === 'BR') {
          if (fn(c, isTail(c) ? '' : '\n')) return true;
          continue;
        }
        if (BLOCKISH.has(c.nodeName) && !first) {
          if (fn(c, '\n')) return true;
        }
        if (rec(c)) return true;
      }
    }
    return false;
  };
  rec(root);
}

/** Source text of a content element. */
export function readText(root: Node): string {
  let s = '';
  walk(root, (_n, t) => {
    s += t;
  });
  return s;
}

/** Source offset of DOM point (node, offset) within root. */
export function pointToOffset(root: Node, node: Node, offset: number): number {
  if (node !== root && !root.contains(node)) return 0;
  const r = (root.ownerDocument || document).createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const idx = (n: Node) => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;
  let acc = 0;
  walk(root, (n, t) => {
    if (n.nodeType === 3) {
      if (n === node) {
        acc += Math.min(offset, t.length);
        return true;
      }
      if (r.comparePoint(n, t.length) > 0) return true;
    } else if (t === '\n' && n.nodeName !== 'BR') {
      if (r.comparePoint(n.parentNode!, idx(n)) >= 0) return true;
    } else if (r.comparePoint(n.parentNode!, idx(n) + 1) > 0) return true;
    acc += t.length;
  });
  return acc;
}

function visible(n: Node): boolean {
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
  if (!el) return false;
  if (typeof el.getClientRects !== 'function') return true;
  return el.getClientRects().length > 0;
}

/** DOM point for source offset `off` (prefers visible text nodes). */
export function offsetToPoint(root: Node, off: number): { node: Node; offset: number } {
  let acc = 0;
  const cands: { node: Node; offset: number }[] = [];
  let lastBreak: { node: Node; offset: number } | null = null;
  walk(root, (n, t) => {
    if (n.nodeType === 3) {
      if (off >= acc && off <= acc + t.length) cands.push({ node: n, offset: off - acc });
    } else if (t === '\n' && n.nodeName === 'BR' && acc + 1 === off) {
      const p = n.parentNode!;
      lastBreak = { node: p, offset: Array.prototype.indexOf.call(p.childNodes, n) + 1 };
    }
    acc += t.length;
    return acc > off && cands.length > 0;
  });
  if (cands.length) {
    // Prefer the end of a visible node before the start of a hidden one etc.
    const vis = cands.filter((c) => visible(c.node));
    const pick = vis.length ? vis : cands;
    // Inside the middle of a node beats a boundary; at a boundary keep the left node.
    return pick.find((c) => c.offset > 0 && c.offset < (c.node as Text).data.length) ?? pick[0];
  }
  if (lastBreak) return lastBreak;
  // Empty content or offset at end after a <br>.
  const tail = root.lastChild && isTail(root.lastChild) ? root.childNodes.length - 1 : root.childNodes.length;
  return { node: root, offset: off <= 0 ? 0 : tail };
}

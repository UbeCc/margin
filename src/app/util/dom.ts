type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Tiny hyperscript: h('div.cls#id', {title:'x', onclick: fn}, ...children). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  attrs?: Attrs | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(tag);
  const name = (m ? m[1] : tag) as K;
  const el = document.createElement(name);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Inline SVG icon (stroke icons, 16px viewbox). */
export function icon(name: keyof typeof ICONS, cls = ''): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  if (cls) svg.classList.add(cls);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.appendChild(path);
  return svg;
}

export const ICONS = {
  sidebar: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  folder: 'M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  chevron: 'M6 4l4 4-4 4',
  plus: 'M8 3v10M3 8h10',
  target: 'M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  search: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l3.5 3.5',
  close: 'M4 4l8 8M12 4l-8 8',
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
  code: 'M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5',
  list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5',
  gear: 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1',
  caseSensitive: 'M2 12l2.5-7 2.5 7M2.8 10h3.4M10.5 8.5a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zM12.2 7.5v4.5',
  wholeWord: 'M1.5 12.5v1.5h13v-1.5M4 4l1.5 6 1.5-4 1.5 4L10 4M12 5.5h1.5',
  regex: 'M11 2.5v5M8.8 3.8l4.4 2.4M8.8 6.2l4.4-2.4M4 11.5h.01',
  pin: 'M9.5 1.5L7.5 3.5 5 3l.5 2.5L3.5 7.5 1.5 5.5 1 6l4 6 .5 3 1.5-1.5L14 5l.5-.5z',
} as const;

export function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const d = ((...a: A) => {
    lastArgs = a;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      const args = lastArgs!;
      lastArgs = null;
      fn(...args);
    }, ms);
  }) as ((...a: A) => void) & { flush(): void; cancel(): void };
  d.flush = () => {
    if (!t) return;
    clearTimeout(t);
    t = null;
    const args = lastArgs!;
    lastArgs = null;
    fn(...args);
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
    lastArgs = null;
  };
  return d;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

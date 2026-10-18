import type { DirEntry, Platform } from '../../contracts';
import { h, clearChildren, icon } from '../util/dom';
import { basename, dirname, relative } from '../util/path';
import { collectDocs } from './walk';
import { queryRegExp } from '../findmatches';

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchHost {
  platform: Platform;
  options(): SearchOptions;
  setOptions(o: SearchOptions): void;
  /** Open a file; with a query, select its `occurrence`-th match (0-based) and highlight all. */
  openAt(path: string, query: string | null, opts: SearchOptions, occurrence: number): void;
}

export interface LineHit {
  line: number;
  text: string;
  /** match offsets inside `text` */
  ranges: [number, number][];
  /** number of matches in the file before this line */
  before: number;
}

/** Folder search limits (fe-sidebar-statusbar-find §7). */
export const MAX_LINES_PER_FILE = 21;
export const VISIBLE_LINES = 5;
export const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
export const SEARCH_MAX_FILES = 5000;

/** Same matcher as the in-document find bar; null for an invalid regular expression. */
export function makeMatcher(q: string, o: SearchOptions): RegExp | null {
  return queryRegExp(q, o);
}

/**
 * Line-based matches (no multi-line), at most 21 matching lines per file. Text
 * before the first match is cut to "..." + the last 20 characters.
 */
export function findLines(text: string, re: RegExp, max = MAX_LINES_PER_FILE): { total: number; hits: LineHit[] } {
  const hits: LineHit[] = [];
  let total = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const raw = lines[i];
    const ranges: [number, number][] = [];
    re.lastIndex = 0;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
    }
    if (!ranges.length) continue;
    const first = ranges[0][0];
    const cut = first > 20 ? first - 20 : 0;
    const prefix = cut ? '...' : '';
    const shift = prefix.length - cut;
    hits.push({ line: i + 1, text: prefix + raw.slice(cut), ranges: ranges.map(([a, b]) => [a + shift, b + shift] as [number, number]), before: total });
    total += ranges.length;
  }
  return { total, hits };
}

/** Header of a result block: the file's parent path (relative to the root) joined with " / ". */
export function groupTitle(root: string, path: string): string {
  const rel = relative(root, dirname(path));
  return [basename(root), ...rel.split(/[\\/]/).filter((p) => p && p !== '.')].join(' / ');
}

/**
 * Sidebar folder search (#101, `typora.sidebar.search`; fe-sidebar-statusbar-find §7):
 * runs on Enter, Match Case / Whole Word / Regular Expression toggles (persisted),
 * one block per file with a "20+" badge, 5 lines shown and "show N more matches".
 */
export class SidebarSearch {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private toggles: Record<keyof SearchOptions, HTMLButtonElement>;
  private status: HTMLElement;
  private results: HTMLElement;
  private root: string | null = null;
  private gen = 0;

  constructor(private host: SearchHost) {
    this.input = h('input.sidebar-search-input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search', spellcheck: 'false' });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.run();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.results.querySelector<HTMLElement>('.search-file, .search-line')?.focus();
      }
    });
    const toggle = (k: keyof SearchOptions, title: string, ico: 'caseSensitive' | 'wholeWord' | 'regex'): HTMLButtonElement =>
      h('button.icon-btn.search-opt', {
        type: 'button',
        title,
        'aria-label': title,
        'aria-pressed': String(host.options()[k]),
        'data-opt': k,
        onclick: () => {
          const o = { ...this.host.options(), [k]: !this.host.options()[k] };
          this.host.setOptions(o);
          this.toggles[k].setAttribute('aria-pressed', String(o[k]));
          if (this.input.value) void this.run();
        },
      }, icon(ico));
    this.toggles = {
      caseSensitive: toggle('caseSensitive', 'Match Case', 'caseSensitive'),
      wholeWord: toggle('wholeWord', 'Whole Word', 'wholeWord'),
      regex: toggle('regex', 'Regular Expression', 'regex'),
    };
    this.status = h('div.search-status', { role: 'status', 'aria-live': 'polite' });
    this.results = h('div.search-results', { role: 'list' });
    this.results.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h(
      'div.sidebar-search',
      null,
      h('div.search-bar', null, icon('search', 'search-icon'), this.input, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regex),
      this.status,
      this.results,
    );
  }

  setRoot(root: string | null): void {
    this.root = root;
    this.gen++;
    clearChildren(this.results);
    this.status.textContent = '';
  }

  /** Focus the field; a selection's first line pre-fills it. */
  focus(seed?: string): void {
    const first = seed?.split(/\r?\n/)[0].trim();
    if (first) this.input.value = first;
    this.input.focus();
    this.input.select();
  }

  /** Cancel a running search and start a new one (Enter). */
  async run(): Promise<void> {
    const gen = ++this.gen;
    const q = this.input.value;
    clearChildren(this.results);
    this.status.textContent = '';
    if (!q || !this.root) return;
    const o = this.host.options();
    const re = makeMatcher(q, o);
    if (!re) {
      this.status.textContent = 'Invalid regular expression';
      return;
    }
    const root = this.root;
    this.el.setAttribute('aria-busy', 'true');
    const { docs } = await collectDocs(this.host.platform, root, { limit: SEARCH_MAX_FILES, maxBytes: SEARCH_MAX_BYTES, cancelled: () => gen !== this.gen });
    if (gen !== this.gen) return;
    const lq = o.caseSensitive ? q : q.toLowerCase();
    let found = 0;
    const queue = [...docs];
    const worker = async (): Promise<void> => {
      for (let d = queue.shift(); d && gen === this.gen; d = queue.shift()) {
        let text = '';
        try {
          text = await this.host.platform.readTextFile(d.path);
        } catch {
          /* skip unreadable */
        }
        if (gen !== this.gen) return;
        const { total, hits } = findLines(text, re);
        // File-name matches count too (literal mode only), with no lines.
        const named = !o.regex && (o.caseSensitive ? d.name : d.name.toLowerCase()).includes(lq);
        if (total || named) {
          found++;
          this.results.appendChild(this.block(d, root, q, o, total, hits));
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (gen !== this.gen) return;
    this.el.removeAttribute('aria-busy');
    if (!found) this.status.textContent = 'No result found.';
  }

  private block(d: DirEntry, root: string, q: string, o: SearchOptions, total: number, hits: LineHit[]): HTMLElement {
    const head = h(
      'button.search-file',
      { type: 'button', role: 'listitem', 'data-path': d.path, title: d.path, onclick: () => this.host.openAt(d.path, total ? q : null, o, 0) },
      h('span.search-file-name', { text: d.name }),
      h('span.search-file-dir', { text: groupTitle(root, d.path) }),
      total ? h('span.search-count', { text: total > 20 ? '20+' : String(total) }) : null,
    );
    const lines = hits.map((hit, i) => {
      const el = h('button.search-line', { type: 'button', 'data-line': hit.line, onclick: () => this.host.openAt(d.path, q, o, hit.before) });
      el.hidden = i >= VISIBLE_LINES;
      let at = 0;
      for (const [a, b] of hit.ranges) {
        if (a < at) continue;
        el.append(hit.text.slice(at, a), h('mark', { text: hit.text.slice(a, b) }));
        at = b;
      }
      el.append(hit.text.slice(at));
      return el;
    });
    const extra = hits.length - VISIBLE_LINES;
    const more =
      extra > 0
        ? h('button.search-more', {
            type: 'button',
            text: `show ${extra} more matches`,
            onclick: (e: Event) => {
              lines.forEach((l) => (l.hidden = false));
              (e.currentTarget as HTMLElement).remove();
            },
          })
        : null;
    return h('div.search-group', { 'data-path': d.path }, head, ...lines, more);
  }

  private onKey(e: KeyboardEvent): void {
    const items = [...this.results.querySelectorAll<HTMLElement>('.search-file, .search-line:not([hidden]), .search-more')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') items[Math.min(items.length - 1, i + 1)]?.focus();
    else if (e.key === 'ArrowUp') (i <= 0 ? this.input : items[i - 1]).focus();
    else return;
    e.preventDefault();
  }
}

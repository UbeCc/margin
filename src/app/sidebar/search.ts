import type { DirEntry, Platform } from '../../contracts';
import { h, clearChildren, debounce, icon } from '../util/dom';
import { dirname, relative, stripExt } from '../util/path';
import { collectDocs } from './walk';

export interface SearchHost {
  platform: Platform;
  /** Open a file and (optionally) find `query` in it. */
  openAt(path: string, query: string | null, caseSensitive: boolean): void;
}

export interface LineHit {
  line: number;
  text: string;
  /** match offsets inside `text` */
  ranges: [number, number][];
}

/** Max documents scanned per search and line hits shown per file. */
export const SEARCH_MAX_FILES = 5000;
export const LINES_PER_FILE = 8;
const SNIPPET = 120;

/** Literal, optionally case-sensitive match of `q` in each line of `text`. */
export function findLines(text: string, q: string, caseSensitive: boolean, max = LINES_PER_FILE): { total: number; hits: LineHit[] } {
  const needle = caseSensitive ? q : q.toLowerCase();
  const hits: LineHit[] = [];
  let total = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hay = caseSensitive ? raw : raw.toLowerCase();
    let at = hay.indexOf(needle);
    if (at < 0) continue;
    const ranges: [number, number][] = [];
    while (at >= 0) {
      ranges.push([at, at + needle.length]);
      total++;
      at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
    if (hits.length >= max) continue;
    // Window the line around the first match.
    const lead = raw.length - raw.trimStart().length;
    const start = Math.max(lead, ranges[0][0] - 30);
    const prefix = start > lead ? '…' : '';
    const text = prefix + raw.slice(start, start + SNIPPET).trimEnd();
    const shift = prefix.length - start;
    hits.push({ line: i + 1, text, ranges: ranges.map(([a, b]) => [a + shift, b + shift] as [number, number]).filter(([a, b]) => a >= prefix.length && b <= text.length) });
  }
  return { total, hits };
}

/**
 * Sidebar full-text search (#101, `typora.sidebar.search`): file-name matches
 * ("File Results") and per-file content matches with line snippets. Results
 * stream in while documents are read ("Gathering more results").
 */
export class SidebarSearch {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private caseBtn: HTMLButtonElement;
  private status: HTMLElement;
  private results: HTMLElement;
  private root: string | null = null;
  private caseSensitive = false;
  private gen = 0;
  private runSoon = debounce(() => void this.run(), 250);

  constructor(private host: SearchHost) {
    this.input = h('input.sidebar-search-input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search', spellcheck: 'false' });
    this.input.addEventListener('input', () => this.runSoon());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.runSoon.cancel();
        void this.run();
      }
    });
    this.caseBtn = h('button.icon-btn.search-case', {
      type: 'button',
      title: 'Match Case',
      'aria-label': 'Match Case',
      'aria-pressed': 'false',
      onclick: () => {
        this.caseSensitive = !this.caseSensitive;
        this.caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
        void this.run();
      },
    }, h('span', { text: 'Aa' }));
    this.status = h('div.search-status', { role: 'status', 'aria-live': 'polite' });
    this.results = h('div.search-results', { role: 'list' });
    this.el = h('div.sidebar-search', null, h('div.search-bar', null, icon('search', 'search-icon'), this.input, this.caseBtn), this.status, this.results);
  }

  setRoot(root: string | null): void {
    this.root = root;
    this.gen++;
    clearChildren(this.results);
    this.status.textContent = '';
    if (this.input.value) this.runSoon();
  }

  focus(seed?: string): void {
    if (seed && !seed.includes('\n')) {
      this.input.value = seed;
      void this.run();
    }
    this.input.focus();
    this.input.select();
  }

  async run(): Promise<void> {
    const gen = ++this.gen;
    const q = this.input.value;
    clearChildren(this.results);
    if (!q.trim() || !this.root) {
      this.status.textContent = '';
      return;
    }
    const root = this.root;
    const cs = this.caseSensitive;
    this.status.textContent = 'Searching';
    this.el.setAttribute('aria-busy', 'true');
    const { docs } = await collectDocs(this.host.platform, root, { limit: SEARCH_MAX_FILES, cancelled: () => gen !== this.gen });
    if (gen !== this.gen) return;
    const lq = cs ? q : q.toLowerCase();
    const named = docs.filter((d) => (cs ? d.name : d.name.toLowerCase()).includes(lq));
    let fileSection: HTMLElement | null = null;
    if (named.length) {
      fileSection = h('div.search-section', null, h('div.search-section-title', { text: 'File Results' }), ...named.map((d) => this.fileRow(d, root, null)));
      this.results.appendChild(fileSection);
    }
    let found = named.length;
    let done = 0;
    const queue = [...docs];
    const worker = async (): Promise<void> => {
      for (let d = queue.shift(); d && gen === this.gen; d = queue.shift()) {
        let text = '';
        try {
          text = await this.host.platform.readTextFile(d.path);
        } catch {
          /* skip unreadable */
        }
        done++;
        if (gen !== this.gen) return;
        const { total, hits } = findLines(text, q, cs);
        if (total) {
          found++;
          this.results.appendChild(this.contentGroup(d, root, q, total, hits));
        }
        this.status.textContent = done < docs.length ? (found ? 'Gathering more results' : 'Searching') : '';
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (gen !== this.gen) return;
    this.el.removeAttribute('aria-busy');
    this.status.textContent = found ? '' : 'No Results';
  }

  private fileRow(d: DirEntry, root: string, q: string | null): HTMLElement {
    const dir = dirname(d.path);
    return h(
      'button.search-file',
      { type: 'button', role: 'listitem', 'data-path': d.path, title: d.path, onclick: () => this.host.openAt(d.path, q, this.caseSensitive) },
      h('span.search-file-name', { text: stripExt(d.name) }),
      dir !== root ? h('span.search-file-dir', { text: relative(root, dir) }) : null,
    );
  }

  private contentGroup(d: DirEntry, root: string, q: string, total: number, hits: LineHit[]): HTMLElement {
    const head = this.fileRow(d, root, q);
    head.appendChild(h('span.search-count', { text: String(total) }));
    const lines = hits.map((hit) => {
      const el = h('button.search-line', { type: 'button', 'data-line': hit.line, onclick: () => this.host.openAt(d.path, q, this.caseSensitive) });
      let at = 0;
      for (const [a, b] of hit.ranges) {
        if (a < at) continue;
        el.append(hit.text.slice(at, a), h('mark', { text: hit.text.slice(a, b) }));
        at = b;
      }
      el.append(hit.text.slice(at));
      return el;
    });
    return h('div.search-group', { 'data-path': d.path }, head, ...lines);
  }
}

import type { EditorCommand, EditorHandle } from '../contracts';
import { h, icon } from './util/dom';
import { clearMatches, currentIndex, findRanges, matchStatus, paintMatches, queryRegExp, type FindOpts } from './findmatches';

/** Find / replace bar docked at the top of the editor area. */
export class FindBar {
  readonly el: HTMLElement;
  private query: HTMLInputElement;
  private replacement: HTMLInputElement;
  private status: HTMLElement;
  private caseBtn: HTMLButtonElement;
  private caseSensitive = false;
  private wordBtn: HTMLButtonElement;
  private regexBtn: HTMLButtonElement;
  private wholeWord = false;
  private regex = false;

  constructor(
    private editor: () => EditorHandle,
    private host: () => HTMLElement | null = () => document.querySelector<HTMLElement>('.md-editor'),
  ) {
    this.query = h('input.find-input', { type: 'text', placeholder: 'Find', 'aria-label': 'Find', spellcheck: 'false' });
    this.replacement = h('input.find-input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' });
    this.status = h('span.find-status', { 'aria-live': 'polite' });
    this.caseBtn = h('button.icon-btn.find-case', { type: 'button', title: 'Match Case', 'aria-label': 'Match Case', 'aria-pressed': 'false', onclick: () => this.toggleCase() }, icon('caseSensitive'));
    const toggle = (label: string, cls: string, ic: Parameters<typeof icon>[0], flip: () => boolean): HTMLButtonElement => {
      const b: HTMLButtonElement = h(`button.icon-btn.${cls}`, {
        type: 'button',
        title: label,
        'aria-label': label,
        'aria-pressed': 'false',
        onclick: () => {
          const on = flip();
          b.setAttribute('aria-pressed', String(on));
          b.classList.toggle('on', on);
          this.refresh(null);
        },
      }, icon(ic));
      return b;
    };
    this.wordBtn = toggle('Whole Word', 'find-word', 'wholeWord', () => (this.wholeWord = !this.wholeWord));
    this.regexBtn = toggle('Regular Expression', 'find-regex', 'regex', () => (this.regex = !this.regex));
    const btn = (label: string, ic: Parameters<typeof icon>[0], run: () => void): HTMLButtonElement =>
      h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, onclick: run }, icon(ic));
    const textBtn = (label: string, cls: string, run: () => void): HTMLButtonElement =>
      h('button.btn.btn-small', { type: 'button', class: cls, text: label, onclick: run });

    this.el = h(
      'div.findbar',
      { role: 'search', hidden: true },
      h(
        'div.find-row',
        null,
        h('span.find-field', null, icon('search', 'find-icon'), this.query),
        this.caseBtn,
        this.wordBtn,
        this.regexBtn,
        this.status,
        btn('Previous Match (⇧↩)', 'up', () => this.find(true)),
        btn('Next Match (↩)', 'down', () => this.find(false)),
        btn('Close (Esc)', 'close', () => this.close()),
      ),
      h(
        'div.find-row.replace-row',
        null,
        h('span.find-field', null, this.replacement),
        textBtn('Replace', 'find-replace-one', () => this.replace(false)),
        textBtn('All', 'find-replace-all', () => this.replace(true)),
      ),
    );
    this.query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.find(e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.query.addEventListener('input', () => {
      this.el.classList.remove('no-match');
      this.refreshSoon();
    });
    this.replacement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.replace(e.metaKey || e.ctrlKey || e.altKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(replace: boolean): void {
    this.el.hidden = false;
    this.el.classList.toggle('with-replace', replace);
    const sel = window.getSelection()?.toString() ?? '';
    const ta = document.activeElement;
    const taSel =
      ta instanceof HTMLTextAreaElement ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    const seed = (taSel || sel).trim();
    if (seed && !seed.includes('\n') && seed.length < 200) this.query.value = seed;
    (replace && this.query.value ? this.replacement : this.query).focus();
    (replace && this.query.value ? this.replacement : this.query).select();
    this.refresh();
  }

  /** Open the bar with `query` (sidebar search results) and select its first match. */
  searchFor(query: string, caseSensitive: boolean): boolean {
    this.el.hidden = false;
    this.el.classList.remove('with-replace');
    this.query.value = query;
    if (caseSensitive !== this.caseSensitive) this.toggleCase();
    this.editor().exec({ kind: 'jump', to: 'top' });
    const ok = this.find();
    this.refresh();
    return ok;
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.status.textContent = '';
    this.el.classList.remove('no-match');
    clearMatches();
    this.editor().focus();
  }

  private toggleCase(): void {
    this.caseSensitive = !this.caseSensitive;
    this.caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
    this.caseBtn.classList.toggle('on', this.caseSensitive);
    this.refresh(null);
  }

  private opts(): FindOpts {
    return { caseSensitive: this.caseSensitive, wholeWord: this.wholeWord, regex: this.regex };
  }

  private refreshTimer = 0;
  /** Live count while typing, off the keystroke path (large docs; keeps the field's undo grouping). */
  private refreshSoon(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(null), 120);
  }

  /** Recount and repaint matches (after typing in the bar or a document change). */
  refresh(sel: Range | null = this.selectionRange()): void {
    clearTimeout(this.refreshTimer);
    if (!this.isOpen) return;
    const q = this.query.value;
    if (!q) {
      clearMatches();
      this.setStatus('');
      return;
    }
    const ed = this.editor();
    const host = this.host();
    if (ed.isSourceMode() || !host) {
      clearMatches();
      const re = queryRegExp(q, this.opts());
      const n = re ? [...ed.getMarkdown().matchAll(re)].filter((m) => m[0].length).length : 0;
      this.setStatus(re ? matchStatus(n, -1) : 'Invalid pattern');
      return;
    }
    if (!queryRegExp(q, this.opts())) {
      clearMatches();
      this.setStatus('Invalid pattern');
      return;
    }
    const ranges = findRanges(host, q, this.opts());
    const i = currentIndex(ranges, sel);
    paintMatches(ranges, i >= 0 ? ranges[i] : null);
    this.setStatus(matchStatus(ranges.length, i));
  }

  /** Only touch the DOM on change: any mutation while typing breaks Chromium's undo coalescing of the field. */
  private setStatus(text: string): void {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  private selectionRange(): Range | null {
    const s = window.getSelection();
    const host = this.host();
    if (!s?.rangeCount || !host || !host.contains(s.anchorNode)) return null;
    return s.getRangeAt(0).cloneRange();
  }

  /**
   * The editor focuses itself when it selects a match. Record that selection (the core
   * learns it from selectionchange, which would otherwise arrive after we refocus), then
   * give focus back to the bar so Enter keeps searching instead of typing into the doc.
   */
  private afterExec(keep: HTMLInputElement | null, ok: boolean): void {
    const sel = this.selectionRange();
    if (keep) {
      document.dispatchEvent(new Event('selectionchange'));
      keep.focus({ preventScroll: true });
    }
    this.refresh(ok ? sel : null);
  }

  find(backwards = false): boolean {
    const q = this.query.value;
    if (!q) return false;
    const keep = this.fieldFocus();
    const ok = this.editor().exec({ kind: 'find', query: q, ...this.opts(), backwards });
    this.el.classList.toggle('no-match', !ok);
    this.afterExec(keep, ok);
    if (!ok) this.status.textContent = 'No results';
    return ok;
  }

  /** The editor focuses itself when it selects a match; give focus back to the bar so Enter keeps searching. */
  private fieldFocus(): HTMLInputElement | null {
    const a = document.activeElement;
    return a === this.query || a === this.replacement ? (a as HTMLInputElement) : null;
  }

  replace(all: boolean): void {
    const q = this.query.value;
    if (!q) return;
    const keep = this.fieldFocus();
    const ok = this.editor().exec({ kind: 'replace', query: q, replacement: this.replacement.value, all, ...this.opts() } as EditorCommand);
    this.el.classList.toggle('no-match', !ok);
    this.afterExec(keep, ok && !all);
    if (!ok) this.status.textContent = 'No results';
    else if (all) this.status.textContent = 'Replaced all';
  }
}

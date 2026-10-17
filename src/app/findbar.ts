import type { EditorHandle } from '../contracts';
import { h, icon } from './util/dom';

/** Find / replace bar docked at the top of the editor area. */
export class FindBar {
  readonly el: HTMLElement;
  private query: HTMLInputElement;
  private replacement: HTMLInputElement;
  private status: HTMLElement;
  private caseBtn: HTMLButtonElement;
  private caseSensitive = false;

  constructor(private editor: () => EditorHandle) {
    this.query = h('input.find-input', { type: 'text', placeholder: 'Find', 'aria-label': 'Find', spellcheck: 'false' });
    this.replacement = h('input.find-input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' });
    this.status = h('span.find-status', { 'aria-live': 'polite' });
    this.caseBtn = h('button.icon-btn.find-case', { type: 'button', title: 'Match Case', 'aria-label': 'Match Case', 'aria-pressed': 'false', onclick: () => this.toggleCase() }, icon('caseSensitive'));
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
      this.status.textContent = '';
      this.el.classList.remove('no-match');
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
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.status.textContent = '';
    this.el.classList.remove('no-match');
    this.editor().focus();
  }

  private toggleCase(): void {
    this.caseSensitive = !this.caseSensitive;
    this.caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
    this.caseBtn.classList.toggle('on', this.caseSensitive);
  }

  find(backwards = false): boolean {
    const q = this.query.value;
    if (!q) return false;
    const ok = this.editor().exec({ kind: 'find', query: q, caseSensitive: this.caseSensitive, backwards });
    this.el.classList.toggle('no-match', !ok);
    this.status.textContent = ok ? '' : 'No results';
    return ok;
  }

  replace(all: boolean): void {
    const q = this.query.value;
    if (!q) return;
    const ok = this.editor().exec({ kind: 'replace', query: q, replacement: this.replacement.value, all });
    this.el.classList.toggle('no-match', !ok);
    this.status.textContent = ok ? (all ? 'Replaced all' : '') : 'No results';
  }
}

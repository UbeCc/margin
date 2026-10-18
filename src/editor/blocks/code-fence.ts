/**
 * code_fence widget: a lazily created CodeMirror 6 editor per fence.
 *
 * Until the fence scrolls near the viewport (IntersectionObserver) or is clicked /
 * focused, it is a static, syntax-highlighted <pre>. The info string is edited in a
 * small language box; fence chars/length/indent/info/trailing lines round-trip.
 */
import type { BlockWidget, EditorSettings, WidgetContext, WidgetInstance } from '../../contracts';
import { createCodeEditor, CodeEditor, languageNames, loadLanguage, loadedLanguage } from './cm/setup';
import { highlightToHtml } from './cm/highlight';
import { indentRange } from '@codemirror/language';
import { indentSelection } from '@codemirror/commands';
import { buildFenceRaw, FenceParts, parseFence, rawRangeToBody, withFenceInfo } from './util/delimited';
import { copyText, escapeHtml, h, isolateEvents, offsetAtPoint } from './util/dom';

export interface CodeFenceOptions {
  /** Show line numbers in every fence (per-fence: info `{.numberLines}`). */
  lineNumbers?: boolean;
  /** Create editors eagerly when near the viewport (default true). If false, only on click/focus. */
  lazyByViewport?: boolean;
}

let observer: IntersectionObserver | null = null;
const observed = new WeakMap<Element, () => void>();
function observe(el: Element, cb: () => void) {
  if (typeof IntersectionObserver === 'undefined') return false;
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const f = observed.get(e.target);
          observer!.unobserve(e.target);
          observed.delete(e.target);
          f?.();
        }
      },
      { rootMargin: '300px 0px' },
    );
  }
  observed.set(el, cb);
  observer.observe(el);
  return true;
}
function unobserve(el: Element) {
  observed.delete(el);
  observer?.unobserve(el);
}

let datalist: HTMLDataListElement | null = null;
function ensureDatalist(): string {
  if (!datalist || !datalist.isConnected) {
    datalist = h('datalist', { id: 'mb-lang-list' });
    for (const n of languageNames()) datalist.append(h('option', { value: n }));
    document.body.append(datalist);
  }
  return datalist.id;
}

function wantsLineNumbers(info: string, global: boolean): boolean {
  if (/\.(numberLines|number-lines|line-numbers)\b/.test(info)) return true;
  if (/\.(nonumberLines|no-line-numbers)\b/.test(info)) return false;
  return global;
}

export function staticCodeHTML(p: FenceParts, scheme?: 'light' | 'dark'): string {
  const code = highlightToHtml(p.body, loadedLanguage(p.lang));
  const lang = escapeHtml(p.lang);
  const sch = scheme === 'dark' ? ' data-scheme="dark"' : '';
  return `<pre class="md-fences"${lang ? ` lang="${lang}"` : ''}${sch}><code${lang ? ` class="language-${lang}"` : ''}>${code}</code></pre>`;
}

class CodeFenceInstance implements WidgetInstance {
  private raw: string;
  private parts: FenceParts;
  private settings: EditorSettings;
  private root: HTMLElement;
  private body: HTMLElement;
  private langInput: HTMLInputElement;
  private copyBtn: HTMLButtonElement;
  private staticPre: HTMLPreElement | null = null;
  private editor: CodeEditor | null = null;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    private ctx: WidgetContext,
    private opts: CodeFenceOptions,
  ) {
    this.raw = ctx.raw;
    this.parts = parseFence(ctx.raw);
    this.settings = ctx.settings;
    this.langInput = h('input', {
      class: 'mb-lang',
      type: 'text',
      placeholder: 'language',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'code language',
    });
    this.langInput.value = this.parts.info.trim();
    this.copyBtn = h('button', { class: 'mb-copy', type: 'button', title: 'Copy code', 'aria-label': 'Copy code' }, 'Copy');
    this.body = h('div', { class: 'mb-code-body' });
    this.root = h(
      'div',
      { class: 'mb-block mb-code', contenteditable: 'false', 'data-type': 'code_fence' },
      h('div', { class: 'mb-code-tools' }, this.langInput, this.copyBtn),
      this.body,
    );
    this.root.dataset.scheme = this.settings.colorScheme;
    this.root.dataset.lang = this.parts.lang;
    isolateEvents(this.root);
    host.append(this.root);
    this.renderStatic();

    this.langInput.addEventListener('focus', () => this.langInput.setAttribute('list', ensureDatalist()));
    this.langInput.addEventListener('input', () => this.onInfoInput());
    this.langInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'Escape') {
        e.preventDefault();
        this.focus('start');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.ctx.onExit('up');
      }
    });
    this.copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.copyBtn.addEventListener('click', () => this.copy());

    // static highlight once the language arrives
    if (this.parts.lang && !loadedLanguage(this.parts.lang)) {
      loadLanguage(this.parts.lang).then(() => {
        if (!this.destroyed && this.staticPre) this.renderStatic();
      });
    }
    if (this.opts.lazyByViewport !== false) {
      if (!observe(this.root, () => this.ensureEditor())) this.ensureEditor();
    }
  }

  private renderStatic() {
    if (this.editor) return;
    if (!this.staticPre) {
      this.staticPre = h('pre', { class: 'mb-code-static' });
      this.staticPre.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const off = offsetAtPoint(this.staticPre!, e.clientX, e.clientY);
        const ed = this.ensureEditor();
        const pos = Math.min(off ?? ed.view.state.doc.length, ed.view.state.doc.length);
        ed.view.dispatch({ selection: { anchor: pos } });
        ed.view.focus();
      });
      this.body.replaceChildren(this.staticPre);
    }
    this.staticPre.classList.toggle('mb-line-numbers', wantsLineNumbers(this.parts.info, !!this.opts.lineNumbers));
    const html = highlightToHtml(this.parts.body, loadedLanguage(this.parts.lang));
    this.staticPre.innerHTML = `<code>${html || '<br>'}</code>`;
  }

  private ensureEditor(): CodeEditor {
    if (this.editor) return this.editor;
    unobserve(this.root);
    const mount = h('div', { class: 'mb-cm' });
    this.editor = createCodeEditor({
      parent: mount,
      doc: this.parts.body,
      dark: this.settings.colorScheme === 'dark',
      lineNumbers: wantsLineNumbers(this.parts.info, !!this.opts.lineNumbers),
      lineWrapping: false,
      ariaLabel: `code block${this.parts.lang ? ' ' + this.parts.lang : ''}`,
      exit: {
        onExit: (d) => this.ctx.onExit(d),
        onRemove: () => this.ctx.onRemove(),
      },
      onDocChange: (doc) => {
        this.setRaw(buildFenceRaw(this.parts, doc));
      },
    });
    this.editor.setLanguage(this.parts.lang);
    this.body.replaceChildren(mount);
    this.staticPre = null;
    return this.editor;
  }

  private setRaw(raw: string) {
    if (raw === this.raw) return;
    this.raw = raw;
    this.parts = parseFence(raw);
    this.root.dataset.lang = this.parts.lang;
    this.ctx.onChange(raw);
  }

  private onInfoInput() {
    const lead = /^\s*/.exec(this.parts.info)![0];
    const v = this.langInput.value.replace(/[\r\n]/g, '');
    const info = v.trim() === '' ? '' : (lead || '') + v;
    const prevLang = this.parts.lang;
    this.setRaw(withFenceInfo(this.parts, info));
    if (this.parts.lang !== prevLang) {
      this.editor?.setLanguage(this.parts.lang);
      if (!this.editor) loadLanguage(this.parts.lang).then(() => !this.destroyed && this.renderStatic());
    }
    this.editor?.setLineNumbers(wantsLineNumbers(this.parts.info, !!this.opts.lineNumbers));
  }

  private copy() {
    copyText(this.parts.body);
    this.copyBtn.textContent = 'Copied';
    this.copyBtn.classList.add('mb-done');
    setTimeout(() => {
      this.copyBtn.textContent = 'Copy';
      this.copyBtn.classList.remove('mb-done');
    }, 1200);
  }

  update(raw: string): void {
    if (raw === this.raw) return;
    const prevLang = this.parts.lang;
    this.raw = raw;
    this.parts = parseFence(raw);
    this.root.dataset.lang = this.parts.lang;
    if (document.activeElement !== this.langInput) this.langInput.value = this.parts.info.trim();
    if (this.editor) {
      this.editor.setDoc(this.parts.body);
      if (prevLang !== this.parts.lang) this.editor.setLanguage(this.parts.lang);
      this.editor.setLineNumbers(wantsLineNumbers(this.parts.info, !!this.opts.lineNumbers));
    } else this.renderStatic();
  }

  focus(at: 'start' | 'end'): void {
    this.ensureEditor().focus(at);
  }

  /** Code Tools (#98): Copy Code Content, Auto Indent Whole Code, Auto Indent Selected Code. */
  command(op: string): boolean {
    if (op === 'copy') {
      this.copy();
      return true;
    }
    if (op !== 'indentAll' && op !== 'indentSelected') return false;
    const { view } = this.ensureEditor();
    if (op === 'indentSelected') indentSelection(view);
    else {
      const changes = indentRange(view.state, 0, view.state.doc.length);
      if (!changes.empty) view.dispatch({ changes, userEvent: 'indent' });
    }
    view.focus();
    return true;
  }

  select(from: number, to: number): boolean {
    const r = rawRangeToBody(this.parts, from, to);
    if (!r) return false;
    this.ensureEditor().select(r.from, r.to);
    return true;
  }

  renderHTML(): string {
    return staticCodeHTML(this.parts, this.settings.colorScheme === 'dark' ? 'dark' : 'light');
  }

  updateSettings(settings: EditorSettings): void {
    const dark = settings.colorScheme === 'dark';
    // compare with the rendered scheme: the core mutates one settings object in place
    const changed = settings.colorScheme !== this.root.dataset.scheme;
    this.settings = settings;
    this.root.dataset.scheme = settings.colorScheme;
    if (changed) this.editor?.setDark(dark);
  }

  destroy(): void {
    this.destroyed = true;
    unobserve(this.root);
    this.editor?.destroy();
    this.root.remove();
  }
}

export function createCodeFenceWidget(opts: CodeFenceOptions = {}): BlockWidget {
  return {
    type: 'code_fence',
    mount: (host, ctx) => new CodeFenceInstance(host, ctx, opts),
  };
}

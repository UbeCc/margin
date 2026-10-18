/**
 * Generic "rendered preview + source editor on focus" widget, shared by math_block,
 * diagram, html_block and front_matter.
 *
 * - Idle: only the preview is shown. Click / focus(at) → editing.
 * - Editing: a CodeMirror panel over the block body is shown (preview stays live
 *   unless `hidePreviewWhileEditing`). Leaving focus, Escape or arrow keys at the
 *   edges stop editing.
 */
import type { BlockWidget, EditorSettings, WidgetBlockType, WidgetContext, WidgetInstance } from '../../contracts';
import { createCodeEditor, CodeEditor } from './cm/setup';
import { indentRange } from '@codemirror/language';
import { indentSelection } from '@codemirror/commands';
import { copyText, debounce, h, isolateEvents } from './util/dom';
import { rawRangeToBody, type Envelope } from './util/delimited';

export interface Parsed {
  body: string;
  build(body: string): string;
  /** Envelope of the raw source; enables find-in-widget selection (#35). */
  parts?: Envelope;
}

export interface RawPreviewSpec<P extends Parsed> {
  type: WidgetBlockType;
  /** Extra class on the root element. */
  className: string;
  parse(raw: string): P;
  /** CodeMirror language name for the body editor ('' = plain). */
  language(p: P): string;
  /** Render the preview. May be async (mermaid). Must handle errors itself. */
  render(preview: HTMLElement, p: P, settings: EditorSettings, env: RenderEnv): void | Promise<void>;
  /** Static export HTML. */
  renderHTML(p: P, settings: EditorSettings, preview: HTMLElement): string;
  /** Label shown in the editor header (e.g. "$$", "mermaid"). */
  label?(p: P): string;
  placeholder?: string;
  /** Preview debounce while typing (ms). */
  debounceMs?: number;
  hidePreviewWhileEditing?: boolean;
  lineWrapping?: boolean;
  /** Editor panel placement relative to the preview. */
  editorPosition?: 'above' | 'below';
}

export interface RenderEnv {
  /** True if this render is stale (a newer render started). */
  stale(): boolean;
  editing: boolean;
}

export function makeRawPreviewWidget<P extends Parsed>(spec: RawPreviewSpec<P>): BlockWidget {
  return {
    type: spec.type,
    mount(host: HTMLElement, ctx: WidgetContext): WidgetInstance {
      return new RawPreviewInstance(spec, host, ctx);
    },
  };
}

class RawPreviewInstance<P extends Parsed> implements WidgetInstance {
  private raw: string;
  private parsed: P;
  private settings: EditorSettings;
  private root: HTMLElement;
  private preview: HTMLElement;
  private panel: HTMLElement;
  private label: HTMLElement;
  private editor: CodeEditor | null = null;
  private editing = false;
  private renderSeq = 0;
  private destroyed = false;
  private scheduleRender: ReturnType<typeof debounce<[]>>;

  constructor(
    private spec: RawPreviewSpec<P>,
    private host: HTMLElement,
    private ctx: WidgetContext,
  ) {
    this.raw = ctx.raw;
    this.parsed = spec.parse(ctx.raw);
    this.settings = ctx.settings;
    this.preview = h('div', { class: 'mb-preview', title: 'Click to edit' });
    this.label = h('span', { class: 'mb-panel-label' });
    this.panel = h('div', { class: 'mb-panel' }, h('div', { class: 'mb-panel-head' }, this.label));
    this.root = h('div', { class: `mb-block mb-raw ${spec.className}`, contenteditable: 'false', 'data-type': spec.type });
    if (spec.editorPosition === 'above') this.root.append(this.panel, this.preview);
    else this.root.append(this.preview, this.panel);
    this.applyScheme();
    isolateEvents(this.root);
    host.append(this.root);

    this.preview.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a[href]')) return;
      e.preventDefault();
      this.startEditing('end');
    });
    this.root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!this.destroyed && this.editing && !this.root.contains(document.activeElement)) this.stopEditing();
      }, 0);
    });
    this.scheduleRender = debounce(() => this.renderPreview(), spec.debounceMs ?? 120);
    this.renderPreview();
  }

  private applyScheme() {
    this.root.dataset.scheme = this.settings.colorScheme;
  }

  private renderPreview() {
    const seq = ++this.renderSeq;
    const env: RenderEnv = { stale: () => seq !== this.renderSeq || this.destroyed, editing: this.editing };
    this.root.classList.toggle('mb-empty', this.parsed.body.trim() === '');
    if (this.parsed.body.trim() === '' && this.spec.placeholder) {
      this.preview.replaceChildren(h('span', { class: 'mb-placeholder' }, this.spec.placeholder));
      return;
    }
    try {
      const r = this.spec.render(this.preview, this.parsed, this.settings, env);
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => console.error('[blocks] render failed', e));
    } catch (e) {
      this.preview.replaceChildren(h('div', { class: 'mb-error' }, String((e as Error)?.message || e)));
    }
  }

  private ensureEditor(): CodeEditor {
    if (this.editor) return this.editor;
    const mount = h('div', { class: 'mb-cm' });
    this.panel.append(mount);
    this.editor = createCodeEditor({
      parent: mount,
      doc: this.parsed.body,
      dark: this.settings.colorScheme === 'dark',
      lineWrapping: this.spec.lineWrapping ?? true,
      placeholder: this.spec.placeholder,
      ariaLabel: `${this.spec.type} source`,
      exit: {
        onExit: (d) => this.ctx.onExit(d),
        onRemove: () => this.ctx.onRemove(),
        beforeLeave: () => this.stopEditing(),
      },
      onDocChange: (doc) => {
        const raw = this.parsed.build(doc);
        this.raw = raw;
        this.parsed = this.spec.parse(raw);
        this.ctx.onChange(raw);
        this.scheduleRender();
      },
    });
    this.editor.setLanguage(this.spec.language(this.parsed));
    return this.editor;
  }

  startEditing(at: 'start' | 'end') {
    const ed = this.ensureEditor();
    this.label.textContent = this.spec.label?.(this.parsed) ?? '';
    if (!this.editing) {
      this.editing = true;
      this.root.classList.add('mb-editing');
      if (this.spec.hidePreviewWhileEditing) this.preview.hidden = true;
      ed.view.requestMeasure();
    }
    ed.focus(at);
  }

  stopEditing() {
    if (!this.editing) return;
    this.editing = false;
    this.root.classList.remove('mb-editing');
    this.preview.hidden = false;
    this.scheduleRender.flush();
    this.renderPreview();
  }

  update(raw: string): void {
    if (raw === this.raw) return;
    this.raw = raw;
    this.parsed = this.spec.parse(raw);
    if (this.editor) {
      this.editor.setDoc(this.parsed.body);
      this.editor.setLanguage(this.spec.language(this.parsed));
    }
    this.label.textContent = this.spec.label?.(this.parsed) ?? '';
    this.scheduleRender.cancel();
    this.renderPreview();
  }

  /** `refresh` (#98 Refresh All Math Expressions / diagrams): re-render the preview. */
  /** Code Tools on math / HTML blocks (#98): Copy Code Content, Auto Indent Whole / Selected Code. */
  command(op: string): boolean {
    if (op === 'refresh') {
      this.renderPreview();
      return true;
    }
    if (op === 'copy') {
      copyText(this.parsed.body);
      return true;
    }
    if (op !== 'indentAll' && op !== 'indentSelected') return false;
    if (!this.editing) this.startEditing('end');
    const { view } = this.ensureEditor();
    if (op === 'indentSelected') indentSelection(view);
    else {
      const changes = indentRange(view.state, 0, view.state.doc.length);
      if (!changes.empty) view.dispatch({ changes, userEvent: 'indent' });
    }
    view.focus();
    return true;
  }

  focus(at: 'start' | 'end'): void {
    this.startEditing(at);
  }

  select(from: number, to: number): boolean {
    const r = this.parsed.parts && rawRangeToBody(this.parsed.parts, from, to);
    if (!r) return false;
    this.startEditing('start');
    this.editor!.select(r.from, r.to);
    return true;
  }

  renderHTML(): string {
    return this.spec.renderHTML(this.parsed, this.settings, this.preview);
  }

  updateSettings(settings: EditorSettings): void {
    // compare with the rendered scheme: the core mutates one settings object in place
    const schemeChanged = settings.colorScheme !== this.root.dataset.scheme;
    this.settings = settings;
    this.applyScheme();
    if (schemeChanged) {
      this.editor?.setDark(settings.colorScheme === 'dark');
      this.renderPreview();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.scheduleRender.cancel();
    this.editor?.destroy();
    this.root.remove();
    void this.host;
  }
}

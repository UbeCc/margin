/**
 * Source mode: a full-document CodeMirror 6 markdown editor.
 *
 *   const sm = createSourceMode(host, { markdown, settings, onChange });
 *   sm.getMarkdown(); sm.setMarkdown(md); sm.focus(); sm.destroy();
 *
 * The core calls the factory when `setSourceMode(true)` and feeds the result of
 * `getMarkdown()` back into its parser on `setSourceMode(false)`.
 */
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from '@codemirror/search';
import { classHighlighter, tags } from '@lezer/highlight';
import type { EditorSettings } from '../../contracts';
import { External, setDocKeepSelection, themeExtension } from './cm/setup';

export interface SourceModeOptions {
  markdown: string;
  settings: EditorSettings;
  /** Called with the full markdown after every user edit. */
  onChange(markdown: string): void;
  /** Called when the selection moves (for status bar / outline sync). Optional. */
  onSelectionChange?(): void;
  /** Show line numbers (default false — Typora-like). */
  lineNumbers?: boolean;
}

export interface SourceModeFindOptions {
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
  backwards?: boolean;
}

export interface SourceModeInstance {
  getMarkdown(): string;
  /** Replace the document (keeps selection where possible, not added to undo history). */
  setMarkdown(markdown: string): void;
  focus(): void;
  destroy(): void;
  /** Scroll so that 0-based `line` is at the top and put the caret there. */
  scrollToLine(line: number): void;
  /** 0-based line of the main cursor. */
  getCursorLine(): number;
  /** 0-based line at the top of the viewport. */
  getTopLine(): number;
  updateSettings(settings: EditorSettings): void;
  /** Select next/previous match; returns false if nothing found. */
  find(query: string, opts?: SourceModeFindOptions): boolean;
  /** Replace current/next match (or all); returns false if nothing was replaced. */
  replace(query: string, replacement: string, opts?: SourceModeFindOptions & { all?: boolean }): boolean;
  undo(): boolean;
  redo(): boolean;
  /** Replace the main selection with text (#116 Paste as Plain Text). */
  replaceSelection(text: string): void;
  /** Insert markdown at a viewport point (drop), falling back to the caret (#129). */
  insertAt(markdown: string, x?: number, y?: number): boolean;
  /** The CodeMirror view (escape hatch for advanced integrations). */
  readonly view: EditorView;
}

export type SourceModeFactory = (host: HTMLElement, opts: SourceModeOptions) => SourceModeInstance;

/** Markdown-specific token classes on top of classHighlighter (styled in blocks.css). */
const markdownClasses = HighlightStyle.define([
  { tag: tags.processingInstruction, class: 'tok-md-mark' },
  { tag: tags.monospace, class: 'tok-md-code' },
  { tag: tags.quote, class: 'tok-md-quote' },
  { tag: tags.strikethrough, class: 'tok-md-strike' },
  { tag: tags.heading1, class: 'tok-md-h1' },
  { tag: tags.heading2, class: 'tok-md-h2' },
  { tag: tags.contentSeparator, class: 'tok-md-hr' },
  { tag: tags.list, class: 'tok-md-list' },
]);

export const createSourceMode: SourceModeFactory = (host, opts) => {
  const theme = new Compartment();
  let settings = opts.settings;
  // The host may mutate one settings object in place, so remember the scheme itself.
  let scheme = settings.colorScheme;
  const root = document.createElement('div');
  root.className = 'mb-source';
  root.dataset.scheme = settings.colorScheme;
  host.append(root);

  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: opts.markdown,
      extensions: [
        opts.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
        syntaxHighlighting(classHighlighter),
        syntaxHighlighting(markdownClasses),
        EditorView.lineWrapping,
        theme.of(themeExtension(settings.colorScheme === 'dark')),
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ spellcheck: String(settings.spellcheck), 'aria-label': 'Markdown source' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) opts.onChange(u.state.doc.toString());
          if (u.selectionSet) opts.onSelectionChange?.();
        }),
      ],
    }),
  });

  // Keep plain typing/paste inside CodeMirror from reaching any outer handlers.
  for (const t of ['beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionstart', 'compositionend']) {
    root.addEventListener(t, (e) => e.stopPropagation());
  }

  const makeQuery = (q: string, o: SourceModeFindOptions = {}, replace = '') =>
    new SearchQuery({ search: q, caseSensitive: !!o.caseSensitive, regexp: !!o.regexp, wholeWord: !!o.wholeWord, replace, literal: !o.regexp });

  const inst: SourceModeInstance = {
    view,
    getMarkdown: () => view.state.doc.toString(),
    setMarkdown(md) {
      setDocKeepSelection(view, md);
    },
    focus: () => view.focus(),
    destroy() {
      view.destroy();
      root.remove();
    },
    scrollToLine(line) {
      const n = Math.max(1, Math.min(view.state.doc.lines, line + 1));
      const pos = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
    },
    getCursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number - 1,
    getTopLine() {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number - 1;
    },
    updateSettings(s) {
      const changed = s.colorScheme !== scheme;
      scheme = s.colorScheme;
      settings = s;
      root.dataset.scheme = s.colorScheme;
      if (changed) view.dispatch({ effects: theme.reconfigure(themeExtension(s.colorScheme === 'dark')) });
    },
    find(q, o = {}) {
      if (!q) return false;
      view.dispatch({ effects: setSearchQuery.of(makeQuery(q, o)) });
      const before = view.state.selection.main;
      (o.backwards ? findPrevious : findNext)(view);
      const after = view.state.selection.main;
      return after.from !== before.from || after.to !== before.to || view.state.sliceDoc(after.from, after.to).length > 0;
    },
    replace(q, r, o = {}) {
      if (!q) return false;
      view.dispatch({ effects: setSearchQuery.of(makeQuery(q, o, r)) });
      const before = view.state.doc.toString();
      if (o.all) replaceAll(view);
      else {
        replaceNext(view);
        if (view.state.doc.toString() === before) {
          findNext(view);
          replaceNext(view);
        }
      }
      return view.state.doc.toString() !== before;
    },
    undo: () => undo(view),
    redo: () => redo(view),
    replaceSelection: (text) => view.dispatch(view.state.replaceSelection(text)),
    insertAt(markdown, x, y) {
      let pos: number | null = null;
      if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
        // posAtCoords takes viewport (client) coordinates, like the drop point;
        // the fast approximate pass is enough — a drop lands on a line/char.
        pos = view.posAtCoords({ x, y }, false);
      }
      if (pos === null) pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: markdown },
        selection: { anchor: pos + markdown.length },
        scrollIntoView: true,
      });
      view.focus();
      return true;
    },
  };
  return inst;
};

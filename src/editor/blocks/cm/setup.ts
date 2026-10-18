/**
 * Shared CodeMirror 6 plumbing for the block widgets: language loading (via
 * @codemirror/language-data), theme compartments, edge-exit keymap, and minimal
 * external document replacement that keeps the selection.
 */
import { Annotation, Compartment, EditorState, Extension, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, LanguageSupport, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';

/** Marks transactions coming from `setDocKeepSelection` (not user edits). */
export const External = Annotation.define<boolean>();

const ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell',
  shell: 'shell', console: 'shell', yml: 'yaml', md: 'markdown', rs: 'rust', 'c++': 'c++', cpp: 'c++', cs: 'c#', csharp: 'c#',
  kt: 'kotlin', golang: 'go', tex: 'latex', latex: 'latex', math: 'latex', katex: 'latex', html: 'html', xml: 'xml', vue: 'vue',
  objc: 'objective-c', 'objective-c': 'objective-c', dockerfile: 'dockerfile', docker: 'dockerfile', ps1: 'powershell', psql: 'sql',
  json5: 'json', jsonc: 'json', hs: 'haskell', ml: 'ocaml', proto: 'protobuf', tf: 'hcl', toml: 'toml', make: 'cmake', diff: 'diff', patch: 'diff',
};

const cache = new Map<string, Promise<LanguageSupport | null>>();

export function findLanguage(name: string): LanguageDescription | null {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  const alias = ALIASES[n] ?? n;
  return LanguageDescription.matchLanguageName(languages, alias, true) || LanguageDescription.matchFilename(languages, `x.${n}`) || null;
}

/** Load (cached) a language by fence name. Resolves null for unknown languages. */
export function loadLanguage(name: string): Promise<LanguageSupport | null> {
  const desc = findLanguage(name);
  if (!desc) return Promise.resolve(null);
  let p = cache.get(desc.name);
  if (!p) {
    p = desc.load().catch(() => null);
    cache.set(desc.name, p);
  }
  return p;
}

/** Synchronously available language support (if already loaded). */
export function loadedLanguage(name: string): LanguageSupport | null {
  const desc = findLanguage(name);
  return desc?.support ?? null;
}

/** All known language names (for the language input datalist). */
export function languageNames(): string[] {
  const out = new Set<string>();
  for (const l of languages) {
    out.add(l.name.toLowerCase());
    for (const a of l.alias) out.add(a);
  }
  return [...out].sort();
}

export function themeExtension(dark: boolean): Extension {
  return [
    EditorView.theme(
      {
        '&': { color: 'var(--margin-fg, inherit)', backgroundColor: 'transparent', fontSize: 'inherit' },
        '&.cm-focused': { outline: 'none' },
        '.cm-content': { fontFamily: 'var(--margin-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', caretColor: 'var(--margin-accent, #4a7cf7)' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--margin-accent, #4a7cf7)' },
        '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--margin-muted, #999)' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
          backgroundColor: dark ? 'rgba(120,160,255,0.30)' : 'rgba(70,120,240,0.20)',
        },
        '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.55' },
      },
      { dark },
    ),
  ];
}

export interface ExitHandlers {
  onExit(direction: 'up' | 'down' | 'left' | 'right'): void;
  onRemove?(): void;
  /** Called before onExit/onRemove (e.g. stop editing). */
  beforeLeave?(): void;
}

/** Is the caret on the first (up) / last (down) visual line of the document? Handles wrapping. */
function onVisualEdge(v: EditorView, dir: 'up' | 'down'): boolean {
  const head = v.state.selection.main.head;
  const line = v.state.doc.lineAt(head);
  if (dir === 'up' ? line.number !== 1 : line.number !== v.state.doc.lines) return false;
  const a = v.coordsAtPos(head);
  const b = v.coordsAtPos(dir === 'up' ? 0 : v.state.doc.length);
  if (!a || !b) return true;
  return Math.abs(a.top - b.top) < 3;
}

/** Arrow keys at the document edges leave the editor; Backspace in empty doc removes the block. */
export function edgeKeymap(h: ExitHandlers): Extension {
  const leave = (dir: 'up' | 'down' | 'left' | 'right') => {
    h.beforeLeave?.();
    h.onExit(dir);
    return true;
  };
  return Prec.highest(
    keymap.of([
      { key: 'ArrowUp', run: (v) => (v.state.selection.main.empty && onVisualEdge(v, 'up') ? leave('up') : false) },
      { key: 'ArrowDown', run: (v) => (v.state.selection.main.empty && onVisualEdge(v, 'down') ? leave('down') : false) },
      { key: 'ArrowLeft', run: (v) => (v.state.selection.main.empty && v.state.selection.main.head === 0 ? leave('left') : false) },
      {
        key: 'ArrowRight',
        run: (v) => (v.state.selection.main.empty && v.state.selection.main.head === v.state.doc.length ? leave('right') : false),
      },
      { key: 'Escape', run: () => leave('down') },
      { key: 'Mod-Enter', run: () => leave('down') },
      {
        key: 'Backspace',
        run: (v) => {
          if (v.state.doc.length !== 0 || !h.onRemove) return false;
          h.beforeLeave?.();
          h.onRemove();
          return true;
        },
      },
    ]),
  );
}

export interface CodeEditorOptions {
  parent: HTMLElement;
  doc: string;
  dark: boolean;
  lineNumbers?: boolean;
  lineWrapping?: boolean;
  placeholder?: string;
  exit: ExitHandlers;
  onDocChange(doc: string): void;
  extra?: Extension[];
  ariaLabel?: string;
}

export interface CodeEditor {
  view: EditorView;
  setLanguage(name: string): void;
  setDark(dark: boolean): void;
  setLineNumbers(on: boolean): void;
  setDoc(doc: string): void;
  getDoc(): string;
  focus(at: 'start' | 'end'): void;
  /** Select `[from, to)` of the doc, scroll it into view and focus (find, #35). */
  select(from: number, to: number): void;
  destroy(): void;
}

export function createCodeEditor(o: CodeEditorOptions): CodeEditor {
  const lang = new Compartment();
  const theme = new Compartment();
  const gutter = new Compartment();
  let langName = '';
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        edgeKeymap(o.exit),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(classHighlighter),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        lang.of([]),
        theme.of(themeExtension(o.dark)),
        gutter.of(o.lineNumbers ? lineNumbers() : []),
        o.lineWrapping ? EditorView.lineWrapping : [],
        o.placeholder ? cmPlaceholder(o.placeholder) : [],
        EditorState.tabSize.of(4),
        EditorView.contentAttributes.of({ 'aria-label': o.ariaLabel || 'code editor', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) o.onDocChange(u.state.doc.toString());
        }),
        ...(o.extra || []),
      ],
    }),
  });
  const ed: CodeEditor = {
    view,
    setLanguage(name) {
      langName = name;
      const now = loadedLanguage(name);
      if (now) {
        view.dispatch({ effects: lang.reconfigure(now) });
        return;
      }
      if (!findLanguage(name)) {
        view.dispatch({ effects: lang.reconfigure([]) });
        return;
      }
      loadLanguage(name).then((support) => {
        if (langName !== name || !view.dom.isConnected && !view.dom.parentNode) return;
        view.dispatch({ effects: lang.reconfigure(support || []) });
      });
    },
    setDark(dark) {
      view.dispatch({ effects: theme.reconfigure(themeExtension(dark)) });
    },
    setLineNumbers(on) {
      view.dispatch({ effects: gutter.reconfigure(on ? lineNumbers() : []) });
    },
    setDoc(doc) {
      setDocKeepSelection(view, doc);
    },
    getDoc: () => view.state.doc.toString(),
    focus(at) {
      const pos = at === 'start' ? 0 : view.state.doc.length;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    select(from, to) {
      const len = view.state.doc.length;
      const a = Math.max(0, Math.min(from, len));
      const b = Math.max(a, Math.min(to, len));
      view.focus();
      view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
    },
    destroy() {
      view.destroy();
    },
  };
  return ed;
}

/** Replace the doc with a minimal change (common prefix/suffix) so the selection maps naturally. */
export function setDocKeepSelection(view: EditorView, doc: string): void {
  const cur = view.state.doc.toString();
  if (cur === doc) return;
  let start = 0;
  const max = Math.min(cur.length, doc.length);
  while (start < max && cur.charCodeAt(start) === doc.charCodeAt(start)) start++;
  let endA = cur.length;
  let endB = doc.length;
  while (endA > start && endB > start && cur.charCodeAt(endA - 1) === doc.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  view.dispatch({
    changes: { from: start, to: endA, insert: doc.slice(start, endB) },
    annotations: [External.of(true), Transaction.addToHistory.of(false)],
  });
}

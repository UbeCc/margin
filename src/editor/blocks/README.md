# editor/blocks — block widgets, inline math, source mode

Owner: **blocks**. Implements `BlockWidget`s from `src/contracts.ts` plus the inline math renderer and the source-mode editor.

## Integration (core)

```ts
import { installBlocks } from '../blocks';
import { registerWidget, registerInlineMath, registerSourceMode } from './index';

installBlocks({ registerWidget, registerInlineMath, registerSourceMode }, {
  code: { lineNumbers: false },   // global fence line numbers (per fence: info `{.numberLines}`)
  math: { numbering: false },     // auto (n) equation numbers via CSS counter
});
```

Importing `editor/blocks` also imports `blocks.css` and KaTeX's CSS (side effects). `blocksCSS` (string) is exported for HTML export.

### Widgets registered

| type | raw it expects | notes |
|---|---|---|
| `code_fence` | a whole fence (``` or ~~~, any length, ≤3 indent, info string, optional closing, trailing blank lines) | CM6 per fence, created lazily: static highlighted `<pre>` until near viewport (IntersectionObserver, 300px margin) or click/`focus()`. Language box edits the info string, Copy button. |
| `math_block` | `$$\n…\n$$` or `$$ … $$` | KaTeX preview; CM (latex) panel above while editing; errors inline. |
| `diagram` | fence with lang `mermaid`, `sequence`, `flow`, `flowchart` | mermaid (lazy `import()`), 350 ms debounce, theme follows `colorScheme`. js-sequence / flowchart.js syntax is translated to mermaid (`diagram-translate.ts`). The core should route fences with `isDiagramLang(lang)` to this widget. |
| `table` | GFM pipe table (header + delimiter + rows) | contenteditable cells, toolbar, see keys below. Unchanged tables keep their exact source; any edit re-formats the whole table (aligned pipes, CJK width aware). |
| `html_block` | the HTML block lines | allowlist sanitizer (`sanitize.ts`) for preview; export emits the raw HTML. |
| `front_matter` | `---\n…\n---` (or `...` close) | collapsed YAML summary; CM (yaml) editor on click. Exports `''`. |
| `toc` | `[toc]` | renders `ctx.getOutline()`; clicks call `ctx.scrollToHeading(id)`. |

All raw handling is lossless: when the body is unchanged a widget hands back `ctx.raw` byte-for-byte. Edited bodies are re-wrapped with the original opening line, closing line, indent and trailing blank lines (`util/delimited.ts`).

### Widget ↔ core behaviour

- Widgets render into `host` a root `.mb-block[contenteditable=false]` with `data-type` and `data-scheme`. Editable islands inside (CM content, table cells, language input) are `contenteditable=true`/inputs.
- **Events**: each widget root stops propagation of `beforeinput/input/composition*/paste/cut/copy/drop/keyup/keypress`, and of `keydown` unless it carries Cmd/Ctrl/Alt and was not handled (so app shortcuts like Cmd+S still bubble). The core can additionally ignore events whose target is inside `.mb-block`.
- **Exit**: ArrowUp on first visual line / ArrowDown on last / ArrowLeft at 0 / ArrowRight at end, Escape and Mod-Enter (→ `down`) call `ctx.onExit(dir)`. The core then places the caret in the neighbouring block.
- **Enter from outside**: call `instance.focus('start' | 'end')`.
- **Remove**: Backspace in an empty fence/math/diagram/html/front matter editor, Backspace in an all-empty table, Backspace/Delete on a focused TOC, the table 🗑 button → `ctx.onRemove()`. (Typora turns an empty fence back into a paragraph; the core may do that in onRemove.)
- **Undo**: CM editors have local history while focused. External changes arrive via `update(raw)`, which applies a minimal diff that keeps the cursor and does not touch CM history. `update()` with the current raw is a no-op.
- **Theme**: `updateSettings(settings)` switches CM theme and re-renders mermaid when `colorScheme` changes.
- **TOC refresh**: `update()`, a `document` event `margin:outline-changed` (`OUTLINE_CHANGED_EVENT`, optional, dispatch it after heading edits), plus an 800 ms poll that compares signatures.
- **Export**: `renderHTML()` returns static HTML: `<pre class="md-fences" lang><code>` with `tok-*` spans, KaTeX HTML, mermaid SVG (last successful render), `<figure class="md-table-fig"><table>`, `<div class="md-toc">` with `href="#<heading id>"`, so the core's heading export must use the heading block id as the element `id`. Include `blocksCSS` and the KaTeX CSS in exported documents.

### Table keys

Tab / Shift+Tab next/prev cell (Tab in last cell adds a row; Shift+Tab in first cell exits up) · Enter cell below (adds a row at the end) · Mod+Enter insert row below · Shift+Enter inserts `<br>` · arrows move between cells at text edges and exit at the table edges · Mod+Shift+Backspace delete row · Mod+Alt+Arrows move row/column · Escape exits down. Toolbar: align left/center/right/none, insert row above/below, delete row, insert column left/right, delete column, delete table. Cells show rendered inline markdown when idle and raw markdown while being edited. Pasted text is flattened to one line, and unescaped `|` is escaped on serialize.

### Inline math

`renderInlineMath(tex, el)` renders with KaTeX into `el` and adds the `mb-inline-math` class. On error it shows the source with `.mb-math-error` and the message in `title`. `inlineMathHTML(tex)` returns the same thing as a string.

### Source mode (`source-mode.ts`)

```ts
type SourceModeFactory = (host: HTMLElement, opts: {
  markdown: string; settings: EditorSettings;
  onChange(markdown: string): void; onSelectionChange?(): void; lineNumbers?: boolean;
}) => SourceModeInstance;

interface SourceModeInstance {
  getMarkdown(): string; setMarkdown(md: string): void; focus(): void; destroy(): void;
  scrollToLine(line0: number): void; getCursorLine(): number; getTopLine(): number;
  updateSettings(s: EditorSettings): void;
  find(q, {caseSensitive, regexp, wholeWord, backwards}?): boolean;
  replace(q, replacement, {..., all}?): boolean;
  undo(): boolean; redo(): boolean; readonly view: EditorView;
}
```

The editor is CM6 with lang-markdown (fenced code highlighted via language-data), history, search panel (Mod-F) and line wrapping, and its theme follows `colorScheme`. The core creates it on `setSourceMode(true)` and re-parses `getMarkdown()` on `setSourceMode(false)`. `EditorHandle.exec({kind:'find'|'replace'|'undo'|'redo'})` can delegate to it while it is active. The host should have a definite height, because `.mb-source` fills it.

## Theming

`blocks.css` uses `--margin-fg`, `--margin-bg`, `--margin-accent`, `--margin-code-bg`, `--margin-border`, `--margin-muted`, `--margin-error`, `--margin-mono`, `--margin-font` and `--margin-radius`. Syntax colours come from `--tok-*` variables, with light defaults and dark defaults under `[data-scheme=dark]`; themes can override them.

## Files

`index.ts` (installBlocks, exports) · `code-fence.ts` · `raw-preview.ts` (shared preview+editor shell) · `math.ts` · `diagram.ts`, `diagram-translate.ts` · `table.ts`, `table-model.ts` · `html-block.ts`, `sanitize.ts` · `front-matter.ts` · `toc.ts` · `source-mode.ts` · `inline-md.ts` (tiny inline renderer for cells/export) · `cm/setup.ts` (languages, theme, edge keymap), `cm/highlight.ts` (static highlighting) · `util/delimited.ts` (lossless envelopes), `util/dom.ts`.

## Dev & tests

- `npx vite --port 5182` → http://localhost:5182/src/editor/blocks/dev.html mounts every widget with a fake context. It shows live raw output, an event log, a dark toggle and a renderHTML dump. State is on `window.__blocks`.
- Unit: `npm test` (`*.test.ts` here: fence/math/front-matter/html round-trips, table parse/serialize/edits, sanitizer, inline md, diagram translation).
- E2E: `npx playwright test` (`tests/e2e/blocks-*.spec.ts`; config starts vite on 5182).
- In a git worktree whose `node_modules` is a symlink, Vite refuses to serve KaTeX fonts ("outside of serving allow list"). Formulas still render with fallback fonts. Adding `server.fs.allow` in vite.config fixes this; the main checkout is unaffected.

# Margin — architecture

A Typora-style WYSIWYG Markdown editor. Tauri v2 shell (system WebView: WKWebView on macOS) + a self-written editing core in TypeScript. **Clean-room**: we reuse *ideas* learned from studying Typora's architecture, never its code.

## Layout / ownership

```
src/
  contracts.ts          shared interfaces (EditorHandle, BlockWidget, Platform) — coordinator owns
  editor/core/          model, markdown parser/serializer, renderer, caret, input, undo, find  — owner: core
  editor/blocks/        BlockWidget impls (code, math, diagram, table, html, front matter, toc),
                        inline math renderer, source mode (CodeMirror 6)                     — owner: blocks
  app/                  shell UI: sidebar file tree, outline, quick open, status bar, find bar,
                        settings, themes, export, image paste wiring, menus                  — owner: app
  platform/             Platform impls: tauri.ts (invoke) + web.ts (in-browser mock for dev/tests) — owner: native
  themes/               built-in CSS themes (light "paper", dark "night", "github")          — owner: app
src-tauri/              Rust commands, menus, file watching, quick open, PDF export          — owner: native
tests/                  vitest (unit, jsdom) + playwright (e2e against `vite` dev server)
```

## Editing core design (the Typora approach)

1. **Lossless block model.** The document is a list/tree of blocks, each with a stable `id` (`data-bid` on its DOM element) and its **exact markdown source** (`raw`), including original markers, indentation, and the blank lines that follow it. `serialize(parse(x)) === x` for every input. Container blocks (quote / list / list item) keep per-line prefixes so they round-trip too.
2. **Markers live in the DOM.** Inline syntax (`**`, `_`, `` ` ``, `[`, `](url)`, `#`, `> `…) is rendered as `<span class="md-meta">` elements hidden by CSS. Therefore a text block's `textContent` *is* its markdown source. The block/inline containing the caret gets `md-expand`, which reveals its markers.
3. **Edit loop.** `beforeinput`/`input` on a contenteditable root → mark block dirty → read its text → re-parse inline → patch DOM (diff by node) → restore caret from a text-offset bookmark. Structural transforms (`# ` → heading, `- ` → list, ``` ``` ``` → code widget, `|a|b|` → table, Enter/Backspace splitting/merging blocks) are handled explicitly and on leaving a block.
4. **Undo/redo** = command stack of block-level snapshots (`{before, after}` per changed block id + caret bookmarks), coalescing typing in the same block within ~1–3 s.
5. **Widgets.** Non-text blocks (code fences via CodeMirror 6, math via KaTeX, mermaid diagrams, tables, html blocks, front matter, TOC) are mounted by `BlockWidget`s; the core treats them as atomic blocks with `raw` source and caret enter/exit hand-off.
6. **Source mode** swaps the view for a CodeMirror 6 editor over the same markdown string.

## Platform

`Platform` (contracts.ts) abstracts all native capabilities. `platform/web.ts` implements it in-memory/IndexedDB so the whole app runs in a plain browser (`npm run dev`) — used by Playwright e2e tests. `platform/tauri.ts` calls Rust commands.

## Conventions

- TypeScript strict, no UI framework (vanilla DOM), small modules.
- Tests: `npm test` (vitest), `npm run e2e` (playwright). Parser round-trip tests are mandatory.
- Each owner only edits files in their directories (+ their tests). Request contract changes via a note at the bottom of this file.

## Contract change log
- 2026-10-17 (#18): `Platform.print()`, `Platform.allowAssetDir(dir)`, `exportPdf(html, outPath, opts?: { baseDir })` added to the contract.
- **[app → native, request]** Optional `Platform` methods used by the shell when present (feature-detected, see `src/app/platform-extras.ts`): `rename(from,to)`, `remove(path)` (move to trash), `createDir(path)`, `revealInFolder(path)` (tracked in #21). Without them file-tree rename/delete/new-folder are disabled.
- **[app → native, request]** `saveSettings` receives `AppSettings` plus extra shell keys (`darkTheme`, `customCss`, `focusMode`, `typewriterMode`, `zoom`, `sidebar*`, `autoSaveDelay`, `restoreLastFolder`, `settingsVersion`). Persist the object verbatim, including unknown keys. `loadSettings` may return anything, and the app validates it with `migrateSettings`.
- **[app]** The editor host element is `div.margin-doc.editor-host` and themes style `.margin-doc *`. `html[data-scheme]` is `light|dark`.
- 2026-10-18 (#35): optional `WidgetInstance.select(from, to)` — select a range of the widget's raw source for find/replace; core falls back to selecting the whole widget.

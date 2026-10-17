# src/app — Margin shell

Owner: **app**. Vanilla-DOM shell around `EditorHandle` + `Platform` (see `src/contracts.ts`).

## Structure

| file | role |
|---|---|
| `../main.ts` | boot: `loadWiring()` → `new App(wiring, #app).start()`; exposes `window.__margin` |
| `wiring.ts` | **the only integration point**: `getPlatform()`, lazy `installBlocks`, editor core (stub until #1) |
| `dev-stubs.ts` | `<textarea>` EditorHandle used until the core lands (or with `?stub=editor`) |
| `app.ts` | `App`: layout, settings, command dispatcher (`run(id)`), palettes, export, image/link wiring |
| `document.ts` | `DocumentController`: open / save / save as / close, auto-save, dirty tracking, EOL (LF/CRLF) preservation, external-change handling |
| `commands.ts` | command table (labels, categories, shortcuts, scope) for keys, menus and the command palette |
| `settings.ts` | `MarginSettings` (= `AppSettings` + shell prefs), `migrateSettings()` |
| `themes.ts` + `../themes/` | `ThemeManager`, effective-theme logic; built-in `paper`, `github`, `night` |
| `preferences.ts` | Preferences modal (Appearance / Editor / Files / Images) |
| `findbar.ts`, `statusbar.ts`, `sidebar/filetree.ts`, `sidebar/outline.ts` | UI pieces |
| `ui/` | modal (ask/confirm/prompt), palette, context menu, toasts |
| `util/` | `path`, `fuzzy`, `keymap`, `dom` helpers (pure, unit-tested) |
| `platform-extras.ts` | optional platform methods (#21): `rename`, `remove`, `createDir`, `revealInFolder` |

## Wiring points for the integrator

- **Editor core**: `loadCore` in `wiring.ts`. Today it globs `src/editor/core/index.ts` (absent → textarea stub). When #1 merges, replace it with the one-liner in the comment above it (`import('../editor/core')`). If the core exports `registerWidget/registerInlineMath/registerSourceMode` (and not `blocksInstalled: true`), the app calls `installBlocks` with them.
- **Blocks**: imported lazily (CodeMirror + KaTeX stay off the startup path); `blocksCSS` is loaded on export.
- **Platform**: `getPlatform()` — TauriPlatform in the app, WebPlatform (in-memory fs, sample folder `/Margin`) in a browser. `?folder=/path` picks the start folder in the web build; `?open=` opens files.
- **Editor host**: the core mounts into `div.margin-doc.editor-host`, which sits inside `.editor-scroll` (the scrolling element). Themes style `.margin-doc` descendants, and the same class wraps exported HTML.
- **Menus / shortcuts**: keys bound in the native menu (`src/platform/shortcuts.ts`) arrive only via `platform.onMenu` (WebPlatform emulates this in the browser) → `App.onMenu` → `App.run(id)`, the single dispatcher. Editor-scoped actions are ignored while focus is in the find bar / palette / dialogs, except undo/redo which are applied to that text field. App-only keys (command palette ⌘⇧A, ⌘⇧1/⌘⇧3, zoom aliases, …) are handled by a JS keydown listener; `commands.ts` takes the displayed accelerator for menu actions from the native table so labels never drift. Zoom reset is ⌘⇧0, print ⌘⇧P.
- **Settings**: `platform.saveSettings` receives `MarginSettings`, which has extra keys. Platforms must persist unknown keys verbatim (see the ARCHITECTURE.md change log).
- **CSS variables** set by themes: `--margin-fg/bg/accent/code-bg/border`, `--margin-font-body/heading/mono/ui`, plus the aliases read by blocks (`--margin-muted/error/mono/font/radius`) and `--margin-font-size` (set from Preferences). `html[data-scheme=light|dark]` and `html[data-theme=<name>]` are set as well.
- **Images**: `EditorSettings.storeImage` → `platform.storeImage(doc.path, settings.imageRule, input)`. `resolveAsset` → `platform.assetUrl(resolved absolute path)` for relative or absolute local srcs; URLs pass through unchanged.
- **Export**: HTML/PDF = `editor.renderHTML()` inside `<article class="margin-doc">` + current theme + custom CSS + `blocksCSS` + KaTeX CSS (fonts from jsDelivr), only when KaTeX markup is present. PDF passes `{ baseDir: doc dir }`. Print uses `platform.print()` with print CSS. Images outside the opened folder/doc dir are whitelisted with `platform.allowAssetDir(dir)`.

## Tests

- Unit: `npm test` → `src/app/__tests__/*.test.ts` (fuzzy, paths, keymap/commands, settings migration, themes, DocumentController on WebPlatform, export).
- E2E: `npx playwright test` → `tests/e2e/app-*.spec.ts`. They run on the real WebPlatform, seeded with `tests/e2e/app-fixture.ts` via localStorage, file dialogs answered through `__MARGIN_DIALOG__`, editor stubbed (`?stub=editor`). Vite on 5182 (`E2E_PORT` overrides).

## Known gaps

- Single document per window (Typora model). No tabs and no multi-window.
- Exported HTML keeps local image srcs as returned by `renderHTML()` (asset URLs are not rewritten to file paths).

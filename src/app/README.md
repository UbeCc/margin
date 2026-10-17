# src/app — Margin shell

Owner: **app**. Vanilla-DOM shell around `EditorHandle` + `Platform` (see `src/contracts.ts`).

## Structure

| file | role |
|---|---|
| `../main.ts` | boot: `loadWiring()` → `new App(wiring, #app).start()`; exposes `window.__margin` |
| `wiring.ts` | **the only integration point**: picks real core / platform modules or dev stubs |
| `dev-stubs.ts` | `<textarea>` EditorHandle + in-memory `Platform` (demo folder `/Users/demo/Notes`), test hooks on `window.__marginStub` |
| `app.ts` | `App`: layout, settings, command dispatcher (`run(id)`), palettes, export, image/link wiring |
| `document.ts` | `DocumentController`: open / save / save as / close, auto-save, dirty tracking, EOL (LF/CRLF) preservation, external-change handling |
| `commands.ts` | command table (labels, categories, shortcuts, scope) for keys, menus and the command palette |
| `settings.ts` | `MarginSettings` (= `AppSettings` + shell prefs), `migrateSettings()` |
| `themes.ts` + `../themes/` | `ThemeManager`, effective-theme logic; built-in `paper`, `github`, `night` |
| `preferences.ts` | Preferences modal (Appearance / Editor / Files / Images) |
| `findbar.ts`, `statusbar.ts`, `sidebar/filetree.ts`, `sidebar/outline.ts` | UI pieces |
| `ui/` | modal (ask/confirm/prompt), palette, context menu, toasts |
| `util/` | `path`, `fuzzy`, `keymap`, `dom` helpers (pure, unit-tested) |
| `platform-extras.ts` | optional platform methods: `rename`, `remove`, `createDir`, `revealInFolder`, `print` |

## Wiring points for the integrator

- **Editor core**: `wiring.ts` auto-loads `src/editor/core/index.ts` (`createEditor` or default export) via `import.meta.glob`. The core calls `installBlocks(...)` itself. The app only reads `blocksCSS` from `src/editor/blocks` and inlines it into exports.
- **Platform**: in Tauri (`__TAURI_INTERNALS__`) the app loads `src/platform/tauri.ts`, otherwise `src/platform/web.ts`. It accepts `export const platform`, a default export, or a `create*Platform()` factory.
- **Stubs**: used only when a module is missing, or when forced with `?stub=all|editor|platform`. The e2e tests use `?stub=all`.
- If you prefer static imports, rewrite `loadWiring()` only; nothing else imports the modules.
- **Editor host**: the core mounts into `div.margin-doc.editor-host`, which sits inside `.editor-scroll` (the scrolling element). Themes style `.margin-doc` descendants, and the same class wraps exported HTML.
- **Menus**: `platform.onMenu(action)` → `App.run(action)`. Shortcuts are handled in JS (`commands.ts`). A menu action that repeats a key action handled within 250 ms is ignored, so native accelerators that duplicate JS shortcuts are harmless.
- **Settings**: `platform.saveSettings` receives `MarginSettings`, which has extra keys. Platforms must persist unknown keys verbatim (see the ARCHITECTURE.md change log).
- **CSS variables** set by themes: `--margin-fg/bg/accent/code-bg/border`, `--margin-font-body/heading/mono/ui`, plus the aliases read by blocks (`--margin-muted/error/mono/font/radius`) and `--margin-font-size` (set from Preferences). `html[data-scheme=light|dark]` and `html[data-theme=<name>]` are set as well.
- **Images**: `EditorSettings.storeImage` → `platform.storeImage(doc.path, settings.imageRule, input)`. `resolveAsset` → `platform.assetUrl(resolved absolute path)` for relative or absolute local srcs; URLs pass through unchanged.
- **Export**: HTML/PDF = `editor.renderHTML()` inside `<article class="margin-doc">` + current theme + custom CSS + `blocksCSS` + KaTeX CSS (fonts from jsDelivr), only when KaTeX markup is present. Print uses `platform.print?.()` or `window.print()` with print CSS.

## Tests

- Unit: `npm test` → `src/app/__tests__/*.test.ts` (fuzzy, paths, keymap/commands, settings migration, themes, DocumentController, memory platform, export).
- E2E: `npx playwright test` → `tests/e2e/app-*.spec.ts` (vite on port 5183, or set `E2E_PORT`).

## Known gaps

- Single document per window (Typora model). No tabs and no multi-window.
- File-tree rename, delete and new folder need the optional platform methods. Without them those menu items are disabled.
- Exported HTML keeps local image srcs as returned by `renderHTML()` (asset URLs are not rewritten to file paths).
- Find shows "No results" but no match count, because the contract has no count API.

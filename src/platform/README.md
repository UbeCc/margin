# `src/platform` — Platform implementations

```ts
import { getPlatform } from './platform';
const platform = getPlatform(); // TauriPlatform inside the app, WebPlatform in a browser
```

`getPlatform()` checks `'__TAURI_INTERNALS__' in window` and returns a singleton. Both
implementations follow `Platform` in `src/contracts.ts` and also provide `print()` and `allowAssetDir()`
(see `PlatformExtras`).

| File | What |
| --- | --- |
| `index.ts` | `getPlatform()`, re-exports |
| `tauri.ts` | `invoke`/`listen` wrappers over the Rust commands (`src-tauri/README.md`) |
| `web.ts` | in-browser implementation for `npm run dev` and Playwright e2e |
| `common.ts` | built-in themes (`import.meta.glob('../themes/*.css')`), `DEFAULT_SETTINGS`, `normalizeSettings`, POSIX path helpers, image naming |
| `fuzzy.ts` | Quick Open ranking (same algorithm as `quick_open.rs`) |
| `shortcuts.ts` | the menu accelerator table as data, `matchShortcut`, `shortcutLabel` |

## Notes for app / core / blocks

- **Menus own their shortcuts.** On desktop, keys bound in the native menu (⌘S, ⌘B,
  ⌘Z, ⌘1…6, ⌘/, ⌘\, F8, F9…) never reach the webview as `keydown`. They arrive only
  through `onMenu`. `web.ts` copies this: a capture-phase listener turns the same keys
  into `onMenu` actions and stops the event. So:
  - Handle formatting, headings and undo in `onMenu`, not in keydown handlers.
  - `undo`/`redo`/`find` also fire while focus is in an `<input>` such as the find
    bar. Route them yourself, e.g. `document.execCommand('undo')` when
    `activeElement` is an input. Cut, copy, paste and select-all stay native.
- **Zoom reset is ⌘⇧0.** ⌘0 means Paragraph (`heading:0`). ⌘= / ⌘- zoom in and out.
  Zoom is applied by the frontend.
- **Images**:
  - Use `platform.assetUrl(absPath)` for local files. On desktop this gives an
    `asset://` URL. The protocol is scoped to the folders of opened docs, so call
    `readTextFile`/`listDir`/`watch` (or the dialogs) before rendering.
  - The src strings from `storeImage` are percent-encoded (`My%20Doc.assets/x.png`).
    Run `decodeURI` and resolve against the doc dir before calling `assetUrl`.
  - Outside the opened tree, call `platform.allowAssetDir(dir)` first.
    `web.ts` returns data URLs.
- **storeImage** copies and never moves. For an unsaved document, or bytes under the
  `none` rule, desktop writes to `<app data>/images` and returns an absolute path,
  while web returns a `data:` URL. `http(s)`/`data:` inputs come back unchanged.
- **Watch events**:
  - Your own `writeTextFile` produces no `modified` event. It does produce `created`
    when it creates the file (Save As into the open folder).
  - An atomic save by another editor shows up as `modified`, possibly for a path you
    didn't know about yet. Treat an unknown `modified` path as a create.
  - Events come in batches, with a 200 ms debounce on desktop and about 30 ms on web.
- **Close**: `onCloseRequested(cb)` covers the close button, ⌘Q and Dock quit. Return
  `false` to keep the window open. With no handlers, closing is immediate. The `close`
  *menu action* (⌘W) is just a `MenuAction`, and the app decides what it means.
- **onOpenFiles** delivers files given at launch (Finder "Open With", CLI args) once
  you subscribe, then later opens live.
- **exportPdf**:
  - On macOS it writes a paginated PDF and honours `@media print` / `page-break-*`.
    Don't put a page break before the first element.
  - Relative `src`s resolve against the output file's directory, so prefer absolute
    `assetUrl()` srcs.
  - On other desktop OSes and on web it opens the print dialog instead.
  - `print()` prints the current window. Use `@media print` CSS to hide chrome.
- **pandocExport** (optional, desktop only, #81): `pandocExport(md, outPath, {format, docDir, title, pandocPath, timeoutMs})`
  runs `pandoc -f markdown -t <docx|latex|epub> -o <out> --resource-path <docDir>` (argv, markdown on stdin,
  cwd = docDir) and resolves to pandoc's warnings. Pandoc is found via `pandocPath` → `$PATH` →
  `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`; version must be ≥ 2. Not found / too old /
  non-zero exit (stderr included) / timeout (process killed) all reject with a readable message.
  `pandocDetect(path)` returns `{path, version}` for Preferences.
- **Themes**: `listThemes()` = built-ins from `src/themes/*.css` + the user's
  `themesDir()` CSS. On desktop it also refreshes the native Themes menu.
  `theme:<name>` arrives via `onMenu`, and `saveSettings` ticks the matching item.
- **Settings** are normalized on load and save: unknown keys are kept, invalid ones
  reset. `settingsVersion` is stripped on the TS side.

## Web implementation (`web.ts`)

- **In-memory filesystem** seeded with `/Margin/{Welcome.md, Diagrams.md, README.txt, Notes/Ideas.md, Notes/Todo.md}`
  and an empty `/Margin Themes`. It is persisted in `localStorage` (`margin.web.fs.v1`,
  `margin.web.settings.v1`).
- **File System Access API** (Chrome/Edge, not under automation): Open, Open Folder
  and Save As use real files mounted under `/Local/<name>`. Writes go through to disk;
  mounted files are not persisted in localStorage. Folder mounts read
  md/txt/css eagerly, and images are served as blob URLs.
- **Without FSA**: dialogs fall back to `prompt()` over memfs paths.
- **e2e hooks** (`window.__MARGIN_WEB__`, a `WebPlatform`):
  - `dialogHook = (kind, opts) => path | null` or `window.__MARGIN_DIALOG__`
  - `triggerMenu(action)`, `openFiles(paths)`, `requestClose()`
  - `externalWrite(path, text)`, `externalRemove(path)`, `externalRename(from, to)`
    simulate other apps
  - `exports` (recorded HTML/PDF exports), `documentEdited`, `title`, `reset(seed?)`
  - `?open=/Margin/Welcome.md` in the URL acts like a CLI arg.
- Under `navigator.webdriver` it never opens downloads or print dialogs.

## Tests

`npx vitest run src/platform` runs 24 tests: memfs, persistence, watch semantics,
quick open, storeImage, settings, shortcuts, close veto, and the fuzzy and path helpers.

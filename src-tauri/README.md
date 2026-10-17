# Margin native shell (`src-tauri`)

Tauri v2 backend for the `Platform` contract in `src/contracts.ts`. The JS side is
`src/platform/tauri.ts`; see `src/platform/README.md` for the frontend view.

## Layout

| File | What |
| --- | --- |
| `src/lib.rs` | builder, state, menu dispatch, close-request veto, `RunEvent::Opened`/CLI open-files, asset-scope helpers, debug PDF self-test |
| `src/commands.rs` | every `#[tauri::command]` (thin wrappers; blocking I/O runs in `spawn_blocking`) |
| `src/fsops.rs` | atomic write, text decoding, `list_dir` ordering, own-write tracker |
| `src/watch.rs` | `notify` + `notify-debouncer-full` (200 ms) → `FsEvent` batches |
| `src/quick_open.rs` | per-root file index (`ignore` walker) + fuzzy scorer |
| `src/images.rs` | `store_image` rules, naming, relative src encoding |
| `src/settings.rs` | settings JSON: defaults, per-key validation, migrations |
| `src/menu.rs` | native menu + accelerators, Themes submenu |
| `src/pdf_macos.rs` | PDF export via WKWebView print operation; `NSWindow.documentEdited` |

## Commands → events

Commands (JS camelCase args): `read_text_file{path}`, `write_text_file{path,content}`,
`stat{path}`, `list_dir{path}`, `watch{path} → id`, `unwatch{id}`,
`quick_open{root,query,limit}`, `store_image{docPath,rule,path}`,
`store_image_bytes` (raw body + `x-margin-meta` header), `open_dialog{directory}`,
`save_dialog{defaultPath,filters}`, `export_html{html,outPath}`,
`export_pdf{html,outPath,baseDir?}`, `print_window`, `load_settings`,
`save_settings{settings}`, `list_themes`, `themes_dir`, `set_theme_menu{names,current}`,
`open_external{url}`, `set_title{title}`, `set_document_edited{edited}`,
`set_close_guard{enabled}`, `confirm_close`, `take_pending_open_files`, `allow_asset_dir{path}`.

Events to the `main` window: `margin://menu` (a `MenuAction` string),
`margin://fs-events` (`{id, events: FsEvent[]}`), `margin://open-files` (`string[]`),
`margin://close-requested`.

## Behaviour notes

- **Atomic writes**: temp file `.margin-XXXX.tmp` in the same dir → fsync → copy the
  old mode bits (new files get 0644) → rename. Symlinks: the target gets replaced and
  the link stays. Reads strip a UTF-8 BOM and decode UTF-16 with a BOM. Anything else
  that isn't valid UTF-8 is decoded lossily. Saving writes the BOM back as plain UTF-8,
  without the BOM.
- **Watcher**: recursive, 200 ms debounce. Hidden paths and our temp files are dropped.
  A `temp → target` rename (an atomic save, by us or by another editor) becomes
  `modified{target}`. If **we** wrote a path within the last 300 ms, the event is
  dropped when the file already existed, and becomes `created` when our write made it
  (Save As into a watched folder). The watcher also keeps the quick-open index up to date.
- **Quick open**: `.gitignore`/`.ignore`/hidden files are respected even outside git.
  `node_modules`, `target` and `__pycache__` are skipped, and the index is capped at
  50k files. Indexes are cached per root. A watched root is updated incrementally
  (a created directory marks it dirty, so it is re-walked lazily). An unwatched root
  is re-walked after 10 s. Ranking puts markdown/txt first, then score (filename match
  bonus, contiguity, word/camel boundaries), then depth and length.
- **store_image**: copies files and never moves them. If an identical file already
  exists in the target, it is reused. A name clash gets a `-1` suffix. Bytes are
  written as `image-YYYYMMDD-HHMMSS-xxx.ext`, with the extension taken from the mime
  type, the name or magic bytes.
  - `${filename}` expands to the doc's stem, and `~` expands to home.
  - The src is relative for the `relative` rule and absolute for `absolute`.
  - The src uses forward slashes, with ` %()<>#?` percent-encoded (non-ASCII stays as
    is), so `decodeURI` it before resolving.
  - An unsaved doc, or bytes under the `none` rule, goes to `<app data>/images` with an
    absolute src.
  - `http(s):`/`data:` paths are returned unchanged (no downloading yet).
- **Settings**: `<app config>/settings.json` (macOS: `~/Library/Application Support/dev.ubec.margin/`).
  Loading never fails. Unknown keys are kept. A known key with a bad value falls back
  to its default on its own. `fontSize` is clamped to 8–72 and recents are capped at 20.
  Migrations:
  - v0: `imageFolder`/`copyImages`/`darkMode`/`recent`.
  - v1: `colorScheme:"auto"`, `imageRule.kind:"copy"`.
  - Saved files carry `settingsVersion: 2`.
- **Themes**: `list_themes` returns only `<app config>/themes/*.css`, because the
  built-ins are bundled by the frontend. Help › Open Themes Folder opens that directory.
- **Close/quit**: when the frontend has a close handler (`set_close_guard`), the window
  close button, ⌘Q (a custom Quit item) and Dock quit all emit `close-requested`
  instead of closing. The frontend then calls `confirm_close` (destroys the window,
  and the app exits) or does nothing.
- **Open files**: Finder/Dock (`RunEvent::Opened`) and CLI args are queued until the
  frontend calls `take_pending_open_files`; after that they are emitted live.
- **Window**: 1100×760, min 480×360, `titleBarStyle: Transparent` (no layout impact),
  `dragDropEnabled: false`, so HTML5 drag & drop works in the editor and dropped files
  arrive as `File` objects with bytes.

## Security

- **No fs/dialog/opener JS permissions.** All file access goes through our commands.
  `build.rs` declares an app manifest, so each command needs an explicit
  `allow-<command>` permission. Only the `main` window has them
  (`capabilities/default.json`), plus `core:event:allow-listen/unlisten`.
- **Scoped asset protocol.** The scope starts empty and only deny-lists
  `.ssh/.gnupg/.aws/Keychains`. Directories are added at runtime when a document is
  read or written (its parent dir, recursive), when a folder is listed or watched
  (recursive), when a dialog picks a path, for the image fallback dir, and for the
  themes dir.
  - Home and filesystem roots are only allowed non-recursively.
  - `allow_asset_dir` adds a single directory, non-recursively.
  - There is no `allowingReadAccessToURL:/` and no `file://` access.
- **CSP** (production): `script-src 'self'`, `object-src 'none'`, and
  images/styles/fonts from `'self' asset: data: blob:`; images may also come from
  `https:`/`http:`. `devCsp` is null so Vite HMR works.
- **`open_external`** accepts only `http`, `https` and `mailto`.
- **No shell commands anywhere.**
- **PDF export** runs in a hidden window. That window has no capability, so it has no
  IPC. Navigation is limited to `about:`/`asset:`, and pages are loaded with an
  `asset://` base URL.

## PDF export (macOS)

`export_pdf` creates a hidden `WebviewWindow` on `about:blank`. It then calls
`loadHTMLString:baseURL:` with `asset://localhost/%2F<dir>/` as the base URL (the
output file's dir, or `baseDir`), so relative `src`s resolve through the scoped asset
protocol. It waits until `isLoading == false`, then 400 ms more, and enables
`WKPreferences.shouldPrintBackgrounds` on macOS 13.3+.

The PDF itself comes from `printOperationWithPrintInfo:` with `NSPrintSaveJob` to the
output URL, no panels, 0.5" margins, the default paper size and fit-width pagination.
This gives a real multi-page PDF that honours `@media print` / `page-break-*`, and its
text (CJK included) can be selected. If that fails, it falls back to
`createPDFWithConfiguration:` (a single tall page).

Verified on this Mac: `MARGIN_PDF_SELFTEST=/tmp/x.pdf cargo run` (debug builds only)
renders a 6-section sample with a relative SVG image and exits 0. The result has
6 pages, the image shows, and the text extracts.

Limits:
- There are no PDF outlines or bookmarks.
- Internal `#anchor` links are not converted to PDF destinations.
- There are no headers or footers.
- Paper size comes from the system default.
- A `page-break-before` on the very first element yields a blank first page.
- Scripts in the exported HTML run but have no IPC access. Prefer pre-rendered HTML.
- **Linux/Windows**: `export_pdf` returns `unsupported:` and `tauri.ts` falls back to
  printing the HTML in a hidden iframe (system print dialog → "Save as PDF").
  WebView2's `PrintToPdf` would be the Windows upgrade path.

## Build & test

```sh
export PATH=~/.local/node24/bin:$PATH
cd src-tauri && cargo test          # 30 unit tests (fs, images, settings, quick open, watcher, menu)
cargo build                         # dev build (needs `npm run dev` for the UI)
cd .. && npm run tauri build -- --debug --bundles app   # ~30 s incremental → target/debug/bundle/macos/Margin.app
```

The `~/.cargo/config` deprecation warning is harmless. If cargo can't reach the
registry, use `CARGO_HTTP_PROXY=http://127.0.0.1:7897`. `permissions/autogenerated/`
is regenerated by `build.rs` and is git-ignored.

## Known gaps

- No Open Recent menu.
- No multi-window: one `main` window, and Cmd+N is forwarded as `new` to the frontend.
- No single-instance plugin. On macOS the OS already routes opens to the running app.
- Remote images are not downloaded in `store_image`.
- `set_document_edited` is a no-op off macOS. Prefix the title instead.
- Read-only files: writes fail with the OS error. There's no "save anyway" prompt.
- The macOS PDF fallback page is one long page.

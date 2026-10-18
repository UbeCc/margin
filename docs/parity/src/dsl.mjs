// Tiny DSL for parity surfaces. One surface = one REA reconstruction obligation.
//   S(id, title, status, owner, verifier, opts)
//   status:   'owned' | 'partial' | 'missing' | 'oos'
//   owner:    'repo/relative/path#verbatim anchor' (anchor must appear in the file) | null
//   verifier: 'test/file::verbatim test title fragment' | null
//   opts:     { p: 0|1|2, e: epicId, A/B/C: spec labels covered, sec: prose section refs, note, why }
export const S = (id, title, status, owner, verifier, opts = {}) => ({ id, title, status, owner, verifier, ...opts });

// Verifier prefixes (Playwright e2e + vitest).
export const T = {
  nav: 'tests/e2e/app-navigation.spec.ts::',
  files: 'tests/e2e/app-files.spec.ts::',
  pf: 'tests/e2e/parity-files.spec.ts::',
  themes: 'tests/e2e/app-themes.spec.ts::',
  core: 'tests/e2e/core-cases.ts::',
  qa: 'tests/e2e/core-qa.spec.ts::',
  keys: 'tests/e2e/core-nav-keys.spec.ts::',
  wfind: 'tests/e2e/core-widget-find.spec.ts::',
  bw: 'tests/e2e/blocks-widgets.spec.ts::',
  bc: 'tests/e2e/blocks-core.spec.ts::',
  bcss: 'tests/e2e/blocks-export-css.spec.ts::',
  doc: 'src/app/__tests__/document.test.ts::',
  set: 'src/app/__tests__/settings.test.ts::',
  util: 'src/app/__tests__/util.test.ts::',
  web: 'src/platform/web.test.ts::',
  pclip: 'tests/e2e/parity-clipboard.spec.ts::',
};

// Owner prefixes.
export const O = {
  app: 'src/app/app.ts#',
  menu: 'src-tauri/src/menu.rs#',
  cmd: 'src/editor/core/commands.ts#',
  cmds: 'src/app/commands.ts#',
  doc: 'src/app/document.ts#',
  tree: 'src/app/sidebar/filetree.ts#',
  prefs: 'src/app/preferences.ts#',
  set: 'src/app/settings.ts#',
  clip: 'src/editor/core/clipboard.ts#',
  table: 'src/editor/blocks/table.ts#',
  fence: 'src/editor/blocks/code-fence.ts#',
  math: 'src/editor/blocks/math.ts#',
};

export const EPICS = {
  'core-cmds': { p: 0, area: 'area:core', title: 'Paragraph & Format menu commands (headings, inline styles, insert/convert blocks)' },
  files: { p: 0, area: 'area:app,area:native', title: 'File lifecycle: tabs/windows, recent, duplicate/move/rename, encoding, versions, recovery' },
  export: { p: 0, area: 'area:native', title: 'Export, import & print: image/Pandoc/custom formats, export settings, export-with-previous' },
  clipboard: { p: 0, area: 'area:core', title: 'Clipboard & selection: copy-as / paste-as, selection & delete scopes, jump-to' },
  ctx: { p: 1, area: 'area:app', title: 'Editor & sidebar context menus (text, link, table, image, code, math, diagram, outline, files)' },
  tools: { p: 1, area: 'area:blocks', title: 'Table, code-fence and math tools' },
  images: { p: 1, area: 'area:native', title: 'Image pipeline: insert-local, copy/move/upload, zoom, syntax switch, image root path' },
  prefs: { p: 1, area: 'area:app', title: 'Preferences completeness (General, Editor, Image, Markdown, Export, Appearance panes)' },
  sidebar: { p: 1, area: 'area:app', title: 'Sidebar & outline: list view, file search, sort, collapsible outline, filter' },
  syntax: { p: 2, area: 'area:core', title: 'Markdown syntax options & whitespace/line-break settings' },
  chrome: { p: 2, area: 'area:app,area:native', title: 'Window chrome & writing aids: status bar, always-on-top, spelling, substitutions, speech, emoji' },
};

import { S, T, O } from './dsl.mjs';

const ec = 'editor-core';
// Paragraph & Format command verifiers (epic #93): one test per surface, titled with its id.
const V = (id) => 'tests/e2e/parity-core-cmds.spec.ts::' + id + ':';
const PC = 'src/editor/core/para-cmds.ts#';
export default [
  // ── Paragraph ─────────────────────────────────────────────────────
  S('menu.para.headings', 'Paragraph › Heading 1–6 / Paragraph', 'owned', O.cmd + "case 'heading'", T.nav + 'keyboard shortcuts drive editor commands', { A: ['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'], C: ['touchBar.setBlockStyle'] }),
  S('menu.para.heading-level', 'Paragraph › Increase / Decrease Heading Level', 'owned', O.cmd + "case 'headingLevel'", V('menu.para.heading-level'), { A: ['Increase Heading Level', 'Decrease Heading Level'] }),
  S('menu.para.table', 'Paragraph › Table / Insert Table (with rows×columns dialog)', 'owned', 'src/app/ui/table-dialog.ts#export function insertTableDialog', 'tests/e2e/parity-tools.spec.ts::menu.para.table:', { p: 1, e: 'tools', A: ['Table', 'Insert Table'], B: ['Insert Table', 'Rows', 'Columns'], C: ['touchBar.showInsertTableTouchBar', 'touchBar.updateInsertTableTouchBar'], sec: [ec + ' §7.4'], note: '3 columns × 4 rows incl. header, remembers the last size, 1–40 cols / 1–99 rows (typora-re#4); inserts after the caret block instead of splitting the paragraph; no Touch Bar' }),
  S('menu.para.math-block', 'Paragraph › Math Block', 'owned', O.cmd + "case 'math'", T.bw + 'renders KaTeX, edits source, shows errors', { A: ['Math Block', 'Math'], B: ['Input Math TeX here', 'Math Blocks'], sec: [ec + ' §7.2'] }),
  S('menu.para.code-fence', 'Paragraph › Code Fences (with language box)', 'owned', O.cmd + "case 'code'", T.core + '``` + Enter mounts a code widget', { A: ['Code Fences'], B: ['code language', 'Code Fences'], C: ['touchBar.setFencesOnSetLang'], sec: [ec + ' §7.1'] }),
  S('menu.para.html-block', 'Paragraph › HTML Block (insert)', 'owned', O.cmd + "case 'html'", V('menu.para.html-block'), { A: ['HTML Block'], sec: [ec + ' §7.5'] }),
  S('menu.para.containers', 'Paragraph › Quote / Ordered List / Unordered List / Task List', 'owned', O.cmd + "case 'quote'", T.qa + 'cut/paste list items, toggle list on two blocks', { A: ['Quote', 'Ordered List', 'Unordered List', 'Task List', 'List Styles / Remove Block'], B: ['Ordered List', 'Unordered List'] }),
  S('menu.para.task-status', 'Paragraph › Task Status: toggle / mark complete / incomplete', 'owned', PC + 'export function taskStatus', V('menu.para.task-status'), { A: ['Task Status', 'Toggle Task Status', 'Mark as Complete', 'Mark as Incomplete'] }),
  S('menu.para.indent', 'Paragraph › List Indentation: Indent / Outdent', 'owned', 'src/editor/core/input.ts#Tab', T.qa + 'Tab moves an item with its nested children', { A: ['List Indentation', 'Indent', 'Outdent'], B: ['Indent'] }),
  S('menu.para.insert-paragraph', 'Paragraph › Insert Paragraph Before / After', 'owned', PC + 'export function insertParagraph', V('menu.para.insert-paragraph'), { A: ['Insert Paragraph Before', 'Insert Paragraph After', 'Paragraph (before)', 'Paragraph (after)', 'Insert'] }),
  S('menu.para.link-reference', 'Paragraph › Link Reference (insert [id]: url definition)', 'owned', O.cmd + "case 'linkRef'", V('menu.para.link-reference'), { A: ['Link Reference'], note: 'inserts a [id]: url definition; no hover hint on undefined references yet', B: ['Please define image reference by [{0}]: http://example.png', 'Need to define the reference link <b>[{0}]</b> with syntax <b>[{1}]: www.example.com</b>'] }),
  S('menu.para.footnotes', 'Paragraph › Footnotes (insert, hover preview, jump)', 'owned', PC + 'export function insertFootnote', V('menu.para.footnotes'), { A: ['Footnotes'], sec: [ec + ' §7.5'] }),
  S('menu.para.hr', 'Paragraph › Horizontal Line', 'owned', O.cmd + "case 'hr'", T.core + 'exec: heading, strong, block quote', { A: ['Horizontal Line'] }),
  S('menu.para.toc', 'Paragraph › Table of Contents', 'owned', O.cmd + "case 'toc'", T.bw + 'toc lists headings and scrolls', { A: ['Table of Contents'], B: ['Table of Contents'], sec: [ec + ' §7.5'] }),
  S('menu.para.front-matter', 'Paragraph › YAML Front Matter', 'owned', O.cmd + "case 'front_matter'", V('menu.para.front-matter'), { A: ['YAML Front Matter'] }),

  // ── Format ────────────────────────────────────────────────────────
  S('menu.format.basic', 'Format › Strong / Emphasis / Code / Strike / Highlight', 'owned', O.cmd + "case 'mark'", T.nav + 'keyboard shortcuts drive editor commands', { A: ['Format', 'Strong', 'Emphasis', 'Code', 'Strike', 'Highlight', 'Inline Styles', 'Block Styles'], C: ['touchBar.setInlineEnabled', 'touchBar.setInlineStates'] }),
  S('menu.format.underline', 'Format › Underline (<u>)', 'owned', O.cmd + "underline: ['<u>', '</u>']", V('menu.format.underline'), { A: ['Underline'] }),
  S('menu.format.inline-math', 'Format › Inline Math (toggle $…$)', 'owned', O.cmd + "math: ['$', '$']", V('menu.format.inline-math'), { A: ['Inline Math'] }),
  S('menu.format.sub-sup', 'Format › Superscript / Subscript', 'owned', O.cmd + "sub: ['<sub>', '</sub>']", V('menu.format.sub-sup'), { A: ['Superscript', 'Subscript'] }),
  S('menu.format.comment', 'Format › Comment (<!-- -->)', 'owned', O.cmd + "comment: ['<!-- ', ' -->']", V('menu.format.comment'), { A: ['Comment'] }),
  S('menu.format.hyperlink', 'Format › Hyperlink', 'owned', O.cmd + "case 'mark'", T.core + 'Cmd+click opens links', { A: ['Hyperlink'] }),
  S('menu.format.clear', 'Format › Clear Format', 'owned', PC + 'export function clearFormat', V('menu.format.clear'), { A: ['Clear Format'] }),
  S('menu.format.image', 'Format › Image › Insert Image / Insert Local Images…', 'owned', 'src/app/images/tools.ts#async insertLocal()', T.pimg + 'menu.format.image: Format › Image › Insert Image / Insert Local Images…', { p: 0, e: 'images', A: ['Image', 'Insert Image', 'Insert Local Images'], B: ['Select image from local file', 'input image URL'], C: ['images.insertLocalImage'], sec: ['images §4.1'], note: 'full Format › Image submenu in Typora order (native menu + palette); per-image entries act on the image at the caret' }),

  // ── View ──────────────────────────────────────────────────────────
  S('menu.view.source-mode', 'View › Source Code Mode', 'owned', O.app + "case 'toggleSource'", T.core + 'source mode round-trip', { A: ['View', 'Source Code Mode', 'Toggle Source Code Mode', 'Exit Source Code Mode'], B: ['Toggle Source Code Mode', 'Exit Source Code Mode'], C: ['window.updateUIAfterExitSourceMode'], sec: [ec + ' §8.1'] }),
  S('menu.view.focus-typewriter', 'View › Focus Mode / Typewriter Mode', 'owned', O.app + "case 'toggleFocus'", T.nav + 'native menu actions route through one dispatcher', { A: ['Focus Mode', 'Typewriter Mode'], B: ['Typewriter Mode', 'Turn off Typewriter / Focus Mode', 'Typewriter / Focus Mode have been turned off.', 'Always keep caret in middle of screen when typewriter mode is enabled'], sec: [ec + ' §8.2'] }),
  S('menu.view.sidebar', 'View › Toggle Sidebar / Outline / File Tree', 'owned', O.app + "case 'toggleSidebar'", T.nav + 'outline lists headings and jumps on click', { A: ['Toggle Sidebar', 'Outline', 'File Tree', 'File Tree (Tree View)'], B: ['Toggle Sidebar', 'Close sidebar', 'Close Sidebar Menu', 'Outline', 'Switch to Outline view', 'Switch to File Tree view'] }),
  S('menu.view.status-bar', 'View › Show Status Bar (word count, toggle)', 'partial', 'src/app/statusbar.ts#cycle()', null, { p: 2, e: 'chrome', A: ['Show Status Bar'], B: ['Show status bar', 'Status Bar', 'Word Count', 'Always Show Word Count', 'Words', 'Word', 'Characters', 'Character', 'Lines', 'Line', 'Minute', 'Minutes', 'Reading Speed', 'words / min', '120 words/minute (Slow)', '240 words/minute (Medium)', '382 words/minute (Fast)', 'Total', 'Word count only support OS X later than 10.10.'], C: ['word.updateWordCount'], sec: [ec + ' §8.3'], note: 'status bar always shown; no reading time / word-count popover' }),
  S('menu.view.zoom', 'View › Actual Size / Zoom In / Zoom Out', 'owned', O.app + "case 'zoomIn'", null, { A: ['Actual Size', 'Zoom In', 'Zoom Out', 'Zoom'], C: ['window.zoomIn', 'window.zoomOut', 'window.resetZoom'] }),
  S('menu.view.fullscreen', 'View › Toggle Fullscreen', 'owned', O.menu + 'PredefinedMenuItem::fullscreen', null, { A: ['Full Screen', 'Toggle Fullscreen'] }),
  S('menu.view.always-on-top', 'View › Always on Top', 'missing', null, null, { p: 2, e: 'chrome', A: ['Always on Top'] }),
  S('menu.view.devtools', 'View › Toggle DevTools / Inspect Element (debug builds)', 'missing', null, null, { p: 2, e: 'chrome', A: ['Toggle DevTools', 'Inspect Element'], B: ['Developer', 'Enable Debug'] }),
  S('menu.view.magnification', 'View › Allow Magnification (trackpad pinch zoom)', 'missing', null, null, { p: 2, e: 'chrome', A: ['Allow Magnification'] }),

  // ── Themes / Window / Help ────────────────────────────────────────
  S('menu.themes', 'Themes menu: built-in + user themes, check mark on current', 'owned', O.menu + 'THEMES_SUBMENU_ID', T.themes + 'command palette theme entry and custom CSS', { A: ['Themes'], B: ['Themes', 'Theme', 'Current Theme'], sec: ['files-windows-settings §9'] }),
  S('menu.themes.folder', 'Themes › Open Theme Folder', 'owned', O.app + "case 'openThemesFolder'", null, { B: ['Open Theme Folder'] }),
  S('menu.themes.gallery', 'Themes › Get Themes (theme gallery website)', 'oos', null, null, { B: ['Get Themes'], why: 'Links to the vendor-hosted theme gallery; Margin documents user themes instead.' }),
  S('menu.state-sync', 'Native menu state sync (enabled/checked items follow editor state)', 'partial', 'src-tauri/src/commands.rs#set_theme_menu', null, { p: 2, e: 'chrome', C: ['menu.updateMenu'], note: 'only the Themes check marks are synced' }),
  S('menu.window', 'Window › Minimize / Zoom / Bring All to Front', 'owned', O.menu + 'PredefinedMenuItem::minimize', null, { A: ['Window', 'Minimize', 'Bring All to Front'] }),
  S('menu.help.reference', 'Help › Markdown reference', 'owned', O.menu + 'ID_HELP_MARKDOWN', null, { A: ['Help'], B: ['Support Document', 'Support Documentation', 'Learn More', 'Learn More…'] }),
  S('menu.help.vendor-links', 'Help › Website / Feedback / Change Log / Contact (vendor URLs)', 'oos', null, null, { A: ['Website', 'Feedback', 'Change Log', 'Learn More'], B: ['Contact'], why: 'Vendor-specific web destinations; Margin points at its own repo.' }),
];

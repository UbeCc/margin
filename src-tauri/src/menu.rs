//! Native application menu. Every custom item's id is a `MenuAction` string
//! (see `src/contracts.ts`); clicks are forwarded to the main window as
//! `margin://menu` events. Clipboard items stay native (predefined) so they work
//! in every text field of the webview.

use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuBuilder, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Runtime};

pub const THEMES_SUBMENU_ID: &str = "submenu:themes";
pub const BUILTIN_THEMES: &[&str] = &["paper", "night", "github"];
/// Menu ids handled in Rust rather than forwarded.
pub const ID_QUIT: &str = "app:quit";
pub const ID_HELP_MARKDOWN: &str = "help:markdown";
pub const ID_HELP_THEMES_FOLDER: &str = "help:themesFolder";

/// (id/action, label, accelerator)
type Item = (&'static str, &'static str, Option<&'static str>);

const FILE_OPEN: &[Item] = &[
    ("new", "New", Some("CmdOrCtrl+N")),
    ("newTab", "New Tab", Some("CmdOrCtrl+T")),
    ("newWindow", "New Window", Some("CmdOrCtrl+Shift+N")),
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("openFolder", "Open Folder…", None),
];
const REVEAL: &str = if cfg!(target_os = "macos") { "Reveal in Finder" } else { "Open File Location" };
const FILE: &[Item] = &[
    ("reopenClosed", "Reopen Closed File", Some("CmdOrCtrl+Shift+T")),
    ("quickOpen", "Open Quickly…", Some("CmdOrCtrl+Shift+O")),
    ("-", "", None),
    ("save", "Save", Some("CmdOrCtrl+S")),
    ("saveAs", "Save As…", Some("CmdOrCtrl+Shift+S")),
    ("saveAll", "Save All", Some("CmdOrCtrl+Alt+S")),
    ("duplicate", "Duplicate", None),
    ("renameFile", "Rename…", None),
    ("moveTo", "Move To…", None),
    ("-", "", None),
    ("reloadFromDisk", "Revert to Saved", None),
    ("browseVersions", "Browse All Versions…", None),
    ("reopenWithEncoding", "Reopen with Encoding…", None),
    ("recoverDrafts", "Recover Unsaved Drafts…", None),
    ("-", "", None),
    ("revealInFinder", REVEAL, None),
    ("copyFilePath", "Copy File Path", None),
    ("properties", "Properties…", None),
    ("-", "", None),
    ("import", "Import…", None),
];
/// Window menu: document tabs (#94).
const WINDOW_TABS: &[Item] = &[
    ("nextTab", "Show Next Tab", Some("CmdOrCtrl+Shift+BracketRight")),
    ("prevTab", "Show Previous Tab", Some("CmdOrCtrl+Shift+BracketLeft")),
];
const EXPORT: &[Item] = &[
    ("exportHtml", "HTML…", None),
    ("exportPdf", "PDF…", Some("CmdOrCtrl+Alt+E")),
    ("exportDocx", "Word (.docx)…", None),
    ("exportLatex", "LaTeX…", None),
    ("exportEpub", "EPUB…", None),
    ("exportOdt", "OpenOffice…", None),
    ("exportRtf", "RTF…", None),
    ("exportMediawiki", "MediaWiki…", None),
    ("exportRst", "reStructuredText…", None),
    ("exportTextile", "Textile…", None),
    ("exportOpml", "OPML…", None),
];
/// Export submenu, after the format items (#95).
const EXPORT_MORE: &[Item] = &[
    ("exportHtmlPlain", "HTML (without Styles)…", None),
    ("exportImage", "Image…", None),
    ("exportCustom", "Custom…", None),
    ("-", "", None),
    ("exportPrevious", "Export with Previous", None),
    ("exportOverwrite", "Export and Overwrite with Previous", None),
    ("-", "", None),
    ("exportSettings", "Export Settings…", None),
];
const EDIT_TOP: &[Item] = &[("undo", "Undo", Some("CmdOrCtrl+Z")), ("redo", "Redo", Some("CmdOrCtrl+Shift+Z"))];
const EDIT_FIND: &[Item] = &[("find", "Find…", Some("CmdOrCtrl+F")), ("replace", "Replace…", Some("CmdOrCtrl+Alt+F"))];
// #96 Edit › Copy As / Paste as Plain Text / Selection / Delete / Jump To
const EDIT_COPY_AS: &[Item] = &[
    ("copyAs:markdown", "Copy as Markdown", Some("CmdOrCtrl+Shift+C")),
    ("copyAs:html", "Copy as HTML Code", None),
    ("copyAs:plain", "Copy as Plain Text", None),
    ("copyAs:unstyled", "Copy without Theme Styling", None),
    ("copyAs:word", "Copy to Word Processor", None),
    ("-", "", None),
    ("copyAs:tex", "Copy Math as TeX", None),
    ("copyAs:mathml", "Copy Math as MathML", None),
    ("copyAs:image", "Copy Image", None),
];
const EDIT_PASTE_AS: &[Item] = &[("pastePlain", "Paste as Plain Text", Some("CmdOrCtrl+Shift+V"))];
const EDIT_SELECTION: &[Item] = &[
    ("select:word", "Select Word", Some("CmdOrCtrl+D")),
    ("select:line", "Select Line / Sentence", Some("CmdOrCtrl+L")),
    ("select:block", "Select Paragraph / Block", None),
    ("select:styled", "Select Styled Scope", Some("CmdOrCtrl+Shift+E")),
];
const EDIT_DELETE: &[Item] = &[
    ("delete:word", "Delete Word", Some("CmdOrCtrl+Shift+D")),
    ("delete:line", "Delete Line / Sentence", None),
    ("delete:block", "Delete Paragraph / Block", None),
    ("delete:styled", "Delete Styled Scope", None),
    ("delete:range", "Delete Range", None),
];
// ⌘↑ / ⌘↓ stay editor keys (text fields keep them); only the labels are shown
const EDIT_JUMP: &[Item] = &[
    ("jump:top", "Jump to Top", None),
    ("jump:bottom", "Jump to Bottom", None),
    ("jump:selection", "Jump to Selection", Some("CmdOrCtrl+J")),
];
// #103 Edit › Substitutions / Spelling and Grammar / Speech (native-commands.md §5.3–5.5, appendix A)
const EDIT_SUBST: &[Item] = &[
    ("subst:input", "Convert on Input", None),
    ("subst:render", "Convert on Rendering", None),
    ("-", "", None),
    ("subst:quotes", "Smart Quotes", None),
    ("subst:dashes", "Smart Dashes", None),
    ("subst:textReplacement", "Text Replacement", None),
    ("-", "", None),
    ("subst:remap", "Remap Unicode Punctuation on Parse", None),
    ("subst:more", "More Options…", None),
];
const EDIT_SPELL: &[Item] = &[
    ("spell:panel", "Show Spelling and Grammar", Some("CmdOrCtrl+Colon")),
    ("spell:now", "Check Document Now", Some("CmdOrCtrl+Semicolon")),
    ("spell:toggle", "Check Spelling While Typing", None),
    ("spell:grammar", "Check Grammar With Spelling", None),
    ("spell:autocorrect", "Correct Spelling Automatically", None),
];
const EDIT_SPEECH: &[Item] = &[("speech:start", "Start Speaking", None), ("speech:stop", "Stop Speaking", None)];
/// Menu ids rendered as tickable check items (menu state sync, #103).
const CHECK_IDS: &[&str] = &[
    "toggleStatusBar",
    "alwaysOnTop",
    "toggleMagnification",
    "spell:toggle",
    "spell:grammar",
    "spell:autocorrect",
    "subst:input",
    "subst:render",
    "subst:quotes",
    "subst:dashes",
    "subst:textReplacement",
    "subst:remap",
];
#[cfg(test)]
const EDIT_AIDS: &[&[Item]] = &[EDIT_SUBST, EDIT_SPELL, EDIT_SPEECH];
#[cfg(test)]
const EDIT_EXTRA: &[&[Item]] = &[EDIT_COPY_AS, EDIT_PASTE_AS, EDIT_SELECTION, EDIT_DELETE, EDIT_JUMP];
const PARAGRAPH: &[Item] = &[
    ("heading:1", "Heading 1", Some("CmdOrCtrl+1")),
    ("heading:2", "Heading 2", Some("CmdOrCtrl+2")),
    ("heading:3", "Heading 3", Some("CmdOrCtrl+3")),
    ("heading:4", "Heading 4", Some("CmdOrCtrl+4")),
    ("heading:5", "Heading 5", Some("CmdOrCtrl+5")),
    ("heading:6", "Heading 6", Some("CmdOrCtrl+6")),
    ("heading:0", "Paragraph", Some("CmdOrCtrl+0")),
    ("-", "", None),
    ("para:headingUp", "Increase Heading Level", None),
    ("para:headingDown", "Decrease Heading Level", None),
    ("-", "", None),
    ("@table", "Table", None),
    ("block:code", "Code Fences", Some("CmdOrCtrl+Alt+C")),
    ("@codeTools", "Code Tools", None),
    ("block:math", "Math Block", Some("CmdOrCtrl+Alt+B")),
    ("@mathTools", "Math Tools", None),
    ("block:html", "HTML Block", None),
    ("-", "", None),
    ("block:quote", "Quote", Some("CmdOrCtrl+Alt+Q")),
    ("block:ol", "Ordered List", Some("CmdOrCtrl+Alt+O")),
    ("block:ul", "Unordered List", Some("CmdOrCtrl+Alt+U")),
    ("block:task", "Task List", Some("CmdOrCtrl+Alt+X")),
    ("task:toggle", "Toggle Task Status", None),
    ("task:complete", "Mark as Complete", None),
    ("task:incomplete", "Mark as Incomplete", None),
    ("-", "", None),
    ("para:insertBefore", "Insert Paragraph Before", None),
    ("para:insertAfter", "Insert Paragraph After", None),
    ("-", "", None),
    ("block:linkRef", "Link Reference", None),
    ("block:footnote", "Footnotes", None),
    ("-", "", None),
    ("block:hr", "Horizontal Line", Some("CmdOrCtrl+Alt+Minus")),
    ("block:toc", "Table of Contents", None),
    ("block:front_matter", "YAML Front Matter", None),
];
// #98 Paragraph › Table / Code Tools / Math Tools (ops act on the block with the caret).
// Add Row Below (⌘↩) / Delete Row (⌘⇧⌫) stay table-cell keys so they never steal
// Cmd+Enter / Cmd+Shift+Backspace from other blocks; only the labels mention them.
const PARA_TABLE: &[Item] = &[
    ("block:table", "Insert Table…", Some("CmdOrCtrl+Alt+T")),
    ("-", "", None),
    ("table:rowAbove", "Add Row Above", None),
    ("table:rowBelow", "Add Row Below", None),
    ("-", "", None),
    ("table:colBefore", "Add Column Before", None),
    ("table:colAfter", "Add Column After", None),
    ("-", "", None),
    ("table:moveRowUp", "Move Row Up", None),
    ("table:moveRowDown", "Move Row Down", None),
    ("table:moveColLeft", "Move Column Left", None),
    ("table:moveColRight", "Move Column Right", None),
    ("-", "", None),
    ("table:deleteRow", "Delete Row", None),
    ("table:deleteCol", "Delete Column", None),
    ("-", "", None),
    ("table:alignLeft", "Align Left", None),
    ("table:alignCenter", "Align Center", None),
    ("table:alignRight", "Align Right", None),
    ("table:resize", "Resize Table…", None),
    ("-", "", None),
    ("table:copy", "Copy Table", None),
    ("table:prettify", "Prettify Source Code", None),
    ("table:delete", "Delete Table", None),
];
const PARA_CODE_TOOLS: &[Item] = &[
    ("code:copy", "Copy Code Content", None),
    ("code:indentAll", "Auto Indent Whole Code", None),
    ("code:indentSelected", "Auto Indent Selected Code", None),
];
const PARA_MATH_TOOLS: &[Item] = &[
    ("math:copyTex", "Copy as Tex", None),
    ("math:copyMathML", "Copy as MathML", None),
    ("-", "", None),
    ("math:delete", "Delete Math", None),
    ("-", "", None),
    ("math:refresh", "Refresh All Math Expressions", None),
];
/// `@name` markers in an item list expand to these submenus.
const SUBMENUS: &[(&str, &[Item])] = &[("@table", PARA_TABLE), ("@codeTools", PARA_CODE_TOOLS), ("@mathTools", PARA_MATH_TOOLS)];

const FORMAT: &[Item] = &[
    ("mark:strong", "Strong", Some("CmdOrCtrl+B")),
    ("mark:em", "Emphasis", Some("CmdOrCtrl+I")),
    ("mark:code", "Code", Some("CmdOrCtrl+E")),
    ("mark:strike", "Strike", Some("CmdOrCtrl+Shift+X")),
    ("mark:highlight", "Highlight", Some("CmdOrCtrl+Shift+H")),
    ("mark:underline", "Underline", Some("CmdOrCtrl+U")),
    ("mark:math", "Inline Math", Some("CmdOrCtrl+Shift+M")),
    ("mark:sup", "Superscript", None),
    ("mark:sub", "Subscript", None),
    ("mark:comment", "Comment", None),
    ("-", "", None),
    ("mark:link", "Hyperlink", Some("CmdOrCtrl+K")),
    ("-", "", None),
];
// #136: Typora order — Image submenu, Take Picture, Clear Format.
const FORMAT_TAIL: &[Item] = &[("takePicture", "Take Picture", None), ("clearFormat", "Clear Format", None)];
// Format › Image (#99): Typora's menu order; per-image entries act on the image at the caret.
const IMAGE_TOP: &[Item] = &[
    ("image:insert", "Insert Image", None),
    ("image:insertLocal", "Insert Local Images…", None),
    ("-", "", None),
    ("image:openLocation", "Open Image Location…", None),
    ("image:copyContent", "Copy Image Content", None),
];
const IMAGE_ZOOM: &[Item] = &[
    ("image:zoom-25", "25%", None),
    ("image:zoom-33", "33%", None),
    ("image:zoom-50", "50%", None),
    ("image:zoom-67", "67%", None),
    ("image:zoom-80", "80%", None),
    ("image:zoom-100", "100%", None),
    ("image:zoom-150", "150%", None),
    ("image:zoom-200", "200%", None),
];
const IMAGE_SYNTAX: &[Item] = &[("image:syntaxMarkdown", "Markdown Style", None), ("image:syntaxHtml", "HTML Style", None)];
const IMAGE_FILE: &[Item] = &[
    ("image:deleteFile", "Delete Image File", None),
    ("image:copyTo", "Copy Image to…", None),
    ("image:moveTo", "Rename or Move Image to…", None),
    ("image:upload", "Upload Image", None),
    ("-", "", None),
    ("image:copyAll", "Copy All Images to…", None),
    ("image:moveAll", "Move All Images to…", None),
    ("image:uploadAll", "Upload All Local Images", None),
    ("image:reloadAll", "Reload All Images", None),
    ("-", "", None),
];
const IMAGE_WHEN_INSERT: &[Item] = &[("image:insertCopyToFolder", "Copy Image File to Folder…", None), ("image:insertUpload", "Upload Image", None)];
const IMAGE_BOTTOM: &[Item] = &[("image:rootPath", "Use Image Root Path", None), ("image:settings", "Global Image Settings…", None)];
#[cfg(test)]
const IMAGE_ALL: &[&[Item]] = &[IMAGE_TOP, IMAGE_ZOOM, IMAGE_SYNTAX, IMAGE_FILE, IMAGE_WHEN_INSERT, IMAGE_BOTTOM];

const VIEW: &[Item] = &[
    ("commandPalette", "Command Palette…", Some("CmdOrCtrl+Shift+A")),
    ("-", "", None),
    ("toggleSidebar", "Toggle Sidebar", Some("CmdOrCtrl+Backslash")),
    ("showOutline", "Outline", Some("CmdOrCtrl+Shift+1")),
    ("showArticles", "Articles", Some("CmdOrCtrl+Shift+2")),
    ("showFiles", "Files", Some("CmdOrCtrl+Shift+3")),
    ("sidebarSearch", "Search", Some("CmdOrCtrl+Shift+F")),
    ("revealActiveFile", "Reveal Active File in Sidebar", None),
    ("toggleSource", "Source Code Mode", Some("CmdOrCtrl+Slash")),
    ("-", "", None),
    ("toggleFocus", "Focus Mode", Some("F8")),
    ("toggleTypewriter", "Typewriter Mode", Some("F9")),
    ("-", "", None),
    // #103 window chrome (Typora order: Allow Magnification, zoom, Always on Top)
    ("toggleMagnification", "Allow Magnification", None),
    ("toggleStatusBar", "Show Status Bar", None),
    ("-", "", None),
    ("zoomReset", "Actual Size", Some("CmdOrCtrl+Shift+0")),
    ("zoomIn", "Zoom In", Some("CmdOrCtrl+Equal")),
    ("zoomOut", "Zoom Out", Some("CmdOrCtrl+Minus")),
    ("-", "", None),
    ("alwaysOnTop", "Always on Top", None),
    ("toggleDevtools", "Toggle DevTools", None),
    ("-", "", None),
    ("toggleLineEnding", "Toggle Line Endings (LF / CRLF)", None),
];

/// Every action the menu can emit (used by tests to keep Rust and TS in sync).
#[cfg(test)]
pub fn all_actions() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = [FILE_OPEN, FILE, EXPORT, EXPORT_MORE, EDIT_TOP, EDIT_FIND, PARAGRAPH, FORMAT, VIEW, WINDOW_TABS]
        .iter()
        .chain(SUBMENUS.iter().map(|(_, items)| items))
        .chain(IMAGE_ALL.iter())
        .chain(EDIT_AIDS.iter())
        .flat_map(|g| g.iter().map(|i| i.0))
        .filter(|id| *id != "-" && !id.starts_with('@'))
        .collect();
    v.extend(["pageSetup", "print", "close", "preferences", "emojiPicker", crate::recent::ID_CLEAR]);
    v
}

fn add_items<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    mut b: SubmenuBuilder<'a, R, AppHandle<R>>,
    items: &[Item],
) -> tauri::Result<SubmenuBuilder<'a, R, AppHandle<R>>> {
    for (id, label, accel) in items {
        b = if *id == "-" {
            b.separator()
        } else if let Some((_, sub)) = SUBMENUS.iter().find(|(m, _)| m == id) {
            b.item(&add_items(app, SubmenuBuilder::new(app, *label), sub)?.build()?)
        } else if CHECK_IDS.contains(id) {
            b.item(&CheckMenuItem::with_id(app, *id, *label, true, false, *accel)?)
        } else {
            b.item(&MenuItem::with_id(app, *id, *label, true, *accel)?)
        };
    }
    Ok(b)
}

pub fn theme_items<R: Runtime>(
    app: &AppHandle<R>,
    names: &[String],
    current: &str,
) -> tauri::Result<Vec<CheckMenuItem<R>>> {
    names
        .iter()
        .map(|n| {
            let label = title_case(n);
            CheckMenuItem::with_id(app, format!("theme:{n}"), label, true, n == current, None::<&str>)
        })
        .collect()
}

fn title_case(s: &str) -> String {
    s.split(['-', '_', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    themes: &[String],
    current_theme: &str,
    recent: &[(String, String)],
) -> tauri::Result<Menu<R>> {
    let mac = cfg!(target_os = "macos");
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some("Margin".into()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };
    let prefs = MenuItem::with_id(app, "preferences", if mac { "Settings…" } else { "Preferences…" }, true, Some("CmdOrCtrl+Comma"))?;
    let quit = MenuItem::with_id(app, ID_QUIT, if mac { "Quit Margin" } else { "Quit" }, true, Some("CmdOrCtrl+Q"))?;

    let mut menu = MenuBuilder::new(app);

    if mac {
        let app_menu = SubmenuBuilder::new(app, "Margin")
            .item(&PredefinedMenuItem::about(app, Some("About Margin"), Some(about.clone()))?)
            .separator()
            .item(&prefs)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&quit)
            .build()?;
        menu = menu.item(&app_menu);
    }

    let export = add_items(app, SubmenuBuilder::new(app, "Export"), EXPORT)?;
    let export = add_items(app, export.separator(), EXPORT_MORE)?.build()?;
    let recent_menu = SubmenuBuilder::with_id(app, crate::recent::SUBMENU_ID, "Open Recent").build()?;
    crate::recent::fill(app, &recent_menu, recent)?;
    let file = add_items(app, SubmenuBuilder::new(app, "File"), FILE_OPEN)?.item(&recent_menu);
    let mut file = add_items(app, file, FILE)?
        .separator()
        .item(&export)
        .item(&MenuItem::with_id(app, "pageSetup", "Page Setup…", true, Some("CmdOrCtrl+Shift+P"))?)
        .item(&MenuItem::with_id(app, "print", "Print…", true, Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&MenuItem::with_id(app, "close", "Close", true, Some("CmdOrCtrl+W"))?);
    if !mac {
        file = file.separator().item(&prefs).separator().item(&quit);
    }
    menu = menu.item(&file.build()?);

    let edit = add_items(app, SubmenuBuilder::new(app, "Edit"), EDIT_TOP)?
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?);
    let edit = add_items(app, edit, EDIT_PASTE_AS)?
        .item(&add_items(app, SubmenuBuilder::new(app, "Copy As"), EDIT_COPY_AS)?.build()?)
        .separator()
        .item(&add_items(app, SubmenuBuilder::new(app, "Selection"), EDIT_SELECTION)?.build()?)
        .item(&add_items(app, SubmenuBuilder::new(app, "Delete"), EDIT_DELETE)?.build()?)
        .item(&add_items(app, SubmenuBuilder::new(app, "Jump To"), EDIT_JUMP)?.build()?)
        .separator()
        .item(&add_items(app, SubmenuBuilder::new(app, "Substitutions"), EDIT_SUBST)?.build()?)
        .item(&add_items(app, SubmenuBuilder::new(app, "Spelling and Grammar"), EDIT_SPELL)?.build()?);
    let edit = add_items(app, edit, EDIT_FIND)?
        .separator()
        .item(&add_items(app, SubmenuBuilder::new(app, "Speech"), EDIT_SPEECH)?.build()?)
        .item(&MenuItem::with_id(app, "emojiPicker", "Emoji and Symbols", true, Some("CmdOrCtrl+Alt+Space"))?)
        .build()?;
    menu = menu.item(&edit);

    menu = menu.item(&add_items(app, SubmenuBuilder::new(app, "Paragraph"), PARAGRAPH)?.build()?);
    let image = add_items(app, SubmenuBuilder::new(app, "Image"), IMAGE_TOP)?
        .item(&add_items(app, SubmenuBuilder::new(app, "Zoom Image"), IMAGE_ZOOM)?.build()?)
        .item(&add_items(app, SubmenuBuilder::new(app, "Switch Image Syntax"), IMAGE_SYNTAX)?.build()?);
    let image = add_items(app, image.separator(), IMAGE_FILE)?
        .item(&add_items(app, SubmenuBuilder::new(app, "When Insert Local Image"), IMAGE_WHEN_INSERT)?.build()?);
    let image = add_items(app, image, IMAGE_BOTTOM)?.build()?;
    let format = add_items(app, add_items(app, SubmenuBuilder::new(app, "Format"), FORMAT)?.separator().item(&image), FORMAT_TAIL)?;
    menu = menu.item(&format.build()?);
    let view = add_items(app, SubmenuBuilder::new(app, "View"), VIEW)?
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    menu = menu.item(&view);

    let mut themes_menu = SubmenuBuilder::with_id(app, THEMES_SUBMENU_ID, "Themes");
    for it in theme_items(app, themes, current_theme)? {
        themes_menu = themes_menu.item(&it);
    }
    menu = menu.item(&themes_menu.build()?);

    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, if mac { Some("Zoom") } else { None })?);
    // macOS Window › Bring All to Front (native-commands §menus Window).
    let window = if mac { window.item(&PredefinedMenuItem::bring_all_to_front(app, None)?) } else { window }.separator();
    let window = add_items(app, window, WINDOW_TABS)?.build()?;
    menu = menu.item(&window);

    let mut help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItem::with_id(app, ID_HELP_MARKDOWN, "Markdown Reference", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, ID_HELP_THEMES_FOLDER, "Open Themes Folder", true, None::<&str>)?);
    if !mac {
        help = help.separator().item(&PredefinedMenuItem::about(app, Some("About Margin"), Some(about))?);
    }
    menu = menu.item(&help.build()?);

    menu.build()
}

/// Labels of a built menu as `Top › Item` paths (predefined items included), for the
/// structure self-test (`tests/menu_main.rs`, parity verifiers for the native menus).
pub fn labels<R: Runtime>(menu: &Menu<R>) -> tauri::Result<Vec<String>> {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, prefix: &str, out: &mut Vec<String>) -> tauri::Result<()> {
        for it in items {
            let (text, sub) = match &it {
                MenuItemKind::MenuItem(m) => (m.text()?, None),
                MenuItemKind::Predefined(m) => (m.text()?, None),
                MenuItemKind::Check(m) => (m.text()?, None),
                MenuItemKind::Icon(m) => (m.text()?, None),
                MenuItemKind::Submenu(m) => (m.text()?, Some(m.items()?)),
            };
            if text.is_empty() {
                continue; // separators
            }
            let path = if prefix.is_empty() { text } else { format!("{prefix} › {text}") };
            out.push(path.clone());
            if let Some(items) = sub {
                walk(items, &path, out)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(menu.items()?, "", &mut out)?;
    Ok(out)
}

/// Native menu structure self-test (run on the main thread by `tests/menu_main.rs`):
/// the application, View, Window and Help surfaces Typora has on macOS.
pub fn structure_selftest<R: Runtime>(h: &AppHandle<R>) -> Result<Vec<String>, String> {
    let e = |x: tauri::Error| x.to_string();
    let m = build(h, &["paper".into()], "paper", &[]).map_err(e)?;
    let got = labels(&m).map_err(e)?;
    let need: &[&str] = &[
        // menu.app.about / menu.app.system
        "Margin › About Margin",
        "Margin › Services",
        "Margin › Hide Others",
        "Margin › Show All",
        "Margin › Quit Margin",
        // menu.view.zoom (custom items) / menu.view.fullscreen (predefined)
        "View › Actual Size",
        "View › Zoom In",
        "View › Zoom Out",
        // menu.window
        "Window › Minimize",
        "Window › Zoom",
        "Window › Bring All to Front",
        // menu.help.reference
        "Help › Markdown Reference",
    ];
    let missing: Vec<&str> = need.iter().copied().filter(|n| !got.iter().any(|g| g == n)).collect();
    if !missing.is_empty() {
        return Err(format!("missing {missing:?} in {got:?}"));
    }
    if !got.iter().any(|g| g.starts_with("Margin › Hide") && g != "Margin › Hide Others") {
        return Err("no Hide <app> item".into());
    }
    if !got.iter().any(|g| g.starts_with("View › ") && g.contains("Full Screen")) {
        return Err(format!("no View › Full Screen item in {got:?}"));
    }
    let order = |a: &str, b: &str| got.iter().position(|g| g == a) < got.iter().position(|g| g == b);
    if !(order("Margin › About Margin", "Margin › Services") && order("Margin › Show All", "Margin › Quit Margin") && order("Window › Minimize", "Window › Zoom") && order("Window › Zoom", "Window › Bring All to Front")) {
        return Err(format!("unexpected order {got:?}"));
    }
    Ok(got)
}

/// Replace the Themes submenu's items (called when the frontend knows the full list).
pub fn set_themes<R: Runtime>(app: &AppHandle<R>, names: &[String], current: &str) -> tauri::Result<()> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let Some(MenuItemKind::Submenu(sub)) = menu.get(THEMES_SUBMENU_ID) else { return Ok(()) };
    let sub: Submenu<R> = sub;
    for item in sub.items()? {
        sub.remove(&item)?;
    }
    for it in theme_items(app, names, current)? {
        sub.append(&it)?;
    }
    Ok(())
}

/// Tick exactly one theme item.
pub fn check_theme<R: Runtime>(app: &AppHandle<R>, current: &str) {
    let Some(menu) = app.menu() else { return };
    let Some(MenuItemKind::Submenu(sub)) = menu.get(THEMES_SUBMENU_ID) else { return };
    if let Ok(items) = sub.items() {
        for item in items {
            if let MenuItemKind::Check(c) = item {
                let _ = c.set_checked(c.id().as_ref() == format!("theme:{current}"));
            }
        }
    }
}

/// Tick / untick a check item anywhere in the menu tree (#103 menu state sync).
/// Unknown ids (e.g. custom menus) are ignored.
pub fn set_checked<R: Runtime>(app: &AppHandle<R>, id: &str, checked: bool) {
    let Some(menu) = app.menu() else { return };
    for item in menu.items().unwrap_or_default() {
        if set_checked_item(&item, id, checked) {
            return;
        }
    }
}

fn set_checked_item<R: Runtime>(item: &MenuItemKind<R>, id: &str, checked: bool) -> bool {
    match item {
        MenuItemKind::Check(c) => {
            if c.id().as_ref() == id {
                let _ = c.set_checked(checked);
                true
            } else {
                false
            }
        }
        MenuItemKind::Submenu(sub) => sub
            .items()
            .unwrap_or_default()
            .iter()
            .any(|it| set_checked_item(it, id, checked)),
        _ => false,
    }
}
/// Enable / disable a menu item anywhere in the tree (e.g. the forced-on
/// Remap Unicode Punctuation item while smart input conversion is active).
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, id: &str, enabled: bool) {
    let Some(menu) = app.menu() else { return };
    for item in menu.items().unwrap_or_default() {
        if set_enabled_item(&item, id, enabled) {
            return;
        }
    }
}


fn set_enabled_item<R: Runtime>(item: &MenuItemKind<R>, id: &str, enabled: bool) -> bool {
    match item {
        MenuItemKind::Check(c) => {
            if c.id().as_ref() == id {
                let _ = c.set_enabled(enabled);
                return true;
            }
            false
        }
        MenuItemKind::MenuItem(m) => {
            if m.id().as_ref() == id {
                let _ = m.set_enabled(enabled);
                return true;
            }
            false
        }
        MenuItemKind::Submenu(sub) => sub.items().unwrap_or_default().iter().any(|it| set_enabled_item(it, id, enabled)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for g in [FILE_OPEN, FILE, EXPORT, EXPORT_MORE, EDIT_TOP, EDIT_FIND, PARAGRAPH, FORMAT, FORMAT_TAIL, VIEW, WINDOW_TABS]
            .iter()
            .chain(EDIT_EXTRA.iter())
        .chain(EDIT_AIDS.iter())
            .chain(SUBMENUS.iter().map(|(_, items)| items))
        {
            for (_, _, a) in g.iter() {
                if let Some(a) = a {
                    assert!(seen.insert(*a), "duplicate accelerator {a}");
                }
            }
        }
        assert!(!seen.contains("CmdOrCtrl+Comma") && !seen.contains("CmdOrCtrl+W"));
    }

    #[test]
    fn actions_match_contract_shapes() {
        for a in all_actions() {
            let ok = [
                "new", "open", "openFolder", "save", "saveAs", "close", "exportHtml", "exportPdf", "print", "undo",
                "redo", "find", "replace", "toggleSidebar", "toggleSource", "toggleFocus", "toggleTypewriter",
                "quickOpen", "zoomIn", "zoomOut", "zoomReset", "preferences", "clearRecent", "commandPalette", "showOutline",
                "showFiles", "showArticles", "sidebarSearch", "revealActiveFile", "reloadFromDisk", "toggleLineEnding", "exportHtmlPlain", "exportImage",
                "exportPrevious", "exportOverwrite", "exportSettings", "pageSetup",
                "exportDocx", "exportLatex",
                "exportEpub", "clearFormat", "exportOdt", "exportRtf", "exportMediawiki", "exportRst", "exportTextile", "exportOpml",
                "exportCustom", "import", "takePicture",
                // #94 file lifecycle
                "newTab", "newWindow", "nextTab", "prevTab", "reopenClosed", "saveAll", "duplicate", "renameFile",
                "moveTo", "revealInFinder", "copyFilePath", "browseVersions", "reopenWithEncoding", "properties",
                "recoverDrafts",
            ]
            .contains(&a)
                || a.starts_with("spell:")
                || a.starts_with("subst:")
                || a.starts_with("speech:")
                || ["emojiPicker", "toggleStatusBar", "alwaysOnTop", "toggleDevtools", "toggleMagnification"].contains(&a)
                || a.starts_with("heading:")
                || a.starts_with("mark:")
                || a.starts_with("block:")
                || a.starts_with("para:")
                || a.starts_with("task:")
                || ["pastePlain", "jump:top", "jump:bottom", "jump:selection"].contains(&a)
                || a.starts_with("copyAs:")
                || a.starts_with("select:")
                || a.starts_with("delete:")
                || a.starts_with("table:")
                || a.starts_with("code:")
                || a.starts_with("math:")
                || a.starts_with("image:");
            assert!(ok, "{a} is not a MenuAction");
        }
    }

    #[test]
    fn paragraph_and_format_menus_cover_parity_commands() {
        let ids: Vec<&str> = PARAGRAPH.iter().chain(FORMAT.iter()).chain(FORMAT_TAIL.iter()).map(|i| i.0).collect();
        for want in [
            "para:headingUp", "para:headingDown", "para:insertBefore", "para:insertAfter", "block:html", "block:linkRef",
            "block:footnote", "block:front_matter", "task:toggle", "task:complete", "task:incomplete", "mark:underline",
            "mark:math", "mark:sup", "mark:sub", "mark:comment", "clearFormat",
        ] {
            assert!(ids.contains(&want), "missing menu item {want}");
        }
    }

    #[test]
    fn paragraph_tool_submenus_are_wired() {
        let markers: Vec<&str> = PARAGRAPH.iter().map(|i| i.0).filter(|id| id.starts_with('@')).collect();
        assert_eq!(markers, ["@table", "@codeTools", "@mathTools"]);
        for want in ["block:table", "table:moveRowUp", "table:resize", "table:copy", "code:indentAll", "math:copyMathML", "math:refresh"] {
            assert!(all_actions().contains(&want), "missing menu item {want}");
        }
    }

    #[test]
    fn chrome_check_items_are_check_menu_items() {
        // The aids surfaces (#103) must be tickable so state sync can mark them.
        for want in CHECK_IDS {
            assert!(all_actions().contains(want), "{want} missing from the menu");
        }
        for aid in ["spell:panel", "spell:now", "subst:more", "speech:start", "speech:stop", "emojiPicker"] {
            assert!(all_actions().contains(&aid), "{aid} missing from the menu");
        }
    }
}

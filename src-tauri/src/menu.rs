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
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("openFolder", "Open Folder…", Some("CmdOrCtrl+Shift+O")),
];
const FILE: &[Item] = &[
    ("quickOpen", "Quick Open…", Some("CmdOrCtrl+P")),
    ("-", "", None),
    ("save", "Save", Some("CmdOrCtrl+S")),
    ("saveAs", "Save As…", Some("CmdOrCtrl+Shift+S")),
    ("reloadFromDisk", "Revert to Saved", None),
    ("-", "", None),
    ("import", "Import…", None),
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
    ("clearFormat", "Clear Format", None),
];
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
    ("showFiles", "Files", Some("CmdOrCtrl+Shift+3")),
    ("revealActiveFile", "Reveal Active File in Sidebar", None),
    ("toggleSource", "Source Code Mode", Some("CmdOrCtrl+Slash")),
    ("-", "", None),
    ("toggleFocus", "Focus Mode", Some("F8")),
    ("toggleTypewriter", "Typewriter Mode", Some("F9")),
    ("-", "", None),
    ("zoomReset", "Actual Size", Some("CmdOrCtrl+Shift+0")),
    ("zoomIn", "Zoom In", Some("CmdOrCtrl+Equal")),
    ("zoomOut", "Zoom Out", Some("CmdOrCtrl+Minus")),
    ("-", "", None),
    ("toggleLineEnding", "Toggle Line Endings (LF / CRLF)", None),
];

/// Every action the menu can emit (used by tests to keep Rust and TS in sync).
#[cfg(test)]
pub fn all_actions() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = [FILE_OPEN, FILE, EXPORT, EXPORT_MORE, EDIT_TOP, EDIT_FIND, PARAGRAPH, FORMAT, VIEW]
        .iter()
        .chain(EDIT_EXTRA.iter())
        .chain(IMAGE_ALL.iter())
        .chain(SUBMENUS.iter().map(|(_, items)| items))
        .flat_map(|g| g.iter().map(|i| i.0))
        .filter(|id| *id != "-" && !id.starts_with('@'))
        .collect();
    v.extend(["pageSetup", "print", "close", "preferences", crate::recent::ID_CLEAR]);
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
        .item(&MenuItem::with_id(app, "pageSetup", "Page Setup…", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "print", "Print…", true, Some("CmdOrCtrl+Shift+P"))?)
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
        .separator();
    let edit = add_items(app, edit, EDIT_FIND)?.build()?;
    menu = menu.item(&edit);

    menu = menu.item(&add_items(app, SubmenuBuilder::new(app, "Paragraph"), PARAGRAPH)?.build()?);
    let image = add_items(app, SubmenuBuilder::new(app, "Image"), IMAGE_TOP)?
        .item(&add_items(app, SubmenuBuilder::new(app, "Zoom Image"), IMAGE_ZOOM)?.build()?)
        .item(&add_items(app, SubmenuBuilder::new(app, "Switch Image Syntax"), IMAGE_SYNTAX)?.build()?);
    let image = add_items(app, image.separator(), IMAGE_FILE)?
        .item(&add_items(app, SubmenuBuilder::new(app, "When Insert Local Image"), IMAGE_WHEN_INSERT)?.build()?);
    let image = add_items(app, image, IMAGE_BOTTOM)?.build()?;
    let format = add_items(app, SubmenuBuilder::new(app, "Format"), FORMAT)?.separator().item(&image);
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
        .item(&PredefinedMenuItem::maximize(app, if mac { Some("Zoom") } else { None })?)
        .build()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for g in [FILE_OPEN, FILE, EXPORT, EXPORT_MORE, EDIT_TOP, EDIT_FIND, PARAGRAPH, FORMAT, VIEW]
            .iter()
            .chain(EDIT_EXTRA.iter())
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
                "showFiles", "revealActiveFile", "reloadFromDisk", "toggleLineEnding", "exportHtmlPlain", "exportImage",
                "exportPrevious", "exportOverwrite", "exportSettings", "pageSetup",
                "exportDocx", "exportLatex",
                "exportEpub", "clearFormat", "exportOdt", "exportRtf", "exportMediawiki", "exportRst", "exportTextile", "exportOpml",
                "exportCustom", "import",
            ]
            .contains(&a)
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
        let ids: Vec<&str> = PARAGRAPH.iter().chain(FORMAT.iter()).map(|i| i.0).collect();
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
}

/// Every app command is declared here so Tauri generates an `allow-<command>`
/// permission for it. Commands are then *only* callable from windows whose
/// capability lists them (see `capabilities/default.json`: the `main` window).
/// Hidden helper webviews (PDF export) get no IPC access at all.
const COMMANDS: &[&str] = &[
    "read_text_file",
    "write_text_file",
    "stat",
    "list_dir",
    "watch",
    "unwatch",
    "quick_open",
    "store_image",
    "store_image_bytes",
    "open_dialog",
    "save_dialog",
    "export_html",
    "export_pdf",
    "print_window",
    "load_settings",
    "save_settings",
    "list_themes",
    "themes_dir",
    "open_external",
    "set_title",
    "set_document_edited",
    "set_close_guard",
    "confirm_close",
    "take_pending_open_files",
    "allow_asset_dir",
    "set_theme_menu",
    "rename_path",
    "trash_path",
    "create_dir",
    "reveal_path",
    "clipboard_write_rich",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

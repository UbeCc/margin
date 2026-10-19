//! Runs on the process main thread (`harness = false`): native menus can't be built
//! from libtest's worker threads on macOS.
fn main() {
    if !cfg!(target_os = "macos") {
        println!("menu_main: skipped (needs a native menu backend on the main thread)");
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("doc.md");
    std::fs::write(&f, "").unwrap();
    let app = tauri::test::mock_builder()
        .manage(margin_lib::recent::RecentState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    match margin_lib::recent::menu_selftest(app.handle(), &f.to_string_lossy()) {
        Ok(()) => println!("menu_main: Open Recent submenu ok"),
        Err(e) => {
            eprintln!("menu_main FAILED: {e}");
            std::process::exit(1);
        }
    }
    // Parity verifiers menu.app.about, menu.app.system, menu.view.fullscreen, menu.window,
    // menu.help.reference: the native menu carries Typora's macOS items in Typora's order.
    match margin_lib::menu_structure_selftest(app.handle()) {
        Ok(labels) => println!("menu_main: native menu structure ok ({} items)", labels.len()),
        Err(e) => {
            eprintln!("menu_main FAILED: {e}");
            std::process::exit(1);
        }
    }
}

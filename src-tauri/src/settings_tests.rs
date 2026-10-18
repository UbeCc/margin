//! Settings persistence edge cases.

use crate::settings::*;
use serde_json::{Value, json};
use std::fs;

#[test]
fn corrupt_file_is_backed_up_before_defaults_overwrite_it() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("settings.json");
    let broken = r#"{"theme":"night","pluginX":{"keep":true},"recentFiles":["/a.md"]"#; // truncated
    fs::write(&p, broken).unwrap();
    let loaded = load(&p);
    assert_eq!(typed(&loaded), AppSettings::default());
    // the next save (with defaults) must not destroy the only copy of the user's data
    save(&p, Value::Object(loaded)).unwrap();
    let backups: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("settings.json.corrupt"))
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(fs::read_to_string(dir.path().join(&backups[0])).unwrap(), broken);
    // loading again (now valid) doesn't create more backups
    let _ = load(&p);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn non_object_json_and_empty_file() {
    for text in ["[]", "null", "42", "\"s\"", "", "   "] {
        assert_eq!(typed(&parse(text)), AppSettings::default(), "{text:?}");
    }
}

#[test]
fn unknown_keys_and_nested_values_survive_save_and_load() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("cfg/settings.json");
    let v = json!({
        "theme": "github", "darkTheme": "night", "customCss": "body{}\n", "zoom": 1.25,
        "sidebarWidth": 280, "unicode": "日本語 ✓", "nested": {"a": [1, {"b": null}]},
        "settingsVersion": 2
    });
    save(&p, v.clone()).unwrap();
    let back = load(&p);
    for k in ["darkTheme", "customCss", "zoom", "sidebarWidth", "unicode", "nested"] {
        assert_eq!(back[k], v[k], "{k}");
    }
    assert_eq!(back["theme"], json!("github"));
}

#[test]
fn newer_version_file_keeps_its_keys() {
    // a file written by a newer Margin (version 9) is loaded without dropping keys
    let s = parse(r#"{"settingsVersion":9,"theme":"night","futureThing":{"x":1},"colorScheme":"dark"}"#);
    assert_eq!(s["futureThing"], json!({"x": 1}));
    assert_eq!(typed(&s).color_scheme, "dark");
}

#[test]
fn numbers_and_types_at_the_edges() {
    let t = typed(&parse(r#"{"fontSize":-5}"#));
    assert_eq!(t.font_size, 8.0);
    let t = typed(&parse(r#"{"fontSize":"16"}"#));
    assert_eq!(t.font_size, 16.0, "string falls back to default");
    // serde_json rejects out-of-range numbers: the whole file is unreadable (and is
    // backed up by `load`, see above), never a panic
    assert_eq!(typed(&parse(r#"{"fontSize":1e400,"theme":"night"}"#)), AppSettings::default());
    let s = parse(r#"{"recentFiles":["/a.md",1,"/b.md"]}"#);
    assert_eq!(typed(&s).recent_files, Vec::<String>::new(), "mixed array is invalid as a whole");
    let many: Vec<String> = (0..50).map(|i| format!("/f{i}.md")).collect();
    let s = parse(&json!({ "recentFiles": many }).to_string());
    assert_eq!(typed(&s).recent_files.len(), MAX_RECENT);
}

#[test]
fn image_rule_variants_validate() {
    let t = typed(&parse(r#"{"imageRule":{"kind":"absolute","dir":"~/img"}}"#));
    assert_eq!(t.image_rule, crate::images::ImageRule::Absolute { dir: "~/img".into() });
    let t = typed(&parse(r#"{"imageRule":{"kind":"bogus"}}"#));
    assert_eq!(t.image_rule, crate::images::ImageRule::default());
    let t = typed(&parse(r#"{"imageRule":{"kind":"relative"}}"#));
    assert_eq!(t.image_rule, crate::images::ImageRule::default(), "missing dir");
}

#[cfg(unix)]
#[test]
fn symlinked_settings_file_stays_a_symlink() {
    // dotfile managers symlink config files into a repo
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("dotfiles-settings.json");
    fs::write(&real, "{}").unwrap();
    let p = dir.path().join("settings.json");
    std::os::unix::fs::symlink(&real, &p).unwrap();
    save(&p, json!({"theme": "night"})).unwrap();
    assert!(fs::symlink_metadata(&p).unwrap().file_type().is_symlink());
    assert_eq!(typed(&load(&real)).theme, "night");
}

//! App settings persisted as JSON in the app config dir.
//!
//! Loading never fails: a missing/corrupt file yields defaults, unknown keys are
//! preserved (other modules may add settings), and each known key whose value has
//! the wrong type falls back to its default individually.

use crate::images::ImageRule;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::path::Path;

pub const SETTINGS_VERSION: u64 = 2;
pub const VERSION_KEY: &str = "settingsVersion";

/// Mirrors `AppSettings` in `src/contracts.ts` (used for defaults + validation).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub color_scheme: String,
    pub font_size: f64,
    pub auto_save: bool,
    pub image_rule: ImageRule,
    pub spellcheck: bool,
    pub recent_files: Vec<String>,
    pub recent_folders: Vec<String>,
    /// View › Allow Magnification, global (#103; Typora stores the inverse `noMagnification`).
    #[serde(default = "default_true")]
    pub allow_magnification: bool,
    /// Appearance › Window Style, applied after restart (#134).
    #[serde(default = "default_style")]
    pub window_style: String,
    /// General › Quit Margin when last window is closed (#134; macOS stays alive by default).
    #[serde(default)]
    pub quit_on_last_window_close: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: "paper".into(),
            color_scheme: "system".into(),
            font_size: 16.0,
            auto_save: false,
            image_rule: ImageRule::Relative { dir: "./assets".into() },
            spellcheck: false,
            recent_files: vec![],
            recent_folders: vec![],
            allow_magnification: default_true(),
            window_style: default_style(),
            quit_on_last_window_close: false,
        }
    }
}
fn default_true() -> bool {
    true
}

fn default_style() -> String {
    "seamless".into()
}

pub const MAX_RECENT: usize = 20;

pub fn defaults_value() -> Map<String, Value> {
    let mut m = match serde_json::to_value(AppSettings::default()).unwrap() {
        Value::Object(m) => m,
        _ => unreachable!(),
    };
    m.insert(VERSION_KEY.into(), json!(SETTINGS_VERSION));
    m
}

/// Upgrade older on-disk layouts in place.
///
/// * v0 (no version key, pre-release): `imageFolder: string | null` and
///   `copyImages: bool`, `darkMode: bool`, `recent: string[]`.
/// * v1: `colorScheme` could be `"auto"`; `imageRule.kind` could be `"copy"`.
pub fn migrate(mut m: Map<String, Value>) -> Map<String, Value> {
    let version = m.get(VERSION_KEY).and_then(Value::as_u64).unwrap_or(0);
    if version < 1 {
        if !m.contains_key("imageRule") {
            let copy = m.get("copyImages").and_then(Value::as_bool).unwrap_or(true);
            let rule = match m.get("imageFolder").and_then(Value::as_str) {
                Some(dir) if copy && !dir.is_empty() => {
                    if Path::new(dir).is_absolute() || dir.starts_with('~') {
                        json!({"kind": "absolute", "dir": dir})
                    } else {
                        json!({"kind": "relative", "dir": dir})
                    }
                }
                _ if !copy => json!({"kind": "none"}),
                _ => json!({"kind": "relative", "dir": "./assets"}),
            };
            m.insert("imageRule".into(), rule);
        }
        m.remove("imageFolder");
        m.remove("copyImages");
        if let Some(dark) = m.remove("darkMode").and_then(|v| v.as_bool()) {
            m.entry("colorScheme").or_insert(json!(if dark { "dark" } else { "light" }));
        }
        if let Some(recent) = m.remove("recent") {
            m.entry("recentFiles").or_insert(recent);
        }
    }
    if version < 2 {
        if m.get("colorScheme").and_then(Value::as_str) == Some("auto") {
            m.insert("colorScheme".into(), json!("system"));
        }
        if let Some(rule) = m.get_mut("imageRule").and_then(Value::as_object_mut)
            && rule.get("kind").and_then(Value::as_str) == Some("copy") {
                rule.insert("kind".into(), json!("relative"));
            }
    }
    m.insert(VERSION_KEY.into(), json!(SETTINGS_VERSION));
    m
}

/// Merge `input` over defaults; keep unknown keys; drop invalid known values.
pub fn normalize(input: Map<String, Value>) -> Map<String, Value> {
    let mut out = defaults_value();
    for (k, v) in input {
        if out.contains_key(&k) && k != VERSION_KEY {
            let mut trial = out.clone();
            trial.insert(k.clone(), v.clone());
            if serde_json::from_value::<AppSettings>(Value::Object(trial)).is_ok() && valid_enum(&k, &v) {
                out.insert(k, v);
            }
        } else if k != VERSION_KEY {
            out.insert(k, v);
        }
    }
    // clamp / trim
    if let Some(fs) = out.get("fontSize").and_then(Value::as_f64) {
        out.insert("fontSize".into(), json!(fs.clamp(8.0, 72.0)));
    }
    for key in ["recentFiles", "recentFolders"] {
        if let Some(Value::Array(a)) = out.get_mut(key) {
            a.truncate(MAX_RECENT);
        }
    }
    out
}

fn valid_enum(k: &str, v: &Value) -> bool {
    match k {
        "colorScheme" => matches!(v.as_str(), Some("light" | "dark" | "system")),
        _ => true,
    }
}

pub fn parse(text: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => normalize(migrate(m)),
        _ => defaults_value(),
    }
}

pub fn load(path: &Path) -> Map<String, Value> {
    let Ok(bytes) = std::fs::read(path) else { return defaults_value() };
    let text = String::from_utf8_lossy(&bytes);
    let readable = matches!(serde_json::from_str::<Value>(&text), Ok(Value::Object(_)));
    if !readable && !text.trim().is_empty() {
        backup_corrupt(path, &bytes);
    }
    parse(&text)
}

/// Keep a copy of an unreadable settings file before defaults replace it on the next
/// save: `settings.json.corrupt-YYYYMMDD-HHMMSS` (one per distinct content).
fn backup_corrupt(path: &Path, bytes: &[u8]) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { return };
    let prefix = format!("{}.corrupt-", name.to_string_lossy());
    let already = std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
        e.file_name().to_string_lossy().starts_with(&prefix) && std::fs::read(e.path()).ok().as_deref() == Some(bytes)
    });
    if already {
        return;
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = dir.join(format!("{prefix}{stamp}"));
    if let Err(e) = std::fs::write(&target, bytes) {
        log::warn!("could not back up corrupt settings to {}: {e}", target.display());
    } else {
        log::warn!("settings file was unreadable; kept a copy at {}", target.display());
    }
}

pub fn save(path: &Path, settings: Value) -> Result<Map<String, Value>, String> {
    let Value::Object(m) = settings else {
        return Err("settings must be a JSON object".into());
    };
    let m = normalize(m);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(m.clone())).unwrap();
    crate::fsops::atomic_write(path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(m)
}

/// Typed view (used by Rust code, e.g. to pre-check the theme menu).
pub fn typed(m: &Map<String, Value>) -> AppSettings {
    serde_json::from_value(Value::Object(m.clone())).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_corrupt_gives_defaults() {
        assert_eq!(typed(&parse("not json")), AppSettings::default());
        assert_eq!(typed(&parse("{}")), AppSettings::default());
        assert_eq!(parse("{}")[VERSION_KEY], json!(SETTINGS_VERSION));
    }

    #[test]
    fn migrates_v0() {
        let s = parse(r#"{"imageFolder":"./${filename}.assets","darkMode":true,"recent":["/a.md"],"fontSize":18}"#);
        let t = typed(&s);
        assert_eq!(t.image_rule, ImageRule::Relative { dir: "./${filename}.assets".into() });
        assert_eq!(t.color_scheme, "dark");
        assert_eq!(t.recent_files, vec!["/a.md".to_string()]);
        assert_eq!(t.font_size, 18.0);
        assert!(!s.contains_key("imageFolder") && !s.contains_key("darkMode"));

        let s = typed(&parse(r#"{"imageFolder":"/abs/img"}"#));
        assert_eq!(s.image_rule, ImageRule::Absolute { dir: "/abs/img".into() });
        let s = typed(&parse(r#"{"copyImages":false}"#));
        assert_eq!(s.image_rule, ImageRule::None);
    }

    #[test]
    fn migrates_v1() {
        let s = typed(&parse(r#"{"settingsVersion":1,"colorScheme":"auto","imageRule":{"kind":"copy","dir":"img"}}"#));
        assert_eq!(s.color_scheme, "system");
        assert_eq!(s.image_rule, ImageRule::Relative { dir: "img".into() });
    }

    #[test]
    fn bad_values_fall_back_individually_and_unknown_keys_survive() {
        let s = parse(r#"{"settingsVersion":2,"theme":42,"fontSize":200,"colorScheme":"purple","autoSave":true,"pluginX":{"a":1}}"#);
        let t = typed(&s);
        assert_eq!(t.theme, "paper");
        assert_eq!(t.font_size, 72.0);
        assert_eq!(t.color_scheme, "system");
        assert!(t.auto_save);
        assert_eq!(s["pluginX"], json!({"a": 1}));
    }

    #[test]
    fn save_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cfg/settings.json");
        let mut v = defaults_value();
        v.insert("theme".into(), json!("night"));
        save(&p, Value::Object(v)).unwrap();
        assert_eq!(typed(&load(&p)).theme, "night");
    }
}

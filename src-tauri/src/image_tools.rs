//! Image Tools primitives (#99): copy / move one image into a folder (Typora's
//! duplicate-name rule), the pixel-to-point scale used by "Zoom Image to N%", and a
//! multi-select image picker for Format › Image › Insert Local Images….
//! All decisions (which folder, how the src is written) stay in the frontend.

use crate::images::{copy_unique, normalize};
use std::fs;
use std::path::{Path, PathBuf};

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "avif", "ico", "heic"];

/// Copy (or move) `src` into `dir` (created when missing). With `name`, the file is
/// written exactly there and an existing different file is refused (never clobbered);
/// without it Typora's duplicate rule applies (`stem-<7 digits>.ext`). Moving the file
/// onto itself is a no-op. Returns the absolute destination.
pub fn copy_image_to(src: &Path, dir: &Path, name: Option<&str>, mv: bool) -> Result<PathBuf, String> {
    let src = normalize(src);
    let dir = normalize(dir);
    if !src.is_file() {
        return Err(format!("image not found: {}", src.display()));
    }
    if dir.exists() && !dir.is_dir() {
        return Err(format!("{} is a file, not a directory", dir.display()));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let dest = match name {
        Some(n) => {
            if n.is_empty() || n.contains('/') || n.contains('\\') || n == "." || n == ".." {
                return Err(format!("invalid file name: {n}"));
            }
            let d = dir.join(n);
            if d == src {
                return Ok(d);
            }
            if d.exists() {
                return Err(format!("{} already exists", d.display()));
            }
            fs::copy(&src, &d).map_err(|e| format!("{}: {e}", d.display()))?;
            d
        }
        None => {
            if src.parent() == Some(dir.as_path()) {
                return Ok(src); // already directly in the target folder
            }
            let file = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "image.png".into());
            copy_unique(&src, &dir, &file).map_err(|e| format!("{}: {e}", dir.display()))?
        }
    };
    if mv && dest != src {
        fs::remove_file(&src).map_err(|e| format!("copied to {}, but could not remove the original: {e}", dest.display()))?;
    }
    Ok(dest)
}

/// Device pixels per point (`pixelsWide / size.width` on macOS): the image's DPI / 72,
/// read from PNG `pHYs` or JPEG JFIF density. 1.0 when unknown.
pub fn image_scale_of(data: &[u8]) -> f64 {
    let dpi = png_dpi(data).or_else(|| jpeg_dpi(data));
    match dpi {
        Some(d) if d.is_finite() && d > 0.0 => {
            let s = d / 72.0;
            if (s - 1.0).abs() < 0.02 { 1.0 } else { (s * 100.0).round() / 100.0 }
        }
        _ => 1.0,
    }
}

fn png_dpi(d: &[u8]) -> Option<f64> {
    if !d.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut i = 8;
    while i + 8 <= d.len() {
        let len = u32::from_be_bytes(d[i..i + 4].try_into().ok()?) as usize;
        let kind = &d[i + 4..i + 8];
        let body = d.get(i + 8..i + 8 + len)?;
        if kind == b"pHYs" && len >= 9 {
            let x = u32::from_be_bytes(body[0..4].try_into().ok()?) as f64;
            return (body[8] == 1).then_some(x * 0.0254); // unit 1 = per metre
        }
        if kind == b"IDAT" || kind == b"IEND" {
            return None;
        }
        i += 12 + len;
    }
    None
}

fn jpeg_dpi(d: &[u8]) -> Option<f64> {
    if !d.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= d.len() && d[i] == 0xFF {
        let marker = d[i + 1];
        let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        let seg = d.get(i + 4..i + 2 + len)?;
        if marker == 0xE0 && seg.starts_with(b"JFIF\0") && seg.len() >= 12 {
            let units = seg[7];
            let x = u16::from_be_bytes([seg[8], seg[9]]) as f64;
            return match units {
                1 => Some(x),
                2 => Some(x * 2.54),
                _ => None,
            };
        }
        if marker == 0xDA {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// Read up to 1 MiB of the file header and compute its scale.
pub fn image_scale_path(p: &Path) -> f64 {
    use std::io::Read;
    let mut buf = Vec::new();
    match fs::File::open(p) {
        Ok(f) => {
            let _ = f.take(1 << 20).read_to_end(&mut buf);
            image_scale_of(&buf)
        }
        Err(_) => 1.0,
    }
}

// ------------------------------------------------------------------ tauri commands

type R<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

fn abs_path(p: &str) -> R<PathBuf> {
    let p = PathBuf::from(p);
    if p.is_absolute() { Ok(p) } else { Err(format!("path must be absolute: {}", p.display())) }
}

/// Copy / move one image (Image Tools, Copy / Move All Images to…).
#[tauri::command]
pub async fn copy_image<Rt: tauri::Runtime>(
    app: tauri::AppHandle<Rt>,
    state: tauri::State<'_, crate::AppState>,
    src: String,
    dir: String,
    name: Option<String>,
    mv: Option<bool>,
) -> R<String> {
    let (s, d) = (abs_path(&src)?, abs_path(&dir)?);
    let mv = mv.unwrap_or(false);
    let dest = blocking(move || copy_image_to(&s, &d, name.as_deref(), mv)).await??;
    state.own_writes.record(&dest, false);
    if let Some(parent) = dest.parent() {
        crate::allow_assets(&app, parent, false);
    }
    Ok(crate::fsops::path_str(&dest))
}

/// Pixel-to-point ratio of an image file (1.0 when unknown).
#[tauri::command]
pub async fn image_scale(path: String) -> R<f64> {
    let p = abs_path(&path)?;
    blocking(move || image_scale_path(&p)).await
}

/// Multi-select image picker (Insert Local Images…).
#[tauri::command]
pub async fn open_images_dialog<Rt: tauri::Runtime>(app: tauri::AppHandle<Rt>, window: tauri::WebviewWindow<Rt>) -> R<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let b = app.dialog().file().set_parent(&window).set_title("Select image from local file").add_filter("Images", IMAGE_EXTENSIONS);
    let picked = blocking(move || b.blocking_pick_files()).await?.unwrap_or_default();
    let mut out = Vec::new();
    for p in picked.into_iter().filter_map(|p| p.into_path().ok()) {
        crate::allow_assets_for_file(&app, &p);
        out.push(crate::fsops::path_str(&p));
    }
    Ok(out)
}

#[cfg(test)]
#[path = "image_tools_tests.rs"]
mod tests;

//! Unix-only helpers for `atomic_write`: extended attributes, ownership, access checks.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

fn cpath(p: &Path) -> Option<CString> {
    CString::new(p.as_os_str().as_bytes()).ok()
}

/// `access(W_OK)` for the real user (honours ACLs, root, read-only mounts).
pub fn writable(p: &Path) -> bool {
    let Some(c) = cpath(p) else { return true };
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

pub fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "macos")]
mod sys {
    use super::*;
    pub unsafe fn list(p: &CString, buf: *mut libc::c_char, n: usize) -> isize {
        unsafe { libc::listxattr(p.as_ptr(), buf, n, libc::XATTR_NOFOLLOW) }
    }
    pub unsafe fn get(p: &CString, name: &CString, buf: *mut libc::c_void, n: usize) -> isize {
        unsafe { libc::getxattr(p.as_ptr(), name.as_ptr(), buf, n, 0, libc::XATTR_NOFOLLOW) }
    }
    pub unsafe fn set(p: &CString, name: &CString, v: &[u8]) -> i32 {
        unsafe { libc::setxattr(p.as_ptr(), name.as_ptr(), v.as_ptr().cast(), v.len(), 0, libc::XATTR_NOFOLLOW) }
    }
}

#[cfg(target_os = "linux")]
mod sys {
    use super::*;
    pub unsafe fn list(p: &CString, buf: *mut libc::c_char, n: usize) -> isize {
        unsafe { libc::llistxattr(p.as_ptr(), buf, n) }
    }
    pub unsafe fn get(p: &CString, name: &CString, buf: *mut libc::c_void, n: usize) -> isize {
        unsafe { libc::lgetxattr(p.as_ptr(), name.as_ptr(), buf, n) }
    }
    pub unsafe fn set(p: &CString, name: &CString, v: &[u8]) -> i32 {
        unsafe { libc::lsetxattr(p.as_ptr(), name.as_ptr(), v.as_ptr().cast(), v.len(), 0) }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn xattr_names(p: &Path) -> Vec<CString> {
    let Some(c) = cpath(p) else { return vec![] };
    let n = unsafe { sys::list(&c, std::ptr::null_mut(), 0) };
    if n <= 0 {
        return vec![];
    }
    let mut buf = vec![0u8; n as usize];
    let n = unsafe { sys::list(&c, buf.as_mut_ptr().cast(), buf.len()) };
    if n <= 0 {
        return vec![];
    }
    buf.truncate(n as usize);
    buf.split(|b| *b == 0).filter(|s| !s.is_empty()).filter_map(|s| CString::new(s).ok()).collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn xattr_get(p: &Path, name: &str) -> Option<Vec<u8>> {
    let (c, n) = (cpath(p)?, CString::new(name).ok()?);
    get_c(&c, &n)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn get_c(c: &CString, n: &CString) -> Option<Vec<u8>> {
    let len = unsafe { sys::get(c, n, std::ptr::null_mut(), 0) };
    if len < 0 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    let len = unsafe { sys::get(c, n, buf.as_mut_ptr().cast(), buf.len()) };
    if len < 0 {
        return None;
    }
    buf.truncate(len as usize);
    Some(buf)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn xattr_set(p: &Path, name: &str, v: &[u8]) -> bool {
    match (cpath(p), CString::new(name)) {
        (Some(c), Ok(n)) => unsafe { sys::set(&c, &n, v) == 0 },
        _ => false,
    }
}

/// Best effort: copy every extended attribute (Finder tags, quarantine, `user.*`,
/// POSIX ACLs on Linux) and, on macOS, the ACL, from `from` to `to`.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn copy_metadata(from: &Path, to: &Path) {
    let (Some(f), Some(t)) = (cpath(from), cpath(to)) else { return };
    for name in xattr_names(from) {
        if let Some(v) = get_c(&f, &name) {
            unsafe {
                sys::set(&t, &name, &v);
            }
        }
    }
    #[cfg(target_os = "macos")]
    unsafe {
        libc::copyfile(f.as_ptr(), t.as_ptr(), std::ptr::null_mut(), libc::COPYFILE_ACL);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn copy_metadata(_from: &Path, _to: &Path) {}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn xattr_get(_p: &Path, _name: &str) -> Option<Vec<u8>> {
    None
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn xattr_set(_p: &Path, _name: &str, _v: &[u8]) -> bool {
    false
}

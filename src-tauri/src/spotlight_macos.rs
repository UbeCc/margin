//! Spotlight (MDQuery) fast path for Quick Open on macOS.
//!
//! Raw CoreServices/CoreFoundation FFI (no extra crates): a synchronous
//! `MDQueryExecute` scoped to one folder via `MDQuerySetSearchScope`, run on a
//! helper thread so callers can race it against the walker. Every failure maps to
//! `None` so the caller falls back to the directory walker.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type CFAllocatorRef = *const c_void;
type MDQueryRef = *const c_void;
type CFIndex = isize;

const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
const MD_QUERY_SYNCHRONOUS: usize = 1; // kMDQuerySynchronous

#[repr(C)]
struct CFArrayCallBacks {
    _private: [u8; 0],
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeArrayCallBacks: CFArrayCallBacks;
    fn CFStringCreateWithBytes(a: CFAllocatorRef, b: *const u8, n: CFIndex, enc: u32, ext: u8) -> CFStringRef;
    fn CFStringGetLength(s: CFStringRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(len: CFIndex, enc: u32) -> CFIndex;
    fn CFStringGetCString(s: CFStringRef, buf: *mut u8, size: CFIndex, enc: u32) -> u8;
    fn CFStringGetTypeID() -> usize;
    fn CFGetTypeID(v: CFTypeRef) -> usize;
    fn CFArrayCreate(a: CFAllocatorRef, v: *const CFTypeRef, n: CFIndex, cb: *const CFArrayCallBacks) -> CFArrayRef;
    fn CFRelease(v: CFTypeRef);
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    static kMDItemPath: CFStringRef;
    fn MDQueryCreate(a: CFAllocatorRef, q: CFStringRef, vals: CFArrayRef, sort: CFArrayRef) -> MDQueryRef;
    fn MDQuerySetSearchScope(q: MDQueryRef, scope: CFArrayRef, opts: u32);
    fn MDQuerySetMaxCount(q: MDQueryRef, n: CFIndex);
    fn MDQueryExecute(q: MDQueryRef, opts: usize) -> u8;
    fn MDQueryGetResultCount(q: MDQueryRef) -> CFIndex;
    fn MDQueryGetResultAtIndex(q: MDQueryRef, i: CFIndex) -> *const c_void;
    fn MDItemCopyAttribute(item: *const c_void, name: CFStringRef) -> CFTypeRef;
}

/// Owned CF object, released on drop.
struct Cf(CFTypeRef);
impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

fn cfstr(s: &str) -> Cf {
    Cf(unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as CFIndex, UTF8, 0) })
}

fn to_string(s: CFStringRef) -> Option<String> {
    unsafe {
        if s.is_null() || CFGetTypeID(s) != CFStringGetTypeID() {
            return None;
        }
        let cap = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), UTF8) + 1;
        let mut buf = vec![0u8; cap.max(1) as usize];
        if CFStringGetCString(s, buf.as_mut_ptr(), cap, UTF8) == 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        buf.truncate(end);
        String::from_utf8(buf).ok()
    }
}

/// Run one synchronous scoped query on the current thread. Returns the
/// absolute paths Spotlight reported (as given, not canonicalized).
pub fn query_blocking(scope: &Path, query: &str, max: usize) -> Option<Vec<PathBuf>> {
    let scope_s = scope.to_str()?;
    unsafe {
        let q = cfstr(query);
        let dir = cfstr(scope_s);
        if q.0.is_null() || dir.0.is_null() {
            return None;
        }
        let md = Cf(MDQueryCreate(std::ptr::null(), q.0, std::ptr::null(), std::ptr::null()));
        if md.0.is_null() {
            return None; // malformed query string
        }
        let items = [dir.0];
        let scope_arr = Cf(CFArrayCreate(std::ptr::null(), items.as_ptr(), 1, &kCFTypeArrayCallBacks));
        if scope_arr.0.is_null() {
            return None;
        }
        MDQuerySetSearchScope(md.0, scope_arr.0, 0);
        MDQuerySetMaxCount(md.0, max as CFIndex);
        if MDQueryExecute(md.0, MD_QUERY_SYNCHRONOUS) == 0 {
            return None;
        }
        let n = MDQueryGetResultCount(md.0).max(0) as usize;
        let mut out = Vec::with_capacity(n.min(max));
        for i in 0..n.min(max) {
            let item = MDQueryGetResultAtIndex(md.0, i as CFIndex);
            if item.is_null() {
                continue;
            }
            let p = Cf(MDItemCopyAttribute(item, kMDItemPath));
            if let Some(s) = to_string(p.0) {
                out.push(PathBuf::from(s));
            }
        }
        Some(out)
    }
}

/// At most this many query threads may be outstanding (an abandoned query
/// keeps its thread until Spotlight answers; this stops them piling up).
const MAX_IN_FLIGHT: usize = 1;
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Slot for one outstanding query thread; released on drop.
pub struct InFlight(());

impl InFlight {
    pub fn acquire() -> Option<InFlight> {
        if IN_FLIGHT.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(InFlight(()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Run `job` on a helper thread holding an in-flight slot; the receiver gets
/// its result. `None` when no slot is free or the thread cannot be spawned.
pub fn spawn<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Option<mpsc::Receiver<T>> {
    let slot = InFlight::acquire()?;
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("spotlight-query".into())
        .spawn(move || {
            let _slot = slot;
            let _ = tx.send(job());
        })
        .ok()?;
    Some(rx)
}

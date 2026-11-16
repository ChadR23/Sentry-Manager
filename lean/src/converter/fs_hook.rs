//! Points inside a file copy (and the telemetry writer) where the crash
//! tests kill the converter, as test/fixtures/crashPoints.js wraps
//! fs.promises.open: a copy just created, half written, complete, being read
//! back; the staged copy of an original half written; the encoded file just
//! emptied by the writer. Only test builds have a hook; elsewhere every call
//! is a no-op the compiler removes.
//!
//! Events: "open-new" (a file created exclusively), "write" (before each
//! chunk: Some(_) writes only its first half, then "written-part"),
//! "copied" (the copy closed), "read-open" (a file opened to be read back
//! in full), "truncated" (the writer emptied the encode).

use std::path::Path;

#[cfg(test)]
pub type Hook = std::sync::Arc<dyn Fn(&str, &Path) -> Option<usize> + Send + Sync>;
#[cfg(test)]
pub static HOOK: std::sync::RwLock<Option<Hook>> = std::sync::RwLock::new(None);

#[cfg(test)]
#[inline]
pub fn event(name: &str, path: &Path) -> Option<usize> {
    let h = HOOK.read().unwrap().clone();
    h.and_then(|h| h(name, path))
}

#[cfg(not(test))]
#[inline(always)]
pub fn event(_name: &str, _path: &Path) -> Option<usize> {
    None
}

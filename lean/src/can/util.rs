//! Small helpers the CAN area shares: times as Node gives them, files read
//! as JSON, hashes, hex.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Date.now().
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// fs.Stats#mtimeMs (sec * 1000 + nsec / 1e6, as Node works it out).
pub fn mtime_ms(md: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    md.mtime() as f64 * 1000.0 + md.mtime_nsec() as f64 / 1e6
}

/// fs.Stats#birthtimeMs where the system gives it, else ctimeMs.
pub fn ctime_ms(md: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    md.ctime() as f64 * 1000.0 + md.ctime_nsec() as f64 / 1e6
}

pub fn read_json(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

/// SHA-256 (hex) and length of a file.
pub fn hash_file(file: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(file)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut len = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        len += n as u64;
    }
    Ok((hex(&h.finalize()), len))
}

/// Bytes free for this process on the file system of `p`.
pub fn free_bytes(p: &Path) -> Option<f64> {
    use std::ffi::CString;
    let c = CString::new(p.as_os_str().to_string_lossy().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some(s.f_bavail as f64 * s.f_frsize as f64)
}

/// Random bytes from the kernel.
pub fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b
}

/// Buffer#toString('base64url') without padding.
pub fn base64url(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Directory entries that are folders (names), or empty.
pub fn subdirs(p: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(p) else { return Vec::new() };
    let mut v: Vec<String> = rd.filter_map(|e| e.ok()).filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).filter_map(|e| e.file_name().into_string().ok()).collect();
    v.sort();
    v
}

/// Names in a folder, sorted by bytes (Node's fs.readdir is libuv's scandir, sorted with strcmp).
pub fn names(p: &Path) -> Option<Vec<String>> {
    let rd = std::fs::read_dir(p).ok()?;
    let mut v: Vec<String> = rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect();
    v.sort();
    Some(v)
}

/// String#localeCompare for the ASCII names compared here (bus names, ids): punctuation first,
/// then digits, then letters without regard to case; lower case before upper case on a tie.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn class(c: char) -> (u8, u32) {
        if c.is_ascii_digit() {
            (1, c as u32)
        } else if c.is_ascii_alphabetic() {
            (2, c.to_ascii_lowercase() as u32)
        } else if c.is_alphabetic() {
            (2, c.to_lowercase().next().unwrap_or(c) as u32)
        } else {
            (0, c as u32)
        }
    }
    let pa: Vec<(u8, u32)> = a.chars().map(class).collect();
    let pb: Vec<(u8, u32)> = b.chars().map(class).collect();
    pa.cmp(&pb).then_with(|| {
        // (tertiary: lower case first)
        let ta: Vec<bool> = a.chars().map(|c| c.is_uppercase()).collect();
        let tb: Vec<bool> = b.chars().map(|c| c.is_uppercase()).collect();
        ta.cmp(&tb)
    })
}

/// One line of text from an untrusted source: no control characters, at most `n` characters.
pub fn one_line(v: &str, n: usize) -> String {
    let mut s = String::new();
    let mut space = false;
    for c in v.chars() {
        let ctl = (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) || c == '\u{2028}' || c == '\u{2029}';
        if ctl || c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !s.is_empty() {
            s.push(' ');
        }
        space = false;
        s.push(c);
    }
    let len = s.encode_utf16().count();
    if len > n {
        let cut: String = utf16_slice(&s, n - 1);
        format!("{}…", cut)
    } else {
        s
    }
}

/// s.slice(0, n) in UTF-16 units (a surrogate pair cut in half is dropped).
pub fn utf16_slice(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            break;
        }
        used += w;
        out.push(c);
    }
    out
}

//! memory.js and host.js: the whole server's memory from /proc/meminfo, and
//! the server line (host name, OS from the kernel's build string, kernel,
//! uptimes, versions).

use super::util::*;
use crate::ops::js::num as jnum;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Memory {
    pub total_b: Option<f64>,
    pub used_b: Option<f64>,
    pub available_b: Option<f64>,
    pub cache_b: Option<f64>,
    pub swap_total_b: Option<f64>,
    pub swap_used_b: Option<f64>,
    pub app_b: Option<f64>,
}

impl Memory {
    pub fn to_json(&self) -> Value {
        let n = |x: Option<f64>| x.map_or(Value::Null, jnum);
        json!({
            "totalB": n(self.total_b), "usedB": n(self.used_b), "availableB": n(self.available_b), "cacheB": n(self.cache_b),
            "swapTotalB": n(self.swap_total_b), "swapUsedB": n(self.swap_used_b), "appB": n(self.app_b)
        })
    }
}

pub fn read_memory(proc_root: &Path) -> Memory {
    let m = parse_key_values(read_text(proc_root.join("meminfo")).as_deref());
    let kb = |k: &str| m.get(k).filter(|v| v.is_finite()).map(|v| v * 1024.0);
    let Some(total) = kb("MemTotal").filter(|t| *t != 0.0) else {
        return Memory { swap_total_b: kb("SwapTotal"), ..Default::default() };
    };
    // MemAvailable is missing on kernels before 3.14
    let avail = kb("MemAvailable").unwrap_or_else(|| kb("MemFree").unwrap_or(0.0) + kb("Buffers").unwrap_or(0.0) + kb("Cached").unwrap_or(0.0));
    let avail = total.min(avail.max(0.0));
    // "buff/cache" as free(1) counts it
    let cache = kb("Buffers").unwrap_or(0.0) + kb("Cached").unwrap_or(0.0) + kb("SReclaimable").unwrap_or(0.0);
    let (st, sf) = (kb("SwapTotal"), kb("SwapFree"));
    Memory {
        total_b: Some(total),
        used_b: Some(total - avail),
        available_b: Some(avail),
        cache_b: Some(cache),
        swap_total_b: st,
        swap_used_b: match (st, sf) {
            (Some(a), Some(b)) => Some((a - b).max(0.0)),
            _ => None,
        },
        app_b: None,
    }
}

/// The host's distribution, as far as its kernel build string tells.
pub fn os_from_kernel(release: Option<&str>, version: Option<&str>) -> Option<&'static str> {
    let s = format!("{} {}", release.unwrap_or(""), version.unwrap_or(""));
    let tests: [(&super::util::Re, &str); 19] = [
        (re!(r"(?i)unraid"), "Unraid"),
        (re!(r"(?i)truenas"), "TrueNAS"),
        (re!(r"(?i)-pve\b|proxmox"), "Proxmox VE"),
        (re!(r"(?i)synology"), "Synology DSM"),
        (re!(r"(?i)qnap"), "QNAP QTS"),
        (re!(r"(?i)microsoft|WSL"), "Windows (WSL)"),
        (re!(r"(?i)rpt-rpi|raspberrypi|\+rpt"), "Raspberry Pi OS"),
        (re!(r"(?i)ubuntu"), "Ubuntu"),
        (re!(r"(?i)debian|\+deb\d+"), "Debian"),
        (re!(r"(?i)\.fc\d+\."), "Fedora"),
        (re!(r"(?i)\.el\d+"), "Enterprise Linux"),
        (re!(r"(?i)-arch\d|archlinux"), "Arch Linux"),
        (re!(r"(?i)manjaro"), "Manjaro"),
        (re!(r"(?i)gentoo"), "Gentoo"),
        (re!(r"(?i)alpine|-lts\b"), "Alpine"),
        (re!(r"(?i)nixos"), "NixOS"),
        (re!(r"(?i)suse"), "openSUSE"),
        (re!(r"(?i)talos"), "Talos"),
        (re!(r"(?i)linuxkit"), "Docker Desktop"),
    ];
    for (r, name) in tests {
        if r.is(&s) {
            return Some(name);
        }
    }
    release.filter(|r| !r.is_empty()).map(|_| "Linux")
}

/// "ffmpeg version 7.1.1-Jellyfin Copyright ..." -> "7.1.1-Jellyfin"
pub fn parse_ffmpeg_version(text: &str) -> Option<String> {
    re!(r"ffmpeg version (\S+)").group(text, 1)
}

/// Docker Desktop for Windows (WSL2): its kernel's release says so.
pub fn is_wsl(release: Option<&str>) -> bool {
    re!(r"(?i)microsoft|WSL").is(release.unwrap_or(""))
}

#[derive(Clone, Debug)]
pub struct HostStatic {
    pub hostname: Option<String>,
    pub os: Option<&'static str>,
    pub kernel: Option<String>,
    pub wsl: bool,
    pub arch: Option<String>,
}

pub struct HostInfo {
    proc_root: PathBuf,
    pub version: Value,
    /// what Node puts in `node` (process.version); this server has no Node: null
    pub node: Value,
    pub static_: Option<HostStatic>,
}

/// os.machine(): the kernel's machine name (uname -m).
pub(super) fn machine() -> Option<String> {
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut u) } != 0 {
        return None;
    }
    let s = unsafe { std::ffi::CStr::from_ptr(u.machine.as_ptr()) }.to_string_lossy().into_owned();
    (!s.is_empty()).then_some(s)
}

pub(super) fn os_hostname() -> Option<String> {
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut u) } != 0 {
        return None;
    }
    let s = unsafe { std::ffi::CStr::from_ptr(u.nodename.as_ptr()) }.to_string_lossy().into_owned();
    (!s.is_empty()).then_some(s)
}

impl HostInfo {
    pub fn new(proc_root: &Path, version: Value) -> HostInfo {
        HostInfo { proc_root: proc_root.into(), version, node: Value::Null, static_: None }
    }

    pub fn probe(&mut self) {
        let kernel = read_line(self.proc_root.join("sys/kernel/osrelease"));
        self.static_ = Some(HostStatic {
            hostname: read_line(self.proc_root.join("sys/kernel/hostname")).or_else(os_hostname),
            os: os_from_kernel(kernel.as_deref(), read_text(self.proc_root.join("version")).as_deref()),
            wsl: is_wsl(kernel.as_deref()),
            kernel,
            arch: read_line(self.proc_root.join("sys/kernel/arch")).or_else(machine),
        });
    }

    pub fn info(&self, uptime_s: Option<f64>, app_start_s: Option<f64>, ffmpeg: &Value) -> Value {
        let app = match (uptime_s, app_start_s) {
            (Some(u), Some(a)) => Some(js_round(u - a)),
            _ => None,
        };
        let s = self.static_.as_ref();
        let mut out = serde_json::Map::new();
        if let Some(s) = s {
            out.insert("hostname".into(), json!(s.hostname));
            out.insert("os".into(), json!(s.os));
            out.insert("kernel".into(), json!(s.kernel));
            out.insert("arch".into(), json!(s.arch));
            out.insert("version".into(), self.version.clone());
            out.insert("node".into(), self.node.clone());
        }
        out.insert("uptimeS".into(), uptime_s.map_or(Value::Null, |u| jnum(js_round(u))));
        out.insert("appUptimeS".into(), app.filter(|a| *a >= 0.0).map_or(Value::Null, jnum));
        out.insert("ffmpeg".into(), ffmpeg.clone());
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_os() {
        assert_eq!(os_from_kernel(Some("6.1.106-Unraid"), Some("")), Some("Unraid"));
        assert_eq!(os_from_kernel(Some("6.6.44-production+truenas"), Some("")), Some("TrueNAS"));
        assert_eq!(os_from_kernel(Some("6.8.12-4-pve"), Some("")), Some("Proxmox VE"));
        assert_eq!(os_from_kernel(Some("6.11.4-301.fc41.x86_64"), Some("")), Some("Fedora"));
        assert_eq!(os_from_kernel(Some("5.10.0"), Some("Linux version 5.10.0")), Some("Linux"));
        assert_eq!(os_from_kernel(None, None), None);
        assert_eq!(parse_ffmpeg_version("ffmpeg version 7.1.1-Jellyfin Copyright (c)").as_deref(), Some("7.1.1-Jellyfin"));
    }
}

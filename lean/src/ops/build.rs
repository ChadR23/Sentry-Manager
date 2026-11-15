//! What this build is (server/buildInfo.js: BUILD_INFO.json) and the kind of
//! host it runs on (server/hostInfo.js: one word from a fixed list, for the
//! heartbeat; never the kernel string or a host name).

use serde_json::{Map, Value};
use std::path::Path;
use std::sync::OnceLock;

/// A build number: a whole number from 1, else None.
pub fn clean_build(v: &Value) -> Option<u64> {
    let text = match v {
        Value::Null => String::new(),
        v => super::js::to_string(v),
    };
    let t = text.trim();
    let t = if t.len() >= 6 && t[..6].eq_ignore_ascii_case("build-") { &t[6..] } else { t };
    if t.is_empty() || t.len() > 9 || !t.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: u64 = t.parse().ok()?;
    (n > 0).then_some(n)
}

/// BUILD_INFO.json from `root`, with `build` a number (or left out); {} when there is none.
pub fn read_build_info(root: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(root.join("BUILD_INFO.json")) else { return Value::Object(Map::new()) };
    let Ok(Value::Object(mut info)) = serde_json::from_str::<Value>(&text) else { return Value::Object(Map::new()) };
    let build = info.remove("build").unwrap_or(Value::Null);
    if let Some(n) = clean_build(&build) {
        info.insert("build".into(), Value::from(n));
    }
    Value::Object(info)
}

/// "Build 128 (cb593ca)", "cb593ca" for an image from before build numbers, None from source.
pub fn build_name(info: &Value) -> Option<String> {
    let sha: String = if super::js::truthy(&info["sha"]) { super::js::to_string(&info["sha"]).chars().take(7).collect() } else { String::new() };
    if let Some(n) = clean_build(&info["build"]) {
        return Some(if sha.is_empty() { format!("Build {n}") } else { format!("Build {n} ({sha})") });
    }
    (!sha.is_empty()).then_some(sha)
}

/// stats/host.js appVersion: "Build N" from BUILD_INFO.json (release images;
/// the commit for one from before build numbers), else version.json's version.
pub fn app_version(root: &Path) -> Option<String> {
    let info = read_build_info(root);
    if let Some(n) = clean_build(&info["build"]) {
        return Some(format!("Build {n}"));
    }
    if super::js::truthy(&info["sha"]) {
        return Some(super::js::to_string(&info["sha"]).chars().take(7).collect());
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(root.join("version.json")).ok()?).ok()?;
    let version = &v["version"];
    super::js::truthy(version).then(|| super::js::to_string(version))
}

// ---- the host

pub const HOST_OS: [&str; 11] = ["truenas", "unraid", "synology", "qnap", "wsl", "macos", "raspberry-pi", "ubuntu", "debian", "fedora", "linux"];

/// The host's files and kernel release, injectable for tests.
pub struct HostSigns<'a> {
    pub read: &'a dyn Fn(&str) -> Option<String>,
    pub exists: &'a dyn Fn(&str) -> bool,
    pub release: String,
    pub platform: &'a str,
    pub arch: &'a str,
}

fn lower_has(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase().contains(needle)
}

fn container_text(t: &str) -> bool {
    ["docker", "containerd", "kubepods", "libpod"].iter().any(|n| lower_has(t, n))
}

pub fn in_container(s: &HostSigns) -> bool {
    if (s.exists)("/.dockerenv") {
        return true;
    }
    container_text(&(s.read)("/proc/1/cgroup").unwrap_or_default()) || container_text(&(s.read)("/proc/self/mountinfo").unwrap_or_default())
}

/// The KEY=value lines of an os-release file, quotes off.
pub fn parse_os_release(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let l = line.trim();
        let Some((k, v)) = l.split_once('=') else { continue };
        let k = k.trim_end();
        if k.is_empty() || !k.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_') {
            continue;
        }
        let v = v.trim();
        let b = v.as_bytes();
        let v = if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] { &v[1..v.len() - 1] } else { v };
        out.retain(|(x, _)| x != k);
        out.push((k.to_string(), v.to_string()));
    }
    out
}

fn from_kernel(release: &str, version: &str, arch: &str, pi_model: bool, syno_file: bool) -> Option<&'static str> {
    let k = format!("{release} {version}");
    if lower_has(&k, "truenas") {
        return Some("truenas");
    }
    if lower_has(&k, "unraid") {
        return Some("unraid");
    }
    if lower_has(&k, "microsoft") {
        return Some("wsl");
    }
    if lower_has(&k, "linuxkit") {
        return Some(if arch == "arm64" { "macos" } else { "wsl" });
    }
    if pi_model || lower_has(&k, "rpi") || lower_has(&k, "raspi") {
        return Some("raspberry-pi");
    }
    if lower_has(&k, "synology") || syno_file {
        return Some("synology");
    }
    if lower_has(&k, "qnap") {
        return Some("qnap");
    }
    None
}

/// (os, docker) for this host.
pub fn detect_host(s: &HostSigns) -> (Option<&'static str>, bool) {
    let docker = in_container(s);
    if s.platform == "darwin" {
        return (Some("macos"), docker);
    }
    if s.platform != "linux" {
        return (None, docker);
    }
    let read = |p: &str| (s.read)(p).unwrap_or_default();
    let pi = ["/proc/device-tree/model", "/sys/firmware/devicetree/base/model"].iter().any(|p| lower_has(&read(p), "raspberry pi"));
    let kernel = from_kernel(&s.release, &read("/proc/version"), s.arch, pi, (s.exists)("/proc/sys/kernel/syno_hw_version"));
    if kernel.is_some() || docker {
        return (Some(kernel.unwrap_or("linux")), docker);
    }
    let text = ["/etc/os-release", "/usr/lib/os-release"].iter().map(|p| read(p)).find(|t| !t.is_empty()).unwrap_or_default();
    let rel = parse_os_release(&text);
    let get = |k: &str| rel.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let mut ids = vec![get("ID").to_lowercase()];
    ids.extend(get("ID_LIKE").split_whitespace().map(str::to_lowercase));
    const IDS: [(&str, &str); 7] = [("ubuntu", "ubuntu"), ("debian", "debian"), ("fedora", "fedora"), ("raspbian", "raspberry-pi"), ("truenas", "truenas"), ("unraid", "unraid"), ("unraid-os", "unraid")];
    let os = ids.iter().filter(|x| !x.is_empty()).find_map(|x| IDS.iter().find(|(k, _)| k == x).map(|(_, v)| *v));
    (Some(os.unwrap_or("linux")), docker)
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    }
}

/// Node's process.platform and process.arch for this build.
pub fn platform_arch() -> (&'static str, &'static str) {
    let p = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    (p, arch())
}

/// The host, worked out once.
pub fn host_info() -> (Option<&'static str>, bool) {
    static CACHE: OnceLock<(Option<&'static str>, bool)> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.trim().to_string()).unwrap_or_default();
        let (platform, arch) = platform_arch();
        let read = |p: &str| std::fs::read_to_string(p).ok();
        let exists = |p: &str| Path::new(p).exists();
        detect_host(&HostSigns { read: &read, exists: &exists, release, platform, arch })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn detect(release: &str, files: &[(&str, &str)], platform: &str, arch: &str) -> (Option<&'static str>, bool) {
        let m: HashMap<String, String> = files.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let read = |p: &str| m.get(p).cloned();
        let exists = |p: &str| m.contains_key(p);
        detect_host(&HostSigns { read: &read, exists: &exists, release: release.into(), platform, arch })
    }

    const PI: &str = "Raspberry Pi 5 Model B Rev 1.0\u{0}";

    // test/hostInfo.test.js
    #[test]
    fn in_a_container_the_host_from_its_kernel_string() {
        let d = ("/.dockerenv", "");
        let table: Vec<(&str, &str, Vec<(&str, &str)>, &str)> = vec![
            ("6.6.44-production+truenas", "x64", vec![], "truenas"),
            ("6.1.106-Unraid", "x64", vec![], "unraid"),
            ("5.15.153.1-microsoft-standard-WSL2", "x64", vec![], "wsl"),
            ("4.19.128-microsoft-standard", "x64", vec![], "wsl"),
            ("6.10.14-linuxkit", "arm64", vec![], "macos"),
            ("6.10.14-linuxkit", "x64", vec![], "wsl"),
            ("6.6.31+rpt-rpi-v8", "arm64", vec![], "raspberry-pi"),
            ("6.6.31+rpt-rpi-2712", "arm64", vec![("/proc/device-tree/model", PI)], "raspberry-pi"),
            ("5.15.0-1034-raspi", "arm64", vec![], "raspberry-pi"),
            ("5.15.84-v8+", "arm64", vec![("/sys/firmware/devicetree/base/model", "Raspberry Pi 4 Model B Rev 1.4")], "raspberry-pi"),
            ("5.15.84-v8+", "arm64", vec![], "linux"),
            ("4.4.302+", "x64", vec![("/proc/version", "Linux version 4.4.302+ (root@build6) (gcc version 12.2.0) #72806 SMP synology_geminilake_920+")], "synology"),
            ("4.4.302+", "x64", vec![("/proc/sys/kernel/syno_hw_version", "DS920+")], "synology"),
            ("5.10.60-qnap", "x64", vec![], "qnap"),
            ("6.8.0-45-generic", "x64", vec![("/etc/os-release", "ID=debian\n")], "linux"),
            ("", "x64", vec![], "linux"),
        ];
        for (release, arch, mut files, want) in table {
            files.push(d);
            assert_eq!(detect(release, &files, "linux", arch), (Some(want), true), "{release}");
        }
        assert_eq!(detect("", &[d, ("/proc/version", "Linux version 6.6.44-production+truenas (root@x)")], "linux", "x64").0, Some("truenas"));
    }

    #[test]
    fn outside_a_container_os_release_kernel_and_device_tree() {
        let rel = |id: &str, like: &str| format!("NAME=\"X\"\nID={id}\n{}VERSION_ID=\"1\"\n", if like.is_empty() { String::new() } else { format!("ID_LIKE=\"{like}\"\n") });
        let table: Vec<(&str, Vec<(&str, String)>, &str)> = vec![
            ("6.8.0-45-generic", vec![("/etc/os-release", rel("ubuntu", "debian"))], "ubuntu"),
            ("6.1.0-25-amd64", vec![("/etc/os-release", rel("debian", ""))], "debian"),
            ("6.11.4-301.fc41.x86_64", vec![("/etc/os-release", rel("fedora", ""))], "fedora"),
            ("6.1.21-v8+", vec![("/etc/os-release", rel("raspbian", "debian"))], "raspberry-pi"),
            ("6.6.31+rpt-rpi-v8", vec![("/etc/os-release", rel("debian", ""))], "raspberry-pi"),
            ("6.1.0-25-arm64", vec![("/etc/os-release", rel("debian", "")), ("/proc/device-tree/model", PI.into())], "raspberry-pi"),
            ("6.6.44", vec![("/etc/os-release", rel("truenas", ""))], "truenas"),
            ("6.1.106", vec![("/etc/os-release", rel("unraid", ""))], "unraid"),
            ("6.8.0", vec![("/etc/os-release", rel("linuxmint", "ubuntu debian"))], "ubuntu"),
            ("5.14.0", vec![("/etc/os-release", rel("rocky", "rhel centos fedora"))], "fedora"),
            ("6.6.0", vec![("/etc/os-release", rel("arch", ""))], "linux"),
            ("6.6.0", vec![], "linux"),
            ("6.6.0", vec![("/usr/lib/os-release", "ID=\"fedora\"\n".into())], "fedora"),
        ];
        for (release, files, want) in table {
            let f: Vec<(&str, &str)> = files.iter().map(|(a, b)| (*a, b.as_str())).collect();
            assert_eq!(detect(release, &f, "linux", "x64"), (Some(want), false), "{release}");
        }
        assert_eq!(detect("24.1.0", &[], "darwin", "arm64"), (Some("macos"), false));
        assert_eq!(detect("10.0.26100", &[], "win32", "x64"), (None, false));
    }

    #[test]
    fn os_release_and_containers() {
        let r = parse_os_release("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n# a comment\nPRETTY_NAME='Ubuntu 24.04'\n");
        assert_eq!(r, vec![("NAME".into(), "Ubuntu".into()), ("ID".into(), "ubuntu".into()), ("ID_LIKE".into(), "debian".into()), ("PRETTY_NAME".into(), "Ubuntu 24.04".into())]);
        assert_eq!(detect("6.6.0", &[("/proc/1/cgroup", "0::/init.scope\n")], "linux", "x64").1, false);
        assert_eq!(detect("6.6.0", &[("/proc/self/mountinfo", "641 512 0:52 / / rw - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC")], "linux", "x64").1, true);
        let (os, _) = host_info();
        assert!(os.is_none() || HOST_OS.contains(&os.unwrap()));
    }

    #[test]
    fn build_numbers_and_names() {
        assert_eq!(clean_build(&json!("build-128")), Some(128));
        assert_eq!(clean_build(&json!(0)), None);
        assert_eq!(clean_build(&json!("x")), None);
        assert_eq!(clean_build(&json!(" 42 ")), Some(42));
        assert_eq!(build_name(&json!({ "sha": "cb593ca0123", "build": 128 })).as_deref(), Some("Build 128 (cb593ca)"));
        assert_eq!(build_name(&json!({ "sha": "cb593ca0123" })).as_deref(), Some("cb593ca"));
        assert_eq!(build_name(&json!({ "build": "x" })), None);
    }
}

//! server/gpu.js: what graphics hardware the container can see, for the
//! Settings / Encoder pages, the health check and the heartbeat. The
//! converter's planner decides which encoder is used; this only explains
//! what is there and why a GPU might not be used. (The converter area owns
//! `OpsCtx::detect_gpus`; this is the port it can call.)

use super::stats::util::{basename, re};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// proc.js run(): exit code (None: it could not run or timed out) and its output.
#[derive(Clone, Debug, Default)]
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub type Runner = dyn Fn(&str, &[&str], Duration) -> RunResult + Send + Sync;

/// Runs a program with a timeout (proc.js run).
pub fn run(cmd: &str, args: &[&str], timeout: Duration) -> RunResult {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() else {
        return RunResult { code: None, ..Default::default() };
    };
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.by_ref().take(4 << 20).read_to_end(&mut b);
        let _ = tx.send((0, b));
    });
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.by_ref().take(4 << 20).read_to_end(&mut b);
        let _ = tx2.send((1, b));
    });
    let deadline = std::time::Instant::now() + timeout;
    let mut r = RunResult::default();
    for _ in 0..2 {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok((0, b)) => r.stdout = String::from_utf8_lossy(&b).into_owned(),
            Ok((_, b)) => r.stderr = String::from_utf8_lossy(&b).into_owned(),
            Err(_) => {
                // (our own child)
                let _ = child.kill();
                let _ = child.wait();
                return RunResult { code: None, ..r };
            }
        }
    }
    r.code = child.wait().ok().and_then(|s| s.code());
    r
}

fn vendor_of(id: Option<&str>) -> Option<&'static str> {
    match id? {
        "0x1002" => Some("amd"),
        "0x10de" => Some("nvidia"),
        "0x8086" => Some("intel"),
        _ => None,
    }
}

fn vendor_name(v: &str) -> Option<&'static str> {
    match v {
        "amd" => Some("AMD"),
        "nvidia" => Some("NVIDIA"),
        "intel" => Some("Intel"),
        _ => None,
    }
}

fn read_sys(p: impl AsRef<Path>) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

/// Parse `vainfo` output into a driver name and the codecs it can encode.
pub fn parse_vainfo(text: &str) -> Value {
    let driver = re!(r"Driver version:\s*(.+)").group(text, 1).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let enc = |profile: &str| super::stats::util::Re::new(&format!(r"{profile}\s*:\s*VAEntrypointEncSlice(LP)?\b")).is(text);
    let lp_only = |profile: &str| super::stats::util::Re::new(&format!(r"{profile}\s*:\s*VAEntrypointEncSliceLP")).is(text) && !super::stats::util::Re::new(&format!(r"{profile}\s*:\s*VAEntrypointEncSlice\b(?!LP)")).is(text);
    json!({
        "driver": driver,
        "encodes": { "h264": enc("VAProfileH264(High|Main|ConstrainedBaseline)"), "hevc": enc("VAProfileHEVCMain"), "av1": enc("VAProfileAV1Profile0") },
        "lowPowerOnly": lp_only("VAProfileHEVCMain")
    })
}

/// A friendly GPU name out of the VA driver string, e.g. "AMD Radeon Graphics (renoir)".
pub fn name_from_driver(driver: Option<&str>) -> Option<String> {
    let d = driver.filter(|d| !d.is_empty())?;
    if let Some(c) = re!(r"(?i)for (AMD [^(]+)\(radeonsi, ([a-z0-9_]+)").caps(d) {
        return Some(format!("{} ({})", c[1].as_deref().unwrap_or("").trim(), c[2].as_deref().unwrap_or("")));
    }
    if re!(r"(?i)Intel iHD driver").is(d) {
        return Some("Intel graphics (iHD)".into());
    }
    Some(d.encode_utf16().take(80).collect::<Vec<u16>>()).map(|u| String::from_utf16_lossy(&u))
}

/// Where detect_gpus looks (the tests point these at a fake host).
pub struct DetectOptions {
    pub dri_dir: PathBuf,
    pub sys_drm: PathBuf,
    pub dxg: PathBuf,
    pub proc_version: PathBuf,
    /// process.arch: "x64", "arm64", ...
    pub arch: String,
}

impl Default for DetectOptions {
    fn default() -> Self {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "arm" => "arm",
            x => x,
        };
        DetectOptions { dri_dir: "/dev/dri".into(), sys_drm: "/sys/class/drm".into(), dxg: "/dev/dxg".into(), proc_version: "/proc/version".into(), arch: arch.into() }
    }
}

fn render_nodes(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| re!(r"^renderD\d+$").is(n)).collect()).unwrap_or_default();
    v.sort();
    v
}

/// detectGpus(): { gpus, nvidia, hints }.
pub fn detect_gpus(o: &DetectOptions, run_impl: &Runner) -> Value {
    let wsl = o.dxg.exists();
    let passed = render_nodes(&o.dri_dir);
    // sysfs is not namespaced: it lists the host's GPUs even when /dev/dri is not passed in
    let host_nodes = render_nodes(&o.sys_drm);
    let mut all: Vec<String> = Vec::new();
    for n in host_nodes.iter().chain(passed.iter()) {
        if !all.contains(n) {
            all.push(n.clone());
        }
    }
    let mut gpus: Vec<Value> = Vec::new();
    for node in all {
        let vendor_id = read_sys(o.sys_drm.join(&node).join("device/vendor"));
        let vendor = vendor_of(vendor_id.as_deref());
        let is_passed = passed.contains(&node);
        if vendor.is_none() && !is_passed {
            continue;
        }
        let driver_name = std::fs::read_link(o.sys_drm.join(&node).join("device/driver")).ok().map(|l| basename(&l.to_string_lossy()));
        let mut entry = json!({
            "node": format!("/dev/dri/{node}"), "vendor": vendor,
            "vendorName": vendor.and_then(vendor_name).map(str::to_string).or(vendor_id.clone().filter(|s| !s.is_empty())).unwrap_or_else(|| "unknown".into()),
            "driver": driver_name, "name": null, "passedThrough": is_passed, "encodes": null, "lowPowerOnly": false
        });
        if is_passed && vendor != Some("nvidia") {
            let dev = entry["node"].as_str().unwrap().to_string();
            let va = run_impl("vainfo", &["--display", "drm", "--device", &dev], Duration::from_secs(10));
            let mut driver = None;
            if va.code == Some(0) || !va.stdout.is_empty() {
                let info = parse_vainfo(&format!("{}\n{}", va.stdout, va.stderr));
                driver = info["driver"].as_str().map(str::to_string);
                entry["name"] = json!(name_from_driver(driver.as_deref()));
                entry["encodes"] = info["encodes"].clone();
                entry["lowPowerOnly"] = info["lowPowerOnly"].clone();
            }
            // Windows (WSL): a render node backed by Microsoft's D3D12 bridge
            let bridge = re!(r"(?i)d3d12").is(driver.as_deref().unwrap_or("")) || (wsl && driver.is_none());
            if vendor.is_none() && bridge {
                entry["virtual"] = json!(true);
                entry["name"] = json!("Windows (WSL) graphics bridge");
                entry["encodes"] = Value::Null;
            }
        }
        gpus.push(entry);
    }
    let smi = run_impl("nvidia-smi", &["--query-gpu=name,driver_version", "--format=csv,noheader"], Duration::from_secs(10));
    let nvidia: Vec<Value> = if smi.code == Some(0) {
        smi.stdout.trim().split('\n').filter(|l| !l.is_empty()).map(|l| {
            let parts: Vec<&str> = l.split(',').map(str::trim).collect();
            json!({ "name": parts.first(), "driver": parts.get(1) })
        }).collect()
    } else {
        Vec::new()
    };
    let mut hints: Vec<String> = Vec::new();
    for g in &gpus {
        if g["virtual"] == json!(true) {
            continue;
        }
        let passed = g["passedThrough"] == json!(true);
        if !passed && g["vendor"] != json!("nvidia") {
            hints.push(format!("{} GPU found on the host but /dev/dri is not passed into the container (add devices: - /dev/dri:/dev/dri).", g["vendorName"].as_str().unwrap_or("")));
        }
        if passed && g["encodes"].is_object() && g["encodes"]["hevc"] != json!(true) {
            let name = g["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(g["node"].as_str().unwrap_or(""));
            hints.push(format!("{name}: the VA-API driver reports no H.265 encoder."));
        }
    }
    if gpus.iter().any(|g| g["vendor"] == json!("nvidia")) && nvidia.is_empty() {
        hints.push("An NVIDIA GPU is on the host but not available in the container. Use the NVIDIA Container Toolkit (gpus: all) with NVIDIA_DRIVER_CAPABILITIES=compute,video,utility.".into());
    }
    // Docker Desktop runs containers in a Linux VM (its kernel says linuxkit)
    if !gpus.iter().any(|g| g["passedThrough"] == json!(true) && g["virtual"] != json!(true)) && nvidia.is_empty() {
        let kernel = std::fs::read_to_string(&o.proc_version).unwrap_or_default();
        if re!(r"(?i)linuxkit").is(&kernel) {
            hints.push(if o.arch == "arm64" {
                "Running in Docker Desktop, likely on an Apple Silicon Mac: Docker cannot use a Mac's GPU (macOS does not share it with the Linux virtual machine containers run in), so conversions use the CPU encoder. A Linux or Windows computer with a GPU can encode for this server as a node (Nodes).".into()
            } else {
                "Running in Docker Desktop: its Linux virtual machine sees no GPU. On Windows, an NVIDIA GPU works with WSL 2 and gpus: all; on a Mac no GPU can be used, so conversions use the CPU encoder.".into()
            });
        }
    }
    json!({ "gpus": gpus, "nvidia": nvidia, "hints": hints })
}

/// usableGpus(found): the GPUs this container can use: [{ name, vendor, ... }].
pub fn usable_gpus(found: &Value) -> Vec<Value> {
    if let Some(list) = found.as_array() {
        return list.iter().filter(|g| super::js::truthy(g)).cloned().collect();
    }
    let mut out = Vec::new();
    for g in found["gpus"].as_array().into_iter().flatten() {
        if g.is_object() && super::js::truthy(&g["passedThrough"]) && !super::js::truthy(&g["virtual"]) && g["vendor"] != json!("nvidia") {
            let mut x = g.clone();
            let name = g["name"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("{} GPU", g["vendorName"].as_str().filter(|s| !s.is_empty()).unwrap_or("Unknown")));
            x["name"] = json!(name);
            out.push(x);
        }
    }
    for g in found["nvidia"].as_array().into_iter().flatten() {
        if super::js::truthy(g) {
            let mut x = g.clone();
            if x.is_object() {
                x["name"] = json!(g["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("NVIDIA GPU"));
                x["vendor"] = json!("nvidia");
            }
            out.push(x);
        }
    }
    out
}

fn api_vendor(api: Option<&str>) -> Option<&'static str> {
    match api? {
        "nvenc" => Some("nvidia"),
        "qsv" => Some("intel"),
        "amf" => Some("amd"),
        _ => None,
    }
}

/// encodeGpuName: the name of the GPU an encode used, exactly as usable_gpus names it.
pub fn encode_gpu_name(found: &Value, device: Option<&str>, api: Option<&str>, vendor: Option<&str>) -> String {
    let usable = usable_gpus(found);
    let nvidia: Vec<&Value> = usable.iter().filter(|g| g["vendor"] == json!("nvidia")).collect();
    let dri: Vec<&Value> = usable.iter().filter(|g| g["vendor"] != json!("nvidia") && g["node"].is_string()).collect();
    let dev = device.unwrap_or("");
    let name = |g: &Value| super::js::to_string(&g["name"]);
    if let Some(i) = re!(r"^nvidia(\d+)$").group(dev, 1).and_then(|i| i.parse::<usize>().ok()) {
        if let Some(g) = nvidia.get(i) {
            return name(g);
        }
    }
    if let Some(render) = re!(r"(?:^|/)(renderD\d+)$").group(dev, 1) {
        if let Some(g) = dri.iter().find(|x| basename(x["node"].as_str().unwrap_or("")) == render) {
            return name(g);
        }
    }
    if dev.is_empty() {
        let maker = api_vendor(api);
        let pick = match maker {
            Some("nvidia") => nvidia.first().copied(),
            Some(m) => dri.iter().find(|g| g["vendor"] == json!(m)).copied(),
            None if api == Some("vaapi") => dri.iter().find(|g| basename(g["node"].as_str().unwrap_or("")) == "renderD128").or(dri.first()).copied(),
            None => None,
        };
        if let Some(g) = pick {
            return name(g);
        }
        let same = usable.iter().filter(|g| maker.is_none_or(|m| g["vendor"] == json!(m))).count();
        if usable.len() == 1 && same == 1 {
            return name(&usable[0]);
        }
    }
    let maker = vendor.or(api_vendor(api));
    maker.and_then(vendor_name).map_or_else(|| "GPU".to_string(), |v| format!("{v} GPU"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_host(wsl: bool) -> (PathBuf, DetectOptions) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("lean-gpu-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("dri")).unwrap();
        std::fs::write(dir.join("dri/renderD128"), "").unwrap();
        std::fs::create_dir_all(dir.join("drm/renderD128")).unwrap();
        if wsl {
            std::fs::write(dir.join("dxg"), "").unwrap();
        }
        std::fs::write(dir.join("version"), "Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075)\n").unwrap();
        let o = DetectOptions { dri_dir: dir.join("dri"), sys_drm: dir.join("drm"), dxg: dir.join("dxg"), proc_version: dir.join("version"), arch: "x64".into() };
        (dir, o)
    }

    fn runner(vainfo: RunResult, smi: RunResult) -> impl Fn(&str, &[&str], Duration) -> RunResult {
        move |cmd: &str, _: &[&str], _| if cmd == "vainfo" { vainfo.clone() } else { smi.clone() }
    }

    fn ok(out: &str) -> RunResult {
        RunResult { code: Some(0), stdout: out.into(), stderr: String::new() }
    }

    fn fail() -> RunResult {
        RunResult { code: Some(1), ..Default::default() }
    }

    const SMI: &str = "NVIDIA GeForce RTX 4070 Ti, 617.42\n";

    // test/gpu.test.js
    #[test]
    fn wsl_bridge_and_hints() {
        let (dir, o) = fake_host(true);
        let out = detect_gpus(&o, &runner(ok("vainfo: Driver version: Mesa Gallium driver 24.0.5 for D3D12 (NVIDIA GeForce RTX 4070 Ti)\nVAProfileH264Main : VAEntrypointVLD\n"), ok(SMI)));
        assert_eq!(out["gpus"][0]["virtual"], true);
        assert_eq!(out["gpus"][0]["name"], "Windows (WSL) graphics bridge");
        assert_eq!(out["hints"], json!([]));
        assert_eq!(out["nvidia"], json!([{ "name": "NVIDIA GeForce RTX 4070 Ti", "driver": "617.42" }]));
        // without a working VA-API driver: still the bridge, no warning
        let out = detect_gpus(&o, &runner(RunResult { code: Some(1), stdout: String::new(), stderr: "vaInitialize failed".into() }, ok(SMI)));
        assert_eq!(out["gpus"][0]["virtual"], true);
        assert_eq!(out["hints"], json!([]));
        let _ = std::fs::remove_dir_all(dir);

        // a real GPU whose driver lacks H.265 still gets its hint
        let (dir, o) = fake_host(false);
        let out = detect_gpus(&o, &runner(ok("Driver version: Intel iHD driver for Intel(R) Gen Graphics\nVAProfileH264Main : VAEntrypointEncSlice\n"), fail()));
        assert!(out["gpus"][0].get("virtual").is_none());
        assert_eq!(out["hints"].as_array().unwrap().len(), 1);
        assert!(out["hints"][0].as_str().unwrap().contains("no H.265 encoder"));
        // /dev/dri left out: the bridge is not listed and no "pass it in" hint
        std::fs::remove_file(dir.join("dri/renderD128")).unwrap();
        let out = detect_gpus(&o, &runner(fail(), ok(SMI)));
        assert_eq!(out["gpus"], json!([]));
        assert_eq!(out["hints"], json!([]));
        // an AMD GPU on the host that is not passed in gets its hint
        std::fs::create_dir_all(dir.join("drm/renderD128/device")).unwrap();
        std::fs::write(dir.join("drm/renderD128/device/vendor"), "0x1002\n").unwrap();
        let out = detect_gpus(&o, &runner(fail(), fail()));
        assert_eq!(out["gpus"].as_array().unwrap().len(), 1);
        assert!(out["hints"][0].as_str().unwrap().starts_with("AMD GPU found on the host but /dev/dri is not passed"));
        let _ = std::fs::remove_dir_all(dir);
    }

    // "Docker Desktop on a Mac: no GPU, and the reason is said plainly"
    #[test]
    fn docker_desktop_on_a_mac() {
        let dir = std::env::temp_dir().join(format!("lean-gpu-mac-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("version"), "Linux version 6.10.14-linuxkit (root@buildkitsandbox) (gcc (Alpine 13.2.1_git20240309) 13.2.1) #1 SMP\n").unwrap();
        let mut o = DetectOptions { dri_dir: dir.join("no-dri"), sys_drm: dir.join("no-drm"), dxg: dir.join("no-dxg"), proc_version: dir.join("version"), arch: "arm64".into() };
        let none = |_: &str, _: &[&str], _| fail();
        let mac = detect_gpus(&o, &none);
        assert_eq!((mac["gpus"].as_array().unwrap().len(), mac["nvidia"].as_array().unwrap().len()), (0, 0));
        assert!(mac["hints"][0].as_str().unwrap().contains("Docker cannot use a Mac's GPU"));
        o.arch = "x64".into();
        assert!(detect_gpus(&o, &none)["hints"][0].as_str().unwrap().contains("Docker Desktop"));
        std::fs::write(dir.join("version"), "Linux version 6.8.0-45-generic\n").unwrap();
        o.arch = "arm64".into();
        assert_eq!(detect_gpus(&o, &none)["hints"], json!([]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn vainfo_names_and_usable_gpus() {
        let v = parse_vainfo("Driver version: Mesa Gallium driver 23.1 for AMD Radeon Graphics (radeonsi, renoir, LLVM 15)\nVAProfileHEVCMain               :\tVAEntrypointEncSliceLP\nVAProfileH264Main : VAEntrypointEncSlice\n");
        assert_eq!(v["encodes"], json!({ "h264": true, "hevc": true, "av1": false }));
        assert_eq!(v["lowPowerOnly"], true);
        assert_eq!(name_from_driver(v["driver"].as_str()).as_deref(), Some("AMD Radeon Graphics (renoir)"));
        let found = json!({ "gpus": [{ "node": "/dev/dri/renderD128", "vendor": "intel", "vendorName": "Intel", "name": null, "passedThrough": true }], "nvidia": [{ "name": "RTX", "driver": "1" }] });
        let u = usable_gpus(&found);
        assert_eq!(u.iter().map(|g| g["name"].clone()).collect::<Vec<_>>(), vec![json!("Intel GPU"), json!("RTX")]);
        assert_eq!(encode_gpu_name(&found, Some("nvidia0"), Some("nvenc"), None), "RTX");
        assert_eq!(encode_gpu_name(&found, None, Some("vaapi"), None), "Intel GPU");
        assert_eq!(encode_gpu_name(&found, Some("nvidia3"), None, Some("nvidia")), "NVIDIA GPU");
        assert_eq!(encode_gpu_name(&json!([]), None, Some("x264"), None), "GPU");
    }
}

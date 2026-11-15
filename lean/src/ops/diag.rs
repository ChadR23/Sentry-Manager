//! What a report carries (index.js reportDiagnostics, reportHeartbeat,
//! reportIdentifiers) and storageTotals.js. Ops builds them from its own
//! parts (health, notifications, savings, settings in manager.db) and from
//! the `OpsCtx` calls the other areas implement.

use super::ctx::{Level, OpsCtx, VehicleInfo};
use super::js::{iso, num, truthy};
use super::store;
use super::Ops;
use serde_json::{json, Map, Value};
use std::time::Duration;

/// os.cpus()[0].model: the first "model name" of /proc/cpuinfo, trimmed.
pub fn cpu_model() -> Option<String> {
    let text = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    text.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim() == "model name").map(|(_, v)| v.trim().to_string())).filter(|s| !s.is_empty())
}

fn cpu_count() -> usize {
    std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default().lines().filter(|l| l.split_once(':').is_some_and(|(k, _)| k.trim() == "processor")).count()
}

fn read_trim(p: &str) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn meminfo_kb(key: &str) -> Option<f64> {
    std::fs::read_to_string("/proc/meminfo").ok()?.lines().find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(':')).and_then(|r| r.trim().split_whitespace().next()?.parse::<f64>().ok()))
}

fn rss_bytes() -> Option<f64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    s.lines().find_map(|l| l.strip_prefix("VmRSS:")).and_then(|r| r.trim().split_whitespace().next()?.parse::<f64>().ok()).map(|k| k * 1024.0)
}

/// os.arch()
fn node_arch() -> &'static str {
    super::build::platform_arch().1
}

/// os.release()
fn kernel_release() -> Option<String> {
    read_trim("/proc/sys/kernel/osrelease")
}

fn hostname() -> String {
    read_trim("/proc/sys/kernel/hostname").unwrap_or_default()
}

/// fsSpace.js diskSpace: { total, free, used, type, unit }, or null.
fn disk_space_value(p: &std::path::Path) -> Value {
    use std::os::unix::ffi::OsStrExt;
    let Some(sp) = super::sys::disk_space(p) else { return Value::Null };
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap_or_default();
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    let ty = if unsafe { libc::statfs(c.as_ptr(), &mut s) } == 0 { json!(s.f_type as i64) } else { Value::Null };
    let unit = if sp.total > 0.0 { super::stats::filesystems::ShareFs::fragment_size(&super::stats::filesystems::RealFs, &p.to_string_lossy()).map_or(Value::Null, num) } else { Value::Null };
    json!({ "total": num(sp.total), "free": num(sp.free), "used": num(sp.used), "type": ty, "unit": unit })
}

/// storageTotals.js storageKey: what a vehicle's footage is stored on.
pub fn storage_key(v: &VehicleInfo) -> String {
    if v.source_type.as_deref() == Some("smb") {
        let share = v.share.clone().map(Value::String);
        return match crate::supervisor::spec::parse_share(share.as_ref()) {
            Ok(p) => format!("smb:{}/{}", p.host.to_lowercase(), p.share.to_lowercase()),
            Err(_) => format!("smb:{}", v.share.clone().unwrap_or_default().to_lowercase()),
        };
    }
    let root = v.roots.first().cloned().unwrap_or_default();
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(&root) {
        Ok(m) => format!("dev:{}", m.dev()),
        Err(_) => format!("path:{}", if root.is_empty() { v.id.clone() } else { root }),
    }
}

/// storageTotals.js: { freeBytes, totalBytes } summed once per storage; both null when none reports space.
pub fn storage_totals(list: &[VehicleInfo]) -> (Option<f64>, Option<f64>) {
    let mut seen = Vec::new();
    let (mut free, mut total): (Option<f64>, Option<f64>) = (None, None);
    for v in list {
        let st = v.status.clone().unwrap_or_default();
        let (Some(f), Some(t)) = (st.free_bytes.filter(|x| x.is_finite()), st.total_bytes.filter(|x| x.is_finite())) else { continue };
        let key = storage_key(v);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        free = Some(free.unwrap_or(0.0) + f);
        total = Some(total.unwrap_or(0.0) + t);
    }
    (free, total)
}

fn ffmpeg_first_line(ctx: &dyn OpsCtx) -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let r = super::gpu::run(&ctx.ffmpeg_path(), &["-hide_banner", "-version"], Duration::from_secs(10));
            super::power::js_slice(r.stdout.split('\n').next().unwrap_or(""), 200)
        })
        .clone()
}

fn setting(ctx: &dyn OpsCtx, key: &str) -> Value {
    store::get(&ctx.db(), key).unwrap_or(Value::Null)
}

fn opt_env(k: &str) -> Value {
    std::env::var(k).ok().filter(|s| !s.is_empty()).map_or(Value::Null, Value::String)
}

/// index.js reportDiagnostics(): what a support report or a crash report carries.
pub fn diagnostics(ops: &Ops) -> Value {
    let ctx = &*ops.ctx;
    let list = ctx.vehicles();
    let mut out = Map::new();
    let mut system = match ctx.system_summary(false) {
        Value::Object(o) => o,
        _ => Map::new(),
    };
    let os_name = super::stats::util::re!(r#"PRETTY_NAME="?([^"\n]*)"?"#).group(&std::fs::read_to_string("/etc/os-release").unwrap_or_default(), 1);
    let ff = ffmpeg_first_line(ctx);
    for (k, v) in [
        ("hostname", json!(hostname())),
        ("os", json!(os_name)),
        ("kernel", json!(kernel_release())),
        ("arch", json!(node_arch())),
        ("cpu", json!(cpu_model())),
        ("cores", json!(cpu_count())),
        ("memory", json!({ "total": meminfo_kb("MemTotal").map(|k| num(k * 1024.0)), "free": meminfo_kb("MemAvailable").map(|k| num(k * 1024.0)), "process": rss_bytes().map(num) })),
        ("container", json!({ "memoryMax": read_trim("/sys/fs/cgroup/memory.max"), "cpuMax": read_trim("/sys/fs/cgroup/cpu.max"), "pidsMax": read_trim("/sys/fs/cgroup/pids.max") })),
        ("ffmpeg", if ff.is_empty() { Value::Null } else { json!(ff) }),
        ("uptime", json!({ "app": num(super::stats::js_round((store::now_ms() - ops.started_at) as f64 / 1000.0)), "system": super::stats::procs::read_uptime(std::path::Path::new("/proc")).map(|u| num(super::stats::js_round(u))) })),
        ("build", json!(super::build::build_name(&ops.build_info))),
    ] {
        system.insert(k.into(), v);
    }
    out.insert("system".into(), Value::Object(system));
    out.insert(
        "storage".into(),
        json!({
            "data": disk_space_value(&ctx.data_dir()),
            "footage": list.iter().map(|v| {
                let st = v.status.clone().unwrap_or_default();
                json!({ "vehicle": v.id, "root": v.roots.first(), "healthy": v.status.as_ref().map(|_| st.healthy), "writable": st.writable, "free": st.free_bytes.map(num), "total": st.total_bytes.map(num), "footage": v.footage_bytes.map(num) })
            }).collect::<Vec<_>>()
        }),
    );
    let recent = ctx.recent_jobs(500);
    let mut by_status = Map::new();
    for j in &recent {
        let k = super::js::to_string(&j["status"]);
        let n = by_status.get(&k).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        by_status.insert(k, num(n));
    }
    let open = store::list(&ctx.db(), true, 1000, None).len();
    out.insert(
        "counts".into(),
        json!({
            "vehicles": list.len(), "recordings": num(list.iter().map(|v| v.recordings.unwrap_or(0.0)).sum()), "jobs": by_status,
            "binItems": num(list.iter().map(|v| v.bin_items.unwrap_or(0.0)).sum()), "notificationsOpen": open
        }),
    );
    let s = |v: &Value, n: usize| super::power::js_slice(&if v.is_null() { String::new() } else { super::js::to_string(v) }, n);
    out.insert(
        "jobs".into(),
        json!(ctx.recent_jobs(25).iter().map(|j| json!({ "type": j["type"], "status": j["status"], "title": s(&j["title"], 200), "detail": s(&j["detail"], 400), "startedAt": j["startedAt"], "finishedAt": j["finishedAt"] })).collect::<Vec<_>>()),
    );
    let conv = ctx.converter();
    out.insert("converter".into(), json!({ "ready": conv.ready, "running": conv.running, "capabilities": if conv.ready { conv.capabilities.clone() } else { Value::Null }, "error": conv.error, "settings": setting(ctx, "studio-settings") }));
    out.insert(
        "settings".into(),
        json!({
            "appearance": setting(ctx, "appearance"), "power": setting(ctx, "power"), "prefetch": setting(ctx, "prefetch"), "notifyMuted": setting(ctx, "notify-muted"),
            "imageUpdates": setting(ctx, "image-updates"), "canKeep": setting(ctx, "can-keep"), "access": ctx.access_settings(),
            "policies": list.iter().map(|v| (v.id.clone(), v.policy.clone())).collect::<Map<_, _>>(), "placesCount": ctx.places_count()
        }),
    );
    let can = setting(ctx, "can");
    let devs = ctx.sentry_usb_infos();
    out.insert(
        "features".into(),
        json!({
            "can": { "enabled": truthy(&can["enabled"]), "vehicles": setting(ctx, "can-vehicles").as_object().map_or(0, |o| o.len()) },
            "sentryUsb": { "found": !devs.is_empty(), "devices": devs.iter().map(|(v, w)| json!({ "version": v, "written": iso((w * 1000.0) as i64) })).collect::<Vec<_>>() },
            "uiPack": ctx.ui_pack(), "metrics": truthy(&setting(ctx, "metrics")["enabled"]), "nodes": setting(ctx, "nodes").as_array().map_or(0, |a| a.len()),
            "tls": { "mode": ctx.tls_mode(), "trustProxy": ctx.trust_proxy(), "hostnames": opt_env("TLS_HOSTNAMES"), "acme": opt_env("TLS_ACME_DOMAIN") }
        }),
    );
    out.insert("health".into(), ops.health.last().unwrap_or_else(|| ops.health.run(ctx, Some(&ops.snapshots), false)));
    let week = store::now_ms() - 7 * 86_400_000;
    out.insert(
        "logs".into(),
        json!(ctx.log_search(week, Level::Warn, 200).iter().map(|l| format!("{} {} [{}] {}", iso(l.at), l.level.name().to_uppercase(), l.scope, super::power::js_slice(&l.message, 2000))).collect::<Vec<_>>()),
    );
    out.insert("crashes".into(), json!(ops.reports.recent_crashes()));
    out.insert("can".into(), ctx.can_status());
    Value::Object(out)
}

/// index.js reportHeartbeat(): numbers and yes/no, nothing that names anything (normalised by reports).
pub fn heartbeat(ops: &Ops) -> Value {
    let ctx = &*ops.ctx;
    let list = ctx.vehicles();
    let (sentry, dashcam) = ctx.clips_arrived(store::now_ms() - 86_400_000);
    let models = ctx.car_models();
    let cars: Vec<Value> = (0..list.len()).map(|i| json!({ "model": models.get(i).cloned().flatten(), "firmware": null })).collect();
    let results = ops.health.last().unwrap_or_else(|| ops.health.run(ctx, Some(&ops.snapshots), false));
    let checks = results["checks"].as_array().cloned().unwrap_or_default();
    let (free, total) = storage_totals(&list);
    let sum = |f: &dyn Fn(&VehicleInfo) -> Option<f64>| list.iter().map(|v| f(v).filter(|x| x.is_finite()).unwrap_or(0.0)).sum::<f64>();
    let gpu = ctx.detect_gpus();
    let (platform, arch) = super::build::platform_arch();
    let (os, docker) = super::build::host_info();
    let saved = {
        let db = ctx.db();
        list.iter().map(|v| super::power::for_vehicle(&db, &v.id)["bytes"].as_f64().filter(|x| x.is_finite()).unwrap_or(0.0)).sum::<f64>()
    };
    let mut out = Map::new();
    out.insert("footageSeconds".into(), num(sum(&|v| v.footage_minutes) * 60.0));
    out.insert("platform".into(), json!(platform));
    out.insert("arch".into(), json!(arch));
    out.insert("host".into(), json!({ "os": os, "docker": docker }));
    if let Value::Object(hw) = ctx.heartbeat_hardware() {
        for (k, v) in hw {
            out.insert(k, v);
        }
    }
    out.insert("cars".into(), json!(cars));
    out.insert("clips24h".into(), json!({ "sentry": num(sentry), "dashcam": num(dashcam) }));
    out.insert("uptimeSec".into(), num(super::stats::js_round((store::now_ms() - ops.started_at) as f64 / 1000.0)));
    out.insert("health".into(), json!({ "warnings": checks.iter().filter(|c| c["status"] == "warn").count(), "problems": checks.iter().filter(|c| c["status"] == "bad").count() }));
    out.insert("vehicles".into(), json!(list.len()));
    out.insert("footageBytes".into(), num(sum(&|v| v.footage_bytes)));
    out.insert("recordings".into(), num(sum(&|v| v.recordings)));
    out.insert("spaceSavedBytes".into(), num(saved));
    out.insert("distanceKm".into(), num(ctx.driven_metres() / 1000.0));
    out.insert("freeBytes".into(), free.map_or(Value::Null, num));
    out.insert("totalBytes".into(), total.map_or(Value::Null, num));
    out.insert("converting".into(), json!(ctx.converter().running));
    out.insert("jobsQueued".into(), json!(ctx.jobs_queued()));
    let gpu_ok = gpu["gpus"].as_array().into_iter().flatten().any(|g| truthy(&g["passedThrough"]) && !truthy(&g["virtual"])) || gpu["nvidia"].as_array().is_some_and(|a| !a.is_empty());
    out.insert("features".into(), json!({ "can": truthy(&setting(ctx, "can")["enabled"]), "sentryUsbPaired": !ctx.sentry_usb_infos().is_empty(), "gpu": gpu_ok }));
    Value::Object(out)
}

/// tls.js parseHostnames, leniently: the names in TLS_HOSTNAMES (bad ones are left out here).
fn hostnames(v: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in super::stats::util::re!(r"[\s,]+").split(v) {
        let h = raw.trim().trim_start_matches('[').trim_end_matches(']').to_lowercase();
        if !h.is_empty() && !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// index.js reportIdentifiers(): what an anonymous report must not contain.
pub fn identifiers(ctx: &dyn OpsCtx) -> Vec<String> {
    let mut ids = vec![hostname(), ctx.data_dir().to_string_lossy().into_owned()];
    for v in ctx.vehicles() {
        ids.push(v.id.clone());
        ids.push(v.name.clone());
        ids.extend(v.roots.iter().cloned());
        ids.extend([v.share.clone(), v.username.clone(), v.domain.clone()].into_iter().flatten());
        if let Some(host) = v.share.as_deref().and_then(|s| super::stats::util::re!(r"^[\\/]{2}([^\\/]+)").group(s, 1)) {
            ids.push(host);
        }
    }
    for n in setting(ctx, "nodes").as_array().into_iter().flatten() {
        for k in ["name", "host"] {
            if let Some(s) = n[k].as_str() {
                ids.push(s.to_string());
            }
        }
    }
    ids.extend(ctx.identifiers());
    ids.extend(hostnames(&std::env::var("TLS_HOSTNAMES").unwrap_or_default()));
    for k in ["TLS_ACME_DOMAIN", "TLS_ACME_EMAIL"] {
        if let Ok(v) = std::env::var(k) {
            ids.push(v);
        }
    }
    ids.into_iter().filter(|s| s.encode_utf16().count() >= 3).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::ctx::ShareStatus;

    fn v(id: &str, kind: &str, share: Option<&str>, root: &str, free: f64) -> VehicleInfo {
        VehicleInfo {
            id: id.into(),
            source_type: Some(kind.into()),
            share: share.map(str::to_string),
            roots: vec![root.into()],
            status: Some(ShareStatus { free_bytes: Some(free), total_bytes: Some(free * 2.0), ..Default::default() }),
            ..Default::default()
        }
    }

    // storageTotals.js: each share or disk once, however many vehicles use it
    #[test]
    fn storage_counted_once() {
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        let list = vec![v("a", "smb", Some("//NAS/TeslaCam/car1"), "/x", 10.0), v("b", "smb", Some("//nas/teslacam/car2"), "/y", 10.0), v("c", "path", None, &tmp, 5.0), v("d", "path", None, &tmp, 5.0)];
        assert_eq!(storage_totals(&list), (Some(15.0), Some(30.0)));
        assert_eq!(storage_key(&list[0]), "smb:nas/teslacam");
        assert_eq!(storage_totals(&[]), (None, None));
    }

    #[test]
    fn identifiers_from_every_part() {
        let ctx = crate::ops::testing::FakeCtx::new();
        *ctx.vehicles.lock().unwrap() = vec![VehicleInfo { id: "v1".into(), name: "Daily Driver".into(), roots: vec!["/footage/tesla".into()], share: Some("//nas-box/TeslaCam".into()), username: Some("me".into()), ..Default::default() }];
        crate::ops::store::set(&ctx.db(), "nodes", &json!([{ "name": "garage-pc", "host": "10.0.0.7" }]));
        let ids = identifiers(&*ctx);
        for x in ["Daily Driver", "/footage/tesla", "//nas-box/TeslaCam", "nas-box", "garage-pc", "10.0.0.7"] {
            assert!(ids.contains(&x.to_string()), "{x}");
        }
        assert!(!ids.contains(&"me".to_string()), "shorter than 3: left out");
        assert_eq!(hostnames("A.example, [::1] b.example a.example"), vec!["a.example", "::1", "b.example"]);
    }
}

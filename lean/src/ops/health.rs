//! Health checks (server/health.js): what the app needs to work, each with
//! what to do when it does not. Settings → Health runs them on request; at
//! every start they run once by themselves a minute after the app is up,
//! and what fails becomes a notification and the amber bar on every page.
//!
//! A check: { detail, hint, id, group, label, status: ok | warn | bad | skip }
//! (that key order: health.js spreads the check over { detail: '', hint: '' }).

use super::ctx::{Level, OpsCtx};
use super::js::to_fixed;
use super::notes::Notes;
use super::snapshots::Snapshots;
use super::store::{now_ms, Note};
use super::sys;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

fn size(b: f64) -> String {
    if b >= GB {
        format!("{} GB", to_fixed(b / GB, 1))
    } else {
        format!("{} MB", (b / (1024.0 * 1024.0)).round() as i64)
    }
}

fn writable(dir: &Path) -> Option<String> {
    let probe = dir.join(format!(".health-{}-{}", std::process::id(), now_ms()));
    let r = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(&probe, "ok")?;
        std::fs::remove_file(&probe)
    })();
    r.err().map(|e| sys::errno_code(&e))
}

fn check(id: &str, group: &str, label: &str, status: &str, detail: &str, hint: &str) -> Value {
    json!({ "detail": detail, "hint": hint, "id": id, "group": group, "label": label, "status": status })
}

/// Every check, in the order health.js runs them.
pub fn checks(ctx: &dyn OpsCtx, snapshots: Option<&Snapshots>) -> Vec<Value> {
    let mut out = Vec::new();
    let data = ctx.data_dir();

    // ---- the data folder and what lives in it
    let data_err = writable(&data);
    out.push(check(
        "data-writable",
        "Data folder",
        "The data folder can be written",
        if data_err.is_some() { "bad" } else { "ok" },
        &data_err.as_ref().map(|e| format!("Writing failed: {e}")).unwrap_or_default(),
        if data_err.is_some() { "Check that the data volume is mounted and owned by the PUID/PGID the app runs as." } else { "" },
    ));
    let free = sys::disk_space(&data).map(|s| s.free);
    out.push(check(
        "data-space",
        "Data folder",
        "Free space for the data folder",
        match free {
            None => "skip",
            Some(f) if f < 0.5 * GB => "bad",
            Some(f) if f < 2.0 * GB => "warn",
            _ => "ok",
        },
        &free.map_or("Could not be read.".to_string(), |f| format!("{} free", size(f))),
        if free.is_some_and(|f| f < 2.0 * GB) { "Previews, thumbnails and conversions need room here; free some space on the disk the data folder is on." } else { "" },
    ));
    let mut cache_bad = false;
    for sub in ["scrub", "thumbnails", "speeds", "converter-temp"] {
        let err = if data_err.is_some() { None } else { writable(&data.join(sub)) };
        if let Some(err) = err {
            cache_bad = true;
            out.push(check(&format!("cache-{sub}"), "Data folder", &format!("data/{sub} can be written"), "bad", &err, "A folder made by another user (root) cannot be written: fix its owner to the PUID/PGID."));
        }
    }
    if !cache_bad {
        out.push(check("caches", "Data folder", "Cache folders can be written", if data_err.is_some() { "skip" } else { "ok" }, "", ""));
    }
    let quick: Result<String, String> = ctx.db().query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)).map_err(|e| e.to_string());
    match quick {
        Ok(v) => {
            let ok = v == "ok";
            out.push(check("database", "Data folder", "Database is intact", if ok { "ok" } else { "bad" }, if ok { "" } else { &v }, if ok { "" } else { "Restore yesterday's snapshot below." }));
        }
        Err(e) => out.push(check("database", "Data folder", "Database is intact", "bad", &e, "Restore a snapshot below.")),
    }
    if let Some(s) = snapshots {
        let list = s.list();
        let newest = list.first();
        let age = newest.and_then(|n| n["at"].as_f64()).map(|at| (now_ms() as f64 - at) / 86_400_000.0);
        out.push(check(
            "snapshots",
            "Data folder",
            "Daily database snapshot",
            if newest.is_none() || age.is_some_and(|a| a > 2.0) { "warn" } else { "ok" },
            &newest.map_or("None yet: the first is made a minute after the app starts.".to_string(), |n| format!("Newest: {}", n["day"].as_str().unwrap_or(""))),
            if newest.is_some() && age.is_some_and(|a| a > 2.0) { "Snapshots are not being made: check that the data folder can be written." } else { "" },
        ));
    }

    // ---- footage shares
    for v in ctx.vehicles() {
        let group = format!("Vehicle: {}", v.name);
        let Some(st) = &v.status else {
            out.push(check(&format!("share-{}", v.id), &group, "Footage share", "skip", "", ""));
            continue;
        };
        let err = st.last_error.clone().filter(|s| !s.is_empty());
        out.push(check(
            &format!("share-{}", v.id),
            &group,
            "Footage can be read",
            if st.healthy { "ok" } else { "bad" },
            &if st.healthy { String::new() } else { err.clone().unwrap_or_else(|| "The share cannot be read.".into()) },
            &if st.healthy { String::new() } else { st.hint.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "Check that the NAS or PC sharing the footage is on, and the share name, user and password in Vehicles.".into()) },
        ));
        if st.healthy {
            let status = match st.writable {
                Some(false) => "warn",
                Some(true) => "ok",
                None => "skip",
            };
            let detail = if st.read_only {
                "Mounted read-only: the footage is only read.".to_string()
            } else if st.writable == Some(false) {
                err.clone().unwrap_or_else(|| "Read-only.".into())
            } else {
                String::new()
            };
            let hint = if st.read_only {
                "Conversions, the Recycle Bin and restoring are off. Mount it read-write (no :ro) to use them."
            } else if st.writable == Some(false) {
                "Conversions, the Recycle Bin and restoring need write access: give the share user write permission."
            } else {
                ""
            };
            out.push(check(&format!("write-{}", v.id), &group, "Footage share can be written", status, &detail, hint));
            let ratio = match (st.total_bytes.filter(|t| *t != 0.0), st.free_bytes) {
                (Some(t), Some(f)) => Some(f / t),
                (Some(_), None) => Some(0.0),
                _ => None,
            };
            out.push(check(
                &format!("space-{}", v.id),
                &group,
                "Free space on the share",
                match ratio {
                    None => "skip",
                    Some(r) if r < 0.05 => "bad",
                    Some(r) if r < 0.1 => "warn",
                    _ => "ok",
                },
                &ratio.map_or(String::new(), |_| format!("{} free of {}", size(st.free_bytes.unwrap_or(0.0)), size(st.total_bytes.unwrap_or(0.0)))),
                if ratio.is_some_and(|r| r < 0.1) { "Empty the Recycle Bin, convert footage, or set a policy to move old footage out." } else { "" },
            ));
            if let Some(w) = st.warning.as_ref().filter(|s| !s.is_empty()) {
                out.push(check(&format!("warning-{}", v.id), &group, "Share set-up", "warn", w, ""));
            }
        }
    }

    // ---- video tools
    let ten = Duration::from_secs(10);
    let ff = sys::first_line(&ctx.ffmpeg_path(), &["-hide_banner", "-version"], ten);
    let ff_detail = match &ff {
        Ok(line) => line.find(" Copyright").map_or(line.clone(), |i| line[..i].to_string()),
        Err(e) => e.clone(),
    };
    out.push(check("ffmpeg", "Video", "ffmpeg runs", if ff.is_ok() { "ok" } else { "bad" }, &ff_detail, if ff.is_ok() { "" } else { "The image is damaged: pull it again (docker compose pull && docker compose up -d)." }));
    let fp = sys::first_line(&ctx.ffprobe_path(), &["-hide_banner", "-version"], ten);
    out.push(check("ffprobe", "Video", "ffprobe runs", if fp.is_ok() { "ok" } else { "bad" }, fp.as_ref().err().map_or("", |e| e.as_str()), if fp.is_ok() { "" } else { "The image is damaged: pull it again." }));
    let gpus = ctx.usable_gpus();
    let conv = ctx.converter();
    if !conv.ready {
        out.push(check("encoder", "Video", "Converter", "warn", "The converter has not started.", "See the logs below for why."));
    } else if conv.encoding_now {
        out.push(check("encoder", "Video", "GPU encoder", "skip", "Not tested while something converts (a busy GPU would fail the test).", ""));
    } else {
        let chosen = ctx.select_encoder();
        let hw = chosen.as_ref().is_some_and(|c| c.hardware);
        let detail = match &chosen {
            Some(c) => format!(
                "{} {}{}",
                if hw { "Converting with" } else { "Converting on the CPU with" },
                c.codec,
                if gpus > 0 && !hw { format!(" ({gpus} GPU{} visible)", if gpus == 1 { "" } else { "s" }) } else { String::new() }
            ),
            None => "No encoder passed its test.".into(),
        };
        let hint = if gpus > 0 && !hw {
            "The GPU is visible but its encoder failed a test encode: check the /dev/dri (AMD, Intel) or NVIDIA lines in docker-compose.yml and the host's GPU driver."
        } else if chosen.is_none() {
            "See the logs below."
        } else {
            ""
        };
        out.push(check("encoder", "Video", if gpus > 0 { "GPU encoder works" } else { "Encoder" }, if hw { "ok" } else if gpus > 0 { "warn" } else if chosen.is_some() { "ok" } else { "bad" }, &detail, hint));
    }

    // ---- access
    if let Some(t) = ctx.tls() {
        let status = if t.mode == "off" {
            if t.trust_proxy { "ok" } else { "warn" }
        } else if t.error.as_ref().is_some_and(|e| !e.is_empty()) {
            "bad"
        } else {
            "ok"
        };
        out.push(check("https", "Access", "HTTPS", status, t.detail.as_deref().unwrap_or(""), if t.mode == "off" && !t.trust_proxy { "Plain HTTP: only use it behind a reverse proxy that does HTTPS." } else { "" }));
    }
    out
}

/// One run at a time; the newest results are kept for the banner and GET /api/health.
pub struct Health {
    last: Mutex<Option<Value>>,
    running: Mutex<bool>,
    done: Condvar,
}

impl Default for Health {
    fn default() -> Self {
        Health { last: Mutex::new(None), running: Mutex::new(false), done: Condvar::new() }
    }
}

impl Health {
    pub fn last(&self) -> Option<Value> {
        self.last.lock().unwrap().clone()
    }

    /// Runs every check; a run already going is waited for and its result given.
    pub fn run(&self, ctx: &dyn OpsCtx, snapshots: Option<&Snapshots>, startup: bool) -> Value {
        {
            let mut r = self.running.lock().unwrap();
            if *r {
                while *r {
                    r = self.done.wait(r).unwrap();
                }
                return self.last().unwrap_or(Value::Null);
            }
            *r = true;
        }
        let list = checks(ctx, snapshots);
        let res = json!({ "at": now_ms(), "checks": list, "startup": startup });
        *self.last.lock().unwrap() = Some(res.clone());
        *self.running.lock().unwrap() = false;
        self.done.notify_all();
        res
    }

    /// GET /api/health/banner: what the last run found broken (a vehicle's check names its vehicle).
    pub fn banner(&self) -> Value {
        let problems: Vec<Value> = self
            .last()
            .map(|l| {
                l["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|c| c["status"] == "bad")
                    .map(|c| {
                        let group = c["group"].as_str().unwrap_or("");
                        let label = c["label"].as_str().unwrap_or("");
                        let named = match group.strip_prefix("Vehicle: ") {
                            Some(v) => format!("{v}: {label}"),
                            None => label.to_string(),
                        };
                        json!({ "label": named, "detail": c["detail"] })
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({ "problems": problems })
    }
}

/// The startup self-check (index.js, a minute after the start): what fails is a
/// critical notification, what passes clears its old one, and one log line.
pub fn startup_check(ctx: &dyn OpsCtx, health: &Health, notes: &Notes, snapshots: Option<&Snapshots>) {
    let res = health.run(ctx, snapshots, true);
    let checks = res["checks"].as_array().cloned().unwrap_or_default();
    let s = |c: &Value, k: &str| c[k].as_str().unwrap_or("").to_string();
    let mut bad = Vec::new();
    for c in &checks {
        if c["status"] == "bad" {
            let detail = s(c, "detail");
            let hint = s(c, "hint");
            notes.raise(
                &Note::new("health", "critical", format!("Startup check: {}{}", s(c, "label"), if detail.is_empty() { String::new() } else { format!(": {detail}") }))
                    .key(format!("health:{}", s(c, "id")))
                    .message(if hint.is_empty() { "Settings → Health has the details.".to_string() } else { hint }),
            );
            bad.push(c.clone());
        } else {
            notes.resolve(&format!("health:{}", s(c, "id")));
        }
    }
    if !bad.is_empty() {
        let text: Vec<String> = bad.iter().map(|c| format!("{}{}", s(c, "label"), if s(c, "detail").is_empty() { String::new() } else { format!(" ({})", s(c, "detail")) })).collect();
        ctx.log("health", Level::Error, &format!("Startup check: {}", text.join("; ")));
    } else {
        ctx.log("health", Level::Info, &format!("Startup check: all {} checks passed or were skipped", checks.len()));
    }
}

/// Starts the self-check a minute after the start.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::ctx::{ConverterInfo, Encoder, ShareStatus, VehicleInfo};
    use crate::ops::store;
    use crate::ops::testing::FakeCtx;

    fn ctx_with(gpus: usize, encoder: Option<Encoder>) -> Arc<FakeCtx> {
        let ctx = FakeCtx::new();
        *ctx.gpus.lock().unwrap() = gpus;
        *ctx.encoder.lock().unwrap() = encoder;
        *ctx.converter.lock().unwrap() = ConverterInfo { ready: true, ..Default::default() };
        ctx
    }

    fn encoder_check(gpus: usize, codec: &str, hw: bool) -> Value {
        let ctx = ctx_with(gpus, Some(Encoder { codec: codec.into(), hardware: hw }));
        checks(&*ctx, None).into_iter().find(|c| c["id"] == "encoder").unwrap()
    }

    // test/healthGpu.test.js
    #[test]
    fn a_passed_in_gpu_whose_encoder_works() {
        let c = encoder_check(1, "hevc_qsv", true);
        assert_eq!(c["label"], "GPU encoder works");
        assert_eq!(c["status"], "ok");
    }

    #[test]
    fn a_passed_in_gpu_whose_encoder_fails() {
        let c = encoder_check(1, "libx265", false);
        assert_eq!(c["status"], "warn");
        assert!(c["detail"].as_str().unwrap().contains("1 GPU visible"));
        assert!(c["hint"].as_str().unwrap().contains("encoder failed a test encode"));
        let none = encoder_check(0, "libx265", false);
        assert_eq!(none["status"], "ok");
        assert_eq!(none["label"], "Encoder");
    }

    #[test]
    fn checks_in_order_with_their_keys_and_the_banner() {
        let ctx = FakeCtx::new();
        *ctx.vehicles.lock().unwrap() = vec![
            VehicleInfo { id: "car".into(), name: "Car".into(), status: Some(ShareStatus { healthy: false, last_error: Some("Host is down".into()), ..Default::default() }), ..Default::default() },
            VehicleInfo { id: "two".into(), name: "Two".into(), status: Some(ShareStatus { healthy: true, writable: Some(true), free_bytes: Some(1.0 * GB), total_bytes: Some(100.0 * GB), ..Default::default() }), ..Default::default() },
        ];
        let h = Health::default();
        assert_eq!(h.banner(), json!({ "problems": [] }));
        let r = h.run(&*ctx, None, false);
        let ids: Vec<&str> = r["checks"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["data-writable", "data-space", "caches", "database", "share-car", "share-two", "write-two", "space-two", "ffmpeg", "ffprobe", "encoder"]);
        let first = r["checks"][0].as_object().unwrap();
        assert_eq!(first.keys().collect::<Vec<_>>(), ["detail", "hint", "id", "group", "label", "status"]);
        assert_eq!(r["checks"][7]["detail"], "1.0 GB free of 100.0 GB");
        assert_eq!(r["checks"][8]["detail"], "spawn /nonexistent/ffmpeg ENOENT");
        let banner = h.banner();
        let labels: Vec<&str> = banner["problems"].as_array().unwrap().iter().map(|p| p["label"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Car: Footage can be read", "Two: Free space on the share", "ffmpeg runs", "ffprobe runs"]);
        assert_eq!(banner["problems"][0]["detail"], "Host is down");
    }

    #[test]
    fn the_startup_check_raises_and_clears_notifications() {
        let ctx = FakeCtx::new();
        let notes = Notes::new(ctx.clone());
        let h = Health::default();
        startup_check(&*ctx, &h, &notes, None);
        let open = store::list(&ctx.db(), true, 200, None);
        let titles: Vec<&str> = open.iter().map(|n| n["title"].as_str().unwrap()).collect();
        assert!(titles.contains(&"Startup check: ffmpeg runs: spawn /nonexistent/ffmpeg ENOENT"), "{titles:?}");
        assert_eq!(open.iter().find(|n| n["dedupeKey"] == "health:ffmpeg").unwrap()["message"], "The image is damaged: pull it again (docker compose pull && docker compose up -d).");
        assert!(ctx.logs.lock().unwrap().iter().any(|(s, l, t)| s == "health" && *l == Level::Error && t.starts_with("Startup check: ffmpeg runs (spawn")));
        // a fixed ffmpeg clears it at the next start
        *ctx.ffmpeg.lock().unwrap() = "true".into();
        startup_check(&*ctx, &h, &notes, None);
        assert!(store::list(&ctx.db(), true, 200, None).iter().all(|n| n["dedupeKey"] != "health:ffmpeg"));
    }
}

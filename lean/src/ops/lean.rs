//! `OpsCtx` for the stand-alone lean server until core lands: the first
//! slice's `App` for the vehicles, and its own connection to
//! DATA_PATH/manager.db (the same file and schema as server/db.js; only the
//! settings and notifications tables are made here). Core replaces this with
//! its `AppState` when the areas are merged (lean/PORT_PLAN.md).

use super::ctx::*;
use crate::app::App;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub struct LeanCtx {
    app: Arc<App>,
    db: Mutex<Connection>,
    data: PathBuf,
}

impl LeanCtx {
    pub fn open(app: Arc<App>, data: &Path) -> rusqlite::Result<Arc<LeanCtx>> {
        let file = data.join("manager.db");
        // a snapshot chosen for restoring goes in place first (snapshots.js applyPendingRestore)
        if let Ok(true) = super::snapshots::apply_pending_restore(&file) {
            eprintln!("WARN  [server] {}", super::snapshots::restored_line(&file));
        }
        let db = Connection::open(&file)?;
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        super::store::ensure_schema(&db)?;
        Ok(Arc::new(LeanCtx { app, db: Mutex::new(db), data: data.to_path_buf() }))
    }
}

fn level_word(l: Level) -> &'static str {
    match l {
        Level::Debug => "DEBUG",
        Level::Info => "INFO ",
        Level::Warn => "WARN ",
        Level::Error => "ERROR",
    }
}

/// A folder's status as the Node server's local-folder share reports it.
fn folder_status(root: &Path) -> ShareStatus {
    use std::os::unix::ffi::OsStrExt;
    let healthy = std::fs::read_dir(root).is_ok();
    let space = super::sys::disk_space(root);
    let c = std::ffi::CString::new(root.as_os_str().as_bytes()).unwrap_or_default();
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    let read_only = unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0 && (s.f_flag & libc::ST_RDONLY) != 0;
    let writable = healthy.then(|| !read_only && unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0);
    let shown = root.to_string_lossy();
    ShareStatus {
        healthy,
        writable,
        read_only,
        free_bytes: space.map(|x| x.free),
        total_bytes: space.map(|x| x.total),
        last_error: (!healthy).then(|| format!("{} cannot be read", root.display())),
        // share.js: a local folder with nothing mounted at it is the container's own disk
        warning: (healthy && !mounted_at(&shown)).then(|| format!("Nothing is mounted at {shown}, so the manager is looking at the container's own disk. Set SMB_SHARE or add a volume for {shown}.")),
        ..Default::default()
    }
}

/// share.js findMount: whether /proc/self/mountinfo has a mount at exactly this point.
fn mounted_at(point: &str) -> bool {
    let unescape = |s: &str| -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
                out.push(u8::from_str_radix(&s[i + 1..i + 4], 8).unwrap_or(b'?'));
                i += 4;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    std::fs::read_to_string("/proc/self/mountinfo")
        .unwrap_or_default()
        .split('\n')
        .filter_map(|line| line.split_once(" - ").map(|(l, _)| l))
        .any(|left| left.split(' ').nth(4).is_some_and(|m| unescape(m) == point))
}

impl OpsCtx for LeanCtx {
    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap()
    }
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn app_root(&self) -> PathBuf {
        self.app.app_root.clone()
    }
    fn audit(&self, level: Level, line: &str) {
        eprintln!("{} [audit] {line}", level_word(level));
    }
    fn log(&self, scope: &str, level: Level, line: &str) {
        eprintln!("{} [{scope}] {line}", level_word(level));
    }
    fn announce(&self, _topic: &str) {
        // (the live-update hub is core's: /api/events is not in the lean server yet)
    }
    fn vehicles(&self) -> Vec<VehicleInfo> {
        self.app
            .vehicles
            .iter()
            .map(|v| {
                let st = self.app.state_of(&v.id);
                let totals = st.as_ref().filter(|s| s.scanned).map(|s| crate::inventory::totals(&s.recordings, s.files, s.scanned_at.unwrap_or(0.0)));
                VehicleInfo {
                    id: v.id.clone(),
                    name: v.name.clone(),
                    roots: vec![v.root.to_string_lossy().into_owned(), self.app.studio_root(v).to_string_lossy().into_owned()],
                    source_type: Some("path".into()),
                    status: Some(folder_status(&v.root)),
                    footage_bytes: totals.as_ref().and_then(|t| t["bytes"].as_f64()),
                    recordings: totals.as_ref().and_then(|t| t["recordings"].as_f64()),
                    bin_bytes: Some(0.0),
                    policy: Value::Null,
                    ..Default::default()
                }
            })
            .collect()
    }
    fn converter(&self) -> ConverterInfo {
        ConverterInfo { ready: false, error: Some("CONVERTER_STARTING".into()), ..Default::default() }
    }
    fn select_encoder(&self) -> Option<Encoder> {
        None
    }
    fn detect_gpus(&self) -> Value {
        json!({ "gpus": [], "nvidia": [], "hints": [] })
    }
    fn usable_gpus(&self) -> usize {
        0
    }
    fn tls(&self) -> Option<TlsInfo> {
        Some(TlsInfo { mode: self.tls_mode(), ..Default::default() })
    }
    fn ffmpeg_path(&self) -> String {
        std::env::var("FFMPEG_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ffmpeg".into())
    }
    fn ffprobe_path(&self) -> String {
        std::env::var("FFPROBE_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ffprobe".into())
    }
    fn ui_pack(&self) -> String {
        "original".into()
    }
    fn identifiers(&self) -> Vec<String> {
        let mut ids = vec![std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string(), self.data.to_string_lossy().into_owned()];
        for v in self.vehicles() {
            ids.push(v.id);
            ids.push(v.name);
            ids.extend(v.roots);
        }
        ids.into_iter().filter(|s| s.encode_utf16().count() >= 3).collect()
    }
    fn diagnostics(&self, _kind: &str) -> Value {
        json!({ "system": self.system_summary(false) })
    }
    fn heartbeat(&self) -> Value {
        let list = self.vehicles();
        let sum = |f: &dyn Fn(&VehicleInfo) -> Option<f64>| list.iter().map(|v| f(v).unwrap_or(0.0)).sum::<f64>();
        let (platform, arch) = super::build::platform_arch();
        let (os, docker) = super::build::host_info();
        json!({
            "platform": platform, "arch": arch, "host": { "os": os, "docker": docker },
            "vehicles": list.len(), "footageBytes": sum(&|v| v.footage_bytes), "recordings": sum(&|v| v.recordings),
            "converting": false, "jobsQueued": 0, "features": { "can": false, "sentryUsbPaired": false, "gpu": false }
        })
    }
    fn shutdown(&self, reason: &str) {
        eprintln!("INFO  [server] Stopping ({reason})");
        std::process::exit(0);
    }
    fn system_summary(&self, placeholders: bool) -> Value {
        let (platform, arch) = super::build::platform_arch();
        let build = super::build::read_build_info(&self.app.app_root);
        json!({
            "made": super::js::iso(super::store::now_ms()), "version": build, "node": null, "platform": format!("{platform} {arch}"),
            "supervised": false, "tlsMode": self.tls_mode(), "trustProxy": false, "timezone": std::env::var("TZ").ok(),
            "gpus": self.detect_gpus(), "converter": { "ready": false },
            "vehicles": self.vehicles().iter().enumerate().map(|(i, v)| {
                let st = v.status.clone().unwrap_or_default();
                json!({ "vehicle": if placeholders { format!("<vehicle-{}>", i + 1) } else { v.name.clone() }, "type": v.source_type, "healthy": st.healthy, "writable": st.writable, "freeBytes": st.free_bytes, "totalBytes": st.total_bytes, "recordings": v.recordings, "policy": v.policy })
            }).collect::<Vec<_>>(),
            "uiPack": self.ui_pack()
        })
    }
}

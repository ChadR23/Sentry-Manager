//! The converter on core: `ConverterCtx` on core's state (the data and temp
//! folders, the tools, the footage guard every folder goes through, log
//! lines), the runtime started with its recovery, the bridge behind
//! `POST /api/converter/invoke/:name` and `/api/converter/events`, and what
//! index.js does with every job snapshot: Activity's line for the job
//! (mirrorConverterJob), the space saved and the stats' job mark (ops).

use super::Server;
use crate::converter::ctx::ConverterCtx;
use crate::converter::ipc::Bridge;
use crate::converter::runtime::{Converter, RuntimeOptions};
use crate::core::db::{JobUpdate, NewJob, NewNotification};
use crate::core::http::{error_json, ApiRaw, Res};
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use axum::body::Body;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

/// index.js CONVERTER_ACTIVE and encoderStats.js RUNNING
pub const ACTIVE: [&str; 10] = ["discovering", "waiting", "staging", "encoding", "writing-telemetry", "verifying", "copying", "replacing", "paused", "paused_network"];
pub const RUNNING: [&str; 8] = ["discovering", "waiting", "staging", "encoding", "writing-telemetry", "verifying", "copying", "replacing"];
/// index.js MAX_EVENT_CLIENTS
const MAX_STREAMS: usize = 200;

pub struct Conv {
    host: crate::converter::host::Host,
    pub runtime: Arc<Converter>,
    pub bridge: Arc<Bridge>,
    /// convertStats.js: the heartbeat's conversion speed per device
    pub convert_stats: crate::converter::stats::ConvertStats,
    streams: Mutex<usize>,
    /// jobId -> the Activity line last written (mirrorConverterJob's mirroredLines)
    lines: Mutex<HashMap<i64, String>>,
    /// the jobs the converter knows: id -> state
    pub jobs: Mutex<HashMap<String, String>>,
    /// index.js converterJobs: each job's latest snapshot, slim (slimJob: its counts without its clips)
    snaps: Mutex<HashMap<String, Value>>,
    /// index.js converterListed: the jobs from before the start were listed
    listed: std::sync::atomic::AtomicBool,
}

pub struct CoreConverter {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
}

impl Conv {
    /// converterHost stop(): the lifecycle's beforeQuit
    pub fn stop(&self) {
        if let Some(p) = self.bridge.previews() { p.shutdown(); }
        self.host.stop();
    }
    /// a conversion runs now (encoderStats.js RUNNING)
    pub fn running(&self) -> bool {
        self.jobs.lock().unwrap().values().any(|st| RUNNING.contains(&st.as_str()))
    }
    /// index.js keepExternal for Clear jobs: the conversions still under way (CONVERTER_ACTIVE)
    pub fn active_external(&self) -> Vec<String> {
        self.jobs.lock().unwrap().iter().filter(|(_, st)| ACTIVE.contains(&st.as_str())).map(|(id, _)| format!("converter:{id}")).collect()
    }
    /// index.js busyPaths: the clips of active jobs in hand (`processing`), as absolute paths
    pub fn busy_paths(&self) -> Vec<String> {
        let ids: Vec<String> = self.jobs.lock().unwrap().iter().filter(|(_, st)| ACTIVE.contains(&st.as_str())).map(|(id, _)| id.clone()).collect();
        let mut out = Vec::new();
        for id in ids {
            let Ok(job) = self.runtime.service.get(&id) else { continue };
            let root = job["config"]["sourceRoot"].as_str().unwrap_or("").to_string();
            for it in job["items"].as_array().into_iter().flatten() {
                if it["state"] == "processing" {
                    if let Some(rel) = it["relativePath"].as_str() {
                        out.push(std::path::Path::new(&root).join(rel).to_string_lossy().into_owned());
                    }
                }
            }
        }
        out
    }
}

impl ConverterCtx for CoreConverter {
    fn data_path(&self) -> PathBuf {
        // (index.js dataDir: the job store, the converted index, automatic conversion)
        self.state.config.data.join("converter")
    }
    fn temp_path(&self) -> PathBuf {
        // index.js: path.join(DATA, 'converter-temp'), the container's own
        self.state.config.data.join("converter-temp")
    }
    fn ffmpeg_path(&self) -> String {
        self.state.config.ffmpeg.clone()
    }
    fn ffprobe_path(&self) -> String {
        self.state.config.ffprobe.clone()
    }
    fn resolve_path(&self, path: &str, must_exist: bool) -> Option<String> {
        // index.js allowed: createRealGuard(allowedRoots: the vehicles' folders (an SMB one only
        // inside FOOTAGE_ROOT) and the output folders, deny DATA, APP_ROOT, RUN_DIR and the system's)
        let s = self.srv.upgrade()?;
        let cfg = &self.state.config;
        let mut roots: Vec<PathBuf> = s
            .app()
            .vehicles
            .roots()
            .into_iter()
            .filter(|(root, within)| {
                let Ok(real) = std::fs::canonicalize(root) else { return false };
                within.iter().filter_map(|w| std::fs::canonicalize(w).ok()).any(|h| real.starts_with(&h))
            })
            .map(|(root, _)| root)
            .collect();
        roots.push(cfg.converted_dir());
        roots.extend(cfg.extra_roots.iter().map(PathBuf::from));
        let mut deny = vec![cfg.data.clone(), cfg.app_root.clone(), cfg.run_dir.clone()];
        deny.extend(["/proc", "/sys", "/dev", "/etc", "/root", "/run", "/boot"].map(PathBuf::from));
        let guard = crate::viewer::studio::Guard { roots, deny };
        guard.resolve_with(path, must_exist).map(|p| p.to_string_lossy().into_owned())
    }
    fn clip_converted(&self, output_path: &str) {
        // our in-place output is never hashed as an arrival (arrivalChecksums.converted); the
        // viewer's previews and filmstrips of that clip are made again when asked
        if let Some(a) = self.srv.upgrade().and_then(|s| s.arrival().cloned()) {
            a.clip_converted(output_path);
        }
        self.state.announce("inventory");
    }
    fn log_error(&self, line: &str) {
        self.state.logger.scope("converter").error(line);
    }
    fn log_info(&self, line: &str) {
        self.state.logger.scope("converter").info(line);
    }
}

/// The Recycle Bin, for an original a replace left beside its converted copy
/// (converter/leftovers.rs case c, footage/bin.rs adopt_original).
struct OriginalsBin {
    srv: std::sync::Weak<Server>,
}

impl crate::converter::leftovers::OriginalsBin for OriginalsBin {
    fn adopt_original(&self, backup: &std::path::Path, original: &std::path::Path, dev: u64, ino: u64) -> Result<String, String> {
        let s = self.srv.upgrade().ok_or("the server is stopping")?;
        crate::footage::bin::adopt_original(s.app(), backup, original, dev, ino)
    }
    fn holds(&self, original: &std::path::Path) -> bool {
        self.srv.upgrade().is_some_and(|s| crate::footage::bin::holds_original(s.app(), original))
    }
}

fn counts(s: &Value) -> (u64, u64, u64) {
    if let (Some(c), true) = (s.get("itemCounts").filter(|c| c.is_object()), s["items"].as_array().is_none_or(|a| a.is_empty())) {
        let n = |k: &str| c[k].as_u64().unwrap_or(0);
        return (n("converted"), n("skipped"), n("failed"));
    }
    let (mut ok, mut skipped, mut failed) = (0, 0, 0);
    for it in s["items"].as_array().into_iter().flatten() {
        if it["kind"] != "video" {
            continue;
        }
        match it["state"].as_str() {
            Some("completed") if it["eligibleVideo"] != json!(false) => ok += 1,
            Some("skipped") => skipped += 1,
            Some("failed") => failed += 1,
            _ => {}
        }
    }
    (ok, skipped, failed)
}

/// encoderStats.js jobProgress
pub fn job_progress(s: &Value) -> (f64, f64) {
    let saved = s["counters"]["savedBytes"].as_f64().unwrap_or(0.0);
    if let (Some(p), true) = (s["progressClips"].as_u64(), s["items"].as_array().is_none_or(|a| a.is_empty())) {
        return (p as f64, saved);
    }
    (counts(s).0 as f64, saved)
}

fn vehicle_of(srv: &Server, src: &str) -> Option<crate::footage::vehicles::Vehicle> {
    if src.is_empty() {
        return None;
    }
    srv.app().vehicles.vehicle_for_path(std::path::Path::new(src))
}

/// index.js slimJob: a job as kept, its counts without its clip list
fn slim(s: &Value) -> Value {
    let Some(m) = s.as_object() else { return s.clone() };
    let mut out = Value::Object(m.iter().map(|(k, v)| {
        (k.clone(), if k == "items" && v.is_array() { json!([]) } else { v.clone() })
    }).collect());
    if s["items"].as_array().is_some_and(|a| !a.is_empty()) {
        let (converted, skipped, failed) = counts(s);
        let (clips, _) = job_progress(s);
        out["items"] = json!([]);
        out["itemCounts"] = json!({ "converted": converted, "skipped": skipped, "failed": failed });
        out["progressClips"] = json!(clips);
    }
    out
}

/// What index.js does with each job snapshot: the savings and the stats' job mark (ops), and,
/// for a live snapshot (not a job listed at the start), its Activity line (mirrorConverterJob).
fn on_snapshot(srv: &Server, conv: &Conv, s: &Value, live: bool) {
    let Some(id) = s["id"].as_str() else { return };
    let st = s["state"].as_str().unwrap_or("");
    conv.jobs.lock().unwrap().insert(id.to_string(), st.to_string());
    let src = s["config"]["sourceRoot"].as_str().unwrap_or("");
    let v = vehicle_of(srv, src);
    if let Some(ops) = srv.ops() {
        let (clips, saved) = job_progress(s);
        ops.job_snapshot(&crate::ops::JobSnapshot { id: id.to_string(), running: RUNNING.contains(&st), vehicle_id: v.as_ref().map(|v| v.id.clone()), saved_bytes: saved, clips });
    }
    if live {
        mirror(srv, conv, s, id, st, src, v.as_ref());
        conv.snaps.lock().unwrap().insert(id.to_string(), slim(s));
    } else {
        conv.snaps.lock().unwrap().entry(id.to_string()).or_insert_with(|| slim(s));
    }
}

/// index.js settleConversionRows: once the converter has listed its jobs, a conversion's
/// Activity row still "running" for a job it no longer runs gets the job's real end, or
/// "interrupted" when the converter no longer has the job; rows of jobs under way stay.
pub fn settle(srv: &Server, conv: &Conv) -> usize {
    if !conv.listed.load(std::sync::atomic::Ordering::SeqCst) {
        return 0;
    }
    let state = &srv.state;
    let mut n = 0;
    let rows = match state.db.jobs(500, None) {
        Ok(r) => r,
        Err(e) => {
            // (settled on a later call)
            state.logger.scope("converter").warn(format!("Conversion rows were not settled: {e}"));
            return 0;
        }
    };
    for row in rows {
        let Some(ext) = row.external_id.as_deref().filter(|e| e.starts_with("converter:")) else { continue };
        if row.kind != "conversion" || row.status != "running" {
            continue;
        }
        let id = &ext["converter:".len()..];
        let snap = conv.snaps.lock().unwrap().get(id).cloned();
        match snap {
            Some(s) if ACTIVE.contains(&s["state"].as_str().unwrap_or("")) => continue,
            Some(s) => {
                let st = s["state"].as_str().unwrap_or("").to_string();
                let src = s["config"]["sourceRoot"].as_str().unwrap_or("").to_string();
                let v = vehicle_of(srv, &src);
                mirror(srv, conv, &s, id, &st, &src, v.as_ref());
            }
            None => {
                let detail = format!("{}the converter no longer has this job", row.detail.as_deref().filter(|d| !d.is_empty()).map(|d| format!("{d} · ")).unwrap_or_default());
                if let Err(e) = state.jobs.finish(row.id, Some("interrupted"), Some(detail), None) {
                    state.logger.scope("converter").warn(format!("The Activity row of conversion {id} was not settled: {e}"));
                    continue;
                }
            }
        }
        n += 1;
    }
    if n > 0 {
        state.log.info(format!("Jobs: {n} conversion row(s) the converter no longer runs were settled"));
    }
    n
}

/// index.js mirrorConverterJob: the job's line in Activity (jobs), its end, a notification for failed clips.
fn mirror(srv: &Server, conv: &Conv, s: &Value, id: &str, st: &str, src: &str, v: Option<&crate::footage::vehicles::Vehicle>) {
    let state = &srv.state;
    let external = format!("converter:{id}");
    let (ok, skipped, failed) = counts(s);
    let saved = s["counters"]["savedBytes"].as_f64().unwrap_or(0.0);
    let detail = format!("{ok} converted, {skipped} skipped, {failed} failed{}", if saved > 0.0 { format!(" · {} saved", crate::footage::bin::format_bytes(saved)) } else { String::new() });
    let terminal = !ACTIVE.contains(&st);
    // (the Activity row is kept on the next snapshot when the database fails now; never a second row)
    let failed_row = |what: &str, e: crate::core::db::DbError| state.logger.scope("converter").warn(format!("The Activity row of conversion {id} was not {what}: {e}"));
    let mut job = match state.db.job_by_external(&external) {
        Ok(j) => j,
        Err(e) => return failed_row("read", e),
    };
    if job.is_none() && terminal {
        match state.db.job_cleared(&external) {
            Ok(true) => return,
            Ok(false) => {}
            Err(e) => return failed_row("read", e),
        }
    }
    if job.is_none() {
        let codec = s["config"]["codec"].as_str().unwrap_or("");
        let label = match codec {
            "h265" => "H.265".to_string(),
            "av1" => "AV1".to_string(),
            c => c.to_uppercase(),
        };
        let part = s["config"]["part"].as_f64().filter(|p| *p > 1.0).map(|p| format!(" (part {p})")).unwrap_or_default();
        let title = format!("Convert {} to {label}{part}", v.map_or(src.to_string(), |v| v.name.clone()));
        if let Err(e) = state.jobs.start(NewJob { kind: "conversion".into(), vehicle_id: v.map(|v| v.id.clone()), title, detail: None, external_id: Some(external.clone()) }) {
            return failed_row("made", e);
        }
        job = match state.db.job_by_external(&external) {
            Ok(j) => j,
            Err(e) => return failed_row("read", e),
        };
    }
    let Some(job) = job else { return };
    if terminal && job.status == "running" {
        let status = if failed > 0 || st == "failed" { "failed" } else if st == "cancelled" { "cancelled" } else { "done" };
        let energy = srv.ops().map(|o| o.job_energy(id)).filter(|e| !e.is_null());
        if let Err(e) = state.jobs.finish(job.id, Some(status), Some(detail), energy.map(|e| json!({ "energy": e }))) {
            return failed_row("finished", e);
        }
        if failed > 0 {
            let raised = state.notes.raise(NewNotification {
                kind: "conversion".into(),
                level: Some("warning".into()),
                vehicle_id: v.map(|v| v.id.clone()),
                title: format!("{failed} clip(s) could not be converted"),
                message: Some("The originals were kept. Open the Encoder tab for details and Retry failed.".into()),
                dedupe_key: Some(format!("conversion-failed:{id}")),
            });
            if let Err(e) = raised {
                state.logger.scope("converter").warn(format!("The notification of conversion {id}'s failed clips was not kept: {e}"));
            }
        }
    } else if !terminal {
        let line = format!("{st}: {detail}");
        let mut lines = conv.lines.lock().unwrap();
        if lines.get(&job.id) != Some(&line) {
            lines.insert(job.id, line.clone());
            drop(lines);
            if let Err(e) = state.jobs.update(job.id, JobUpdate { detail: Some(line), ..Default::default() }) {
                // (written again with the next snapshot)
                conv.lines.lock().unwrap().remove(&job.id);
                failed_row("updated", e);
            }
        }
    }
    if terminal {
        conv.lines.lock().unwrap().remove(&job.id);
    }
}

/// The benchmark's power meter (index.js powerMeter: ops' account of the energy).
struct OpsMeter {
    srv: Weak<Server>,
    tokens: Mutex<(u64, HashMap<u64, crate::ops::MeterToken>)>,
}

impl crate::converter::benchmark::PowerMeter for OpsMeter {
    fn start(&self) -> Result<Value, String> {
        let ops = self.srv.upgrade().and_then(|s| s.ops().cloned()).ok_or("no stats")?;
        let t = ops.meter_start();
        let mut g = self.tokens.lock().unwrap();
        g.0 += 1;
        let id = g.0;
        g.1.insert(id, t);
        Ok(json!(id))
    }
    fn stop(&self, token: &Value) -> Result<Option<Value>, String> {
        let ops = self.srv.upgrade().and_then(|s| s.ops().cloned()).ok_or("no stats")?;
        let Some(t) = token.as_u64().and_then(|id| self.tokens.lock().unwrap().1.remove(&id)) else { return Ok(None) };
        Ok(ops.meter_stop(t).map(|(wh, avg_w)| json!({ "wh": wh, "avgW": avg_w })))
    }
}

/// The converter as converterHost.js starts it, on its own thread (open, then start with its
/// recovery, up to 5 attempts 2 s apart); until it is up, its routes answer as Node does while
/// the converter starts. Then the bridge (with devices, automatic conversion, the benchmark),
/// the snapshots to Activity and ops, the conversion speed samples, and the jobs listed.
pub fn spawn(srv: &Arc<Server>) {
    let s = srv.clone();
    std::thread::Builder::new()
        .name("converter-start".into())
        .spawn(move || {
            let st = s.state.clone();
            let ctx = Arc::new(CoreConverter { srv: Arc::downgrade(&s), state: st.clone() });
            let temp = ctx.temp_path();
            let _ = std::fs::create_dir_all(&temp);
            let temp = std::fs::canonicalize(&temp).unwrap_or(temp);
            // index.js: dataDir path.join(DATA, 'converter') (the job store, the converted
            // index, automatic conversion's state), tempDir path.join(DATA, 'converter-temp')
            let data = st.config.data.join("converter");
            let _ = std::fs::create_dir_all(&data);
            let data = std::fs::canonicalize(&data).unwrap_or(data);
            let meter: Arc<dyn crate::converter::benchmark::PowerMeter> = Arc::new(OpsMeter { srv: Arc::downgrade(&s), tokens: Mutex::new((0, HashMap::new())) });
            let open = || {
                let mut o = RuntimeOptions::new(data.clone(), temp.clone(), &st.config.ffmpeg, &st.config.ffprobe);
                // the Sentry USB checksum record of the original, before it is replaced in place
                o.before_replace_original = s.arrival().map(|a| a.before_replace_fn());
                // clips Sentry USB is still copying are held back (sentryUsb.holds)
                let w = Arc::downgrade(&s);
                o.hold_discovered = Some(Arc::new(move |_config: &Value, discovered: &Value| {
                    w.upgrade().is_some_and(|srv| super::arrival::holds(&srv, discovered["sourcePath"].as_str().unwrap_or("")))
                }));
                o.power_meter = Some(meter.clone());
                o.originals_bin = Some(Arc::new(OriginalsBin { srv: Arc::downgrade(&s) }));
                o.is_cheap_now = Some(cheap_now(st.db.clone(), st.logger.scope("converter")));
                o.nodes = s.nodes().map(|n| {
                    let remote: Arc<dyn crate::nodes::lanes::RemoteNodes> = Arc::new(n.nodes.clone());
                    Arc::new(crate::converter::service::lanes::FromNodes(remote)) as Arc<dyn crate::converter::service::lanes::NodeLanes>
                });
                Converter::open(o)
            };
            let host = crate::converter::host::Host::default();
            let runtime = match host.start(&open, &*ctx, 5, std::time::Duration::from_secs(2)) {
                Ok(r) => r,
                Err(e) => {
                    st.logger.scope("converter").error(format!("Converter did not start: {e}"));
                    return;
                }
            };
            let caps = crate::converter::ipc::capabilities(&runtime.staging.capabilities());
            let bridge = Bridge::new(Arc::new(runtime.service.clone()), ctx.clone(), caps);
            bridge.mount_runtime(&runtime);
            match super::converter_preview::mount(&s, &runtime, ctx, &bridge) {
                Ok(p) => bridge.mount_previews(p),
                Err(e) => st.logger.scope("converter").error(format!("Previews did not start: {e}")),
            }
            // (the conversion speed notes: best effort, each failure logged; a failed read is not written over)
            let (get_db, set_db) = (st.db.clone(), st.db.clone());
            let (get_log, set_log) = (st.logger.scope("converter"), st.logger.scope("converter"));
            let mut stats = crate::converter::stats::ConvertStats::new(
                Some(Arc::new(move |k: &str| {
                    get_db.get(k).map_err(|e| {
                        get_log.warn(format!("Conversion speed notes ({k}) could not be read: {e}"));
                        e.to_string()
                    })
                })),
                Some(Arc::new(move |k: &str, v: &Value| {
                    if let Err(e) = set_db.set(k, v) {
                        set_log.warn(format!("Conversion speed notes ({k}) were not kept: {e}"));
                    }
                })),
            );
            stats.cpu_name = Arc::new(crate::ops::diag::cpu_model);
            let conv = Arc::new(Conv {
                host,
                runtime,
                bridge,
                convert_stats: stats,
                streams: Mutex::new(0),
                lines: Mutex::new(HashMap::new()),
                jobs: Mutex::new(HashMap::new()),
                snaps: Mutex::new(HashMap::new()),
                listed: std::sync::atomic::AtomicBool::new(false),
            });
            let (w, c) = (Arc::downgrade(&s), Arc::downgrade(&conv));
            conv.runtime.service.subscribe(Arc::new(move |event: &Value| {
                let (Some(srv), Some(conv)) = (w.upgrade(), c.upgrade()) else { return };
                // the heartbeat's conversion speed and device (convertStats.js; at most a sample every 30 s)
                if event["type"] == "progress" {
                    let rt = conv.runtime.clone();
                    conv.convert_stats.sample(&|| rt.active_encodes());
                    return;
                }
                if event["type"] == "snapshot" && event["snapshot"].is_object() {
                    on_snapshot(&srv, &conv, &event["snapshot"], true);
                }
            }));
            let _ = s.converter.set(conv.clone());
            // jobs from before a restart (a paused one still owns its clips); only a list that
            // loaded settles rows (a failed one would end them all)
            if let Ok(list) = conv.runtime.service.list_summaries() {
                for job in list {
                    on_snapshot(&s, &conv, &job, false);
                }
                conv.listed.store(true, std::sync::atomic::Ordering::SeqCst);
                settle(&s, &conv);
            }
        })
        .ok();
}

/// POST /api/converter/invoke/:name
pub fn invoke(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    if c.method == "GET" || c.method == "HEAD" { return super::converter_preview::image(srv, c); }
    let Some(conv) = srv.converter() else { return Ok(Reply::json(json!({ "ok": false, "error": { "code": "CONVERTER_STARTING" } }))) };
    let name = c.params.get("name").cloned().unwrap_or_default();
    let client = c.headers.get("x-client-id").and_then(|v| v.to_str().ok()).map(String::from);
    Ok(Reply::json(conv.bridge.invoke(&name, c.body.take(), client.as_deref())))
}

struct Stream {
    conv: Arc<Conv>,
    client: String,
}

// A slow browser reconnects and fetches current state instead of retaining the job's
// history. Include the SSE/envelope overhead above the bridge's snapshot size limit.
const EVENT_QUEUE_FRAMES: usize = 4;
const MAX_EVENT_FRAME_BYTES: usize = crate::converter::ipc::MAX_SNAPSHOT_BYTES + 1024;

fn event_queue() -> (crate::converter::ipc::Sink, tokio::sync::mpsc::Receiver<String>) {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(EVENT_QUEUE_FRAMES);
    let _ = tx.try_send("event: hello\ndata: {}\n\n".into());
    let sender = Mutex::new(Some(tx));
    (Box::new(move |text: &str| {
        let mut sender = sender.lock().unwrap();
        if text.len() <= MAX_EVENT_FRAME_BYTES && sender.as_ref().is_some_and(|tx| tx.try_send(text.to_string()).is_ok()) {
            return true;
        }
        // Close even though the bridge's ping task may still hold this sink.
        sender.take();
        false
    }), rx)
}

#[cfg(test)]
mod event_queue_tests {
    use super::*;

    #[test]
    fn slow_progress_client_is_disconnected_instead_of_queuing_forever() {
        let (sink, mut rx) = event_queue();
        assert_eq!(rx.try_recv().unwrap(), "event: hello\ndata: {}\n\n");
        let mut refused = false;
        for _ in 0..64 {
            if !sink("event: converter:progress\ndata: {}\n\n") { refused = true; break; }
        }
        assert!(refused, "a stalled browser must not retain every update of a long job");
        while rx.try_recv().is_ok() {}
        assert_eq!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected));
        assert!(!sink("later"), "an overflowed connection stays closed");
        let (oversized, _large_rx) = event_queue();
        assert!(!oversized(&"x".repeat(1024 * 1024)), "one oversized frame cannot bypass the queue's byte bound");
        let (fast, mut rx) = event_queue();
        rx.try_recv().unwrap();
        for _ in 0..1000 {
            assert!(fast("progress"));
            assert_eq!(rx.try_recv().unwrap(), "progress");
        }
        drop(rx);
        assert!(!fast("closed"));
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.conv.bridge.detach(&self.client);
        *self.conv.streams.lock().unwrap() -= 1;
    }
}

/// GET /api/converter/events?client=<id>: the live updates (Server-Sent Events).
pub async fn events(srv: Arc<Server>, a: ApiRaw) -> Res {
    let accept = a.ctx.accept_encoding().to_string();
    let Some(conv) = srv.converter().cloned() else { return error_json(503, "Converter is starting", None, &accept) };
    {
        let mut n = conv.streams.lock().unwrap();
        if *n >= MAX_STREAMS {
            return error_json(503, "Too many open connections.", None, &accept);
        }
        *n += 1;
    }
    let client: String = a.ctx.query.get("client").map(|c| c.encode_utf16().take(64).collect::<Vec<u16>>()).map(|u| String::from_utf16_lossy(&u)).unwrap_or_default();
    let (sink, rx) = event_queue();
    conv.bridge.attach_events(&client, sink);
    let guard = Stream { conv, client };
    // (the stream ends when the page goes: the receiver is dropped, the bridge forgets the client)
    let body = futures_util::stream::unfold((rx, guard), |(mut rx, guard)| async move {
        let text = rx.recv().await?;
        Some((Ok::<_, std::convert::Infallible>(bytes::Bytes::from(text)), (rx, guard)))
    });
    axum::http::Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(body))
        .unwrap()
}

/// Off-peak only: whether power is cheapest now. Rates that cannot be read are not "cheap now", so
/// automatic conversion waits; said once until they can be read (the scheduler asks every 30 s).
fn cheap_now(db: Arc<crate::core::db::Db>, log: crate::core::log::Scope) -> Arc<dyn Fn(i64) -> Option<bool> + Send + Sync> {
    let unread = crate::core::db::LogOnce::default();
    Arc::new(move |ms: i64| {
        let p = db.get("power");
        if let (true, Err(e)) = (unread.first("power", p.is_err()), &p) {
            log.warn(format!("Automatic conversion waits: the power rates could not be read: {e}"));
        }
        match p {
            Ok(p) => crate::ops::power::is_cheapest(&p.unwrap_or(Value::Null), ms),
            Err(_) => Some(false),
        }
    })
}

#[cfg(test)]
mod cheap_now_tests {
    use super::*;

    #[test]
    fn rates_that_cannot_be_read_are_not_cheap_and_are_said_once_until_they_can() {
        let db = Arc::new(crate::core::db::Db::memory().unwrap());
        let logger = crate::core::log::Logger::with("info", 100, true, None, 1);
        let cheap = cheap_now(db.clone(), logger.scope("converter"));
        let said = || logger.recent(100.0, "warn").iter().filter(|e| e.message.starts_with("Automatic conversion waits")).count();
        db.conn().execute_batch("CREATE TABLE gone (x); ALTER TABLE settings RENAME TO settings_kept; CREATE VIEW settings AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        assert_eq!((cheap(0), cheap(30_000)), (Some(false), Some(false)), "it waits");
        assert_eq!(said(), 1, "once, not every tick");
        db.conn().execute_batch("DROP VIEW settings; ALTER TABLE settings_kept RENAME TO settings;").unwrap();
        cheap(60_000);
        db.conn().execute_batch("CREATE TABLE gone (x); ALTER TABLE settings RENAME TO settings_kept; CREATE VIEW settings AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        cheap(90_000);
        assert_eq!(said(), 2, "again after it could be read");
    }
}

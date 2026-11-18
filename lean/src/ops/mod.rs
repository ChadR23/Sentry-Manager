//! The ops area (lean/PORT_PLAN.md): notifications and their rules, health
//! checks with the startup self-check and the banner, database snapshots,
//! power price and savings, image updates, metrics, the opt-in feedback and
//! diagnostics reports, system info, the server monitor (stats with history,
//! CSV, GPUs, power and energy, data used, disks, shares, sensors, processes,
//! alerts, node power) and the support bundle.
//!
//! Handlers are plain functions over `ctx::OpsCtx`; `routes` maps a request
//! to them and answers with a `Reply`, which `api.rs` turns into HTTP. The
//! hooks other areas call are methods on `Ops` (see "hooks" below).

pub mod build;
pub mod ctx;
pub mod diag;
pub mod gpu;
pub mod health;
pub mod js;

pub mod net;
pub mod node_power;
pub mod notes;
pub mod power;
pub mod reports;
pub mod snapshots;
pub mod stats;
pub mod store;
pub mod sys;
pub mod updates;

/// A fake of the rest of the server, for the ops tests (unit and tests/).
#[doc(hidden)]
pub mod testing;
pub mod routes;
pub mod zip;

#[cfg(test)]
mod hooks_tests;

pub use routes::{access, Access, Reply, Request};

use ctx::{Level, OpsCtx};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

/// JSON.stringify(value, null, 2)
pub fn js_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// A conversion job as the converter's snapshots show it (index.js
/// runtime.service.subscribe 'snapshot' events), as far as ops needs it.
#[derive(Clone, Debug, Default)]
pub struct JobSnapshot {
    pub id: String,
    /// encoderStats.js RUNNING has its state (the job converts now)
    pub running: bool,
    /// the vehicle its source root belongs to (vehicleForReal / vehicleForPath)
    pub vehicle_id: Option<String>,
    /// counters.savedBytes
    pub saved_bytes: f64,
    /// jobProgress(s).clips
    pub clips: f64,
}

/// The benchmark's energy token (index.js powerMeter.start).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeterToken {
    wh: f64,
    seconds: f64,
    at: i64,
    id: u64,
}

#[derive(Default)]
struct Converting {
    /// the job whose energy is counted (statsJob)
    job: Option<String>,
    /// the benchmark's token while it measures
    benchmarking: Option<MeterToken>,
    next: u64,
}

/// The ops area's state: one per server.
pub struct Ops {
    pub ctx: Arc<dyn OpsCtx>,
    pub notes: Arc<notes::Notes>,
    pub health: Arc<health::Health>,
    pub snapshots: Arc<snapshots::Snapshots>,
    pub updates: Arc<updates::ImageUpdates>,
    pub reports: Arc<reports::Reports>,
    pub stats: Arc<stats::Stats>,
    pub build_info: Value,
    pub started_at: i64,
    /// when a page last asked for /api/stats (the RAPL keep-alive)
    stats_asked_at: Mutex<i64>,
    converting: Arc<Mutex<Converting>>,
}

/// The stats engine as index.js sets it up: the data folder and the shares,
/// the running ffmpegs, prices, job progress, alerts as notifications.
fn server_stats(ctx: &Arc<dyn OpsCtx>, notes: &Arc<notes::Notes>, converting: &Arc<Mutex<Converting>>, version: Value) -> Arc<stats::Stats> {
    let mut o = stats::StatsOptions::server(Some(ctx.data_dir()), version);
    let c = ctx.clone();
    let conv = converting.clone();
    o.is_busy = Arc::new(move || c.stats_busy() || conv.lock().unwrap().benchmarking.is_some());
    let c = ctx.clone();
    o.read_shares = Arc::new(move || stats::shares_of(&c.data_dir(), &c.vehicles()));
    let c = ctx.clone();
    o.active_encodes = Arc::new(move || c.active_encodes());
    o.ffmpeg_path = ctx.ffmpeg_path();
    let c = ctx.clone();
    o.price_at = Arc::new(move |ms| power::price_at(&store::get(&c.read_db(), "power").unwrap_or(Value::Null), ms));
    let c = ctx.clone();
    o.job_progress = Arc::new(move |id| c.job_progress(id));
    let c = ctx.clone();
    o.log = Arc::new(move |level, m| c.log("stats", if level == "info" { Level::Info } else if level == "error" { Level::Error } else { Level::Warn }, m));
    let (c, n) = (ctx.clone(), notes.clone());
    o.on_alert = Some(Box::new(move |key, level, message| {
        c.log("stats", if level == "error" { Level::Error } else { Level::Warn }, message);
        n.raise(&store::Note::new("server", if level == "error" { "critical" } else { "warning" }, message).key(format!("server:{key}")).message("Overview > Server shows the live numbers."));
    }));
    let (c, n) = (ctx.clone(), notes.clone());
    o.on_alert_clear = Some(Box::new(move |key| {
        c.log("stats", Level::Info, &format!("Back to normal: {key}"));
        n.resolve(&format!("server:{key}"));
    }));
    // CPU power right away when sampling starts (the keep-alive follows)
    let c = ctx.clone();
    o.on_sampling = Some(Arc::new(move |on| {
        if on && c.supervised() {
            c.request_rapl();
        }
    }));
    stats::Stats::new(o)
}

impl Ops {
    /// `transport`: the registry and the report receiver (net::Https in the
    /// server, a fake in tests). `env`: REPORTS, REPORTS_URL,
    /// REPORTS_PUBLIC_KEY, NODE_ENV and UPDATE_CHECK as the process has them.
    pub fn new(ctx: Arc<dyn OpsCtx>, transport: Arc<dyn net::Transport>, env: HashMap<String, String>) -> Arc<Ops> {
        Ops::with_stats(ctx, transport, env, None)
    }

    /// As `new`, with a stats engine of the caller's (tests: a fake machine).
    pub fn with_stats(ctx: Arc<dyn OpsCtx>, transport: Arc<dyn net::Transport>, env: HashMap<String, String>, stats: Option<Arc<stats::Stats>>) -> Arc<Ops> {
        let build_info = build::read_build_info(&ctx.app_root());
        let notes = notes::Notes::new(ctx.clone());
        let update_off = env.get("UPDATE_CHECK").is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "off" | "false" | "0" | "no"));
        let own = updates::own_critical_level(&ctx.app_root());
        let updates = Arc::new(updates::ImageUpdates::new(ctx.clone(), Some(notes.clone()), transport.clone(), &build_info, !update_off, own));
        updates.announce();
        let reports = reports::Reports::new(ctx.clone(), env, build_info.clone(), transport, None);
        // (the server line's version: stats/host.js appVersion)
        let version = build::app_version(&ctx.app_root()).map_or(Value::Null, Value::String);
        // Server alerts from before a restart: the new run raises them again if they still hold
        store::resolve_prefix(&ctx.db(), "server:");
        let converting = Arc::new(Mutex::new(Converting::default()));
        let stats = stats.unwrap_or_else(|| server_stats(&ctx, &notes, &converting, version));
        let ops = Arc::new(Ops {
            snapshots: Arc::new(snapshots::Snapshots::new(&ctx.data_dir())),
            stats,
            health: Arc::new(health::Health::default()),
            notes,
            updates,
            reports,
            build_info,
            started_at: store::now_ms(),
            stats_asked_at: Mutex::new(0),
            converting,
            ctx,
        });
        let weak = Arc::downgrade(&ops);
        let (w1, w2, w3) = (weak.clone(), weak.clone(), weak);
        ops.reports.set_sources(reports::Sources {
            diagnostics: Box::new(move |_| w1.upgrade().map_or(json!({}), |o| diag::diagnostics(&o))),
            heartbeat: Box::new(move || w2.upgrade().map_or(json!({}), |o| diag::heartbeat(&o))),
            identifiers: Box::new(move || w3.upgrade().map_or_else(Vec::new, |o| diag::identifiers(&*o.ctx))),
        });
        // savings by month: what was counted before months were kept goes to
        // the month its conversion finished (the job history)
        {
            let db = ops.ctx.db();
            power::backfill(&db, |job| month_of_job(&db, job));
        }
        ops
    }

    /// The environment names ops reads, from the process.
    pub fn process_env() -> HashMap<String, String> {
        let mut env = reports::Reports::process_env();
        if let Ok(v) = std::env::var("UPDATE_CHECK") {
            env.insert("UPDATE_CHECK".into(), v);
        }
        env
    }

    /// The background work: the startup self-check a minute after the start,
    /// the daily database snapshot (a minute after the start, then checked
    /// hourly), the image check (soon after the start, then every 12 hours),
    /// the once-a-minute housekeeping (the update check, the stats' daily
    /// network reading), the RAPL keep-alive and the opt-in reports' timers.
    pub fn start(self: &Arc<Self>) {
        // One thread for both minute-after-start jobs, in Node's order: its
        // snapshot timer is set before the startup check's, both for 60 s, so
        // the first snapshot is always there when the check looks for it.
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            let mut first = true;
            loop {
                let day = snapshots::utc_day(store::now_ms());
                let r = me.snapshots.take(&me.ctx.db(), &day, false);
                match r {
                    Ok(Some(name)) => me.ctx.log("snapshots", Level::Info, &format!("Database snapshot {name} saved")),
                    Ok(None) => {}
                    Err(e) => me.ctx.log("snapshots", Level::Warn, &format!("Database snapshot failed: {e}")),
                }
                if first {
                    first = false;
                    health::startup_check(&*me.ctx, &me.health, &me.notes, Some(&me.snapshots));
                }
                std::thread::sleep(Duration::from_secs(3600));
            }
        });
        let me: Weak<Ops> = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            // (index.js ticks these with its housekeeping, once a minute)
            std::thread::sleep(Duration::from_secs(60));
            let Some(me) = me.upgrade() else { return };
            me.updates.tick();
            // data used: the network counters once a day, with no page open too
            me.stats.tick();
        });
        // CPU power: the root supervisor reads the energy counters while asked
        let me: Weak<Ops> = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(10));
            let Some(me) = me.upgrade() else { return };
            me.rapl_keepalive();
        });
        self.reports.start();
    }

    /// The keep-alive's step: ask for RAPL while sampling or a page asked lately.
    pub fn rapl_keepalive(&self) {
        let asked = *self.stats_asked_at.lock().unwrap();
        if self.ctx.supervised() && (self.stats.sampling() || store::now_ms() - asked < 20_000) {
            self.ctx.request_rapl();
        }
    }

    /// At shutdown.
    pub fn stop(&self) {
        self.reports.stop();
        self.stats.stop();
    }

    // ---- hooks other areas call

    /// The supervisor's `rapl-reading` message (core's link).
    pub fn rapl_reading(&self, message: &Value) {
        self.stats.set_rapl(message);
    }

    /// A server error answered with 500 (index.js: `reports.noteCrash(err, 'error')`), core's error path.
    pub fn note_server_error(&self, name: &str, message: &str, stack: &str) {
        self.reports.note_crash(name, message, stack, "error");
    }

    /// A crash the process is about to end with (uncaughtExceptionMonitor; a panic hook in Rust).
    pub fn note_crash(&self, name: &str, message: &str, stack: &str) {
        self.reports.note_crash(name, message, stack, "crash");
    }

    /// A node's power reading (nodes.js onPower): its share of a running job's energy.
    pub fn node_power(&self, node: &str, at: i64, w: Option<f64>, encoding: bool) {
        self.stats.node_power(node, at, w, encoding);
    }

    /// A converter job snapshot (index.js runtime.service.subscribe): the
    /// job's energy is counted while it runs (unless a benchmark measures),
    /// and its saved space goes onto its vehicle's total (savings.record).
    /// Also for the jobs listed at the start (savings of jobs from before).
    pub fn job_snapshot(&self, s: &JobSnapshot) {
        {
            let mut c = self.converting.lock().unwrap();
            if s.running {
                if c.job.as_deref() != Some(s.id.as_str()) {
                    c.job = Some(s.id.clone());
                    if c.benchmarking.is_none() {
                        self.stats.mark_job(Some(&s.id));
                    }
                }
            } else if c.job.as_deref() == Some(s.id.as_str()) {
                c.job = None;
                if c.benchmarking.is_none() {
                    self.stats.mark_job(None);
                }
            }
        }
        self.record_savings(s);
    }

    /// recordSavings: a converter job's saved space, onto its vehicle's total.
    pub fn record_savings(&self, s: &JobSnapshot) {
        let Some(v) = &s.vehicle_id else { return };
        let bytes = if s.saved_bytes.is_finite() { s.saved_bytes } else { 0.0 };
        power::record(&self.ctx.db(), &s.id, v, bytes, s.clips);
    }

    /// The energy measured for a job (stats.energy().byJob[id]) as Jobs keeps it
    /// with a finished conversion: { wh, avgW, seconds, cost, nodeWh? }.
    pub fn job_energy(&self, job: &str) -> Value {
        let m = self.stats.energy()["byJob"][job].clone();
        if !m.is_object() {
            return Value::Null;
        }
        let mut e = json!({ "wh": m["wh"], "avgW": m["avgW"], "seconds": m["seconds"], "cost": m["cost"] });
        if js::truthy(&m["nodeWh"]) {
            e["nodeWh"] = m["nodeWh"].clone();
        }
        e
    }

    /// The benchmark's power meter starts a level (index.js powerMeter.start).
    pub fn meter_start(&self) -> MeterToken {
        let before = self.stats.energy()["byJob"]["benchmark"].clone();
        let mut c = self.converting.lock().unwrap();
        c.next += 1;
        let t = MeterToken { wh: before["wh"].as_f64().unwrap_or(0.0), seconds: before["seconds"].as_f64().unwrap_or(0.0), at: store::now_ms(), id: c.next };
        c.benchmarking = Some(t);
        drop(c);
        self.stats.mark_job(Some("benchmark"));
        t
    }

    /// The level ends: its energy ({ wh, avgW }) or None when nothing was measured.
    pub fn meter_stop(&self, token: MeterToken) -> Option<(f64, f64)> {
        {
            let mut c = self.converting.lock().unwrap();
            if c.benchmarking == Some(token) {
                // a conversion's own count carries on
                let job = c.job.clone();
                c.benchmarking = None;
                drop(c);
                self.stats.mark_job(job.as_deref());
            }
        }
        let after = self.stats.energy()["byJob"]["benchmark"].clone();
        let wh = after["wh"].as_f64().map_or(0.0, |w| w - token.wh);
        let seconds = after["seconds"].as_f64().map_or(0.0, |s| s - token.seconds);
        if !(wh > 0.0 && seconds > 0.0) {
            return None;
        }
        let avg = wh * 3600.0 / seconds;
        let elapsed = (store::now_ms() - token.at) as f64 / 1000.0;
        Some((if elapsed > 0.0 { avg * elapsed / 3600.0 } else { wh }, avg))
    }

    /// nodeWorker's power(): this server's power for a main's "All servers" total. The main
    /// asks about every 30 s: sampling holds 45 s, and the RAPL keep-alive counts it as a page
    /// asking for the stats (statsAskedAt).
    pub fn power_for_main(&self) -> Value {
        *self.stats_asked_at.lock().unwrap() = store::now_ms();
        self.stats.touch(Some(45_000));
        node_power::power_report(&self.stats.snapshot(), store::now_ms())
    }

    /// GET /api/stats (index.js): the snapshot, every node's power with this
    /// server's ("All servers"), the price now and the encoder block.
    pub fn stats_answer(&self) -> Value {
        *self.stats_asked_at.lock().unwrap() = store::now_ms();
        self.stats.touch(None);
        let mut snap = self.stats.snapshot();
        let ctx = &*self.ctx;
        let pw = store::get(&ctx.read_db(), "power").unwrap_or(Value::Null);
        let t = store::now_ms();
        let price_now = power::price_at(&pw, t);
        let (rows, combined) = node_power::combine(&snap["power"], &ctx.node_powers(), price_now);
        if combined.is_object() {
            let mut combined = combined;
            combined["peakW"] = self.stats.peak("all", combined["totalW"].as_f64()).map_or(Value::Null, js::num);
            let rows: Vec<Value> = rows
                .into_iter()
                .map(|mut r| {
                    let id = js::to_string(&r["id"]);
                    r["peakW"] = self.stats.peak(&format!("node:{id}"), r["totalW"].as_f64()).map_or(Value::Null, js::num);
                    r
                })
                .collect();
            snap["power"]["nodes"] = json!(rows);
            snap["power"]["combined"] = combined;
        }
        snap["price"] = match price_now {
            None => Value::Null,
            Some(now) => json!({ "currency": pw["currency"], "mode": pw["mode"], "now": js::num(now), "rate": power::rate_name_at(&pw, t) }),
        };
        let energy = self.stats.energy();
        snap["encoder"] = ctx.encoder_block(&snap, &energy);
        snap
    }
}

/// The month ('YYYY-MM', local time) a converter job finished in, from the
/// job history (db.jobByExternal(`converter:<id>`)); None without one.
pub fn month_of_job(db: &rusqlite::Connection, job: &str) -> Option<String> {
    let row: Option<(Option<i64>, Option<i64>)> = db
        .query_row("SELECT finished_at, started_at FROM jobs WHERE external_id = ?", [format!("converter:{job}")], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let (f, s) = row?;
    let t = f.filter(|x| *x != 0).or(s.filter(|x| *x != 0))?;
    use chrono::Datelike;
    let d = stats::energy::local_date(t);
    Some(format!("{:04}-{:02}", d.year(), d.month()))
}

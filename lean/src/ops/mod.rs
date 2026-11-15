//! The ops area (lean/PORT_PLAN.md): notifications and their rules, health
//! checks with the startup self-check and the banner, database snapshots,
//! power price and savings, image updates, metrics, the opt-in feedback and
//! diagnostics reports, system info, stats with history and CSV, and the
//! support bundle.
//!
//! Handlers are plain functions over `ctx::OpsCtx`; `routes` maps a request
//! to them and answers with a `Reply`, which `api.rs` turns into HTTP.

pub mod build;
pub mod ctx;
pub mod health;
pub mod js;
pub mod lean;
pub mod net;
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

pub use routes::{access, Access, Reply, Request};

use ctx::{Level, OpsCtx};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// JSON.stringify(value, null, 2)
pub fn js_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
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
}

impl Ops {
    /// `transport`: the registry and the report receiver (net::Https in the
    /// server, a fake in tests). `env`: REPORTS, REPORTS_URL,
    /// REPORTS_PUBLIC_KEY, NODE_ENV and UPDATE_CHECK as the process has them.
    pub fn new(ctx: Arc<dyn OpsCtx>, transport: Arc<dyn net::Transport>, env: HashMap<String, String>) -> Arc<Ops> {
        let build_info = build::read_build_info(&ctx.app_root());
        let notes = notes::Notes::new(ctx.clone());
        let update_off = env.get("UPDATE_CHECK").is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "off" | "false" | "0" | "no"));
        let own = updates::own_critical_level(&ctx.app_root());
        let updates = Arc::new(updates::ImageUpdates::new(ctx.clone(), Some(notes.clone()), transport.clone(), &build_info, !update_off, own));
        updates.announce();
        let reports = reports::Reports::new(ctx.clone(), env, build_info.clone(), transport, None);
        let version = build::build_name(&build_info).map_or(Value::Null, Value::String);
        Arc::new(Ops {
            snapshots: Arc::new(snapshots::Snapshots::new(&ctx.data_dir())),
            stats: stats::Stats::new(Some(ctx.data_dir()), version),
            health: Arc::new(health::Health::default()),
            notes,
            updates,
            reports,
            build_info,
            started_at: store::now_ms(),
            ctx,
        })
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
    /// hourly), the image check (soon after the start, then every 12 hours)
    /// and the opt-in reports' timers.
    pub fn start(self: &Arc<Self>) {
        health::schedule_startup_check(self.ctx.clone(), self.health.clone(), self.notes.clone(), self.snapshots.clone());
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            loop {
                let day = snapshots::utc_day(store::now_ms());
                let r = me.snapshots.take(&me.ctx.db(), &day, false);
                match r {
                    Ok(Some(name)) => me.ctx.log("snapshots", Level::Info, &format!("Database snapshot {name} saved")),
                    Ok(None) => {}
                    Err(e) => me.ctx.log("snapshots", Level::Warn, &format!("Database snapshot failed: {e}")),
                }
                std::thread::sleep(Duration::from_secs(3600));
            }
        });
        let me = Arc::clone(self);
        std::thread::spawn(move || loop {
            // (index.js ticks the update check with its housekeeping, once a minute)
            std::thread::sleep(Duration::from_secs(60));
            me.updates.tick();
        });
        self.reports.start();
    }

    /// At shutdown.
    pub fn stop(&self) {
        self.reports.stop();
        self.stats.stop();
    }
}

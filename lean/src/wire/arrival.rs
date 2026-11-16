//! The arrival checksums on core: `ArrivalCtx` on core's state (footage's
//! vehicles and scans with birth times, the catalog's codecs, Sentry USB's
//! `holds` from the CAN area's status reader, the converter's clips in hand,
//! the `sentry-usb-record` setting, audit and logs). The area's hook goes to
//! the converter (before a replace in place), its view and kick to the CAN
//! area's Sentry USB routes, its forget to the footage area's vehicle removal.

use super::Server;
use crate::arrival::ctx::{ArrivalCtx, ArrivedFile, Car, InventoryView, KnownCodec};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

pub struct CoreArrival {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
}

impl CoreArrival {
    pub fn new(srv: &Arc<Server>) -> CoreArrival {
        CoreArrival { srv: Arc::downgrade(srv), state: srv.state.clone() }
    }
    fn srv(&self) -> Option<Arc<Server>> {
        self.srv.upgrade()
    }
    fn record_setting(&self) -> serde_json::Map<String, Value> {
        self.state.setting("sentry-usb-record").and_then(|r| r.as_object().cloned()).unwrap_or_default()
    }
}

impl ArrivalCtx for CoreArrival {
    fn vehicles(&self) -> Vec<Car> {
        let Some(s) = self.srv() else { return Vec::new() };
        s.app().vehicles.list().into_iter().map(|v| Car { id: v.id, name: v.name, timezone: v.timezone }).collect()
    }
    fn root_of(&self, vid: &str) -> PathBuf {
        self.srv().and_then(|s| s.app().vehicle(vid)).map(|v| v.root).unwrap_or_default()
    }
    fn vehicle_for_path(&self, path: &str) -> Option<String> {
        self.srv()?.app().vehicles.vehicle_for_path(std::path::Path::new(path)).map(|v| v.id)
    }
    fn inventory(&self, vid: &str) -> Option<InventoryView> {
        let st = self.srv()?.app().state_of(vid).filter(|s| s.scanned)?;
        let files = st
            .file_list
            .iter()
            .map(|f| ArrivedFile { rel: f.rel.clone(), clip: f.kind == crate::footage::Kind::Clip, size: f.size, mtime_ms: f.mtime_ms, ctime_ms: f.ctime_ms, birthtime_ms: f.birthtime_ms })
            .collect();
        Some(InventoryView { files, scanning: st.scanning })
    }
    fn codec(&self, vid: &str, rel: &str) -> Option<KnownCodec> {
        let (size, mtime_ms, codec) = self.srv()?.app().catalog.codec(vid, rel).ok()??;
        Some(KnownCodec { size, mtime_ms, codec })
    }
    fn holds(&self, abs: &str) -> bool {
        self.srv().is_some_and(|s| holds(&s, abs))
    }
    fn busy_paths(&self) -> Vec<String> {
        self.srv().and_then(|s| s.converter().map(|c| c.busy_paths())).unwrap_or_default()
    }
    fn idle(&self) -> bool {
        !self.srv().and_then(|s| s.converter().map(|c| c.running())).unwrap_or(false)
    }
    fn older_of(&self, vid: &str) -> bool {
        self.record_setting().get(vid).and_then(|r| r.get("older")).cloned() != Some(Value::Bool(false))
    }
    fn set_older(&self, vid: &str, older: bool) {
        let mut rec = self.record_setting();
        let mut mine = rec.get(vid).and_then(|r| r.as_object().cloned()).unwrap_or_default();
        mine.insert("older".into(), json!(older));
        rec.insert(vid.to_string(), Value::Object(mine));
        self.state.set_setting("sentry-usb-record", &Value::Object(rec));
    }
    fn forget_setting(&self, vid: &str) {
        let mut rec = self.record_setting();
        if rec.remove(vid).is_some() {
            self.state.set_setting("sentry-usb-record", &Value::Object(rec));
        }
    }
    fn audit(&self, line: &str) {
        self.state.audit.info(line);
    }
    fn log_warn(&self, line: &str) {
        self.state.logger.scope("sentry-usb").warn(line);
    }
    fn log_debug(&self, line: &str) {
        self.state.logger.scope("sentry-usb").debug(line);
    }
    fn log_converter(&self, level: &str, line: &str) {
        let s = self.state.logger.scope("converter");
        match level {
            "error" => s.error(line),
            "warn" => s.warn(line),
            _ => s.info(line),
        }
    }
}

/// sentryUsb.holds(abs): the vehicle's status file says this clip is still being copied.
pub fn holds(s: &Server, abs: &str) -> bool {
    let (Some(can), Some(v)) = (s.can().cloned(), s.app().vehicles.vehicle_for_path(std::path::Path::new(abs))) else { return false };
    let status = can.usb.get(&v.id).and_then(|st| crate::arrival::holds::TransferStatus::parse(&st.raw_json));
    crate::arrival::holds::holds(status.as_ref(), crate::scanner::now_ms(), abs)
}

pub fn make(srv: &Arc<Server>) -> Arc<crate::arrival::Area> {
    let ctx: Arc<dyn ArrivalCtx> = Arc::new(CoreArrival { srv: Arc::downgrade(srv), state: srv.state.clone() });
    Arc::new(crate::arrival::Area::open(ctx, &srv.state.config.data))
}

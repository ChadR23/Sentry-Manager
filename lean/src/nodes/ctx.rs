//! What the nodes need from core (PORT_PLAN.md: "<area>/ctx.rs"), and from
//! the converter's runtime for the worker side. Core implements `NodesCtx`
//! on its AppState; the converter implements `WorkerRuntime` (its planner
//! and device list). See README.md.

use crate::converter::planner::{Device, Selected};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

/// A vehicle, as the nodes see it: its id and its TeslaCam folder
/// (vehicles.studioRoot; None when it cannot be worked out).
#[derive(Clone, Debug)]
pub struct Vehicle {
    pub id: String,
    pub studio_root: Option<PathBuf>,
}

pub trait NodesCtx: Send + Sync {
    /// db.get(key) from manager.db's settings (`nodes`, `nodeWorker`); None when unset.
    fn setting(&self, key: &str) -> Option<Value>;
    /// db.set(key, value)
    fn set_setting(&self, key: &str, value: &Value);
    /// logger.scope('audit')
    fn audit(&self, level: Level, line: &str) {
        eprintln!("[audit] {line}");
    }
    /// logger.scope('nodes')
    fn log(&self, level: Level, line: &str) {
        let _ = level;
        eprintln!("[nodes] {line}");
    }
    /// os.hostname(): this server's name as a node and as a main
    fn hostname(&self) -> String {
        std::fs::read_to_string("/proc/sys/kernel/hostname").map(|s| s.trim().to_string()).unwrap_or_else(|_| "localhost".into())
    }
    fn now_ms(&self) -> i64 {
        super::now_ms()
    }
    /// Whether this server runs its own HTTPS (index.js tlsSource; false with
    /// TLS_MODE=off): a node needs it, the main pins its certificate.
    fn tls_available(&self) -> bool;
    /// tlsSource.caPem(): this server's own certificate authority (PEM) or None.
    fn authority_pem(&self) -> Option<String> {
        None
    }
    /// stats.nodePower (ops::Ops::node_power): a node's power as it reported it.
    fn node_power(&self, _node: &str, _at: i64, _w: Option<f64>, _encoding: bool) {}
    /// The worker's own power for its main (index.js: statsAskedAt, stats.touch(45 s),
    /// ops::node_power::power_report(stats snapshot)); None: not measured.
    fn own_power(&self) -> Option<Value> {
        None
    }
    /// This server's CPU model and detectGpus() (ops::gpu::detect_gpus), for the
    /// worker's `hardware`; reused for 10 minutes by the worker. None: not known.
    fn own_gpus(&self) -> Option<(Option<String>, Value)> {
        None
    }
    /// vehicles.list() with each one's TeslaCam folder.
    fn vehicles(&self) -> Vec<Vehicle> {
        Vec::new()
    }
    fn data_path(&self) -> PathBuf;
    fn ffmpeg_path(&self) -> String {
        "ffmpeg".into()
    }
    fn ffprobe_path(&self) -> String {
        "ffprobe".into()
    }
    /// host.runtime: the converter's runtime for the worker side (None while it starts).
    fn runtime(&self) -> Option<Arc<dyn WorkerRuntime>> {
        None
    }
}

/// The converter runtime's encoder choices, as nodeWorker.js asks for them
/// (runtime.selectEncoder, cpuEncoder, localDevices, selectEncoderFor,
/// encodingNow). The converter implements it on its planner.
pub trait WorkerRuntime: Send + Sync {
    /// selectEncoder(family): the preferred encoder (GPU first).
    fn select_encoder(&self, family: &str) -> Result<Option<Selected>, String>;
    /// cpuEncoder(family)
    fn cpu_encoder(&self, family: &str) -> Result<Selected, String>;
    /// localDevices(): this server's own GPUs and CPU; None for a runtime that
    /// lists none (the worker then reports no devices, as an older node).
    fn local_devices(&self) -> Option<Result<Vec<Device>, String>> {
        None
    }
    /// selectEncoderFor(family, device, { probe }); None: the runtime cannot.
    fn select_encoder_for(&self, _family: &str, _device: &Device, _probe: bool) -> Option<Result<Option<Selected>, String>> {
        None
    }
    /// encodingNow(): this server's own converter is encoding.
    fn encoding_now(&self) -> bool {
        false
    }
    /// The platform for decodeAccelArgs ('linux').
    fn platform(&self) -> String {
        "linux".into()
    }
}

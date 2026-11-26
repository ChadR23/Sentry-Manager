//! runtime.js createConverterRuntime, for the server: the job store in
//! `<data>/converter-jobs`, the private temp folder `<temp>/sentry-six-converter`
//! (its real path), the verified-snapshot registry, the staging area and
//! the job service; start() recovers every unfinished job (deferred, then
//! one after the other, as Node does) and shutdown() stops them so a
//! restart carries on.

use super::error::{CError, CResult};
use super::jobstore::JobStore;
use super::service::tools::{RealTools, Tools};
use super::service::{Options, Service};
use super::snapshot::Registry;
use super::staging::{self, Tx};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const ACTIVE_RECOVERY_STATES: [&str; 10] = ["discovering", "waiting", "staging", "encoding", "writing-telemetry", "verifying", "copying", "replacing", "paused", "paused_network"];
pub const STAGING_CHUNK_BYTES: usize = 16 * 1024 * 1024;

pub struct RuntimeOptions {
    pub data_path: PathBuf,
    pub temp_path: PathBuf,
    pub ffmpeg: String,
    pub ffprobe: String,
    /// the Sentry USB checksum hook (staging beforeReplaceOriginal)
    pub before_replace_original: Option<staging::BeforeReplaceFn>,
    /// the tools (tests stand in their own); RealTools otherwise
    pub tools: Option<Arc<dyn Tools>>,
    /// changes to the service's options (tests: backoff, intervals)
    pub tune: Option<Box<dyn FnOnce(&mut Options)>>,
    /// kill points around job-file writes (the crash tests)
    pub hooks: Option<Arc<dyn super::jobstore::StoreHooks>>,
    /// the encoder planner behind the device list (tests: a fake probe)
    pub encoders: Option<Arc<dyn super::devices::Encoders>>,
    /// where the GPUs are found (tests: a fake /dev and /sys)
    pub discovery: Option<super::devices::Discovery>,
    /// GPU decode (Node's gpuDecode; false: the CPU decodes)
    pub gpu_decode: bool,
    /// clips the host holds back for now (Sentry USB copies in progress)
    pub hold_discovered: Option<Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync>>,
    /// energy per benchmark level (the stats engine's RAPL reading)
    pub power_meter: Option<Arc<dyn super::benchmark::PowerMeter>>,
    /// the cheapest electricity rate is in force now (automatic conversion's off-peak window)
    pub is_cheap_now: Option<Arc<dyn Fn(i64) -> Option<bool> + Send + Sync>>,
    /// automatic conversion ticks on its own (false in tests)
    pub auto_timer: bool,
    /// the helper servers (nodes::main_side::Nodes): their devices as lanes,
    /// remote encodes, trust, slots and each one's vehicles first
    pub nodes: Option<Arc<dyn super::service::lanes::NodeLanes>>,
    /// the Recycle Bin, for an original a replace left beside its converted copy
    /// (leftovers.rs case c); None: such an original is kept and reported
    pub originals_bin: Option<Arc<dyn super::leftovers::OriginalsBin>>,
}

impl RuntimeOptions {
    pub fn new(data_path: PathBuf, temp_path: PathBuf, ffmpeg: &str, ffprobe: &str) -> RuntimeOptions {
        RuntimeOptions { data_path, temp_path, ffmpeg: ffmpeg.into(), ffprobe: ffprobe.into(), before_replace_original: None, tools: None, tune: None, hooks: None, encoders: None, discovery: None, gpu_decode: true, hold_discovered: None, power_meter: None, is_cheap_now: None, auto_timer: true, nodes: None, originals_bin: None }
    }
}

pub struct Converter {
    pub service: Service,
    pub store: Arc<JobStore>,
    pub staging: Arc<Tx>,
    pub registry: Arc<Registry>,
    pub temp_path: PathBuf,
    started: Mutex<Option<Vec<Value>>>,
    pub converted_index: Arc<super::converted_index::ConvertedIndex>,
    /// the encoding devices (the `converter:devices` channel, lanes)
    pub devices: Arc<super::devices::Registry>,
    /// automatic conversion (the auto channels)
    pub auto: Arc<super::auto_convert::Auto>,
    /// the service's options, for the benchmark's isolated services
    template: Options,
    ffprobe: String,
    power_meter: Option<Arc<dyn super::benchmark::PowerMeter>>,
    bench: Arc<Bench>,
    shut: AtomicBool,
    /// the Encoder's Hardware panel's memory across polls (encoderStats.js)
    pub encoder_stats: super::stats::EncoderStats,
}

/// The benchmark running now (one at a time) and its services.
#[derive(Default)]
pub struct Bench {
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub services: Mutex<Vec<Service>>,
}

impl Bench {
    pub fn active(&self) -> bool {
        self.cancel.lock().unwrap().is_some()
    }
}

/// hasActiveJob({ manualOnly })
pub fn has_active_job(service: &Service, manual_only: bool) -> bool {
    service.list_summaries().unwrap_or_default().iter().any(|j| active_job(j, manual_only))
}

fn active_job(j: &Value, manual_only: bool) -> bool {
    !["completed", "failed", "cancelled"].contains(&j["state"].as_str().unwrap_or(""))
        && !(j["state"] == "paused" && j["recovery"]["action"] == "manual-intervention")
        && !(manual_only && (j["autoConvert"] == true || j["config"]["autoConvert"] == true))
}

/// A pause request is not idle until workers have parked and encodes have ended.
pub(crate) fn preview_conversion(service: &Service) -> super::service::SResult<Option<String>> {
    let jobs = service.list_summaries()?;
    let encoding = !service.active_encodes().is_empty();
    Ok(jobs.iter().find(|j| active_job(j, false) && (j["state"] != "paused" || encoding))
        .and_then(|j| j["id"].as_str()).map(String::from))
}

impl Converter {
    /// The host installs a weak backend before automatic conversion starts, so
    /// a pending test survives closing the page without keeping the host alive.
    pub fn install_speed_tests(self: &Arc<Self>) {
        self.auto.install_speed_backend(Arc::new(SpeedBackend(Arc::downgrade(self))));
    }
    pub fn open(o: RuntimeOptions) -> CResult<Converter> {
        if !o.data_path.is_absolute() || !o.temp_path.is_absolute() {
            return Err(CError::type_error("userDataPath and tempPath must be absolute"));
        }
        let jobs_root = o.data_path.join("converter-jobs");
        std::fs::create_dir_all(&jobs_root)?;
        let temp_path = std::fs::canonicalize(&o.temp_path)?;
        let temp_root = temp_path.join("sentry-six-converter");
        std::fs::create_dir_all(&temp_root)?;
        let registry = Arc::new(Registry::new(temp_path.clone()));
        let store = JobStore::new(&jobs_root)?;
        let store = Arc::new(match o.hooks {
            Some(h) => store.with_hooks(h),
            None => store,
        });
        let staging = Arc::new(
            Tx::new(
                staging::Options { temp_root: temp_root.clone(), chunk_size: STAGING_CHUNK_BYTES, max_active_leases: super::contracts::CONCURRENCY_MAX as usize, before_replace_original: o.before_replace_original, replacement_free_space: None },
                registry.clone(),
            )
            .map_err(|e| CError::new(&e.code, e.message))?,
        );
        let planner = Arc::new(super::planner::Planner::new(super::process::BoundedRunner::host(), "linux", &o.ffmpeg));
        let planner_for_pictures: Arc<dyn super::devices::Encoders> = match &o.encoders {
            Some(e) => e.clone(),
            None => planner.clone(),
        };
        let tools: Arc<dyn Tools> = match o.tools {
            Some(t) => t,
            None => Arc::new(RealTools::with_planner(&o.ffmpeg, &o.ffprobe, registry.clone(), planner.clone())),
        };
        let encoders: Arc<dyn super::devices::Encoders> = o.encoders.unwrap_or(planner);
        let mut discovery = o.discovery.unwrap_or_else(|| super::devices::Discovery::new(Some(Arc::new(super::process::BoundedRunner::host()))));
        if discovery.name_of.is_none() {
            discovery.name_of = Some(super::devices::stats_name_of());
        }
        let mut reg = super::devices::Registry::new(discovery, encoders);
        if let Some(n) = o.nodes.clone() {
            reg.remote_nodes = Some(Arc::new(move || n.list_checked()));
        }
        let devices = Arc::new(reg);
        // clips known to be converted already (an optimisation only)
        let converted_index = super::converted_index::ConvertedIndex::new(super::converted_index::Options::new(o.data_path.join("converter-index").join("converted-clips.json")));
        converted_index.load();
        let mut so = Options::new(store.clone(), staging.clone(), tools);
        so.converted_index = Some(converted_index.clone());
        so.originals_bin = o.originals_bin.clone();
        let d2 = devices.clone();
        so.resolve_device = Some(Arc::new(move |id: &str| d2.resolve_device(id)));
        let d3 = devices.clone();
        so.default_device = Some(Arc::new(move |codec: &str| d3.default_device(codec)));
        if o.gpu_decode {
            so.decode_accel = Some(Arc::new(|encoder: &str, zero_copy: bool, device: Option<&super::planner::Device>| super::planner::decode_accel_args(encoder, "linux", None, zero_copy, device).ok().flatten()));
        }
        if let Some(n) = o.nodes.clone() {
            so.remote_nodes = Some(n.clone());
            let n2 = n.clone();
            so.set_node_slots = Some(Arc::new(move |id: &str, slots: &Value| n2.set_slots(id, slots)));
            // the pictures of a node's encode, decoded on this server's GPU when it has one
            let planner2 = planner_for_pictures.clone();
            let ffmpeg = o.ffmpeg.clone();
            let gpu = o.gpu_decode;
            so.compare_picture = Some(Arc::new(move |source: &str, candidate: &str, cancel: &Arc<AtomicBool>, duration: Option<f64>| {
                let accel: Option<Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>> = if gpu {
                    let p = planner2.clone();
                    Some(Arc::new(move || {
                        let e = p.select("h265", true).ok().flatten().filter(|e| e.hardware)?;
                        let dev = e.device.as_ref().filter(|d| d.kind != "cpu");
                        super::planner::decode_accel_args(&e.codec, "linux", None, false, dev).ok().flatten()
                    }))
                } else {
                    None
                };
                let decode = crate::nodes::picture::ffmpeg_decoder(crate::nodes::picture::ffmpeg_runner(ffmpeg.clone(), std::time::Duration::from_secs(30 * 60)), accel);
                let signal = crate::nodes::cancel::Cancel::new();
                let (c2, s2, done) = (cancel.clone(), signal.clone(), Arc::new(AtomicBool::new(false)));
                let d2 = done.clone();
                std::thread::spawn(move || {
                    while !d2.load(Ordering::SeqCst) {
                        if c2.load(Ordering::SeqCst) {
                            s2.abort();
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                });
                let mut seed = super::jobstore::now_ms() ^ (std::process::id() as u64) << 20;
                let mut random = move || {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    (seed >> 11) as f64 / (1u64 << 53) as f64
                };
                let r = crate::nodes::picture::compare_pictures(Path::new(source), Path::new(candidate), &signal, &decode, duration, &mut random);
                done.store(true, Ordering::SeqCst);
                r
            }));
        }
        // skipDiscovered: clips an earlier automatic run handled, and clips the host holds back
        let hold = o.hold_discovered.clone();
        let auto_cell: Arc<std::sync::OnceLock<Arc<super::auto_convert::Auto>>> = Arc::new(std::sync::OnceLock::new());
        let held = move |c: &Value, d: &Value| hold.as_ref().is_some_and(|h| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h(c, d))).unwrap_or(false));
        let held = Arc::new(held);
        let (cell, h2) = (auto_cell.clone(), held.clone());
        so.skip_discovered = Some(Arc::new(move |c: &Value, d: &Value| cell.get().is_some_and(|a| a.is_known(c, d)) || h2(c, d)));
        if let Some(t) = o.tune {
            t(&mut so);
        }
        let template = so.clone();
        let service = Service::new(so);
        let bench = Arc::new(Bench::default());
        let (s2, b2) = (service.clone(), bench.clone());
        *devices.encoding_now.lock().unwrap() = Some(Arc::new(move || b2.active() || s2.preview_active() || !s2.active_encodes().is_empty()));
        // automatic conversion (its own jobs are not in the way: one per vehicle)
        let mut ao = super::auto_convert::AutoOptions::new(Arc::new(service.clone()), super::auto_convert::real_scanner(), o.data_path.join("converter-auto"));
        let (s3, b3) = (service.clone(), bench.clone());
        ao.is_busy = Arc::new(move || b3.active() || s3.preview_active() || has_active_job(&s3, true));
        ao.devices = Some(auto_devices(devices.clone()));
        ao.folder_check=Some(Arc::new(super::folder_access::scan));
        let h3 = held.clone();
        ao.hold_discovered = Some(Arc::new(move |c: &Value, d: &Value| h3(c, d)));
        if let Some(n) = o.nodes.clone() {
            ao.node_priorities = Some(Arc::new(move || n.priorities()));
        }
        ao.is_cheap_now = o.is_cheap_now.clone();
        ao.timer = o.auto_timer;
        let auto = super::auto_convert::Auto::new(ao);
        let _ = auto_cell.set(auto.clone());
        // each verified clip leaves its empty snapshot folder: removed once a job ends
        let (s4, b4, t4) = (service.clone(), bench.clone(), temp_path.clone());
        service.subscribe(Arc::new(move |e: &Value| {
            if e["type"] == "snapshot" && ["completed", "failed", "cancelled"].contains(&e["snapshot"]["state"].as_str().unwrap_or("")) {
                let (s, b, t) = (s4.clone(), b4.clone(), t4.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    // (not once the converter has stopped)
                    if !s.0.shutting_down.load(Ordering::SeqCst) {
                        sweep_empty_snapshot_folders(&s, &b, &t);
                    }
                });
            }
        }));
        Ok(Converter { service, store, staging, registry, temp_path, started: Mutex::new(None), converted_index, devices, auto, template, ffprobe: o.ffprobe.clone(), power_meter: o.power_meter.clone(), bench, shut: AtomicBool::new(false), encoder_stats: Default::default() })
    }

    /// start(): every unfinished job reconciled, then recovered one after the other
    pub fn start(&self) -> CResult<Vec<Value>> {
        let mut started = self.started.lock().unwrap();
        if let Some(r) = &*started {
            return Ok(r.clone());
        }
        let summaries = self.store.summaries()?;
        self.sweep_unreferenced_snapshot_folders(&summaries);
        let mut recovered = Vec::new();
        for m in summaries.iter() {
            if !ACTIVE_RECOVERY_STATES.contains(&m["state"].as_str().unwrap_or("")) {
                continue;
            }
            let id = m["id"].as_str().unwrap_or("").to_string();
            match self.service.recover(&id, true) {
                Ok(snap) => recovered.push(snap),
                Err(e) => return Err(CError::new(e.code.as_deref().unwrap_or("RECOVERY_FAILED"), "The interrupted job could not be recovered.")),
            }
        }
        let service = self.service.clone();
        let ids: Vec<String> = recovered.iter().filter_map(|s| s["id"].as_str().map(str::to_string)).collect();
        std::thread::spawn(move || {
            for id in ids {
                let _ = service.continue_recovery(&id);
                let _ = service.when_idle(&id);
            }
        });
        // automatic conversion's settings and index before any automatic job resumes discovering
        self.auto.start();
        sweep_empty_snapshot_folders(&self.service, &self.bench, &self.temp_path);
        self.sweep_leftover_snapshot_folders(&summaries);
        self.sweep_leftover_encodes(&summaries);
        *started = Some(recovered.clone());
        Ok(recovered)
    }

    /// every path a saved job (its summary) still names
    fn owned_paths(jobs: &[Arc<Value>]) -> Vec<PathBuf> {
        let mut owned = vec![];
        for job in jobs {
            let mut collect = |holder: &Value| {
                for v in holder.get("ownedPaths").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
                    if let Some(p) = v.as_str() {
                        owned.push(super::owned::resolve(Path::new(p)));
                    }
                }
                for v in holder.get("ownedArtifacts").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
                    if let Some(p) = v.get("path").and_then(Value::as_str) {
                        owned.push(super::owned::resolve(Path::new(p)));
                    }
                }
                if let Some(p) = holder.get("publicationArtifact").and_then(|a| a.get("path")).and_then(Value::as_str) {
                    owned.push(super::owned::resolve(Path::new(p)));
                }
            };
            collect(job);
            for item in job.get("items").and_then(Value::as_array).into_iter().flatten() {
                collect(item);
            }
        }
        owned
    }

    fn snapshot_folders(&self, older_than_ms: Option<u64>) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(&self.temp_path) else { return vec![] };
        let cutoff = older_than_ms.map(|ms| super::jobstore::now_ms().saturating_sub(ms) as f64);
        rd.filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(super::snapshot::SNAPSHOT_PREFIX))
            .filter(|e| {
                let Ok(st) = std::fs::symlink_metadata(e.path()) else { return false };
                st.is_dir() && !st.file_type().is_symlink() && cutoff.map_or(true, |c| super::jobstore::mtime_ms(&st) <= c)
            })
            .map(|e| e.path())
            .collect()
    }

    /// sweepUnreferencedSnapshotFolders: at startup nothing converts yet, so
    /// a verification folder no saved job records is a leftover
    fn sweep_unreferenced_snapshot_folders(&self, jobs: &[Arc<Value>]) {
        let owned = Self::owned_paths(jobs);
        let mut removed = 0;
        for folder in self.snapshot_folders(None) {
            let f = super::owned::resolve(&folder);
            if owned.iter().any(|o| *o == f || o.starts_with(&f)) {
                continue;
            }
            if std::fs::remove_dir_all(&folder).is_ok() {
                removed += 1;
            }
        }
        if removed > 0 {
            eprintln!("[CONVERTER] Removed {removed} leftover verification folder(s) from before the restart");
        }
    }

    /// sweepLeftoverSnapshotFolders: with no unfinished job, folders older than an hour
    fn sweep_leftover_snapshot_folders(&self, jobs: &[Arc<Value>]) {
        if jobs.iter().any(|j| !["completed", "failed", "cancelled"].contains(&j["state"].as_str().unwrap_or(""))) {
            return;
        }
        let owned = Self::owned_paths(jobs);
        let mut removed = 0;
        for folder in self.snapshot_folders(Some(60 * 60_000)) {
            let f = super::owned::resolve(&folder);
            if owned.iter().any(|o| *o == f || o.starts_with(&f)) {
                continue;
            }
            if std::fs::remove_dir_all(&folder).is_ok() {
                removed += 1;
            }
        }
        if removed > 0 {
            eprintln!("[CONVERTER] Removed {removed} leftover work folder(s) from an earlier session");
        }
    }

    /// sweepLeftoverEncodes: partial encodes no job names, older than an hour
    fn sweep_leftover_encodes(&self, jobs: &[Arc<Value>]) {
        let owned = Self::owned_paths(jobs);
        let root = self.staging.temp_root().to_path_buf();
        let Ok(rd) = std::fs::read_dir(&root) else { return };
        let cutoff = super::jobstore::now_ms().saturating_sub(60 * 60_000) as f64;
        let mut removed = 0;
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if !["-encoded.mp4", "-encoded.mkv", "-encoded.mov"].iter().any(|x| name.ends_with(x)) {
                continue;
            }
            let file = super::owned::resolve(&e.path());
            if owned.contains(&file) {
                continue;
            }
            let Ok(st) = std::fs::symlink_metadata(&file) else { continue };
            if !st.is_file() || super::jobstore::mtime_ms(&st) > cutoff {
                continue;
            }
            if std::fs::remove_file(&file).is_ok() {
                removed += 1;
            }
        }
        if removed > 0 {
            eprintln!("[CONVERTER] Removed {removed} partial encode(s) left from an earlier stop");
        }
    }

    pub fn shutdown(&self) {
        self.shut.store(true, Ordering::SeqCst);
        self.auto.stop();
        self.cancel_benchmark();
        self.service.shutdown();
        self.converted_index.close();
    }

    /// every ffmpeg encoding right now, a benchmark's included (benchmark: true)
    pub fn active_encodes(&self) -> Vec<Value> {
        let mut out = self.service.active_encodes();
        for s in self.bench.services.lock().unwrap().iter() {
            for mut e in s.active_encodes() {
                e["benchmark"] = json!(true);
                out.push(e);
            }
        }
        out
    }

    /// something converts here right now (a GPU test encode then waits)
    pub fn encoding_now(&self) -> bool {
        self.bench.active() || self.service.preview_active() || !self.service.active_encodes().is_empty()
    }

    pub fn cancel_benchmark(&self) {
        if let Some(c) = self.bench.cancel.lock().unwrap().as_ref() {
            c.store(true, Ordering::SeqCst);
        }
    }

    pub fn benchmark_active(&self) -> bool { self.bench.active() }

    pub fn try_preview(&self) -> Result<Option<super::service::PreviewLease>, String> {
        // Same lock order as benchmark admission. A benchmark cannot slip in
        // between this check and reserving the job service.
        let benchmark = self.bench.cancel.lock().unwrap();
        if benchmark.is_some() { return Ok(None); }
        self.service.try_preview().map_err(|e| e.code.unwrap_or_else(|| "PREVIEW_JOB_CHECK_FAILED".into()))
    }

    /// encoderBlock for GET /api/stats (OpsCtx::encoder_block): the jobs as
    /// this process holds them (summaries), every live encode, the slots
    pub fn encoder_block(&self, snapshot: &Value, energy: &Value) -> Value {
        let jobs = self.service.list_summaries().unwrap_or_default();
        let workers = self.active_encodes();
        let service = self.service.clone();
        let slots = move |id: &str| service.slots_of(id).map(|n| n as i64);
        self.encoder_stats.encoder_block(snapshot, &jobs, &workers, energy, Some(&slots))
    }

    /// devices(): the `converter:devices` answer
    pub fn devices_answer(&self) -> Result<Value, String> {
        self.devices.devices()
    }

    pub fn jobs_root(&self) -> &Path {
        self.store.root()
    }
}

/// sweepEmptySnapshotFolders: empty verification folders (older than a
/// minute) removed while nothing converts; rmdir never removes one that
/// still holds a file
pub fn sweep_empty_snapshot_folders(service: &Service, bench: &Bench, temp_path: &Path) {
    static SWEEPING: AtomicBool = AtomicBool::new(false);
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    if !(has_active_job(service, false) || bench.active()) {
        if let Ok(rd) = std::fs::read_dir(temp_path) {
            let cutoff = super::jobstore::now_ms() as f64 - 60_000.0;
            for e in rd.filter_map(|e| e.ok()) {
                if !e.file_name().to_string_lossy().starts_with(super::snapshot::SNAPSHOT_PREFIX) {
                    continue;
                }
                let Ok(st) = std::fs::metadata(e.path()) else { continue };
                if !st.is_dir() || super::jobstore::mtime_ms(&st) > cutoff {
                    continue;
                }
                let _ = std::fs::remove_dir(e.path());
            }
        }
    }
    SWEEPING.store(false, Ordering::SeqCst);
}

// ---- the benchmark (runtime.js runBenchmark)

/// The Encoder benchmark's search for original clips (findBenchmarkClips)
pub const BENCHMARK_SCAN_LIMIT: usize = 500_000;
pub const BENCHMARK_HEADER_CHECKS: usize = 20_000;

/// What runBenchmark is asked (after the channel's checks).
#[derive(Debug, Clone)]
pub struct BenchRequest {
    pub codecs: Vec<String>,
    pub profile_id: String,
    pub bitrate_kbps: Option<Value>,
    pub quality_level: Option<Value>,
    pub verify_mode: String,
    pub source_root: Option<String>,
}

impl Converter {
    /// findBenchmarkClips(sourceRoot): originals left anywhere in a mostly
    /// converted archive, newest first by name, the largest inspected; at most 8
    pub fn find_benchmark_clips(&self, source_root: Option<&str>, cancel: &Arc<AtomicBool>) -> Vec<(PathBuf, String)> {
        let Some(root) = source_root.filter(|r| !r.is_empty()) else { return vec![] };
        let mut found: Vec<Value> = vec![];
        let r = super::scanner::scan(&json!({ "sourceRoot": root }), Some(cancel), None, &mut |d| {
            if d.value["kind"] == "video" {
                found.push(d.value);
            }
            found.len() < BENCHMARK_SCAN_LIMIT
        });
        if r.is_err() {
            return vec![];
        }
        let base = |v: &Value| Path::new(v["sourcePath"].as_str().unwrap_or("")).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // (localeCompare, newest first; Tesla names hold only [a-z0-9_-])
        found.sort_by(|a, b| super::jobstore::locale_cmp(&base(b), &base(a)));
        let mut originals: Vec<Value> = vec![];
        let mut seen = std::collections::HashSet::new();
        let mut checked = 0;
        let mut at = 0;
        while at < found.len() && originals.len() < 24 && checked < BENCHMARK_HEADER_CHECKS {
            if cancel.load(Ordering::SeqCst) {
                return vec![];
            }
            let batch = &found[at..(at + 16).min(found.len())];
            checked += batch.len();
            let codecs: Vec<Option<&'static str>> = std::thread::scope(|s| {
                let hs: Vec<_> = batch
                    .iter()
                    .map(|item| {
                        s.spawn(move || {
                            let o = super::mp4_header::ReadOptions { size: item["sourceBytes"].as_u64(), cancel: Some(cancel), ..Default::default() };
                            super::mp4_header::read_mp4_video_codec(Path::new(item["sourcePath"].as_str().unwrap_or("")), &o).ok().flatten()
                        })
                    })
                    .collect();
                hs.into_iter().map(|h| h.join().ok().flatten()).collect()
            });
            for (i, item) in batch.iter().enumerate() {
                let n = base(item);
                if codecs[i] == Some("h264") && seen.insert(n) {
                    originals.push(item.clone());
                }
            }
            at += 16;
        }
        originals.sort_by(|a, b| b["sourceBytes"].as_f64().unwrap_or(0.0).partial_cmp(&a["sourceBytes"].as_f64().unwrap_or(0.0)).unwrap());
        let mut clips = vec![];
        for item in originals.iter().take(64) {
            let p = item["sourcePath"].as_str().unwrap_or("");
            match self.template.tools.inspect_video(p, cancel) {
                Ok(i) if i.codec == "h264" => {}
                _ => continue,
            }
            clips.push((PathBuf::from(p), base(item)));
            if clips.len() >= 8 {
                break;
            }
        }
        clips
    }

    fn count_frames(&self, target: &Path) -> i64 {
        let args: Vec<String> = ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"].iter().map(|s| s.to_string()).chain([target.to_string_lossy().to_string()]).collect();
        use super::process::Runner;
        let r = super::process::BoundedRunner::host().run(&self.ffprobe, &args, &super::process::RunOptions { timeout_ms: Some(60_000), ..Default::default() });
        r.ok().and_then(|r| r.stdout.trim().parse::<i64>().ok()).filter(|n| *n > 0).unwrap_or(0)
    }

    /// benchmarkLevelRunner: one level in an isolated job store, staging area and output folder
    fn run_level(&self, codec: &str, req: &BenchRequest, device: Option<&Value>, l: &super::benchmark::LevelRequest, cancel: &Arc<AtomicBool>) -> Result<Value, String> {
        let io = |e: std::io::Error| super::owned::code_of(&e).to_string();
        let staging_root = l.work_root.join("staging");
        std::fs::create_dir_all(&staging_root).map_err(io)?;
        std::fs::create_dir_all(l.work_root.join("output")).map_err(io)?;
        let store = Arc::new(JobStore::new(&l.work_root.join("jobs")).map_err(|e| e.code)?);
        let staging = Arc::new(Tx::new(staging::Options { temp_root: staging_root, chunk_size: STAGING_CHUNK_BYTES, max_active_leases: super::contracts::CONCURRENCY_MAX as usize, before_replace_original: None, replacement_free_space: None }, self.registry.clone()).map_err(|e| e.code)?);
        let mut so = self.template.clone();
        so.store = store;
        so.staging = staging;
        // (the benchmark converts temporary copies: never in the index)
        so.converted_index = None;
        so.skip_discovered = None;
        if let Some(d) = device.cloned() {
            // the GPU under test and no other
            so.resolve_device = Some(Arc::new(move |id: &str| if d["id"] == id { Some(d.clone()) } else { None }));
        }
        let svc = Service::new(so);
        self.bench.services.lock().unwrap().push(svc.clone());
        let mut config = json!({
            "sourceRoot": l.source_root, "destinationRoot": l.work_root.join("output"), "codec": codec, "profileId": req.profile_id
        });
        if req.profile_id == "custom" {
            config["bitrateKbps"] = req.bitrate_kbps.clone().unwrap_or(Value::Null);
        }
        if req.profile_id == "quality" {
            config["qualityLevel"] = req.quality_level.clone().unwrap_or(Value::Null);
        }
        let rest = json!({ "verifyMode": l.verify_mode.unwrap_or(&req.verify_mode), "networkMode": "direct", "outputMode": "separate", "includedGroups": ["RecentClips", "SavedClips", "SentryClips"], "replacementConfirmed": false, "concurrency": l.level });
        for (k, v) in rest.as_object().unwrap() {
            config[k] = v.clone();
        }
        if let Some(d) = device {
            config["lanes"] = json!([{ "device": d["id"], "concurrency": l.level }]);
        }
        let r = (|| -> Result<Value, String> {
            let id = svc.start(&config).map_err(|e| e.code.unwrap_or_else(|| "BENCHMARK_FAILED".into()))?;
            // a cancel of the benchmark cancels the level's job
            let done = Arc::new(AtomicBool::new(false));
            let (s2, c2, d2, id2) = (svc.clone(), cancel.clone(), done.clone(), id.clone());
            let watch = std::thread::spawn(move || {
                while !d2.load(Ordering::SeqCst) {
                    if c2.load(Ordering::SeqCst) {
                        let _ = s2.cancel(&id2);
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            let out = svc.when_idle(&id).map_err(|e| e.code.unwrap_or_else(|| "BENCHMARK_FAILED".into()));
            done.store(true, Ordering::SeqCst);
            let _ = watch.join();
            out
        })();
        svc.shutdown();
        self.bench.services.lock().unwrap().retain(|s| !Arc::ptr_eq(&s.0, &svc.0));
        r
    }

    /// runBenchmark(request, onProgress): each requested codec in turn; with
    /// two or more GPUs every GPU by itself in turn
    pub fn run_benchmark(&self, req: &BenchRequest, on_progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String> {
        self.run_benchmark_mode(req, false, false, on_progress)
    }

    pub(crate) fn run_benchmark_mode(&self, req: &BenchRequest, requested: bool, guided: bool, on_progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String> {
        if self.shut.load(Ordering::SeqCst) {
            return Err("SERVICE_SHUTDOWN".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let _lease;
        {
            let mut b = self.bench.cancel.lock().unwrap();
            if b.is_some() {
                return Err("BENCHMARK_ACTIVE".into());
            }
            if guided && self.service.preview_active() { return Err("PREVIEW_ACTIVE".into()); }
            _lease = self.service.try_speed_test(requested).map_err(|e| e.to_string())?.ok_or("JOB_ACTIVE")?;
            *b = Some(cancel.clone());
        }
        let r = self.run_benchmark_inner(req, on_progress, &cancel, guided);
        let mut b = self.bench.cancel.lock().unwrap();
        if b.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            *b = None;
        }
        r
    }

    fn run_benchmark_inner(&self, req: &BenchRequest, on_progress: &(dyn Fn(Value) + Sync), cancel: &Arc<AtomicBool>, guided: bool) -> Result<Value, String> {
        on_progress(json!({ "step": "scan" }));
        let clips = self.find_benchmark_clips(req.source_root.as_deref(), cancel);
        if cancel.load(Ordering::SeqCst) { return Err("CANCELLED".into()); }
        if clips.is_empty() {
            return Err("BENCHMARK_SOURCE_REQUIRED".into());
        }
        let total = req.codecs.len();
        let run_codecs = |select: &dyn Fn(&str) -> Option<super::planner::Selected>, device: Option<&Value>, progress: Value| -> Result<Vec<Value>, String> {
            let mut runs = vec![];
            for (index, current) in req.codecs.iter().enumerate() {
                let encoder = select(current);
                let Some(encoder) = encoder.filter(|e| device.is_none() || e.hardware) else {
                    runs.push(json!({ "codec": current, "error": "UNSUPPORTED", "encoder": null, "results": [], "best": null, "clips": 0 }));
                    continue;
                };
                let shown = json!({ "family": encoder.family, "codec": encoder.codec, "hardware": encoder.hardware });
                let gpu=encoder.hardware.then(|| device.map(super::devices::device_of).or_else(||encoder.device.clone()).or_else(|| {
                    let id=(self.template.default_device.as_ref()?)(current)?;
                    (self.template.resolve_device.as_ref()?)(&id).map(|v|super::devices::device_of(&v))
                })).flatten();
                let budget=if gpu.is_some() {clips.iter().map(|(p,_)|super::gpu_memory::estimate_mib(self.template.tools.video_dimensions(&p.to_string_lossy(),cancel))).max().unwrap_or(0)} else {0};
                let memory=Mutex::new(None::<Value>);
                let level = |l: &super::benchmark::LevelRequest, c: &Arc<AtomicBool>| {
                    if let Some(gpu)=&gpu {
                        if let Some(reading)=self.template.gpu_memory.reading(gpu) {
                            let limit=reading.limit(budget).min(if self.template.gpu_memory.pressured(gpu) {1} else {64});
                            let mut note=memory.lock().unwrap();
                            if note.as_ref().is_none_or(|n|limit<n["limit"].as_u64().unwrap_or(64)) {
                                *note=Some(json!({"freeMib":reading.free_mib,"totalMib":reading.total_mib,"perEncodeMib":budget,"limit":limit}));
                            }
                            if l.level as u64>limit {
                                // A failed level ends the existing benchmark sweep;
                                // its existing best/5% rule selects among measured levels.
                                return Ok(json!({"items":[{"state":"failed","failure":{"code":"gpu-memory-limit","retryable":true}}]}));
                            }
                        }
                    }
                    let mut job = self.run_level(current, req, device, l, c)?;
                    if guided && encoder.hardware { require_tested_encoder(&mut job, &encoder.codec); }
                    if l.level>1 && gpu.as_ref().is_some_and(|d|self.template.gpu_memory.pressured(d)) {
                        for i in job["items"].as_array_mut().into_iter().flatten() {
                            if i["state"]=="completed" {i["state"]=json!("failed");i["failure"]=json!({"code":"gpu-memory-exhausted","retryable":true});}
                        }
                    }
                    Ok(job)
                };
                let progress = |step: Value| {
                    let mut m = step.as_object().cloned().unwrap_or_default();
                    m.insert("codec".into(), json!(current));
                    m.insert("codecIndex".into(), json!(index + 1));
                    m.insert("codecTotal".into(), json!(total));
                    for (k, v) in progress.as_object().into_iter().flatten() {
                        m.insert(k.clone(), v.clone());
                    }
                    on_progress(Value::Object(m));
                };
                let now = || super::jobstore::now_ms() as f64;
                let count = |p: &Path| self.count_frames(p);
                let out = super::benchmark::run_converter_benchmark(&super::benchmark::BenchOptions {
                    clips: clips.clone(),
                    run_level: &level,
                    count_frames: &count,
                    encoder: shown.clone(),
                    temp_root: self.staging.temp_root().to_path_buf(),
                    cancel: cancel.clone(),
                    on_progress: &progress,
                    now: &now,
                    power_meter: self.power_meter.clone(),
                    compare_verify_modes: if guided { vec![] } else { vec!["quick".into(), "full".into()] },
                });
                match out {
                    Ok(r) => {
                        let mut m = serde_json::Map::new();
                        m.insert("codec".into(), json!(current));
                        for (k, v) in r.as_object().unwrap() {
                            m.insert(k.clone(), v.clone());
                        }
                        if let Some(mut note)=memory.into_inner().unwrap() {
                            // A reading alone does not mean memory limited the recommendation.
                            let refused=r["results"].as_array().is_some_and(|levels|levels.iter().any(|level|
                                level["failures"].as_array().is_some_and(|codes|codes.iter().any(|code|
                                    code=="gpu-memory-limit" || code=="gpu-memory-exhausted"))));
                            let capped=note["limit"].as_u64().zip(r["best"]["level"].as_u64()).is_some_and(|(limit,best)|limit<best);
                            note["limited"]=json!(refused || capped);
                            m.insert("memory".into(),note);
                        }
                        runs.push(Value::Object(m));
                    }
                    Err(e) if e == "CANCELLED" || cancel.load(Ordering::SeqCst) => return Err(e),
                    Err(e) => runs.push(json!({ "codec": current, "error": e, "encoder": shown, "results": [], "best": null, "clips": 0 })),
                }
            }
            Ok(runs)
        };
        // Smallest (CPU only) encodes on this server's CPU, so that is what it measures
        let cpu_only = req.profile_id == super::contracts::SMALLEST_PROFILE_ID;
        // this server's own GPUs only: a helper server is not benchmarked from here
        let gpus: Vec<Value> = if cpu_only { vec![] } else { self.devices.look_up().unwrap_or_else(|_| self.devices.local_devices()).into_iter().filter(|d| d["kind"] != "cpu" && d["kind"] != "node").collect() };
        if cancel.load(Ordering::SeqCst) {
            return Err("CANCELLED".into());
        }
        if gpus.is_empty() || (!guided && gpus.len() < 2) {
            let tools = self.template.tools.clone();
            let runs = run_codecs(&|c: &str| if cpu_only { tools.select_cpu_fallback(c).ok() } else { tools.select(c).ok() }, None, json!({}))?;
            let first = runs.iter().find(|r| r.get("error").is_none()).or(runs.first()).cloned().unwrap_or(json!({}));
            let mut m = first.as_object().cloned().unwrap_or_default();
            m.insert("codecs".into(), Value::Array(runs));
            if guided { m.insert("device".into(), json!({"id":"cpu","name":"CPU"})); }
            return Ok(Value::Object(m));
        }
        let mut devices = vec![];
        for (i, gpu) in gpus.iter().enumerate() {
            let named = json!({ "id": gpu["id"], "name": gpu["name"] });
            let enc = self.devices.encoders.clone();
            let dev = super::devices::device_of(gpu);
            let codecs = run_codecs(&|c: &str| enc.select_for(c, &dev, true).ok().flatten(), Some(gpu), json!({ "device": named, "deviceIndex": i + 1, "deviceTotal": gpus.len() }))?;
            devices.push(json!({ "device": named, "codecs": codecs }));
        }
        Ok(json!({ "devices": devices }))
    }
}

struct SpeedBackend(std::sync::Weak<Converter>);

/// GPU saturation can make the normal converter fall back to CPU. That is a
/// useful conversion, but not a successful measurement of this GPU's capacity.
/// Only the isolated benchmark's returned copy is adjusted, never a job store.
fn require_tested_encoder(job: &mut Value, encoder: &str) {
    for item in job["items"].as_array_mut().into_iter().flatten() {
        if item["state"] == "completed" && item["encoder"] != encoder {
            item["state"] = json!("failed");
            item["failure"] = json!({"code":"device-fallback"});
        }
    }
}
impl super::auto_convert::speed::Backend for SpeedBackend {
    fn devices(&self) -> Vec<Value> {
        self.0.upgrade().map(|c| c.devices.local_devices()).unwrap_or_default()
    }
    fn run(&self, config: &Value, requested: bool, progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String> {
        let c = self.0.upgrade().ok_or("SERVICE_SHUTDOWN")?;
        let req = BenchRequest { codecs:vec!["h265".into()], profile_id:config["profileId"].as_str().unwrap_or("aggressive").into(),
            bitrate_kbps:config.get("bitrateKbps").cloned(), quality_level:config.get("qualityLevel").cloned(),
            verify_mode:if config["verifyMode"] == "full" {"full"} else {"quick"}.into(), source_root:config["sourceRoot"].as_str().map(str::to_string) };
        let result = c.run_benchmark_mode(&req, requested, true, progress)?;
        speed_recommendation(&result)
    }
}

/// Consume the benchmark's existing `best` choice. Never repeat its 5% maths,
/// invent a rate for an unmeasured device, or adopt a failed/partial run.
fn speed_recommendation(result: &Value) -> Result<Value, String> {
    let entries = result["devices"].as_array().cloned().unwrap_or_else(|| vec![result.clone()]);
    let mut devices = vec![];
    for entry in entries {
        let run = entry["codecs"].as_array().and_then(|a| a.iter().find(|r| r["codec"] == "h265")).unwrap_or(&entry);
        if run["error"] == "UNSUPPORTED" { continue; }
        let best = &run["best"];
        let n = best["level"].as_i64().filter(|n| super::benchmark::LEVELS.contains(n)).ok_or("SPEED_TEST_FAILED")?;
        if run["memory"]["limit"].as_u64().is_some_and(|limit|n as u64>limit) {return Err("SPEED_TEST_FAILED".into());}
        let rate = best["filesPerMinute"].as_f64().filter(|n| n.is_finite() && *n > 0.0).ok_or("SPEED_TEST_FAILED")?;
        if best["ok"] != true || !run["error"].is_null() || !entry["device"]["id"].is_string() { return Err("SPEED_TEST_FAILED".into()); }
        let kwh = best["filesPerWh"].as_f64().filter(|n| n.is_finite() && *n > 0.0).map(|n| n * 1000.0);
        let mut device=json!({"id":entry["device"]["id"],"name":entry["device"]["name"],"concurrency":n,"filesPerMinute":rate,"filesPerKwh":kwh});
        if run["memory"].is_object() {device["memory"]=run["memory"].clone();}
        devices.push(device);
    }
    if devices.is_empty() || devices.iter().map(|d| d["concurrency"].as_i64().unwrap_or(0)).sum::<i64>() > super::contracts::CONCURRENCY_MAX {
        return Err("SPEED_TEST_FAILED".into());
    }
    Ok(json!({"devices":devices}))
}

#[cfg(test)]
mod speed_tests {
    use super::*;
    use super::super::auto_convert::speed::{Backend, fingerprint};

    #[test]
    fn speed_test_cpu_fallback_does_not_count_as_gpu_capacity() {
        let mut job = json!({"items":[{"state":"completed","encoder":"hevc_nvenc"},{"state":"completed","encoder":"libx265"}]});
        require_tested_encoder(&mut job, "hevc_nvenc");
        assert_eq!(job["items"][0]["state"], "completed");
        assert_eq!(job["items"][1]["state"], "failed");
        assert_eq!(job["items"][1]["failure"]["code"], "device-fallback");
    }

    #[test]
    fn speed_test_uses_the_existing_best_per_device_and_rejects_unmeasured_results() {
        let mut r = json!({"devices":[
            {"device":{"id":"pci:0000:01:00.0","name":"GPU A"},"codecs":[{"codec":"h265","best":{"ok":true,"level":2,"filesPerMinute":9.6,"filesPerWh":3.2}}]},
            {"device":{"id":"pci:0000:02:00.0","name":"GPU B"},"codecs":[{"codec":"h265","best":{"ok":true,"level":4,"filesPerMinute":8.0}}]}
        ]});
        let out = speed_recommendation(&r).unwrap();
        assert_eq!(out["devices"][0]["concurrency"], 2);
        assert_eq!(out["devices"][0]["filesPerKwh"], 3200.0);
        assert_eq!(out["devices"][1]["concurrency"], 4);
        assert!(out["devices"][1]["filesPerKwh"].is_null());
        r["devices"][1]["codecs"][0]["best"]["ok"] = json!(false);
        assert!(speed_recommendation(&r).is_err(), "a failed device does not partially overwrite settings");
    }

    #[test]
    fn speed_test_fingerprint_ignores_enumeration_but_detects_new_devices() {
        let a = json!({"id":"pci:0000:01:00.0","kind":"nvidia","name":"GPU A","index":0});
        let b = json!({"id":"cpu","kind":"cpu","name":"CPU"});
        let mut moved = a.clone(); moved["index"] = json!(1);
        assert_eq!(fingerprint(&[a.clone(),b.clone()]), fingerprint(&[b.clone(),moved]));
        assert_ne!(fingerprint(&[a,b.clone()]), fingerprint(&[b]));
    }

    #[test]
    fn speed_test_generated_original_uses_real_converter_and_leaves_source_unchanged() {
        let d = super::super::testutil::tempdir().unwrap();
        let root = d.path().join("footage");
        for dir in [root.join("RecentClips"),d.path().join("data"),d.path().join("temp")] { std::fs::create_dir_all(dir).unwrap(); }
        let clip = root.join("RecentClips/2026-01-01_00-00-00-front.mp4");
        assert!(std::process::Command::new("ffmpeg").args(["-v","error","-f","lavfi","-i","testsrc2=size=320x180:rate=24:duration=1",
            "-c:v","libx264","-preset","ultrafast","-crf","12","-use_editlist","0"]).arg(&clip).status().unwrap().success());
        let before = std::fs::read(&clip).unwrap();
        let mut o = RuntimeOptions::new(d.path().join("data"),d.path().join("temp"),"ffmpeg","ffprobe");
        o.auto_timer = false;
        let mut discovery = super::super::devices::Discovery::new(None);
        discovery.fixed = Some(Arc::new(|| vec![super::super::devices::cpu_device()])); o.discovery = Some(discovery);
        let c = Arc::new(Converter::open(o).unwrap()); c.start().unwrap();
        let backend = SpeedBackend(Arc::downgrade(&c));
        let events = Mutex::new(vec![]);
        let config = json!({"sourceRoot":root,"codec":"h265","profileId":"smallest","verifyMode":"quick"});
        let result = backend.run(&config, false, &|p| events.lock().unwrap().push(p)).unwrap();
        assert_eq!(result["devices"][0]["id"], "cpu");
        assert!(result["devices"][0]["filesPerMinute"].as_f64().unwrap() > 0.0);
        assert!(events.lock().unwrap().iter().any(|p| p["step"] == "run"));
        assert!(!events.lock().unwrap().iter().any(|p| p["step"] == "verify"), "guided tests use the requested verification mode only");
        assert_eq!(std::fs::read(&clip).unwrap(), before);
        assert!(c.service.list().unwrap().is_empty(), "isolated test jobs never enter the owner's store");
        std::fs::remove_file(clip).unwrap();
        assert_eq!(backend.run(&config,false,&|_|{}).unwrap_err(),"BENCHMARK_SOURCE_REQUIRED");
        c.shutdown();
    }
}

/// The converter as a helper server's worker uses it (nodes::ctx::WorkerRuntime):
/// the encoder this server uses for a codec, the CPU encoder, its own
/// devices and the encoder one of them proves, whether it encodes now.
impl crate::nodes::ctx::WorkerRuntime for Converter {
    fn select_encoder(&self, family: &str) -> Result<Option<super::planner::Selected>, String> {
        self.devices.encoders.select(family, true)
    }
    fn cpu_encoder(&self, family: &str) -> Result<super::planner::Selected, String> {
        self.devices.encoders.select_cpu_fallback(family)
    }
    fn local_devices(&self) -> Option<Result<Vec<super::planner::Device>, String>> {
        Some(Ok(self.devices.local_devices().iter().map(super::devices::device_of).collect()))
    }
    fn select_encoder_for(&self, family: &str, device: &super::planner::Device, probe: bool) -> Option<Result<Option<super::planner::Selected>, String>> {
        Some(self.devices.encoders.select_for(family, device, probe))
    }
    fn encoding_now(&self) -> bool {
        Converter::encoding_now(self)
    }
}

/// The devices automatic jobs are planned on: this server's own when the paired nodes cannot be
/// read (logged by the nodes), as a job finds its devices, so a database error pauses no local job
/// (allocate takes a list it could not get as none, as Node does).
pub(crate) fn auto_devices(d: Arc<super::devices::Registry>) -> Arc<dyn Fn() -> Result<Vec<Value>, String> + Send + Sync> {
    Arc::new(move || Ok(d.recent_or_local()))
}

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
use serde_json::Value;
use std::path::{Path, PathBuf};
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
}

impl RuntimeOptions {
    pub fn new(data_path: PathBuf, temp_path: PathBuf, ffmpeg: &str, ffprobe: &str) -> RuntimeOptions {
        RuntimeOptions { data_path, temp_path, ffmpeg: ffmpeg.into(), ffprobe: ffprobe.into(), before_replace_original: None, tools: None, tune: None, hooks: None, encoders: None, discovery: None, gpu_decode: true, hold_discovered: None }
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
}

impl Converter {
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
        let planner = Arc::new(super::planner::Planner::new(super::process::BoundedRunner::default(), "linux", &o.ffmpeg));
        let tools: Arc<dyn Tools> = match o.tools {
            Some(t) => t,
            None => Arc::new(RealTools::with_planner(&o.ffmpeg, &o.ffprobe, registry.clone(), planner.clone())),
        };
        let encoders: Arc<dyn super::devices::Encoders> = o.encoders.unwrap_or(planner);
        let mut discovery = o.discovery.unwrap_or_else(|| super::devices::Discovery::new(Some(Arc::new(super::process::BoundedRunner::default()))));
        if discovery.name_of.is_none() {
            discovery.name_of = Some(super::devices::stats_name_of());
        }
        let devices = Arc::new(super::devices::Registry::new(discovery, encoders));
        // clips known to be converted already (an optimisation only)
        let converted_index = super::converted_index::ConvertedIndex::new(super::converted_index::Options::new(o.data_path.join("converter-index").join("converted-clips.json")));
        converted_index.load();
        let mut so = Options::new(store.clone(), staging.clone(), tools);
        so.converted_index = Some(converted_index.clone());
        let d2 = devices.clone();
        so.resolve_device = Some(Arc::new(move |id: &str| d2.resolve_device(id)));
        let d3 = devices.clone();
        so.default_device = Some(Arc::new(move |codec: &str| d3.default_device(codec)));
        if o.gpu_decode {
            so.decode_accel = Some(Arc::new(|encoder: &str, zero_copy: bool, device: Option<&super::planner::Device>| super::planner::decode_accel_args(encoder, "linux", None, zero_copy, device).ok().flatten()));
        }
        let hold = o.hold_discovered.clone();
        so.skip_discovered = hold.map(|h| -> Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync> { Arc::new(move |c: &Value, d: &Value| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h(c, d))).unwrap_or(false)) });
        if let Some(t) = o.tune {
            t(&mut so);
        }
        let service = Service::new(so);
        let s2 = service.clone();
        *devices.encoding_now.lock().unwrap() = Some(Arc::new(move || !s2.active_encodes().is_empty()));
        Ok(Converter { service, store, staging, registry, temp_path, started: Mutex::new(None), converted_index, devices })
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
        self.service.shutdown();
        self.converted_index.close();
    }

    pub fn jobs_root(&self) -> &Path {
        self.store.root()
    }
}

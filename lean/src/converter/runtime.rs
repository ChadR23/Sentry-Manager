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
}

pub struct Converter {
    pub service: Service,
    pub store: Arc<JobStore>,
    pub staging: Arc<Tx>,
    pub registry: Arc<Registry>,
    pub temp_path: PathBuf,
    started: Mutex<Option<Vec<Value>>>,
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
        let tools: Arc<dyn Tools> = match o.tools {
            Some(t) => t,
            None => Arc::new(RealTools::new(&o.ffmpeg, &o.ffprobe, registry.clone())),
        };
        let mut so = Options::new(store.clone(), staging.clone(), tools);
        if let Some(t) = o.tune {
            t(&mut so);
        }
        Ok(Converter { service: Service::new(so), store, staging, registry, temp_path, started: Mutex::new(None) })
    }

    /// start(): every unfinished job reconciled, then recovered one after the other
    pub fn start(&self) -> CResult<Vec<Value>> {
        let mut started = self.started.lock().unwrap();
        if let Some(r) = &*started {
            return Ok(r.clone());
        }
        let mut recovered = Vec::new();
        for m in self.store.summaries()? {
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
        *started = Some(recovered.clone());
        Ok(recovered)
    }

    pub fn shutdown(&self) {
        self.service.shutdown();
    }

    pub fn jobs_root(&self) -> &Path {
        self.store.root()
    }
}

//! jobService.js: launch, produce (discovery), the workers, one clip's
//! conversion (processVideoOnceChecked with the split save, the server's
//! staging area always splits), assets, failures and the job's end.

use super::encode::EncodeRequest;
use super::*;
use super::super::jobstore::states::ArtifactState;
use super::super::jobstore::Item;
use super::super::planner::{self, Selected};
use super::super::staging::{Op, SourceAuthority};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

pub struct Cleanup {
    pub cleaned: bool,
    pub recovery_required: bool,
    pub pending: Vec<String>,
    /// the files still recorded after it (its result)
    pub own: Own,
}

impl Cleanup {
    fn done() -> Cleanup {
        Cleanup { cleaned: true, recovery_required: false, pending: vec![], own: Own::default() }
    }
    fn result_value(&self) -> Value {
        let mut v = self.own.to_value();
        if !self.pending.is_empty() {
            v["cleanupPending"] = json!(self.pending);
        }
        v
    }
}

/// AbortSignal.timeout(ms)
pub fn timeout_flag(ms: u64) -> Arc<AtomicBool> {
    let f = Arc::new(AtomicBool::new(false));
    let g = f.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        g.store(true, Ordering::SeqCst);
    });
    f
}

fn own_of_typed(paths: &staging::Paths, arts: &staging::Artifacts) -> Own {
    Own::from_typed(paths, arts)
}

pub fn authority_value(a: &SourceAuthority) -> Value {
    json!({ "size": a.size, "sha256": a.sha256, "device": a.device, "inode": a.inode })
}

pub fn authority_of(v: Option<&Value>) -> Option<SourceAuthority> {
    let v = v?;
    Some(SourceAuthority {
        size: v.get("size")?.as_u64()?,
        sha256: v.get("sha256")?.as_str()?.to_string(),
        device: match v.get("device")? {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
        inode: match v.get("inode")? {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
    })
}

struct Item_ {
    v: Value,
}
impl Item_ {
    fn s(&self, k: &str) -> String {
        self.v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
    }
    fn n(&self, k: &str) -> u64 {
        self.v.get(k).and_then(Value::as_u64).unwrap_or(0)
    }
}

/// First-attempt settings from the whole original clip. Encoder proofs and
/// decode-tier collection belong to the caller; planning has no job or I/O.
pub(crate) struct InitialPlan {
    pub selected: Selected,
    pub bitrate: Option<f64>,
    pub quality: Option<String>,
    pub smallest: Option<planner::Smallest>,
    pub keep_order: bool,
    pub hold_frames: i64,
    /// Decode tier keys and arguments, fastest first; an empty list uses CPU decode.
    pub decode: Vec<(String, Vec<String>)>,
    pub codec: String,
    pub profile_id: String,
    pub cpu_only: bool,
    pub no_target: bool,
    pub target_bytes: Option<f64>,
    pub duration_us: Option<i64>,
}

/// Use whole-file bytes and inspected duration, even when encoding a preview
/// window. `selected` is already proven (CPU-only for Smallest); `tiers` are
/// the caller's available decode tiers for this encoder and lead-in hold.
pub(crate) fn initial_plan(
    config: &Value,
    source_bytes: u64,
    inspected: &tools::Inspected,
    timeline: &super::super::timeline::Timeline,
    selected: Selected,
    tiers: Vec<(String, Vec<String>)>,
) -> SResult<InitialPlan> {
    let hold_frames = super::super::lead_in::hold_frames(Some(&timeline.lead_in)) as i64;
    let codec = config["codec"].as_str().unwrap_or("h265").to_string();
    let profile_id = config["profileId"].as_str().unwrap_or("").to_string();
    let custom = profile_id == "custom";
    let quality: Option<String> = if profile_id == "quality" { config["qualityLevel"].as_str().map(str::to_string) } else { None };
    // Smallest (CPU only): libx265 here, peaks at 60% of this clip's own average
    // bitrate. A clip given back the original's timing keeps its frame order.
    let cpu_only = profile_id == contracts::SMALLEST_PROFILE_ID;
    let smallest = cpu_only.then(|| planner::Smallest { maxrate: contracts::smallest_maxrate(source_bytes as f64, inspected.duration_seconds) });
    let keep_order = cpu_only && super::super::lead_in::source_timing_for(Some(&timeline.lead_in), Some(&timeline.undecodable)).is_some();
    let no_target = !contracts::has_size_target(&profile_id);
    let target_bytes = if no_target { None } else { Some(contracts::target_output_bytes(source_bytes, &profile_id)) };
    let mut bitrate: Option<f64> = if quality.is_some() || cpu_only {
        None
    } else if custom {
        Some(config["bitrateKbps"].as_f64().unwrap_or(0.0) * 1000.0)
    } else {
        Some(planner::calculate_initial_bitrate(&codec, target_bytes.unwrap_or(0.0), inspected.duration_seconds, 0.0, 0.0)
            .map(|b| b as f64).map_err(|_| service_error("INVALID_BITRATE"))?)
    };
    if selected.hardware && !no_target {
        bitrate = bitrate.map(|b| (tools::bitrate_floor(&codec) as f64).max((b * 0.93).floor()));
    }
    let duration_us = {
        let d = contracts::js_round(inspected.duration_seconds * 1_000_000.0) as i64;
        if d != 0 { Some(d) } else { None }
    };
    Ok(InitialPlan { selected, bitrate, quality, smallest, keep_order, hold_frames, decode: tiers, codec, profile_id, cpu_only, no_target, target_bytes, duration_us })
}

impl Service {
    // ---- the save slot and the lead

    pub fn begin_item(rt: &Runtime, item: &Value) {
        let id = item["id"].as_str().unwrap_or("").to_string();
        let mut s = rt.lock();
        if !s.in_flight.contains(&id) {
            s.in_flight.push(id.clone());
        }
        if s.lead_item_id.as_ref().map_or(true, |l| !s.in_flight.contains(l)) {
            s.lead_item_id = Some(id.clone());
        }
        s.ownerships.insert(id, ownership_of(item));
    }

    pub fn finish_item(&self, rt: &Runtime, id: &str) {
        let mut paths: Vec<String> = Self::ownership_for(rt, id).map(|o| o.paths.values().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if let Some(i) = rt.lock().item(id) {
            paths.extend(obj(i.get("ownedPaths")).values().filter_map(|v| v.as_str().map(str::to_string)));
        }
        self.0.o.staging.release_leases(&paths);
        let mut s = rt.lock();
        s.in_flight.retain(|x| x != id);
        s.ownerships.remove(id);
        s.children.remove(id);
        if s.commit_holder.as_deref() == Some(id) {
            s.commit_holder = None;
        }
        if s.lead_item_id.as_deref() == Some(id) {
            s.lead_item_id = s.in_flight.first().cloned();
        }
        drop(s);
        rt.cv.notify_all();
    }

    fn acquire_commit(&self, rt: &Runtime, id: &str) -> SResult<()> {
        let mut s = rt.lock();
        let mut waited = false;
        while s.commit_holder.as_ref().is_some_and(|h| h != id) {
            waited = true;
            s = rt.cv.wait(s).unwrap_or_else(|p| p.into_inner());
        }
        if (s.recovery_required && s.recovery_item_id.as_deref() != Some(id)) || (waited && (s.cancel_requested || s.stop_requested)) {
            drop(s);
            rt.cv.notify_all();
            return Err(service_error("CANCELLED"));
        }
        s.commit_holder = Some(id.to_string());
        Ok(())
    }

    fn release_commit(rt: &Runtime, id: &str) {
        let mut s = rt.lock();
        if s.commit_holder.as_deref() == Some(id) {
            s.commit_holder = None;
        }
        drop(s);
        rt.cv.notify_all();
    }

    // ---- files

    fn op<'a>(&self, rt: &Runtime, item_id: &str, cancel: &'a AtomicBool, persist: &'a (dyn Fn(&Value) -> Result<(), String> + Sync)) -> Op<'a> {
        let m = rt.manifest();
        Op { job_id: m.id().to_string(), item_id: item_id.to_string(), cancel: Some(cancel), persist: Some(persist), codec: m.config()["codec"].as_str().map(str::to_string), ..Default::default() }
    }

    /// cleanupOwnership(runtime, itemId, ownership, signal, { scope })
    pub fn cleanup_ownership(&self, rt: &Arc<Runtime>, item_id: &str, ownership: Option<&Own>, cancel: Option<Arc<AtomicBool>>, item_scope: bool) -> Cleanup {
        let Some(own) = ownership else { return Cleanup::done() };
        if own.paths.is_empty() {
            return Cleanup::done();
        }
        let keys: Vec<String> = own.paths.keys().cloned().collect();
        if own.paths.contains_key("replacementBackup") && own.arts.get("replacementBackup").and_then(|a| a.get("state")).and_then(Value::as_str).map(ArtifactState::parse) != Some(ArtifactState::Intent) {
            return Cleanup { cleaned: false, recovery_required: true, pending: keys, own: own.clone() };
        }
        let cancel = cancel.unwrap_or_else(|| rt.signal());
        let persist = self.persistence(rt, item_id, item_scope);
        let m = rt.manifest();
        let mut op = self.op(rt, item_id, &cancel, &persist);
        op.source = m.item(item_id).and_then(|i| i.str("sourcePath").map(str::to_string));
        op.source_root = m.config()["sourceRoot"].as_str().map(str::to_string);
        op.owned_paths = own.paths_typed();
        op.owned_artifacts = own.arts_typed();
        op.publication_artifact = own.artifact();
        match self.0.o.staging.cleanup_owned_artifacts(&op) {
            Ok(r) => {
                let result_own = Own { paths: own_of_typed(&r.owned_paths, &r.owned_artifacts).paths, arts: own_of_typed(&r.owned_paths, &r.owned_artifacts).arts, publication: r.publication_artifact.as_ref().map(|a| serde_json::to_value(a).unwrap()) };
                let recovery_required = !r.cleaned && r.cleanup_pending.iter().any(|k| k == "replacementBackup");
                if r.cleaned {
                    let base = Self::ownership_for(rt, item_id).unwrap_or_else(|| own.clone());
                    Self::set_ownership(rt, item_id, Some(compose(&base, &json!({}), &keys)));
                } else {
                    let base = Self::ownership_for(rt, item_id).unwrap_or_default();
                    let mut incoming = result_own.to_value();
                    if !r.clear_owned_keys.is_empty() {
                        incoming["clearOwnedKeys"] = json!(r.clear_owned_keys);
                    }
                    Self::set_ownership(rt, item_id, Some(compose(&base, &incoming, &[])));
                }
                Cleanup { cleaned: r.cleaned, recovery_required, pending: r.cleanup_pending, own: result_own }
            }
            Err(e) => Cleanup { cleaned: false, recovery_required: false, pending: e.cleanup_pending.unwrap_or(keys), own: own.clone() },
        }
    }

    /// reconcileItemOwnership(runtime, itemId, ownership, { scope })
    pub fn reconcile_item_ownership(&self, rt: &Arc<Runtime>, item_id: &str, ownership: Option<Own>, item_scope: bool) -> SResult<bool> {
        let Some(own) = ownership.filter(|o| !o.paths.is_empty()) else { return Ok(true) };
        Self::set_ownership(rt, item_id, Some(ownership_of(&own.to_value())));
        let current = Self::ownership_for(rt, item_id);
        let cleanup = self.cleanup_ownership(rt, item_id, current.as_ref(), None, item_scope);
        if cleanup.cleaned {
            self.item_patch(rt, item_id, vec![("ownedPaths", Some(json!({}))), ("ownedArtifacts", Some(json!({}))), ("publicationArtifact", None), ("replacementPhase", None)], vec![])?;
            let item = rt.lock().item(item_id).unwrap_or(Value::Null);
            Self::set_ownership(rt, item_id, Some(ownership_of(&item)));
            return Ok(true);
        }
        let mut retained = compose(&own, &cleanup.result_value(), &[]);
        if !retained.paths.contains_key("publicationSnapshot") {
            retained.publication = None;
        }
        let job = if item_scope {
            vec![]
        } else {
            vec![("ownedPaths", Value::Object(retained.paths.clone())), ("ownedArtifacts", Value::Object(retained.arts.clone())), ("publicationArtifact", retained.publication.clone().unwrap_or(Value::Null))]
        };
        self.item_patch(rt, item_id, vec![("ownedPaths", Some(Value::Object(retained.paths.clone()))), ("ownedArtifacts", Some(Value::Object(retained.arts.clone()))), ("publicationArtifact", retained.publication.clone()), ("resultCode", Some(json!("cleanup-pending")))], job)?;
        Ok(false)
    }

    // ---- the network

    fn path_present(&self, rt: &Runtime, target: &str) -> bool {
        if rt.aborted() {
            return false;
        }
        self.0.o.tools.check_path(target, false)
    }

    /// goneWhileShareAnswers
    fn gone_while_share_answers(&self, rt: &Runtime, target: &str, role: &str) -> bool {
        let m = rt.manifest();
        let Some(root) = m.config()["sourceRoot"].as_str() else { return false };
        if role == "destination" {
            return false;
        }
        let root_path = super::super::owned::resolve(Path::new(root));
        let target_path = super::super::owned::resolve(Path::new(target));
        if target_path == root_path {
            return false;
        }
        if !target_path.starts_with(&root_path) {
            return self.path_present(rt, &root_path.to_string_lossy());
        }
        let mut dir = target_path.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == root_path || d.as_os_str().len() <= root_path.as_os_str().len() {
                break;
            }
            if self.path_present(rt, &d.to_string_lossy()) {
                return true;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        let others: Vec<String> = m.items.iter().filter_map(|i| i.str("sourcePath").map(str::to_string)).filter(|p| super::super::owned::resolve(Path::new(p)) != target_path).collect();
        if others.is_empty() {
            return false;
        }
        for i in [0, others.len() / 2, others.len() - 1] {
            if self.path_present(rt, &others[i]) {
                return true;
            }
        }
        false
    }

    /// waitForNetwork(runtime, target, options): true after a real outage
    pub fn wait_for_network(&self, rt: &Arc<Runtime>, target: &str, persist: bool, item_id: Option<&str>, path_role: Option<&str>, resume_state: Option<JobState>, phase_opt: Option<ReplacementPhase>) -> SResult<bool> {
        let (do_persist, item, observed, phase, owner) = {
            let mut s = rt.lock();
            let do_persist = persist && s.network_pause_owner.is_none() && item_id.map_or(true, |i| s.is_lead(i));
            let pick = item_id.map(str::to_string).or_else(|| s.lead_item_id()).or_else(|| s.manifest.str("activeItemId").map(str::to_string));
            let item = pick.and_then(|i| s.item(&i));
            let observed = resume_state.unwrap_or_else(|| s.manifest.state());
            let phase = if observed == JobState::Replacing { phase_opt.or_else(|| s.manifest.replacement_phase()) } else { None };
            let owner = if do_persist {
                let o = self.0.owner_seq.fetch_add(1, Ordering::SeqCst);
                s.network_pause_owner = Some(o);
                Some(o)
            } else {
                None
            };
            (do_persist, item, observed, phase, owner)
        };
        let resume = if observed == JobState::Discovering && item.is_some() { JobState::Waiting } else { observed.clone() };
        let phase = if resume == JobState::Replacing { phase } else { None };
        let norm = super::super::owned::resolve(Path::new(target)).to_string_lossy().to_lowercase();
        let role = path_role.map(str::to_string).unwrap_or_else(|| match &item {
            Some(i) if super::super::owned::resolve(Path::new(i["sourcePath"].as_str().unwrap_or(""))).to_string_lossy().to_lowercase() == norm => "source".into(),
            Some(i) if output_path(rt.manifest().config(), i).to_lowercase() == norm => "destination".into(),
            _ => "discovery".into(),
        });
        let result = (|| -> SResult<bool> {
            let mut persisted = false;
            if do_persist {
                let still_lead = |s: &RtState| item_id.map_or(true, |i| s.is_lead(i));
                let item_id_v = item.as_ref().and_then(|i| i.get("id").cloned()).unwrap_or(Value::Null);
                let mut rec = Map::new();
                rec.insert("fromState".into(), JobState::PausedNetwork.into());
                rec.insert("action".into(), json!("resume-network"));
                rec.insert("pathRole".into(), json!(role));
                rec.insert("resumeState".into(), resume.clone().into());
                if let Some(p) = &phase {
                    rec.insert("phase".into(), p.clone().into());
                }
                let mut did = false;
                self.update(rt, |s| {
                    if !still_lead(s) {
                        return Some(Patch::new());
                    }
                    did = true;
                    Some(Patch::new().state(JobState::PausedNetwork).set("activeItemId", item_id_v.clone()).set("recovery", Value::Object(rec.clone())))
                })?;
                persisted = did;
            }
            self.emit(rt, "paused_network", vec![("status", json!("waiting"))]);
            let mut delay = self.0.o.backoff_initial_ms;
            let mut outage = false;
            let ended = |rt: &Runtime| {
                let s = rt.lock();
                s.cancel_requested || s.stop_requested || rt.aborted()
            };
            while !ended(rt) {
                let mut available = self.0.o.tools.check_path(target, role == "destination");
                if ended(rt) {
                    return Err(service_error("CANCELLED"));
                }
                if !available {
                    if self.gone_while_share_answers(rt, target, &role) {
                        available = true;
                    } else {
                        outage = true;
                    }
                }
                if available {
                    if persisted {
                        let resume2 = resume.clone();
                        let phase2 = phase.clone();
                        self.update(rt, |s| {
                            if item_id.map_or(true, |i| s.is_lead(i)) && s.manifest.state() == JobState::PausedNetwork {
                                let mut p = Patch::new().state(resume2.clone()).set("recovery", Value::Null);
                                if resume2 == JobState::Replacing {
                                    p = p.set("replacementPhase", phase2.clone().map(Value::from).unwrap_or(Value::Null));
                                }
                                Some(p)
                            } else {
                                Some(Patch::new())
                            }
                        })?;
                    }
                    self.emit(rt, "network_reconnected", vec![("status", json!("resuming"))]);
                    return Ok(outage);
                }
                let until = Instant::now() + Duration::from_millis(delay);
                while Instant::now() < until {
                    if ended(rt) {
                        return Err(service_error("CANCELLED"));
                    }
                    std::thread::sleep(Duration::from_millis(20.min(delay)));
                }
                delay = (delay * 2).min(self.0.o.backoff_max_ms);
            }
            Err(service_error("CANCELLED"))
        })();
        if let Some(o) = owner {
            let mut s = rt.lock();
            if s.network_pause_owner == Some(o) {
                s.network_pause_owner = None;
            }
        }
        result
    }

    pub fn is_retryable_network(f: &Fail) -> bool {
        f.code.as_deref().is_some_and(tools::is_retryable)
    }

    /// retryTransactionOperation
    fn retry_transaction<T>(&self, rt: &Arc<Runtime>, item_id: &str, target: &str, probe: &str, mut op: impl FnMut() -> SResult<T>) -> SResult<T> {
        let mut quick = 0;
        loop {
            match op() {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if !Self::is_retryable_network(&e) {
                        return Err(e);
                    }
                    let _ = target;
                    if !self.reconcile_item_ownership(rt, item_id, Self::ownership_for(rt, item_id), false)? {
                        return Err(service_error("OWNED_CLEANUP_FAILED"));
                    }
                    if self.wait_for_network(rt, probe, true, Some(item_id), Some("destination"), None, None)? {
                        quick = 0;
                    } else {
                        quick += 1;
                        if quick > QUICK_RETRY_LIMIT {
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    /// prepareDestination(config, destination): ensureContainedDestinationParent + revalidate
    fn prepare_destination(&self, config: &Value, destination: &str) -> SResult<()> {
        let guard = ensure_destination_parent(config["destinationRoot"].as_str().unwrap_or(""), destination)?;
        guard.revalidate()
    }

    // ---- discovery

    fn next_item_id(rt: &Runtime) -> String {
        let mut s = rt.lock();
        s.item_sequence += 1;
        format!("item-{:06}", s.item_sequence)
    }

    fn create_queue_item(rt: &Runtime, discovered: &Value, changes: Vec<(&str, Value)>) -> Value {
        let mut m = obj(Some(discovered));
        m.insert("id".into(), json!(Self::next_item_id(rt)));
        m.insert("state".into(), ItemState::Queued.into());
        m.insert("attempts".into(), json!(0));
        for (k, v) in changes {
            m.insert(k.into(), v);
        }
        m.shift_remove("ino");
        Value::Object(m)
    }

    fn discovery_due(&self, rt: &Runtime, pending: usize, last_flush: i64, pending_work: usize) -> bool {
        let b = self.0.o.discovery_batch_size;
        if b == 1 {
            return true;
        }
        let s = rt.lock();
        if pending >= b.max(s.manifest.items.len() / 4) {
            return true;
        }
        if pending_work == 0 {
            return false;
        }
        let short = s.queue.len() < s.concurrency() * 2;
        short && (self.0.o.now)() - last_flush >= self.0.o.discovery_flush_ms
    }

    fn push_queue(rt: &Runtime, id: String) {
        rt.lock().queue.push_back(id);
        rt.cv.notify_all();
    }

    fn close_queue(rt: &Runtime) {
        rt.lock().queue_closed = true;
        rt.cv.notify_all();
    }

    /// produce(runtime)
    fn produce(&self, rt: &Arc<Runtime>) -> SResult<()> {
        let m = rt.manifest();
        let identity = |v: &Value| format!("{}\u{0}{}", v["relativePath"].as_str().unwrap_or(""), v["sourcePath"].as_str().unwrap_or(""));
        let mut known: std::collections::HashSet<String> = m.items.iter().map(|i| identity(i.value())).collect();
        let resume_after = m.config().get("resumeAfter").and_then(Value::as_str).map(str::to_string);
        let order = super::super::scanner::group_order(m.config().get("groupOrder")).unwrap_or_else(|_| super::super::scanner::DEFAULT_GROUP_ORDER.to_vec());
        let config = m.config().clone();
        let mut full = false;
        let mut pending: Vec<Value> = vec![];
        let mut pending_work = 0usize;
        let mut last_flush = i64::MIN / 2;
        let stopped = |rt: &Runtime| rt.lock().stopped();
        let flush = |pending: &mut Vec<Value>, pending_work: &mut usize, last_flush: &mut i64| -> SResult<()> {
            if pending.is_empty() {
                return Ok(());
            }
            let batch = std::mem::take(pending);
            *pending_work = 0;
            let b2 = batch.clone();
            self.update(rt, move |s| {
                let mut items: Vec<ItemIn> = s.manifest.items.iter().cloned().map(ItemIn::Trusted).collect();
                items.extend(b2.into_iter().map(ItemIn::Raw));
                Some(Patch::new().items(items))
            })?;
            if self.0.o.discovery_batch_size > 1 {
                *last_flush = (self.0.o.now)();
            }
            for it in batch {
                if item_state(&it) == ItemState::Queued {
                    Self::push_queue(rt, it["id"].as_str().unwrap().to_string());
                }
            }
            Ok(())
        };
        let signal = rt.signal();
        let mut failure: Option<Fail> = None;
        let retry = |dir: &Path, op: &mut dyn FnMut() -> std::io::Result<Vec<std::fs::DirEntry>>| -> std::io::Result<Vec<std::fs::DirEntry>> {
            let mut quick = 0;
            loop {
                match op() {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        let code = super::super::owned::code_of(&e);
                        if !tools::is_retryable(code) || rt.aborted() {
                            return Err(e);
                        }
                        match self.wait_for_network(rt, &dir.to_string_lossy(), false, None, None, None, None) {
                            Ok(true) => quick = 0,
                            Ok(false) => {
                                quick += 1;
                                if quick > QUICK_RETRY_LIMIT {
                                    return Err(e);
                                }
                            }
                            Err(_) => return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "CANCELLED")),
                        }
                    }
                }
            }
        };
        let scan = super::super::scanner::scan(&config, Some(&signal), Some(&retry), &mut |d| {
            if stopped(rt) {
                return false;
            }
            if let Some(after) = &resume_after {
                if super::super::scanner::compare_scan_paths(d.value["relativePath"].as_str().unwrap_or(""), after, &order) != std::cmp::Ordering::Greater {
                    return true;
                }
            }
            let key = identity(&d.value);
            if known.contains(&key) {
                return true;
            }
            if let Some(skip) = &self.0.o.skip_discovered {
                if skip(&config, &d.value) {
                    return true;
                }
            }
            if known.len() >= self.0.o.job_clip_limit {
                full = true;
                return false;
            }
            known.insert(key);
            let converted = {
                let mut found = d.value.clone();
                found["ino"] = json!(d.ino);
                self.converted_codec_of(rt, &found)
            };
            if converted.is_some() {
                pending.push(Self::create_queue_item(rt, &d.value, vec![("state", ItemState::Skipped.into()), ("eligibleVideo", json!(false)), ("resultCode", json!("already-converted"))]));
            } else {
                pending.push(Self::create_queue_item(rt, &d.value, vec![]));
                pending_work += 1;
            }
            if self.discovery_due(rt, pending.len(), last_flush, pending_work) {
                if let Err(e) = flush(&mut pending, &mut pending_work, &mut last_flush) {
                    failure = Some(e);
                    return false;
                }
            }
            true
        });
        let outcome = match (scan, failure) {
            (_, Some(f)) => Err(f),
            (Err(e), None) => Err(Fail::from(e)),
            (Ok(()), None) => Ok(()),
        };
        let outcome = outcome.and_then(|_| {
            if !stopped(rt) {
                flush(&mut pending, &mut pending_work, &mut last_flush)?;
                let last = if full { rt.manifest().items.last().and_then(|i| i.str("relativePath").map(str::to_string)) } else { None };
                self.update(rt, |_| {
                    let p = Patch::new().set("discoveryComplete", json!(true));
                    Some(match &last {
                        Some(l) => p.set("moreAfter", json!(l)),
                        None => p,
                    })
                })?;
                if let Some(index) = self.0.o.converted_index.clone() {
                    std::thread::spawn(move || {
                        index.flush();
                    });
                }
            }
            Ok(())
        });
        rt.lock().producer_done = true;
        Self::close_queue(rt);
        if let Err(e) = outcome {
            let controlled = {
                let s = rt.lock();
                s.cancel_requested || s.stop_requested || s.recovery_required || e.is("CANCELLED")
            } || rt.aborted();
            if !controlled {
                let code = stable_failure(&e, "discovery-failed");
                let retryable = Self::is_retryable_network(&e);
                self.update(rt, |_| Some(Patch::new().state(JobState::Failed).set("activeItemId", Value::Null).set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", json!({ "code": code, "retryable": retryable }))))?;
                return Err(e);
            }
        }
        Ok(())
    }

    /// convertedCodecOf(runtime, discovered): 'h265' / 'av1' for a clip that
    /// is converted already, from the index (no file access) or else from its
    /// MP4 header; None leaves it to the normal path, as does anything
    /// unexpected. A share that drops meanwhile is waited for.
    pub fn converted_codec_of(&self, rt: &Arc<Runtime>, discovered: &Value) -> Option<String> {
        if discovered["kind"] != "video" {
            return None;
        }
        if let Some(index) = &self.0.o.converted_index {
            if let Some(c) = index.has(discovered) {
                return Some(c);
            }
        }
        let source = discovered["sourcePath"].as_str()?.to_string();
        let size = discovered["sourceBytes"].as_u64().unwrap_or(0);
        let mut quick = 0;
        let codec = loop {
            if rt.aborted() {
                return None;
            }
            // withTimeout(..., headerCheckTimeoutMs): a read stuck on a share is left behind
            let (tx, rx) = std::sync::mpsc::channel();
            let tools = self.0.o.tools.clone();
            let signal = rt.signal();
            let src = source.clone();
            std::thread::spawn(move || {
                let _ = tx.send(tools.read_video_codec(&src, size, &signal));
            });
            match rx.recv_timeout(std::time::Duration::from_millis(self.0.o.header_check_timeout_ms)) {
                Ok(Ok(c)) => break c,
                Ok(Err(e)) => {
                    let code = super::super::owned::code_of(&e);
                    if !tools::is_retryable(code) || rt.aborted() {
                        return None;
                    }
                    match self.wait_for_network(rt, &source, false, None, None, None, None) {
                        Ok(true) => quick = 0,
                        Ok(false) => {
                            quick += 1;
                            if quick > QUICK_RETRY_LIMIT {
                                return None;
                            }
                        }
                        Err(_) => return None,
                    }
                }
                Err(_) => return None,
            }
        };
        let codec = codec.filter(|c| c == "h265" || c == "av1")?;
        if let Some(index) = &self.0.o.converted_index {
            index.add(discovered, &codec);
        }
        Some(codec)
    }

    /// rememberConverted(target, codec): the converted clip's new file goes
    /// into the index (best effort, off the worker's path)
    pub fn remember_converted(&self, target: &str, codec: &str) {
        let Some(index) = self.0.o.converted_index.clone() else { return };
        let (target, codec) = (target.to_string(), codec.to_string());
        std::thread::spawn(move || {
            let Ok(st) = std::fs::metadata(&target) else { return };
            if !st.is_file() {
                return;
            }
            use std::os::unix::fs::MetadataExt;
            index.add(&json!({ "sourcePath": target, "sourceBytes": st.len(), "mtimeMs": super::super::jobstore::normalize::num(super::super::jobstore::mtime_ms(&st)), "ino": st.ino() }), &codec);
        });
    }

    pub fn flush_converted_index(&self) {
        if let Some(index) = &self.0.o.converted_index {
            index.flush();
        }
    }

    // ---- pause

    fn persist_pause_when_parked(&self, rt: &Arc<Runtime>) -> SResult<()> {
        {
            let mut s = rt.lock();
            if !s.pause_requested || s.cancel_requested || s.pause_persisted || s.recovery_required || s.stop_requested || s.halted {
                return Ok(());
            }
            if s.live_workers == 0 || s.parked_workers < s.live_workers {
                return Ok(());
            }
            s.pause_persisted = true;
        }
        self.update(rt, |_| Some(Patch::new().state(JobState::Paused).set("activeItemId", Value::Null)))?;
        self.emit(rt, "paused", vec![]);
        Ok(())
    }

    fn wait_while_paused(&self, rt: &Arc<Runtime>) -> SResult<()> {
        let generation = {
            let mut s = rt.lock();
            if !s.pause_requested || s.cancel_requested {
                return Ok(());
            }
            s.parked_workers += 1;
            s.pause_generation
        };
        let r = self.persist_pause_when_parked(rt);
        let mut s = rt.lock();
        while s.pause_generation == generation && !s.cancel_requested && !s.stop_requested && !s.halted && !s.recovery_required {
            s = rt.cv.wait(s).unwrap_or_else(|p| p.into_inner());
        }
        s.parked_workers -= 1;
        r
    }

    // ---- workers

    /// startMissingWorkers(runtime): the workers each lane is missing
    pub fn start_missing_workers(&self, rt: &Arc<Runtime>) {
        let missing: Vec<(Option<lanes::Lane>, usize)> = {
            let s = rt.lock();
            let running = s.running && (!s.queue_closed || !s.queue.is_empty());
            if !running || !s.consuming || s.cancel_requested || s.stop_requested {
                return;
            }
            let list: Vec<Option<lanes::Lane>> = match &s.lane_plan {
                Some(p) if !p.fallback => p.devices.iter().map(|(id, d)| Some(lanes::Lane { id: id.clone(), device: d.clone() })).collect(),
                _ => vec![None],
            };
            list.into_iter()
                .map(|l| {
                    let id = l.as_ref().map(|l| l.id.clone());
                    let n = s.lane_limit(&id).saturating_sub(s.device_active(&id));
                    (l, n)
                })
                .collect()
        };
        for (lane, n) in missing {
            for _ in 0..n {
                self.add_worker(rt, lane.clone());
            }
        }
    }

    fn add_worker(&self, rt: &Arc<Runtime>, lane: Option<lanes::Lane>) {
        let me = self.clone();
        let rt2 = rt.clone();
        {
            let mut s = rt.lock();
            s.live_workers += 1;
            s.lane_counter(&lane.as_ref().map(|l| l.id.clone())).0 += 1;
        }
        let h = std::thread::spawn(move || me.work(&rt2, lane));
        rt.lock().workers.push(h);
    }

    /// work(runtime, lane): one worker (its live counts already taken)
    fn work(&self, rt: &Arc<Runtime>, lane: Option<lanes::Lane>) -> SResult<()> {
        let lane_id = lane.as_ref().map(|l| l.id.clone());
        let over = |s: &RtState| {
            let (live, retiring) = s.lane_counters.get(&lane_id).copied().unwrap_or((0, 0));
            live.saturating_sub(retiring) > s.lane_limit(&lane_id)
        };
        let mut retired = false;
        let r = (|| -> SResult<()> {
            loop {
                {
                    let s = rt.lock();
                    if s.cancel_requested || s.stop_requested || s.recovery_required {
                        break;
                    }
                }
                self.wait_while_paused(rt)?;
                {
                    let mut s = rt.lock();
                    if s.stopped() {
                        break;
                    }
                    if over(&s) {
                        s.lane_counter(&lane_id).1 += 1;
                        s.retiring += 1;
                        retired = true;
                        break;
                    }
                }
                // queue.shift()
                let next = {
                    let mut s = rt.lock();
                    loop {
                        if let Some(n) = s.queue.pop_front() {
                            break Some(n);
                        }
                        if s.queue_closed {
                            break None;
                        }
                        s = rt.cv.wait(s).unwrap_or_else(|p| p.into_inner());
                    }
                };
                let Some(next) = next else { break };
                if rt.lock().pause_requested {
                    self.wait_while_paused(rt)?;
                }
                {
                    let mut s = rt.lock();
                    if s.cancel_requested || s.stop_requested || s.recovery_required {
                        break;
                    }
                    if over(&s) {
                        s.queue.push_front(next);
                        s.lane_counter(&lane_id).1 += 1;
                        s.retiring += 1;
                        retired = true;
                        drop(s);
                        rt.cv.notify_all();
                        break;
                    }
                }
                let Some(item) = rt.lock().item(&next) else { continue };
                if item_state(&item) != ItemState::Queued {
                    continue;
                }
                Self::begin_item(rt, &item);
                let outcome = if item["kind"] == "asset" {
                    self.process_asset(rt, &item, ("asset-retained", "copied"))
                } else {
                    self.keep_original_when_no_savings(rt, &item, lane.as_ref())
                };
                let r = match outcome {
                    Ok(()) => Ok(()),
                    Err(e) => self.fail_item(rt, item["id"].as_str().unwrap(), &e),
                };
                self.finish_item(rt, item["id"].as_str().unwrap());
                r?;
            }
            Ok(())
        })();
        if r.is_err() {
            let mut s = rt.lock();
            s.halted = true;
            s.queue_closed = true;
        }
        {
            let mut s = rt.lock();
            s.live_workers -= 1;
            let c = s.lane_counter(&lane_id);
            c.0 -= 1;
            if retired {
                c.1 -= 1;
                s.retiring -= 1;
            }
        }
        rt.cv.notify_all();
        if retired {
            // its GPU may be waiting for it (a switch to or from lanes)
            self.start_missing_workers(rt);
        }
        let _ = self.persist_pause_when_parked(rt);
        r
    }

    /// consume(runtime): a job with lanes first finds its GPUs (again when
    /// the lanes changed meanwhile)
    fn consume(&self, rt: &Arc<Runtime>) -> SResult<()> {
        let mut plan = None;
        let mut current = lanes::lanes_of(&rt.manifest());
        while let Some(l) = current {
            let resolved = self.resolve_lanes(&l);
            let latest = lanes::lanes_of(&rt.manifest());
            if latest.as_ref() == Some(&l) {
                plan = Some(resolved);
                break;
            }
            current = latest;
        }
        let start: Vec<(Option<lanes::Lane>, usize)> = {
            let mut s = rt.lock();
            s.lane_plan = plan.clone();
            s.consuming = true;
            match &plan {
                Some(p) if !p.fallback => p.devices.iter().map(|(id, d)| (Some(lanes::Lane { id: id.clone(), device: d.clone() }), p.limits.get(id).copied().unwrap_or(0))).collect(),
                _ => vec![(None, s.concurrency())],
            }
        };
        for (lane, n) in start {
            for _ in 0..n {
                self.add_worker(rt, lane.clone());
            }
        }
        let mut first_err = None;
        loop {
            let h = rt.lock().workers.pop();
            let Some(h) = h else { break };
            match h.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => first_err = first_err.or(Some(e)),
                Err(_) => first_err = first_err.or(Some(service_error("WORKER_PANICKED"))),
            }
        }
        rt.lock().consuming = false;
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// launch(runtime, { discover, itemIds }): the job runs on a thread of its own
    pub fn launch(&self, rt: &Arc<Runtime>, discover: bool, item_ids: Vec<String>) {
        {
            let mut s = rt.lock();
            if s.suppress_launch {
                return;
            }
            if s.running && s.run_kind != Some("recovery") {
                return;
            }
            s.running = true;
            if s.run_kind != Some("recovery") {
                s.run_kind = Some("job");
            }
            for id in item_ids {
                s.queue.push_back(id);
            }
            if !discover {
                s.producer_done = true;
                s.queue_closed = true;
            }
        }
        let from_recovery = rt.lock().run_kind == Some("recovery");
        let me = self.clone();
        let rt2 = rt.clone();
        let body = move || {
            let producer = if discover {
                let me2 = me.clone();
                let rt3 = rt2.clone();
                Some(std::thread::spawn(move || me2.produce(&rt3)))
            } else {
                None
            };
            let consumed = me.consume(&rt2);
            let produced = producer.map(|h| h.join().unwrap_or_else(|_| Err(service_error("PRODUCER_PANICKED")))).unwrap_or(Ok(()));
            let rejected = produced.err().or(consumed.err());
            let state_failed = rt2.manifest().state() == JobState::Failed;
            let controlled = {
                let s = rt2.lock();
                s.cancel_requested || s.stop_requested || s.recovery_required
            };
            if let (Some(e), false, false) = (&rejected, state_failed, controlled) {
                let code = stable_failure(e, "operation-failed");
                let _ = me.update(&rt2, |_| Some(Patch::new().state(JobState::Failed).set("activeItemId", Value::Null).set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", json!({ "code": code, "retryable": false }))));
            } else {
                let _ = me.finalize(&rt2);
            }
            me.flush_converted_index();
        };
        if from_recovery {
            // (inside the recovery run: it waits for this one)
            body();
            return;
        }
        let me = self.clone();
        let rt3 = rt.clone();
        std::thread::spawn(move || {
            body();
            {
                let mut s = rt3.lock();
                s.running = false;
                s.run_kind = None;
            }
            rt3.cv.notify_all();
            me.forget_finished(&rt3);
        });
    }

    // ---- one clip

    fn source_mode(&self, rt: &Runtime, item: &Item_) -> SResult<String> {
        let m = rt.manifest();
        let mut mode = m.config()["networkMode"].as_str().unwrap_or("direct").to_string();
        let free = || staging::statvfs_free(self.0.o.staging.temp_root()).map_err(|_| ());
        let mut space = None;
        if mode == "auto" {
            let c = staging::classify_path(&item.s("sourcePath")).map_err(Fail::from)?;
            let sp = staging::check_staging_space(item.n("sourceBytes"), Some(item.n("sourceBytes")), None, free()).map_err(Fail::from)?;
            mode = staging::choose_staging_mode("auto", &c, Some(&sp)).map_err(Fail::from)?.0.to_string();
            space = Some(sp);
        }
        if mode == "staging" && space.is_none() {
            let sp = staging::check_staging_space(item.n("sourceBytes"), Some(item.n("sourceBytes")), None, free()).map_err(Fail::from)?;
            if !sp.sufficient {
                return Err(service_error("INSUFFICIENT_STAGING_SPACE"));
            }
        }
        Ok(mode)
    }

    /// videoSource: (source to read, its staged ownership, the original's fingerprint)
    fn video_source(&self, rt: &Arc<Runtime>, item: &Item_, mode: &str) -> SResult<(String, Option<Own>, Option<SourceAuthority>)> {
        let id = item.s("id");
        let replacing = rt.manifest().config()["outputMode"] == "replace";
        let signal = rt.signal();
        if mode != "staging" {
            let mut expected = None;
            if replacing {
                let a = self.0.o.staging.capture_source(&item.s("sourcePath"), Some(&signal)).map_err(Fail::from)?;
                self.item_patch(rt, &id, vec![("expectedSource", Some(authority_value(&a)))], vec![])?;
                expected = Some(a);
            }
            return Ok((item.s("sourcePath"), None, expected));
        }
        let persist = self.persistence(rt, &id, false);
        let mut op = self.op(rt, &id, &signal, &persist);
        op.source = Some(item.s("sourcePath"));
        op.record_expected_source = replacing;
        let staged = self.0.o.staging.stage_source(&op).map_err(Fail::from)?;
        let authority = staged.expected_source.clone();
        if replacing {
            let recorded = rt.lock().item(&id).and_then(|i| authority_of(i.get("expectedSource")));
            if recorded.as_ref() != Some(&authority) {
                self.item_patch(rt, &id, vec![("expectedSource", Some(authority_value(&authority)))], vec![])?;
            }
        }
        let own = Own::from_typed(&staged.owned_paths, &staged.owned_artifacts);
        Ok((staged.staged_source.clone(), if own.paths.is_empty() { None } else { Some(own) }, Some(authority)))
    }

    /// processAsset (also a video kept because converting saves nothing)
    pub fn process_asset(&self, rt: &Arc<Runtime>, item_v: &Value, codes: (&str, &str)) -> SResult<()> {
        let item = Item_ { v: item_v.clone() };
        let id = item.s("id");
        let m = rt.manifest();
        if m.config()["outputMode"] == "replace" {
            self.item_patch(rt, &id, vec![("state", Some(ItemState::Skipped.into())), ("resultCode", Some(json!(codes.0))), ("eligibleVideo", Some(json!(false)))], vec![("state", JobState::Waiting.into()), ("activeItemId", Value::Null)])?;
            return Ok(());
        }
        let destination = output_path(m.config(), item_v);
        self.acquire_commit(rt, &id)?;
        self.item_patch(rt, &id, vec![("state", Some(ItemState::Processing.into())), ("eligibleVideo", Some(json!(false)))], vec![("state", JobState::Copying.into()), ("activeItemId", json!(id))])?;
        let config = m.config().clone();
        let result = self.retry_transaction(rt, &id, &destination, config["destinationRoot"].as_str().unwrap_or(""), || {
            self.prepare_destination(&config, &destination)?;
            let signal = rt.signal();
            let persist = self.persistence(rt, &id, false);
            let mut op = self.op(rt, &id, &signal, &persist);
            op.source = Some(item.s("sourcePath"));
            op.source_root = config["sourceRoot"].as_str().map(str::to_string);
            op.destination = Some(destination.clone());
            op.destination_root = config["destinationRoot"].as_str().map(str::to_string);
            self.0.o.staging.copy_asset(&op).map_err(Fail::from)
        });
        let result = match result {
            Ok(r) => r,
            Err(e) => match e.valid_final.clone() {
                Some(v) => v,
                None => return Err(e),
            },
        };
        let own = Own::from_typed(&result.owned_paths, &result.owned_artifacts);
        let cleanup = self.cleanup_ownership(rt, &id, Some(&own), None, false);
        let completed: Changes = vec![
            ("state", Some(ItemState::Completed.into())),
            ("eligibleVideo", Some(json!(false))),
            ("outputPath", Some(json!(result.final_path))),
            ("outputBytes", Some(json!(result.output_bytes))),
            ("resultCode", Some(json!(if cleanup.pending.is_empty() { codes.1 } else { "completed-cleanup-pending" }))),
            ("ownedPaths", Some(if cleanup.cleaned { json!({}) } else { Value::Object(own.paths.clone()) })),
            ("ownedArtifacts", Some(if cleanup.cleaned { json!({}) } else { Value::Object(own.arts.clone()) })),
        ];
        self.update(rt, |s| {
            let finished = merge(&s.item(&id).unwrap_or(Value::Null), &completed);
            let counters = contracts::add_completed_file(s.manifest.get("counters").unwrap_or(&Value::Null), &finished);
            let items = with_item(&s.manifest, &id, |_| finished.clone());
            Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("ownedPaths", Value::Null).set("ownedArtifacts", Value::Null).set("publicationArtifact", Value::Null).set("counters", counters).items(items))
        })?;
        Ok(())
    }

    fn keep_original_when_no_savings(&self, rt: &Arc<Runtime>, item: &Value, lane: Option<&lanes::Lane>) -> SResult<()> {
        match self.process_video(rt, item, lane) {
            Err(e) if e.is("KEEP_ORIGINAL") && Self::ownership_for(rt, item["id"].as_str().unwrap()).map_or(true, |o| o.paths.is_empty()) => {
                let current = rt.lock().item(item["id"].as_str().unwrap()).unwrap_or_else(|| item.clone());
                self.process_asset(rt, &current, ("no-savings", "no-savings"))
            }
            other => other,
        }
    }

    /// processVideo: network waits around processVideoOnce
    fn process_video(&self, rt: &Arc<Runtime>, item: &Value, lane: Option<&lanes::Lane>) -> SResult<()> {
        let id = item["id"].as_str().unwrap().to_string();
        let mut quick = 0;
        loop {
            if rt.lock().stopped() {
                return Err(service_error("CANCELLED"));
            }
            let current = rt.lock().item(&id).unwrap_or_else(|| item.clone());
            match self.process_video_once(rt, &current, lane) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if !Self::is_retryable_network(&e) {
                        return Err(e);
                    }
                    let affected = e.path.clone().unwrap_or_else(|| item["sourcePath"].as_str().unwrap_or("").to_string());
                    if Self::ownership_for(rt, &id).is_some_and(|o| !o.paths.is_empty()) && !self.reconcile_item_ownership(rt, &id, Self::ownership_for(rt, &id), false)? {
                        return Err(service_error("OWNED_CLEANUP_FAILED"));
                    }
                    let probe = e.network_probe_path.clone().unwrap_or(affected);
                    if self.wait_for_network(rt, &probe, true, Some(&id), e.path_role.as_deref(), None, None)? {
                        quick = 0;
                        continue;
                    }
                    if !self.path_present(rt, item["sourcePath"].as_str().unwrap_or("")) {
                        return Err(service_error("SOURCE_MISSING"));
                    }
                    quick += 1;
                    if quick > QUICK_RETRY_LIMIT {
                        return Err(e);
                    }
                }
            }
        }
    }

    fn compose_into(rt: &Runtime, id: &str, incoming: &Own) {
        let base = Self::ownership_for(rt, id).unwrap_or_default();
        Self::set_ownership(rt, id, Some(compose(&base, &incoming.to_value(), &[])));
    }

    /// processVideoOnceChecked
    fn process_video_once(&self, rt: &Arc<Runtime>, item_v: &Value, lane: Option<&lanes::Lane>) -> SResult<()> {
        let item = Item_ { v: item_v.clone() };
        let id = item.s("id");
        let signal = rt.signal();
        let mut timing = Timing::new();
        let inspected = self.0.o.tools.inspect_video(&item.s("sourcePath"), &signal).map_err(Fail::from)?;
        timing.mark("inspect");
        if inspected.codec == "h265" || inspected.codec == "av1" {
            // its header could not tell: remembered now, the next run skips it
            if let Some(index) = &self.0.o.converted_index {
                index.add(&item.v, &inspected.codec);
            }
            self.item_patch(rt, &id, vec![("state", Some(ItemState::Skipped.into())), ("eligibleVideo", Some(json!(false))), ("resultCode", Some(json!("already-converted")))], vec![("state", JobState::Waiting.into()), ("activeItemId", Value::Null)])?;
            return Ok(());
        }
        if inspected.codec != "h264" {
            return Err(service_error("UNSUPPORTED_CODEC"));
        }
        let mode = self.source_mode(rt, &item)?;
        let step = if mode == "staging" { JobState::Staging } else { JobState::Waiting };
        self.item_patch(rt, &id, vec![("state", Some(ItemState::Processing.into())), ("eligibleVideo", Some(json!(true)))], vec![("state", step.into()), ("activeItemId", json!(id))])?;
        let (source, staged_own, expected) = {
            let _read = self.take_read_slot(rt)?;
            self.video_source(rt, &item, &mode)?
        };
        timing.mark("source");
        let r = self.convert(rt, &item, &source, staged_own.as_ref(), expected.as_ref(), &inspected, &mut timing, lane);
        if let Err(e) = r {
            let cleanup = self.cleanup_ownership(rt, &id, staged_own.as_ref(), None, false);
            if !cleanup.cleaned {
                if let Some(o) = &staged_own {
                    Self::compose_into(rt, &id, o);
                }
            }
            return Err(e);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn convert(&self, rt: &Arc<Runtime>, item: &Item_, source: &str, staged_own: Option<&Own>, expected: Option<&SourceAuthority>, inspected: &tools::Inspected, timing: &mut Timing, lane: Option<&lanes::Lane>) -> SResult<()> {
        let id = item.s("id");
        let signal = rt.signal();
        let m = rt.manifest();
        let config = m.config().clone();
        let timeline = self.0.o.tools.read_timeline(source, &signal).map_err(Fail::from)?;
        timing.mark("timeline");
        // Probing and service decode state stay outside the pure clip plan.
        let codec = config["codec"].as_str().unwrap_or("h265");
        let cpu_only = config["profileId"].as_str().unwrap_or("") == contracts::SMALLEST_PROFILE_ID;
        let selected: Selected = match lane {
            _ if cpu_only => self.0.o.tools.select_cpu_fallback(codec),
            Some(l) => self.0.o.tools.select_for(codec, &super::super::devices::device_of(&l.device)),
            None => self.0.o.tools.select(codec),
        }
        .map_err(Fail::from)?;
        let mut used_cpu_fallback = !selected.hardware;
        // set once a node gave the clip back (or its lane landed here because
        // the node has no encoder for the codec): its encodes here wait their turn
        let mut from_node = lane.is_some_and(|l| l.id.starts_with("node:")) && !selected.remote;
        if from_node && rt.lock().own_lanes_off() {
            return Err(service_error("NODE_NO_ENCODER"));
        }
        let mut check: Option<CheckSlot> = None;
        let zero_copy = super::super::lead_in::hold_frames(Some(&timeline.lead_in)) == 0;
        let tiers = self.encode_decode_tiers(&selected, zero_copy);
        let InitialPlan { mut selected, mut bitrate, mut quality, smallest, keep_order, hold_frames, decode: mut tiers, codec, profile_id, cpu_only, no_target, target_bytes, duration_us } =
            initial_plan(&config, item.n("sourceBytes"), inspected, &timeline, selected, tiers)?;
        // Used only after a no-target encode was measured and was not smaller.
        let initial = |target: f64| planner::calculate_initial_bitrate(&codec, target, inspected.duration_seconds, 0.0, 0.0).map(|b| b as f64).map_err(|_| service_error("INVALID_BITRATE"));
        let mut failed_tiers: Vec<String> = vec![];
        let mut tier_retry = false;
        let mut size_retry = 0i64;
        let mut under_source = 0usize;
        let mut attempts = rt.lock().item(&id).and_then(|i| i["attempts"].as_i64()).unwrap_or(0);
        let mut latest: Option<Own> = staged_own.cloned();
        while !rt.lock().stopped() {
            // a slower decode tier with the same encoder is not a new attempt
            if !tier_retry {
                attempts += 1;
            }
            tier_retry = false;
            attempts = attempts.min(MAX_RECORDED_ATTEMPTS);
            self.item_patch(rt, &id, vec![("attempts", Some(json!(attempts))), ("encoder", Some(json!(selected.codec)))], vec![("state", JobState::Encoding.into()), ("activeItemId", json!(id))])?;
            // its node's row was set to Off while the clip was being read: back to the queue
            if selected.remote && lane.is_some_and(|l| rt.lock().lane_limit(&Some(l.id.clone())) == 0) {
                return Err(service_error("NODE_WITHDRAWN"));
            }
            let persist = self.persistence(rt, &id, false);
            let mut op = self.op(rt, &id, &signal, &persist);
            op.extension = Some(".mp4".into());
            let reserved = self.0.o.staging.reserve_encode_output(&op).map_err(Fail::from)?;
            let reserved_own = Own::from_typed(&reserved.owned_paths, &reserved.owned_artifacts);
            latest = Some(reserved_own.clone());
            Self::compose_into(rt, &id, &reserved_own);
            let used_tier = tiers.first().cloned();
            let fallback = if from_node { Some(self.take_fallback_slot(rt)?) } else { None };
            let encoded = self.run_child(rt, &id, &EncodeRequest { source, target: &reserved.path, codec: &codec, encoder: &selected, bitrate, quality: quality.as_deref(), duration_us, window: None, hold_frames, smallest, keep_order, decode: used_tier.as_ref().map(|t| t.1.as_slice()), lane_id: lane.map(|l| l.id.as_str()) });
            drop(fallback);
            timing.mark("encode");
            if let Err(code) = encoded {
                let settle = if code == "cancelled" { timeout_flag(15_000) } else { rt.signal() };
                let mut failed_own = reserved_own.clone();
                let mut op = self.op(rt, &id, &settle, &persist);
                op.owned_paths = reserved.owned_paths.clone();
                op.owned_artifacts = reserved.owned_artifacts.clone();
                if let Ok(a) = self.0.o.staging.adopt_encode_output(&op) {
                    failed_own = Own::from_typed(&a.owned_paths, &a.owned_artifacts);
                    latest = Some(failed_own.clone());
                    Self::compose_into(rt, &id, &failed_own);
                }
                let cleanup = self.cleanup_ownership(rt, &id, Some(&failed_own), Some(settle.clone()), false);
                if !cleanup.cleaned {
                    Self::compose_into(rt, &id, &failed_own);
                    return Err(service_error("OWNED_CLEANUP_FAILED"));
                }
                if code == "cancelled" {
                    return Err(service_error("CANCELLED"));
                }
                // taken back from a node's queue: queued here again (see failItem)
                if code == "withdrawn" {
                    return Err(service_error("NODE_WITHDRAWN"));
                }
                // the same GPU encoder with a slower decode before giving up on it
                if let Some(t) = used_tier {
                    failed_tiers.push(t.0);
                    tiers.remove(0);
                    tier_retry = true;
                    continue;
                }
                // a node that failed: this server's own encoder takes the clip, then the CPU
                if selected.remote {
                    if rt.lock().own_lanes_off() {
                        return Err(service_error("NODE_ENCODE_FAILED"));
                    }
                    from_node = true;
                    selected = self.local_encoder(&codec, cpu_only)?;
                    tiers = self.encode_decode_tiers(&selected, zero_copy);
                    used_cpu_fallback = !selected.hardware;
                    continue;
                }
                if selected.hardware && !used_cpu_fallback {
                    selected = self.0.o.tools.select_cpu_fallback(&codec).map_err(Fail::from)?;
                    used_cpu_fallback = true;
                    continue;
                }
                return Err(service_error("ENCODER_FAILED"));
            }
            self.mark_broken_tiers(&selected, &mut failed_tiers);
            let mut op = self.op(rt, &id, &signal, &persist);
            op.owned_paths = reserved.owned_paths.clone();
            op.owned_artifacts = reserved.owned_artifacts.clone();
            let adopted = self.0.o.staging.adopt_encode_output(&op).map_err(Fail::from)?;
            let mut adopted_own = Own::from_typed(&adopted.owned_paths, &adopted.owned_artifacts);
            latest = Some(adopted_own.clone());
            Self::compose_into(rt, &id, &adopted_own);
            self.item_patch(rt, &id, vec![], vec![("state", JobState::WritingTelemetry.into()), ("activeItemId", json!(id))])?;
            if let Err(e) = self.0.o.tools.write_telemetry(&codec, &reserved.path, &timeline, &signal) {
                let mut op = self.op(rt, &id, &signal, &persist);
                op.owned_paths = adopted_own.paths_typed();
                op.owned_artifacts = adopted_own.arts_typed();
                if let Ok(a) = self.0.o.staging.adopt_encode_output(&op) {
                    adopted_own = Own::from_typed(&a.owned_paths, &a.owned_artifacts);
                    Self::compose_into(rt, &id, &adopted_own);
                }
                let _ = latest;
                return Err(Fail::from(e));
            }
            let mut op = self.op(rt, &id, &signal, &persist);
            op.owned_paths = adopted_own.paths_typed();
            op.owned_artifacts = adopted_own.arts_typed();
            let adopted = self.0.o.staging.adopt_encode_output(&op).map_err(Fail::from)?;
            adopted_own = Own::from_typed(&adopted.owned_paths, &adopted.owned_artifacts);
            latest = Some(adopted_own.clone());
            Self::compose_into(rt, &id, &adopted_own);
            timing.mark("metadata");
            self.item_patch(rt, &id, vec![], vec![("state", JobState::Verifying.into()), ("activeItemId", json!(id))])?;
            // Encoded on another server: its pictures must match the original's
            // before anything else is checked or saved (unless the node is trusted)
            let node_id = selected.device.as_ref().map(|d| d.id.clone()).unwrap_or_default();
            let trusted = selected.remote && self.0.o.remote_nodes.as_ref().is_some_and(|n| n.trusted(&node_id));
            if selected.remote && !trusted {
                if check.is_none() {
                    check = Some(self.take_check_slot(rt, lane)?);
                }
                timing.mark("checkWait");
                let same = match &self.0.o.compare_picture {
                    Some(f) => f(source, &adopted.path, &signal, Some(inspected.duration_seconds)),
                    None => json!({ "ok": false, "reason": "no-picture-check" }),
                };
                timing.mark("picture");
                if rt.aborted() || rt.lock().stopped() {
                    return Err(service_error("CANCELLED"));
                }
                if same["ok"] != true {
                    let here = !rt.lock().own_lanes_off();
                    let shown = selected.device.as_ref().and_then(|d| d.name.clone()).unwrap_or_else(|| "a node".into());
                    eprintln!("[CONVERTER] The encode from {shown} does not show the original's pictures; {}: {} {}", if here { "encoding it on this server instead" } else { "not encoded here (this server is set to Off)" }, item.s("relativePath"), same.to_string().chars().take(200).collect::<String>());
                    let cleanup = self.cleanup_ownership(rt, &id, Some(&adopted_own), None, false);
                    if !cleanup.cleaned {
                        Self::compose_into(rt, &id, &adopted_own);
                        return Err(service_error("OWNED_CLEANUP_FAILED"));
                    }
                    if !here {
                        return Err(service_error("NODE_PICTURE_MISMATCH"));
                    }
                    from_node = true;
                    drop(check.take());
                    selected = self.local_encoder(&codec, cpu_only)?;
                    tiers = self.encode_decode_tiers(&selected, zero_copy);
                    used_cpu_fallback = !selected.hardware;
                    continue;
                }
            }
            let verify_mode = contracts::effective_verify_mode(config["verifyMode"].as_str(), config["outputMode"].as_str());
            let verify_accel = if verify_mode == "full" { self.verify_decode_accel(&selected) } else { None };
            let verified_key = Self::decode_key(&selected);
            let me = self.clone();
            let verdict = self.0.o.tools.verify(&tools::VerifyRequest {
                source,
                candidate: &adopted.path,
                codec: &codec,
                profile_id: &profile_id,
                timeline: &timeline,
                source_duration_us: duration_us.map(|d| d as f64),
                verify_mode,
                keep_off_target: config.get("keepOffTarget") == Some(&json!(true)),
                allow_larger: no_target && config.get("keepLarger") == Some(&json!(true)) && under_source >= UNDER_SOURCE_SHARES.len(),
                cancel: signal.clone(),
                decode_accel: verify_accel.unwrap_or_default(),
                on_decode_accel_fallback: Some(Arc::new(move || me.note_verify_fallback(&verified_key))),
            });
            timing.mark("verify");
            drop(check.take());
            let details = verdict.details.clone();
            if verdict.ok && details.get("larger") == Some(&json!(true)) {
                eprintln!("[CONVERTER] Kept although larger (option on): {} {} bytes larger than the original", item.s("relativePath"), details["largerBytes"]);
            }
            if verdict.ok && details.get("offTarget") == Some(&json!(true)) {
                let retry = planner::decide_size_retry(size_retry, Some("profile-size"), &codec, &selected.codec, bitrate.unwrap_or(0.0), verdict.output_bytes.unwrap_or(0) as f64, target_bytes.unwrap_or(0.0)).unwrap_or((false, None));
                if retry.0 {
                    let cleanup = self.cleanup_ownership(rt, &id, Some(&adopted_own), None, false);
                    if !cleanup.cleaned {
                        Self::compose_into(rt, &id, &adopted_own);
                        return Err(Fail { code: Some("profile-size".into()), retryable: true, ..Default::default() });
                    }
                    size_retry += 1;
                    bitrate = retry.1.map(|b| b as f64);
                    continue;
                }
                eprintln!("[CONVERTER] Kept off its size target (option on): {} {}% smaller, target {}%", item.s("relativePath"), details["offTargetSavedPercent"], details["offTargetTargetPercent"]);
            }
            if !verdict.ok {
                let retry = planner::decide_size_retry(size_retry, verdict.reason, &codec, &selected.codec, bitrate.unwrap_or(0.0), verdict.output_bytes.unwrap_or(0) as f64, target_bytes.unwrap_or(0.0)).unwrap_or((false, None));
                let cleanup = self.cleanup_ownership(rt, &id, Some(&adopted_own), None, false);
                if !cleanup.cleaned {
                    Self::compose_into(rt, &id, &adopted_own);
                    return Err(Fail { code: Some(verdict.reason.unwrap_or("VERIFICATION_FAILED").into()), retryable: verdict.retryable, ..Default::default() });
                }
                if retry.0 {
                    size_retry += 1;
                    bitrate = retry.1.map(|b| b as f64);
                    continue;
                }
                if no_target && verdict.reason == Some("not-smaller") {
                    if under_source < UNDER_SOURCE_SHARES.len() {
                        let share = UNDER_SOURCE_SHARES[under_source];
                        under_source += 1;
                        quality = None;
                        let mut b = initial((item.n("sourceBytes") as f64 * share).floor())?;
                        if selected.hardware {
                            b = (tools::bitrate_floor(&codec) as f64).max((b * 0.93).floor());
                        }
                        bitrate = Some(b);
                        continue;
                    }
                    return Err(service_error("KEEP_ORIGINAL"));
                }
                // a node's encode that does not verify: encoded here instead
                if selected.remote && !rt.lock().own_lanes_off() {
                    let shown = selected.device.as_ref().and_then(|d| d.name.clone()).unwrap_or_else(|| "a node".into());
                    eprintln!("[CONVERTER] The encode from {shown} did not verify ({}); encoding it on this server instead: {} {}", verdict.reason.unwrap_or("unknown"), item.s("relativePath"), details.to_string().chars().take(300).collect::<String>());
                    from_node = true;
                    selected = self.local_encoder(&codec, cpu_only)?;
                    tiers = self.encode_decode_tiers(&selected, zero_copy);
                    used_cpu_fallback = !selected.hardware;
                    continue;
                }
                eprintln!("[CONVERTER] Verification failed: {} {} {}", item.s("relativePath"), verdict.reason.unwrap_or("unknown"), details.to_string().chars().take(600).collect::<String>());
                return Err(Fail { code: Some(verdict.reason.unwrap_or("VERIFICATION_FAILED").into()), retryable: verdict.retryable, ..Default::default() });
            }
            let Some(artifact) = verdict.publication_artifact.clone() else { return Err(service_error("INVALID_PUBLICATION_ARTIFACT")) };
            let destination = output_path(&config, &item.v);
            return self.save_split(rt, item, &artifact, &destination, timing, expected, &codec, &verdict, &selected, attempts);
        }
        self.cleanup_ownership(rt, &id, latest.as_ref(), None, false);
        Err(service_error("CANCELLED"))
    }

    /// publicationError: network errors while saving go to the path the job waits for
    fn publication_error(&self, rt: &Runtime, e: Fail, destination: &str) -> Fail {
        if !Self::is_retryable_network(&e) {
            return e;
        }
        let m = rt.manifest();
        let replace = m.config()["outputMode"] == "replace";
        Fail {
            code: e.code.clone(),
            path: Some(destination.into()),
            network_probe_path: m.config()[if replace { "sourceRoot" } else { "destinationRoot" }].as_str().map(str::to_string),
            path_role: Some(if replace { "source" } else { "destination" }.into()),
            retryable: true,
            ..Default::default()
        }
    }

    /// saveSplit
    #[allow(clippy::too_many_arguments)]
    fn save_split(&self, rt: &Arc<Runtime>, item: &Item_, artifact: &super::super::snapshot::Artifact, destination: &str, timing: &mut Timing, expected: Option<&SourceAuthority>, codec: &str, verdict: &super::super::verifier::Verdict, selected: &Selected, attempts: i64) -> SResult<()> {
        let id = item.s("id");
        let config = rt.manifest().config().clone();
        let replace = config["outputMode"] == "replace";
        let signal = rt.signal();
        let outside = self.persistence(rt, &id, true);
        let common = self.persistence(rt, &id, false);
        let prepared = {
            let mut op = self.op(rt, &id, &signal, &outside);
            op.publication_artifact = Some(artifact.clone());
            let r = if replace {
                op.source = Some(item.s("sourcePath"));
                op.expected_source = expected.cloned();
                op.source_root = config["sourceRoot"].as_str().map(str::to_string);
                self.0.o.staging.prepare_replacement(&op).map_err(Fail::from)
            } else {
                self.prepare_destination(&config, destination).and_then(|_| {
                    op.destination = Some(destination.into());
                    self.0.o.staging.prepare_publication(&op).map_err(Fail::from)
                })
            };
            r.map_err(|e| self.publication_error(rt, e, destination))?
        };
        timing.mark("save");
        self.acquire_commit(rt, &id)?;
        timing.mark("saveWait");
        let slot_started = Instant::now();
        let saved = (|| -> SResult<staging::Saved> {
            let op = Op { prepared: Some(&prepared), persist: Some(&common), ..Default::default() };
            if replace {
                self.0.o.staging.swap_replacement(&op).map_err(Fail::from)
            } else {
                self.update(rt, |s| {
                    let e = s.item(&id).unwrap_or(Value::Null);
                    Some(Patch::new().state(JobState::Copying).set("activeItemId", json!(id)).set("ownedPaths", e.get("ownedPaths").cloned().unwrap_or(json!({}))).set("ownedArtifacts", e.get("ownedArtifacts").cloned().unwrap_or(json!({}))).set("publicationArtifact", e.get("publicationArtifact").cloned().unwrap_or(Value::Null)))
                })?;
                self.prepare_destination(&config, destination)?;
                self.0.o.staging.commit_publication(&op).map_err(Fail::from)
            }
        })();
        let published = match saved {
            Ok(p) => p,
            Err(e) => match e.valid_final.clone() {
                Some(v) => v,
                None => {
                    if e.rolled_back {
                        let mut cleared = false;
                        for attempt in 0..3u64 {
                            if attempt > 0 {
                                std::thread::sleep(Duration::from_millis(100 * attempt));
                            }
                            cleared = self
                                .update(rt, |s| {
                                    if s.manifest.str("activeItemId") == Some(id.as_str()) && s.manifest.get("replacementPhase").is_some() {
                                        Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("replacementPhase", Value::Null).set("ownedPaths", json!({})).set("ownedArtifacts", json!({})).set("publicationArtifact", Value::Null))
                                    } else {
                                        None
                                    }
                                })
                                .is_ok();
                            if cleared {
                                break;
                            }
                        }
                        if !cleared {
                            return Err(Fail { code: Some("REPLACEMENT_RECORD_STALE".into()), replacement_record_stale: true, ..Default::default() });
                        }
                    }
                    return Err(self.publication_error(rt, e, destination));
                }
            },
        };
        let memory = Self::ownership_for(rt, &id).unwrap_or_default();
        let mut leftover = Own::default();
        for k in ["stagedSource", "encodedCandidate"] {
            if let (Some(p), Some(a)) = (memory.paths.get(k), memory.arts.get(k)) {
                leftover.paths.insert(k.into(), p.clone());
                leftover.arts.insert(k.into(), a.clone());
            }
        }
        let pub_own = Own::from_typed(&published.owned_paths, &published.owned_artifacts);
        leftover.paths.extend(pub_own.paths.clone());
        leftover.arts.extend(pub_own.arts.clone());
        let artifact_v = serde_json::to_value(artifact).unwrap();
        if leftover.paths.contains_key("publicationSnapshot") {
            leftover.publication = Some(artifact_v.clone());
        }
        let mut completed: Changes = vec![
            ("state", Some(ItemState::Completed.into())),
            ("eligibleVideo", Some(json!(true))),
            ("outputPath", Some(json!(published.final_path))),
            ("outputBytes", Some(json!(verdict.output_bytes.unwrap_or(0)))),
            ("attempts", Some(json!(attempts))),
            ("encoder", Some(json!(selected.codec))),
            ("resultCode", Some(json!(if published.cleanup_pending.is_empty() { "converted" } else { "completed-cleanup-pending" }))),
        ];
        if verdict.details.get("offTarget") == Some(&json!(true)) {
            completed.push(("offTarget", Some(json!({ "savedPercent": verdict.details["offTargetSavedPercent"], "targetPercent": verdict.details["offTargetTargetPercent"] }))));
        }
        completed.push(("ownedPaths", Some(Value::Object(leftover.paths.clone()))));
        completed.push(("ownedArtifacts", Some(Value::Object(leftover.arts.clone()))));
        completed.push(("publicationArtifact", leftover.publication.clone()));
        completed.push(("replacementPhase", None));
        completed.push(("failure", None));
        self.update(rt, |s| {
            let finished = merge(&s.item(&id).unwrap_or(Value::Null), &completed);
            let counters = contracts::add_completed_file(s.manifest.get("counters").unwrap_or(&Value::Null), &finished);
            let items = with_item(&s.manifest, &id, |_| finished.clone());
            Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("ownedPaths", Value::Null).set("ownedArtifacts", Value::Null).set("publicationArtifact", Value::Null).set("replacementPhase", Value::Null).set("counters", counters).items(items))
        })?;
        Self::set_ownership(rt, &id, Some(leftover.clone()));
        timing.mark("save");
        let slot_ms = slot_started.elapsed().as_millis() as i64;
        Self::release_commit(rt, &id);
        let cleanup = self.cleanup_ownership(rt, &id, Some(&leftover), Some(timeout_flag(15_000)), true);
        let retained = if cleanup.cleaned { None } else { Some(compose(&leftover, &cleanup.result_value(), &[])) };
        timing.mark("cleanup");
        let (phases, total) = timing.result();
        let _ = self.update(rt, |s| {
            let mut changes: Changes = vec![];
            match &retained {
                Some(r) => {
                    changes.push(("ownedPaths", Some(Value::Object(r.paths.clone()))));
                    changes.push(("ownedArtifacts", Some(Value::Object(r.arts.clone()))));
                    let keep = r.paths.contains_key("publicationSnapshot") && leftover.publication.is_some();
                    changes.push(("publicationArtifact", if keep { leftover.publication.clone() } else { None }));
                    changes.push(("resultCode", Some(json!("completed-cleanup-pending"))));
                }
                None => {
                    changes.push(("ownedPaths", Some(json!({}))));
                    changes.push(("ownedArtifacts", Some(json!({}))));
                    changes.push(("publicationArtifact", None));
                }
            }
            let timings = contracts::add_item_timings(s.manifest.get("timings"), &phases);
            Some(Patch::new().set("timings", timings).items(with_item(&s.manifest, &id, |it| merge(it, &changes))))
        });
        Self::set_ownership(rt, &id, retained);
        let mut fields = vec![
            ("itemId", json!(id)),
            ("relativePath", json!(item.s("relativePath"))),
            ("encoder", json!(selected.codec)),
            ("outputPath", json!(published.final_path)),
            ("sourceBytes", json!(item.n("sourceBytes"))),
            ("outputBytes", json!(verdict.output_bytes.unwrap_or(0))),
            ("attempts", json!(attempts)),
            ("slotMs", json!(slot_ms)),
        ];
        fields.push(("phases", phases));
        fields.push(("totalMs", json!(total)));
        self.remember_converted(&published.final_path, codec);
        self.emit(rt, "item_timing", fields);
        Ok(())
    }

    /// failItem(runtime, itemId, error)
    pub fn fail_item(&self, rt: &Arc<Runtime>, item_id: &str, e: &Fail) -> SResult<()> {
        let retryable = e.retryable || Self::is_retryable_network(e);
        let code = stable_failure(e, "operation-failed");
        // why an unsafe-owned-path refusal fired, shown as failure.detail in the snapshot (never stored)
        super::set_failure_detail(rt.manifest().id(), item_id, e.detail.as_deref().filter(|_| code == super::UNSAFE_OWNED_PATH_RESULT));
        if e.code.is_none() {
            eprintln!("[CONVERTER] Unexpected clip failure: {e:?}");
        }
        let ownership = Self::ownership_for(rt, item_id);
        if ownership.as_ref().is_some_and(|o| o.paths.contains_key("replacementBackup")) || e.is("ROLLBACK_FAILED") || e.replacement_record_stale {
            {
                let mut s = rt.lock();
                if !s.recovery_required {
                    s.recovery_required = true;
                    s.recovery_item_id = Some(item_id.to_string());
                }
                s.queue_closed = true;
            }
            rt.do_abort();
            self.terminate_children(rt);
            Self::wake_paused(rt);
            let phase = rt.manifest().replacement_phase().unwrap_or(ReplacementPhase::RollbackFailed);
            self.item_patch(rt, item_id, vec![("state", Some(ItemState::Processing.into())), ("resultCode", Some(json!("recovery-required"))), ("failure", None)], vec![
                ("state", JobState::Paused.into()),
                ("activeItemId", json!(item_id)),
                ("replacementPhase", phase.clone().into()),
                ("recovery", json!({ "fromState": JobState::Replacing, "phase": phase, "action": "manual-intervention" })),
                ("summary", Value::Null),
                ("summaryDismissed", json!(false)),
            ])?;
            return Ok(());
        }
        let cleanup = self.cleanup_ownership(rt, item_id, ownership.as_ref(), None, false);
        if cleanup.cleaned {
            let cur = Self::ownership_for(rt, item_id);
            Self::set_ownership(rt, item_id, cur.map(|o| ownership_of(&o.to_value())));
        }
        let (halted_by_recovery, stop_requested, cancel_requested) = {
            let s = rt.lock();
            (s.recovery_required && s.recovery_item_id.as_deref() != Some(item_id), s.stop_requested, s.cancel_requested)
        };
        let withdrawn = e.is("NODE_WITHDRAWN") && !cancel_requested && cleanup.cleaned;
        let stopped = (stop_requested || halted_by_recovery || withdrawn) && !cancel_requested;
        let terminally = cancel_requested;
        let own = ownership.clone().unwrap_or_default();
        let next = if stopped { ItemState::Queued } else if terminally { ItemState::Cancelled } else { ItemState::Failed };
        let changes: Changes = vec![
            ("state", Some(next.into())),
            ("failure", if stopped || terminally { None } else { Some(json!({ "code": code, "retryable": retryable })) }),
            ("resultCode", if stopped && cleanup.cleaned { None } else { Some(json!(if !cleanup.cleaned { "cleanup-pending".to_string() } else { code.clone() })) }),
            ("ownedPaths", if !cleanup.cleaned { Some(Value::Object(own.paths.clone())) } else { None }),
            ("ownedArtifacts", if !cleanup.cleaned { Some(Value::Object(own.arts.clone())) } else { None }),
        ];
        let phase = rt.manifest().replacement_phase().map(Value::from).unwrap_or(Value::Null);
        self.item_patch(rt, item_id, changes, vec![
            ("state", (if terminally { JobState::Cancelled } else { JobState::Waiting }).into()),
            ("activeItemId", Value::Null),
            ("ownedPaths", if !cleanup.cleaned { Value::Object(own.paths.clone()) } else { json!({}) }),
            ("ownedArtifacts", if !cleanup.cleaned { Value::Object(own.arts.clone()) } else { json!({}) }),
            ("publicationArtifact", if !cleanup.cleaned { own.publication.clone().unwrap_or(Value::Null) } else { Value::Null }),
            ("replacementPhase", if !cleanup.cleaned { phase } else { Value::Null }),
        ])?;
        if withdrawn {
            let attempts = rt.lock().item(item_id).and_then(|i| i["attempts"].as_i64()).unwrap_or(0);
            if attempts > 0 {
                self.item_patch(rt, item_id, vec![("attempts", Some(json!(attempts - 1)))], vec![])?;
            }
            let mut s = rt.lock();
            if !s.stop_requested && !s.recovery_required {
                s.queue.push_front(item_id.to_string());
                drop(s);
                rt.cv.notify_all();
            }
        }
        Ok(())
    }

    /// finalize(runtime)
    pub fn finalize(&self, rt: &Arc<Runtime>) -> SResult<()> {
        {
            let _chain = rt.persist.lock().unwrap_or_else(|p| p.into_inner());
        }
        let m = rt.manifest();
        let (recovery_required, cancel, stop, stop_while_paused, stop_item, stop_phase) = {
            let s = rt.lock();
            (s.recovery_required, s.cancel_requested, s.stop_requested, s.stop_while_paused, s.stop_item_id.clone(), s.stop_phase.clone())
        };
        if recovery_required || m.get("recovery").and_then(|r| r.get("action")) == Some(&json!("manual-intervention")) {
            return Ok(());
        }
        let owns = |i: &Value| obj(i.get("ownedPaths")).len() > 0;
        if cancel {
            if m.state() != JobState::Cancelled || m.items.iter().any(|i| i.state().is_in_flight()) {
                self.update(rt, |s| {
                    let items = s.manifest.items.iter().map(|i| if i.state().is_in_flight() { ItemIn::Raw(merge(i.value(), &vec![("state", Some(ItemState::Cancelled.into())), ("failure", None)])) } else { ItemIn::Trusted(i.clone()) }).collect();
                    Some(Patch::new().state(JobState::Cancelled).set("activeItemId", Value::Null).set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", Value::Null).items(items))
                })?;
            }
            self.emit(rt, "cancelled", vec![]);
            return Ok(());
        }
        let owns_in_flight = |i: &Arc<Item>| i.state().is_in_flight() && owns(i.value());
        if stop && stop_while_paused && !m.items.iter().any(owns_in_flight) {
            self.update(rt, |s| {
                let items = s.manifest.items.iter().map(|i| if i.state() == ItemState::Processing { ItemIn::Raw(merge(i.value(), &vec![("state", Some(ItemState::Queued.into())), ("failure", None)])) } else { ItemIn::Trusted(i.clone()) }).collect();
                Some(Patch::new().state(JobState::Paused).set("activeItemId", Value::Null).set("recovery", Value::Null).items(items))
            })?;
            self.emit(rt, "paused", vec![]);
            return Ok(());
        }
        if stop {
            self.update(rt, |s| {
                let cur = &s.manifest;
                let unresolved = cur.items.iter().find(|i| owns(i.value())).map(|i| i.value().clone());
                let interrupted = cur.items.iter().find(|i| Some(i.id()) == stop_item.as_deref() && i.state() == ItemState::Processing && owns(i.value())).map(|i| i.id().to_string());
                let mapped = match &stop_phase {
                    Some(JobState::Copying) => JobState::Copying,
                    Some(JobState::Replacing) => JobState::Replacing,
                    _ => JobState::Encoding,
                };
                let phase = cur.replacement_phase();
                let replacing_now = mapped == JobState::Replacing && phase.is_some();
                let nothing_half_done = interrupted.is_none() && !replacing_now && !cur.items.iter().any(owns_in_flight);
                let recovery = if nothing_half_done {
                    json!({ "fromState": JobState::Waiting, "action": if cur.get("discoveryComplete") == Some(&json!(false)) { "resume-discovery" } else { "resume-queue" } })
                } else if mapped == JobState::Copying {
                    json!({ "fromState": JobState::Copying, "action": if interrupted.is_some() { "manual-intervention" } else { "restart-copy" } })
                } else if mapped == JobState::Replacing && phase.is_some() {
                    json!({ "fromState": JobState::Replacing, "phase": phase, "action": "manual-intervention" })
                } else {
                    json!({ "fromState": JobState::Encoding, "action": if interrupted.is_some() { "cleanup-and-restart-encoding" } else { "restart-encoding" } })
                };
                let un = unresolved.unwrap_or(json!({}));
                let items = cur.items.iter().map(|i| {
                    if Some(i.id()) == interrupted.as_deref() {
                        ItemIn::Raw(merge(i.value(), &vec![("state", Some(ItemState::Processing.into())), ("failure", None)]))
                    } else if i.state() == ItemState::Processing {
                        ItemIn::Raw(merge(i.value(), &vec![("state", Some(ItemState::Queued.into())), ("failure", None)]))
                    } else {
                        ItemIn::Trusted(i.clone())
                    }
                }).collect();
                Some(Patch::new()
                    .state(JobState::Paused)
                    .set("activeItemId", interrupted.map(Value::from).unwrap_or(Value::Null))
                    .set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", Value::Null)
                    .set("recovery", recovery)
                    .set("ownedPaths", un.get("ownedPaths").cloned().unwrap_or(json!({})))
                    .set("ownedArtifacts", un.get("ownedArtifacts").cloned().unwrap_or(json!({})))
                    .set("publicationArtifact", un.get("publicationArtifact").cloned().unwrap_or(Value::Null))
                    .set("replacementPhase", if mapped == JobState::Replacing { phase.map(Value::from).unwrap_or(Value::Null) } else { Value::Null })
                    .items(items))
            })?;
            self.emit(rt, "paused", vec![]);
            return Ok(());
        }
        if m.state() == JobState::Failed {
            return Ok(());
        }
        if m.get("discoveryComplete") == Some(&json!(false)) {
            let from = if m.state() == JobState::Discovering { JobState::Discovering } else { JobState::Waiting };
            self.update(rt, |_| Some(Patch::new().state(JobState::Paused).set("activeItemId", Value::Null).set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", Value::Null).set("recovery", json!({ "fromState": from, "action": "resume-discovery" }))))?;
            self.emit(rt, "paused", vec![]);
            return Ok(());
        }
        let summary = contracts::serialize_summary(m.get("counters").unwrap_or(&Value::Null));
        let s2 = summary.clone();
        self.update(rt, |s| {
            let un = s.manifest.items.iter().find(|i| owns(i.value())).map(|i| i.value().clone()).unwrap_or(json!({}));
            Some(Patch::new().state(JobState::Completed).set("activeItemId", Value::Null).set("summary", s2.clone()).set("summaryDismissed", json!(false))
                .set("ownedPaths", un.get("ownedPaths").cloned().unwrap_or(json!({})))
                .set("ownedArtifacts", un.get("ownedArtifacts").cloned().unwrap_or(json!({})))
                .set("publicationArtifact", un.get("publicationArtifact").cloned().unwrap_or(Value::Null))
                .set("replacementPhase", Value::Null))
        })?;
        self.emit(rt, "completed", vec![("summary", summary)]);
        let m = rt.manifest();
        if let Some(more) = m.str("moreAfter") {
            if m.config().get("autoConvert") != Some(&json!(true)) {
                let mut config = m.config().clone();
                let part = config.get("part").and_then(Value::as_i64).unwrap_or(1);
                if let Some(c) = config.as_object_mut() {
                    c.shift_remove("resumeAfter");
                    c.shift_remove("part");
                }
                config["resumeAfter"] = json!(more);
                config["part"] = json!(part + 1);
                let me = self.clone();
                std::thread::spawn(move || {
                    // (after this run has ended)
                    std::thread::sleep(Duration::from_millis(50));
                    if let Err(e) = me.start(&config) {
                        eprintln!("[CONVERTER] The next part of the conversion could not start: {e}");
                    }
                });
            }
        }
        Ok(())
    }
}

/// takeReadSlot: originals read in full at once, for the whole service
pub struct ReadSlot(Arc<(Mutex<usize>, Condvar)>);

impl Drop for ReadSlot {
    fn drop(&mut self) {
        *self.0 .0.lock().unwrap() -= 1;
        self.0 .1.notify_all();
    }
}

impl Service {
    pub fn take_read_slot(&self, rt: &Runtime) -> SResult<ReadSlot> {
        let slots = self.0.reads.clone();
        let mut busy = slots.0.lock().unwrap();
        while *busy >= SOURCE_READS_AT_ONCE {
            if rt.aborted() {
                return Err(service_error("CANCELLED"));
            }
            busy = slots.1.wait_timeout(busy, Duration::from_millis(100)).unwrap().0;
        }
        *busy += 1;
        drop(busy);
        Ok(ReadSlot(slots))
    }
}

/// createItemTiming: elapsed time charged to phases
pub struct Timing {
    phases: Vec<(&'static str, f64)>,
    started: Instant,
    last: Instant,
}

impl Timing {
    pub fn new() -> Timing {
        let now = Instant::now();
        Timing { phases: contracts::TIMING_PHASES.iter().map(|p| (*p, 0.0)).collect(), started: now, last: now }
    }
    pub fn mark(&mut self, phase: &str) {
        let now = Instant::now();
        if let Some(p) = self.phases.iter_mut().find(|(n, _)| *n == phase) {
            p.1 += (now - self.last).as_secs_f64() * 1000.0;
        }
        self.last = now;
    }
    pub fn result(&self) -> (Value, i64) {
        let mut m = Map::new();
        for (n, ms) in &self.phases {
            m.insert(n.to_string(), json!(contracts::js_round(*ms) as i64));
        }
        (Value::Object(m), contracts::js_round(self.started.elapsed().as_secs_f64() * 1000.0) as i64)
    }
}

/// runtime.js ensureContainedDestinationParent: the destination's folders
/// made inside its root, each proven (no symbolic link, the real path
/// expected) and proven again just before the save.
pub struct DestinationGuard {
    captured: Vec<(std::path::PathBuf, std::path::PathBuf, u64, u64)>,
}

impl DestinationGuard {
    pub fn revalidate(&self) -> SResult<()> {
        use std::os::unix::fs::MetadataExt;
        for (p, real, dev, ino) in &self.captured {
            let st = match std::fs::symlink_metadata(p) {
                Ok(s) => s,
                Err(e) => {
                    let code = super::super::owned::code_of(&e);
                    if ["ENOENT", "ENOTCONN", "ENETDOWN", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT", "EIO"].contains(&code) {
                        return Err(Fail::code(code));
                    }
                    return Err(Fail::code("UNSAFE_DESTINATION_PATH"));
                }
            };
            let r = std::fs::canonicalize(p).map_err(|_| Fail::code("UNSAFE_DESTINATION_PATH"))?;
            if st.file_type().is_symlink() || !st.is_dir() || st.dev() != *dev || st.ino() != *ino || r != *real {
                return Err(Fail::code("UNSAFE_DESTINATION_PATH"));
            }
        }
        Ok(())
    }
}

/// a slot of a bounded counter, released when dropped
pub struct CheckSlot {
    rt: Arc<Runtime>,
    key: String,
}

impl Drop for CheckSlot {
    fn drop(&mut self) {
        let mut s = self.rt.lock();
        if let Some(n) = s.node_checks.get_mut(&self.key) {
            *n = n.saturating_sub(1);
        }
        drop(s);
        self.rt.cv.notify_all();
    }
}

pub struct FallbackSlot(Arc<(Mutex<usize>, Condvar)>);

impl Drop for FallbackSlot {
    fn drop(&mut self) {
        let (m, cv) = &*self.0;
        *m.lock().unwrap() -= 1;
        cv.notify_all();
    }
}

/// NODE_FALLBACK_AT_ONCE: clips a node gave back, encoded here at once
pub const NODE_FALLBACK_AT_ONCE: usize = 2;
/// NODE_CHECK_EXTRA: a node's clips checked here beyond its own number at once
pub const NODE_CHECK_EXTRA: usize = 2;

impl Service {
    /// localEncoder(codec, cpuOnly): this server's own encoder, never a node
    fn local_encoder(&self, codec: &str, cpu_only: bool) -> SResult<Selected> {
        if cpu_only {
            return self.0.o.tools.select_cpu_fallback(codec).map_err(Fail::from);
        }
        match self.0.o.tools.select(codec) {
            Ok(s) if !s.remote => Ok(s),
            _ => self.0.o.tools.select_cpu_fallback(codec).map_err(Fail::from),
        }
    }

    /// takeFallbackSlot(signal)
    fn take_fallback_slot(&self, rt: &Runtime) -> SResult<FallbackSlot> {
        let slots = self.0.fallbacks.clone();
        let (m, cv) = &*slots;
        let mut n = m.lock().unwrap();
        while *n >= NODE_FALLBACK_AT_ONCE {
            if rt.aborted() {
                return Err(service_error("CANCELLED"));
            }
            n = cv.wait_timeout(n, Duration::from_millis(100)).unwrap().0;
        }
        if rt.aborted() {
            return Err(service_error("CANCELLED"));
        }
        *n += 1;
        drop(n);
        Ok(FallbackSlot(slots.clone()))
    }

    /// takeCheckSlot(runtime, lane, signal): per node, its own number plus NODE_CHECK_EXTRA
    fn take_check_slot(&self, rt: &Arc<Runtime>, lane: Option<&super::lanes::Lane>) -> SResult<CheckSlot> {
        let lane_id = lane.map(|l| l.id.clone()).unwrap_or_else(|| "node".into());
        let key = contracts::node_key_of(&lane_id).map(str::to_string).unwrap_or(lane_id);
        let mut s = rt.lock();
        loop {
            let own: usize = s.lane_plan.as_ref().map(|p| p.base.iter().filter(|(id, _)| contracts::node_key_of(id).map_or(id.as_str() == key, |k| k == key)).map(|(_, n)| *n).sum()).unwrap_or(0);
            let limit = own.max(1) + NODE_CHECK_EXTRA;
            if rt.aborted() {
                return Err(service_error("CANCELLED"));
            }
            let busy = s.node_checks.get(&key).copied().unwrap_or(0);
            if busy < limit {
                s.node_checks.insert(key.clone(), busy + 1);
                return Ok(CheckSlot { rt: rt.clone(), key });
            }
            s = rt.cv.wait_timeout(s, Duration::from_millis(100)).unwrap_or_else(|p| p.into_inner()).0;
        }
    }
}

pub fn ensure_destination_parent(root: &str, destination: &str) -> SResult<DestinationGuard> {
    use std::os::unix::fs::MetadataExt;
    let unsafe_ = || Fail::code("UNSAFE_DESTINATION_PATH");
    if !root.starts_with('/') || !destination.starts_with('/') {
        return Err(unsafe_());
    }
    let root = super::super::owned::resolve(Path::new(root));
    let parent = super::super::owned::resolve(Path::new(destination)).parent().map(Path::to_path_buf).ok_or_else(unsafe_)?;
    if !parent.starts_with(&root) {
        return Err(unsafe_());
    }
    let mut existing = root.clone();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let Some(next) = existing.parent().map(Path::to_path_buf).filter(|n| *n != existing) else { return Err(Fail::code("ENOENT")) };
                existing = next;
            }
            Err(e) => return Err(Fail::code(super::super::owned::code_of(&e))),
        }
    }
    if !parent.starts_with(&existing) {
        return Err(unsafe_());
    }
    let dir_stat = |p: &Path| -> SResult<std::fs::Metadata> {
        let st = std::fs::symlink_metadata(p).map_err(|e| Fail::code(super::super::owned::code_of(&e)))?;
        if st.file_type().is_symlink() || !st.is_dir() {
            return Err(unsafe_());
        }
        Ok(st)
    };
    let st = dir_stat(&existing)?;
    let real_existing = std::fs::canonicalize(&existing).map_err(|e| Fail::code(super::super::owned::code_of(&e)))?;
    let mut captured = vec![(existing.clone(), real_existing.clone(), st.dev(), st.ino())];
    let mut current = existing.clone();
    let mut expected_real = real_existing.clone();
    for c in parent.strip_prefix(&existing).unwrap().components() {
        current.push(c);
        expected_real.push(c);
        let st = match dir_stat(&current) {
            Ok(s) => s,
            Err(e) if e.is("ENOENT") => {
                if let Err(e) = std::fs::create_dir(&current) {
                    if e.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(Fail::code(super::super::owned::code_of(&e)));
                    }
                }
                dir_stat(&current)?
            }
            Err(e) => return Err(e),
        };
        let real = std::fs::canonicalize(&current).map_err(|e| Fail::code(super::super::owned::code_of(&e)))?;
        if real != expected_real || !real.starts_with(&real_existing) {
            return Err(unsafe_());
        }
        captured.push((current.clone(), real, st.dev(), st.ino()));
    }
    Ok(DestinationGuard { captured })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converter::{devices, snapshot::Registry, testutil::tempdir};
    use std::process::Command;

    #[test]
    fn initial_plan_matches_job_path() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.mp4");
        let generated = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2", "-c:v", "libx264", "-crf", "18", "-bf", "0", "-pix_fmt", "yuv420p", "-use_editlist", "0"])
            .arg(&source)
            .output()
            .unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let tools = tools::RealTools::new("ffmpeg", "ffprobe", Arc::new(Registry::new(dir.path().join("snapshots"))));
        let signal = Arc::new(AtomicBool::new(false));
        let inspected = tools.inspect_video(source.to_str().unwrap(), &signal).unwrap();
        let timeline = tools.read_timeline(source.to_str().unwrap(), &signal).unwrap();
        let source_bytes = std::fs::metadata(&source).unwrap().len();
        let config = json!({ "profileId": "aggressive", "codec": "h265" });
        let selected = tools.select_for("h265", &devices::device_of(&devices::cpu_device())).unwrap();
        assert!(!selected.hardware);
        assert_eq!(inspected.codec, "h264");
        assert_eq!(inspected.duration_seconds, 2.0);

        // The existing job path's target/planner calls, with whole-file bytes
        // and inspected duration, not a separate bitrate formula.
        let expected = planner::calculate_initial_bitrate(
            "h265", contracts::target_output_bytes(source_bytes, "aggressive"), inspected.duration_seconds, 0.0, 0.0,
        ).unwrap() as f64;
        assert!(expected > planner::bitrate_floor("h265") as f64, "the fixture must exercise target maths above the floor");
        let plan = initial_plan(&config, source_bytes, &inspected, &timeline, selected.clone(), vec![]).unwrap();
        assert_eq!(plan.bitrate, Some(expected));
        assert_eq!(plan.selected, selected);
        assert_eq!(plan.quality, None);
        assert_eq!(plan.smallest, None);
        assert!(!plan.keep_order);
        assert_eq!(plan.hold_frames, 0);
        assert!(plan.decode.is_empty());
    }
}

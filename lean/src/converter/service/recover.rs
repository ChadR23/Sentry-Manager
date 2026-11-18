//! jobService.js recovery after a stop: recover / continueRecovery,
//! performRecovery (step by step through an interrupted replacement until
//! the clip is finished or its original is back), releaseInterruptedSave,
//! resolveReplacementBeforeCancel and the sweeps of leftover files.

use super::work::authority_of;
use super::*;
use super::super::jobstore::normalize::truthy;
use super::super::jobstore::states::ArtifactState;
use super::super::recovery::{self, Facts};
use super::super::staging::Op;

impl Service {
    fn inspect_with_signal(&self, rt: &Runtime) -> impl FnMut(&Manifest) -> Result<Facts, CError> + '_ {
        let signal = rt.signal();
        let tools = self.0.o.tools.clone();
        move |m: &Manifest| {
            if signal.load(Ordering::SeqCst) {
                return Err(CError::code("CANCELLED"));
            }
            tools.inspect_recovery(m, &signal)
        }
    }

    /// recover(id, inspectRecovery, { deferExecution }): reconciles the job
    /// file now; the recovery itself runs on the job's thread (after
    /// continue_recovery when deferred). Returns the reconciled job.
    pub fn recover(&self, id: &str, defer: bool) -> SResult<Value> {
        self.mutate(|| {
            if self.0.shutting_down.load(Ordering::SeqCst) {
                return Err(service_error("SERVICE_SHUTDOWN"));
            }
            let rt = self.ensure_runtime(id)?;
            {
                let s = rt.lock();
                if defer && s.release_recovery == Some(false) {
                    return Ok(public_snapshot(&s.manifest));
                }
                if s.running {
                    return Err(service_error("JOB_ACTIVE"));
                }
            }
            let recovered = {
                let mut inspect = self.inspect_with_signal(&rt);
                self.0.o.store.recover(id, &mut inspect, true).map_err(Fail::from)
            };
            let recovered = match recovered {
                Ok(m) => m,
                Err(e) => {
                    self.emit(&rt, "recovery_failed", vec![("code", json!(stable_failure(&e, "operation-failed")))]);
                    return Err(e);
                }
            };
            {
                let mut s = rt.lock();
                s.manifest = recovered.clone();
                s.running = true;
                s.run_kind = Some("recovery");
                s.release_recovery = if defer { Some(false) } else { None };
            }
            let me = self.clone();
            let rt2 = rt.clone();
            let id2 = id.to_string();
            std::thread::spawn(move || {
                // the gate (deferExecution)
                {
                    let mut s = rt2.lock();
                    while s.release_recovery == Some(false) && !rt2.aborted() {
                        s = rt2.cv.wait(s).unwrap_or_else(|p| p.into_inner());
                    }
                    s.release_recovery = None;
                }
                let r = if rt2.aborted() || rt2.lock().stopped() {
                    Err(service_error("CANCELLED"))
                } else {
                    me.perform_recovery(&rt2, &id2, recovered)
                };
                if let Err(e) = r {
                    let stopped = rt2.lock().stopped();
                    if stopped {
                        let _ = me.finalize(&rt2);
                    } else {
                        me.emit(&rt2, "recovery_failed", vec![("code", json!(stable_failure(&e, "operation-failed")))]);
                    }
                }
                {
                    let mut s = rt2.lock();
                    s.running = false;
                    s.run_kind = None;
                }
                rt2.cv.notify_all();
            });
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    /// continueRecovery(id)
    pub fn continue_recovery(&self, id: &str) -> SResult<()> {
        let rt = self.ensure_runtime(id)?;
        {
            let mut s = rt.lock();
            if s.release_recovery == Some(false) && !self.0.shutting_down.load(Ordering::SeqCst) {
                s.release_recovery = Some(true);
            }
        }
        rt.cv.notify_all();
        Ok(())
    }

    /// resolveReplacementBeforeCancel(runtime, id, { relaunch })
    pub fn resolve_replacement_before_cancel(&self, rt: &Arc<Runtime>, id: &str, relaunch: bool) -> SResult<()> {
        if rt.lock().running {
            return Err(service_error("RECOVERY_REQUIRED"));
        }
        rt.lock().suppress_launch = !relaunch;
        let r = (|| -> SResult<()> {
            let recovered = {
                let mut inspect = self.inspect_with_signal(rt);
                self.0.o.store.recover(id, &mut inspect, true).map_err(Fail::from)?
            };
            rt.lock().manifest = recovered.clone();
            let rec = recovered.get("recovery").cloned().unwrap_or(Value::Null);
            if recorded_from(&recovered) != Some(JobState::Replacing) || rec.get("action") == Some(&json!("manual-intervention")) {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            // (Node awaits the relaunched job here; this returns once the
            // interrupted clip is settled and the job runs on its own thread)
            self.perform_recovery(rt, id, recovered)?;
            if recorded_from(&rt.manifest()) == Some(JobState::Replacing) {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            Ok(())
        })();
        rt.lock().suppress_launch = false;
        r
    }

    /// releaseInterruptedSave(runtime, { resume })
    pub fn release_interrupted_save(&self, rt: &Arc<Runtime>, resume: bool) -> SResult<bool> {
        let m = rt.manifest();
        let rec = m.get("recovery").cloned().unwrap_or(Value::Null);
        let (running, kind) = {
            let s = rt.lock();
            (s.running, s.run_kind)
        };
        if rec.get("action") != Some(&json!("manual-intervention")) || recorded_from(&m) == Some(JobState::Replacing) || m.get("replacementPhase").is_some() || (running && kind != Some("recovery")) {
            return Ok(false);
        }
        let interrupted: Vec<Value> = m.items.iter().filter(|i| i.state() == ItemState::Processing).map(|i| i.value().clone()).collect();
        for item in &interrupted {
            let Some(backup) = item.get("ownedPaths").and_then(|o| o.get("replacementBackup")).and_then(Value::as_str) else { continue };
            if item["ownedArtifacts"]["replacementBackup"]["state"].as_str().map(ArtifactState::parse) != Some(ArtifactState::Intent) {
                return Ok(false);
            }
            match std::fs::symlink_metadata(backup) {
                Ok(_) => return Ok(false),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Ok(false),
            }
        }
        let mut pending = std::collections::HashSet::new();
        for item in &interrupted {
            if obj(item.get("ownedPaths")).is_empty() {
                continue;
            }
            let id = item["id"].as_str().unwrap();
            if !self.reconcile_item_ownership(rt, id, Some(ownership_of(item)), true)? {
                pending.insert(id.to_string());
            }
        }
        self.update(rt, |s| {
            let items = s.manifest.items.iter().map(|e| {
                if e.state() != ItemState::Processing {
                    return ItemIn::Trusted(e.clone());
                }
                ItemIn::Raw(if pending.contains(e.id()) {
                    merge(e.value(), &vec![("state", Some(ItemState::Failed.into())), ("resultCode", Some(json!("cleanup-pending"))), ("failure", Some(json!({ "code": "interrupted", "retryable": false })))])
                } else {
                    merge(e.value(), &vec![("state", Some(ItemState::Queued.into())), ("failure", None), ("resultCode", None)])
                })
            }).collect();
            Some(Patch::new().state(if resume { JobState::Waiting } else { JobState::Paused }).set("activeItemId", Value::Null).set("recovery", Value::Null).set("replacementPhase", Value::Null).set("ownedPaths", json!({})).set("ownedArtifacts", json!({})).set("publicationArtifact", Value::Null).set("failure", Value::Null).items(items))
        })?;
        for item in &interrupted {
            let id = item["id"].as_str().unwrap();
            if !pending.contains(id) {
                Self::set_ownership(rt, id, None);
            }
        }
        self.emit(rt, "interrupted_save_released", vec![("pending", json!(pending.len()))]);
        Ok(true)
    }

    /// sweepFinishedLeftovers
    fn sweep_finished_leftovers(&self, rt: &Arc<Runtime>) -> SResult<()> {
        let private = ["stagedSource", "encodedCandidate", "publicationSnapshot"];
        let finished: Vec<Value> = rt.manifest().items.iter().filter(|e| {
            let p = obj(e.get("ownedPaths"));
            e.state().is_terminal() && !p.is_empty() && p.keys().all(|k| private.contains(&k.as_str()))
        }).map(|e| e.value().clone()).collect();
        for item in finished {
            let id = item["id"].as_str().unwrap();
            let own = ownership_of(&item);
            let cleanup = self.cleanup_ownership(rt, id, Some(&own), None, true);
            if cleanup.cleaned {
                let mut changes: Changes = vec![("ownedPaths", Some(json!({}))), ("ownedArtifacts", Some(json!({}))), ("publicationArtifact", None)];
                if item["resultCode"] == "completed-cleanup-pending" {
                    changes.push(("resultCode", Some(json!(if item["eligibleVideo"] == json!(false) { "copied" } else { "converted" }))));
                }
                self.item_patch(rt, id, changes, vec![])?;
            }
            Self::set_ownership(rt, id, None);
        }
        Ok(())
    }

    /// releaseInterruptedItems(runtime, keepItemId)
    fn release_interrupted_items(&self, rt: &Arc<Runtime>, keep: Option<&str>) -> SResult<bool> {
        let interrupted: Vec<Value> = rt.manifest().items.iter().filter(|e| e.state() == ItemState::Processing && Some(e.id()) != keep).map(|e| e.value().clone()).collect();
        for item in &interrupted {
            if obj(item.get("ownedPaths")).is_empty() {
                continue;
            }
            if !self.reconcile_item_ownership(rt, item["id"].as_str().unwrap(), Some(ownership_of(item)), true)? {
                return Ok(false);
            }
        }
        if interrupted.is_empty() {
            return Ok(true);
        }
        let ids: std::collections::HashSet<String> = interrupted.iter().map(|i| i["id"].as_str().unwrap().to_string()).collect();
        self.update(rt, |s| {
            let items = s.manifest.items.iter().map(|e| if ids.contains(e.id()) && e.state() == ItemState::Processing {
                ItemIn::Raw(merge(e.value(), &vec![("state", Some(ItemState::Queued.into())), ("failure", None), ("resultCode", None)]))
            } else {
                ItemIn::Trusted(e.clone())
            }).collect();
            Some(Patch::new().items(items))
        })?;
        Ok(true)
    }

    fn relaunch(&self, rt: &Arc<Runtime>) {
        let m = rt.manifest();
        {
            let mut s = rt.lock();
            s.queue.clear();
            s.queue_closed = false;
            s.producer_done = false;
        }
        self.launch(rt, m.get("discoveryComplete") == Some(&json!(false)), Self::queued_ids(&m));
    }

    /// requeueRecovered(runtime, item, ownership): false only when a backup
    /// of an original is among the files
    fn requeue_recovered(&self, rt: &Arc<Runtime>, item: &Value, ownership: &Own) -> SResult<bool> {
        let id = item["id"].as_str().unwrap();
        let mut retained = None;
        if !ownership.paths.is_empty() {
            let cleanup = self.cleanup_ownership(rt, id, Some(ownership), None, false);
            if cleanup.recovery_required {
                return Ok(false);
            }
            if !cleanup.cleaned {
                retained = Some(compose(ownership, &cleanup_value(&cleanup), &[]));
            }
        }
        let job = vec![("state", JobState::Waiting.into()), ("activeItemId", Value::Null), ("recovery", Value::Null), ("replacementPhase", Value::Null), ("ownedPaths", json!({})), ("ownedArtifacts", json!({})), ("publicationArtifact", Value::Null)];
        match retained {
            Some(r) => {
                let keep = r.paths.contains_key("publicationSnapshot");
                self.item_patch(rt, id, vec![("state", Some(ItemState::Failed.into())), ("failure", Some(json!({ "code": "interrupted", "retryable": false }))), ("resultCode", Some(json!("cleanup-pending"))), ("ownedPaths", Some(Value::Object(r.paths.clone()))), ("ownedArtifacts", Some(Value::Object(r.arts.clone()))), ("publicationArtifact", if keep { r.publication.clone() } else { None }), ("replacementPhase", None)], job)?;
            }
            None => {
                self.item_patch(rt, id, vec![("state", Some(ItemState::Queued.into())), ("failure", None), ("resultCode", None), ("ownedPaths", Some(json!({}))), ("ownedArtifacts", Some(json!({}))), ("publicationArtifact", None), ("replacementPhase", None)], job)?;
            }
        }
        Self::set_ownership(rt, id, None);
        Ok(true)
    }

    fn back_to_queue(&self, rt: &Arc<Runtime>) -> SResult<()> {
        self.update(rt, |s| {
            let items = s.manifest.items.iter().map(|e| if e.state() == ItemState::Processing { ItemIn::Raw(merge(e.value(), &vec![("state", Some(ItemState::Queued.into())), ("failure", None)])) } else { ItemIn::Trusted(e.clone()) }).collect();
            Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("recovery", Value::Null).items(items))
        })?;
        Ok(())
    }

    /// performRecovery(runtime, id, inspect, recovered)
    pub fn perform_recovery(&self, rt: &Arc<Runtime>, id: &str, recovered: Manifest) -> SResult<()> {
        let mut recovered = recovered;
        let mut rec = recovered.get("recovery").cloned().unwrap_or(Value::Null);
        let action_of = |r: &Value| r.get("action").and_then(Value::as_str).map(str::to_string);
        if action_of(&rec).as_deref() != Some("manual-intervention") && !self.release_interrupted_items(rt, recovered.str("activeItemId"))? {
            return Ok(());
        }
        self.sweep_finished_leftovers(rt)?;
        if action_of(&rec).as_deref() == Some("resume-network") {
            let interrupted = recovered.active_item().map(|i| i.value().clone());
            let role = rec.get("pathRole").and_then(Value::as_str).unwrap_or("discovery").to_string();
            let target = match (&interrupted, role.as_str()) {
                (Some(_), "destination") => recovered.config()["destinationRoot"].as_str().unwrap_or("").to_string(),
                (Some(i), "source") => i["sourcePath"].as_str().unwrap_or("").to_string(),
                _ => recovered.config()["sourceRoot"].as_str().unwrap_or("").to_string(),
            };
            let resume = rec.get("resumeState").and_then(Value::as_str).map_or(JobState::Waiting, JobState::parse);
            self.wait_for_network(rt, &target, true, None, Some(&role), Some(resume.clone()), rec.get("phase").and_then(Value::as_str).map(ReplacementPhase::parse))?;
            if resume.is_transaction() {
                let mut inspect = self.inspect_with_signal(rt);
                recovered = self.0.o.store.recover(id, &mut inspect, false).map_err(Fail::from)?;
                rt.lock().manifest = recovered.clone();
                rec = recovered.get("recovery").cloned().unwrap_or(Value::Null);
            } else {
                if let Some(i) = &interrupted {
                    if !obj(i.get("ownedPaths")).is_empty() {
                        let iid = i["id"].as_str().unwrap();
                        Self::set_ownership(rt, iid, Some(ownership_of(i)));
                        if !self.reconcile_item_ownership(rt, iid, Self::ownership_for(rt, iid), false)? {
                            return Ok(());
                        }
                    }
                }
                self.back_to_queue(rt)?;
                self.relaunch(rt);
                self.emit(rt, "recovered", vec![]);
                return Ok(());
            }
        }
        let action = action_of(&rec);
        if matches!(action.as_deref(), Some("resume-discovery") | Some("resume-queue")) {
            self.back_to_queue(rt)?;
            let m = rt.manifest();
            {
                let mut s = rt.lock();
                s.queue.clear();
                s.queue_closed = false;
            }
            self.launch(rt, action.as_deref() == Some("resume-discovery"), Self::queued_ids(&m));
            self.emit(rt, "recovered", vec![]);
            return Ok(());
        }
        let item = rt.manifest().item(recovered.str("activeItemId").unwrap_or("")).map(|i| i.value().clone());
        if item.as_ref().is_some_and(|i| item_state(i) == ItemState::Completed) {
            let i = item.unwrap();
            self.update(rt, |_| Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("recovery", Value::Null).set("ownedPaths", i.get("ownedPaths").cloned().unwrap_or(json!({}))).set("ownedArtifacts", i.get("ownedArtifacts").cloned().unwrap_or(json!({}))).set("publicationArtifact", i.get("publicationArtifact").cloned().unwrap_or(Value::Null)).set("replacementPhase", Value::Null)))?;
            self.relaunch(rt);
            self.emit(rt, "recovered", vec![]);
            return Ok(());
        }
        let from = JobState::parse(rec.get("fromState").and_then(Value::as_str).unwrap_or(""));
        if action.as_deref() == Some("manual-intervention") && from != JobState::Replacing {
            if !self.release_interrupted_save(rt, true)? {
                return Ok(());
            }
            self.relaunch(rt);
            self.emit(rt, "recovered", vec![]);
            return Ok(());
        }
        let Some(item) = item else { return Ok(()) };
        if !truthy(&rec) || action.as_deref() == Some("manual-intervention") {
            return Ok(());
        }
        let action = action.unwrap_or_default();
        let item_id = item["id"].as_str().unwrap().to_string();
        let publication = item.get("publicationArtifact").filter(|v| truthy(v)).or_else(|| recovered.get("publicationArtifact").filter(|v| truthy(v))).cloned();
        let item_or_job = |k: &str| item.get(k).filter(|v| truthy(v)).or_else(|| recovered.get(k)).cloned().unwrap_or(json!({}));

        let complete_recovered = |final_path: &str, output_bytes: u64, result: Own, pending: Vec<String>| -> SResult<()> {
            let mut retained = (result.clone(), pending.clone());
            if !result.paths.is_empty() {
                let mut with_pub = result.clone();
                with_pub.publication = publication.clone();
                let cleanup = self.cleanup_ownership(rt, &item_id, Some(&with_pub), None, false);
                retained = if cleanup.cleaned { (Own::default(), vec![]) } else { (if cleanup.own.paths.is_empty() { result.clone() } else { cleanup.own.clone() }, if cleanup.pending.is_empty() { pending.clone() } else { cleanup.pending.clone() }) };
            }
            let mut changes: Changes = vec![
                ("state", Some(ItemState::Completed.into())),
                ("eligibleVideo", Some(json!(true))),
                ("outputPath", Some(json!(final_path))),
                ("outputBytes", Some(json!(output_bytes))),
                ("resultCode", Some(json!(if retained.1.is_empty() { "converted" } else { "completed-cleanup-pending" }))),
                ("ownedPaths", Some(Value::Object(retained.0.paths.clone()))),
                ("ownedArtifacts", Some(Value::Object(retained.0.arts.clone()))),
                ("failure", None),
                ("replacementPhase", None),
            ];
            let keep = retained.0.paths.contains_key("publicationSnapshot");
            changes.push(("publicationArtifact", if keep { publication.clone() } else { None }));
            let completed = merge(&item, &changes);
            self.update(rt, |s| {
                let counters = contracts::add_completed_file(s.manifest.get("counters").unwrap_or(&Value::Null), &completed);
                Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("recovery", Value::Null).set("counters", counters).set("summary", Value::Null).set("summaryDismissed", json!(false))
                    .set("ownedPaths", completed["ownedPaths"].clone()).set("ownedArtifacts", completed["ownedArtifacts"].clone())
                    .set("publicationArtifact", completed.get("publicationArtifact").cloned().unwrap_or(Value::Null)).set("replacementPhase", Value::Null)
                    .items(with_item(&s.manifest, &item_id, |_| completed.clone())))
            })?;
            self.remember_converted(final_path, recovered.config()["codec"].as_str().unwrap_or("h265"));
            self.relaunch(rt);
            Ok(())
        };

        let persist = self.persistence(rt, &item_id, false);
        let signal = rt.signal();
        if from == JobState::Copying {
            let destination = output_path(recovered.config(), &item);
            if item["kind"] == "asset" {
                // (an asset's copy: finished or made again)
                let (final_path, bytes, own, pending) = if action == "finalize-copy" {
                    let o = ownership_of(&item);
                    let cleanup = self.cleanup_ownership(rt, &item_id, Some(&o), None, false);
                    (destination.clone(), item["sourceBytes"].as_u64().unwrap_or(0), if cleanup.cleaned { Own::default() } else { o }, cleanup.pending)
                } else {
                    let o = ownership_of(&item);
                    if !o.paths.is_empty() && !self.cleanup_ownership(rt, &item_id, Some(&o), None, false).cleaned {
                        return Ok(());
                    }
                    let guard = super::work::ensure_destination_parent(recovered.config()["destinationRoot"].as_str().unwrap_or(""), &destination)?;
                    guard.revalidate()?;
                    let mut op = Op { job_id: id.into(), item_id: item_id.clone(), cancel: Some(&signal), persist: Some(&persist), ..Default::default() };
                    op.source = item["sourcePath"].as_str().map(str::to_string);
                    op.source_root = recovered.config()["sourceRoot"].as_str().map(str::to_string);
                    op.destination = Some(destination.clone());
                    op.destination_root = recovered.config()["destinationRoot"].as_str().map(str::to_string);
                    let r = self.0.o.staging.copy_asset(&op).map_err(Fail::from)?;
                    let ro = Own::from_typed(&r.owned_paths, &r.owned_artifacts);
                    let cleanup = self.cleanup_ownership(rt, &item_id, Some(&ro), None, false);
                    (r.final_path.clone(), r.output_bytes, if cleanup.cleaned { Own::default() } else { ro }, if cleanup.cleaned { vec![] } else if cleanup.pending.is_empty() { r.cleanup_pending.clone() } else { cleanup.pending })
                };
                let completed = merge(&item, &vec![
                    ("state", Some(ItemState::Completed.into())),
                    ("eligibleVideo", Some(json!(false))),
                    ("outputPath", Some(json!(final_path))),
                    ("outputBytes", Some(json!(bytes))),
                    ("resultCode", Some(json!(if pending.is_empty() { "copied" } else { "completed-cleanup-pending" }))),
                    ("ownedPaths", Some(Value::Object(own.paths.clone()))),
                    ("ownedArtifacts", Some(Value::Object(own.arts.clone()))),
                    ("failure", None),
                ]);
                self.update(rt, |s| {
                    let counters = contracts::add_completed_file(s.manifest.get("counters").unwrap_or(&Value::Null), &completed);
                    Some(Patch::new().state(JobState::Waiting).set("activeItemId", Value::Null).set("recovery", Value::Null).set("counters", counters).set("summary", Value::Null).set("summaryDismissed", json!(false))
                        .set("ownedPaths", completed["ownedPaths"].clone()).set("ownedArtifacts", completed["ownedArtifacts"].clone())
                        .set("publicationArtifact", completed.get("publicationArtifact").cloned().unwrap_or(Value::Null)).set("replacementPhase", Value::Null)
                        .items(with_item(&s.manifest, &item_id, |_| completed.clone())))
                })?;
                self.relaunch(rt);
                self.emit(rt, "recovered", vec![]);
                return Ok(());
            }
            let partial_owned = item_or_job("ownedArtifacts").get("destinationPartial").and_then(|d| d.get("state")).and_then(Value::as_str).map(ArtifactState::parse) == Some(ArtifactState::Owned);
            if action == "restart-copy" || (action == "resume-copy" && !partial_owned) {
                if !self.requeue_recovered(rt, &item, &ownership_of(&item))? {
                    return Ok(());
                }
                self.relaunch(rt);
                self.emit(rt, "recovered", vec![]);
                return Ok(());
            }
            let guard = super::work::ensure_destination_parent(recovered.config()["destinationRoot"].as_str().unwrap_or(""), &destination)?;
            guard.revalidate()?;
            let own = Own { paths: obj(Some(&item_or_job("ownedPaths"))), arts: obj(Some(&item_or_job("ownedArtifacts"))), publication: None };
            let mut op = Op { job_id: id.into(), item_id: item_id.clone(), cancel: Some(&signal), persist: Some(&persist), ..Default::default() };
            op.action = Some(action.clone());
            op.destination = Some(destination);
            op.publication_artifact = publication.as_ref().and_then(|p| serde_json::from_value(p.clone()).ok());
            op.owned_paths = own.paths_typed();
            op.owned_artifacts = own.arts_typed();
            let r = self.0.o.staging.recover_copy(&op).map_err(Fail::from)?;
            let size = publication.as_ref().and_then(|p| p["size"].as_u64()).unwrap_or(0);
            complete_recovered(r.final_path.as_deref().unwrap_or(""), size, Own::from_typed(&r.owned_paths, &r.owned_artifacts), r.cleanup_pending.clone())?;
        } else if from == JobState::Replacing {
            let expected = authority_of(item.get("expectedSource"));
            if expected.is_none() {
                self.update(rt, |_| {
                    let mut r2 = rec.clone();
                    r2["action"] = json!("manual-intervention");
                    Some(Patch::new().state(JobState::Paused).set("recovery", r2))
                })?;
                return Ok(());
            }
            let rec_phase = rec.get("phase").and_then(Value::as_str).map(ReplacementPhase::parse).or_else(|| recovered.replacement_phase());
            self.update(rt, |_| Some(Patch::new().state(JobState::Replacing).set("activeItemId", json!(item_id)).set("replacementPhase", rec_phase.clone().map(Value::from).unwrap_or(Value::Null)).set("recovery", Value::Null)))?;
            let park = |phase: Option<ReplacementPhase>| -> SResult<()> {
                let rp = rec.get("phase").and_then(Value::as_str).map(ReplacementPhase::parse);
                self.update(rt, |s| {
                    let ph = phase.clone().or_else(|| s.manifest.replacement_phase()).or(rp.clone());
                    Some(Patch::new().state(JobState::Paused).set("activeItemId", json!(item_id)).set("replacementPhase", ph.clone().map(Value::from).unwrap_or(Value::Null)).set("recovery", json!({ "fromState": JobState::Replacing, "phase": ph, "action": "manual-intervention" })))
                })?;
                Ok(())
            };
            let mut action = action;
            let Some(publication_v) = publication.clone() else {
                let phase = rec_phase.clone();
                if action == "rollback-complete" {
                    let own = Own { paths: obj(Some(&item_or_job("ownedPaths"))), arts: obj(Some(&item_or_job("ownedArtifacts"))), publication: None };
                    if !self.requeue_recovered(rt, &item, &own)? {
                        park(phase)?;
                        return Ok(());
                    }
                    self.relaunch(rt);
                    self.emit(rt, "recovered", vec![]);
                    return Ok(());
                }
                let mut size = None;
                if phase == Some(ReplacementPhase::BackupDeleted) && action == "finish-replacement" {
                    size = std::fs::metadata(item["sourcePath"].as_str().unwrap_or("")).ok().map(|m| m.len()).filter(|s| *s > 0);
                }
                let Some(size) = size else {
                    park(phase)?;
                    return Ok(());
                };
                complete_recovered(item["sourcePath"].as_str().unwrap_or(""), size, ownership_of(&item), vec![])?;
                self.emit(rt, "recovered", vec![]);
                return Ok(());
            };
            let artifact: Option<super::super::snapshot::Artifact> = serde_json::from_value(publication_v.clone()).ok();
            let mut own = Own { paths: obj(Some(&item_or_job("ownedPaths"))), arts: obj(Some(&item_or_job("ownedArtifacts"))), publication: None };
            let mut result: Option<staging::Recovered> = None;
            let mut outcome: Option<&str> = None;
            let mut step = 0;
            while step < 6 && outcome.is_none() {
                if action == "manual-intervention" {
                    outcome = Some("park");
                    break;
                }
                let mut op = Op { job_id: id.into(), item_id: item_id.clone(), cancel: Some(&signal), persist: Some(&persist), ..Default::default() };
                op.codec = recovered.config()["codec"].as_str().map(str::to_string);
                op.action = Some(action.clone());
                op.source = item["sourcePath"].as_str().map(str::to_string);
                op.expected_source = expected.clone();
                op.source_root = recovered.config()["sourceRoot"].as_str().map(str::to_string);
                op.publication_artifact = artifact.clone();
                op.owned_paths = own.paths_typed();
                op.owned_artifacts = own.arts_typed();
                let r = match self.0.o.staging.recover_replacement(&op) {
                    Ok(r) => r,
                    Err(e) => {
                        if action == "backup-original" && e.code == "SOURCE_CHANGED" {
                            action = "restart-replacement".into();
                            step += 1;
                            continue;
                        }
                        let _ = park(None);
                        return Err(Fail::from(e));
                    }
                };
                own = Own::from_typed(&r.owned_paths, &r.owned_artifacts);
                if r.action == Some("restart-replacement") || r.phase == Some(ReplacementPhase::BackupRestored) {
                    outcome = Some("requeue");
                } else if r.phase == Some(ReplacementPhase::BackupDeleted) {
                    outcome = Some("complete");
                } else {
                    let mut m = rt.manifest();
                    m.top.insert("state".into(), JobState::Replacing.into());
                    if let Some(p) = &r.phase {
                        m.top.insert("replacementPhase".into(), p.clone().into());
                    }
                    let facts = {
                        let mut inspect = self.inspect_with_signal(rt);
                        inspect(&m)
                    };
                    let facts = match facts {
                        Ok(f) => f,
                        Err(e) => {
                            let _ = park(r.phase.clone());
                            return Err(Fail::from(e));
                        }
                    };
                    let has_expected = m.active_item().is_some_and(|i| i.get("expectedSource").is_some_and(truthy));
                    action = recovery::replacement_action(m.replacement_phase().as_ref(), Some(&facts), has_expected).to_string();
                }
                result = Some(r);
                step += 1;
            }
            let phase_of = |r: &Option<staging::Recovered>| r.as_ref().and_then(|r| r.phase.clone());
            match outcome {
                Some("complete") => {
                    let r = result.unwrap();
                    complete_recovered(item["sourcePath"].as_str().unwrap_or(""), artifact.as_ref().map(|a| a.size).unwrap_or(0), Own::from_typed(&r.owned_paths, &r.owned_artifacts), r.cleanup_pending.clone())?;
                }
                Some("requeue") => {
                    let mut o = own.clone();
                    o.publication = result.as_ref().and_then(|r| r.publication_artifact.as_ref()).map(|a| serde_json::to_value(a).unwrap()).or(Some(publication_v.clone()));
                    if !self.requeue_recovered(rt, &item, &o)? {
                        park(phase_of(&result))?;
                        return Ok(());
                    }
                    self.relaunch(rt);
                }
                _ => {
                    park(phase_of(&result))?;
                    return Ok(());
                }
            }
        } else {
            if action == "cleanup-and-restart-encoding" {
                // (the server's temp files are cleaned up by their recorded identity)
                if !self.requeue_recovered(rt, &item, &ownership_of(&item))? {
                    return Ok(());
                }
            } else {
                self.item_patch(rt, &item_id, vec![("state", Some(ItemState::Queued.into())), ("failure", None)], vec![("state", JobState::Waiting.into()), ("activeItemId", Value::Null), ("recovery", Value::Null)])?;
            }
            self.relaunch(rt);
        }
        self.emit(rt, "recovered", vec![]);
        Ok(())
    }
}

fn cleanup_value(c: &super::work::Cleanup) -> Value {
    let mut v = c.own.to_value();
    if !c.pending.is_empty() {
        v["cleanupPending"] = json!(c.pending);
    }
    v
}

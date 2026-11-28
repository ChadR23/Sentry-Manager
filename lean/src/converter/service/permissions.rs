//! Folder inventory is advisory. Admission and retries use the folders of the
//! actual clips, and a permission pause is persisted only after workers drain.
use super::*;
use super::super::{folder_access::{self, FolderChecks, Report}, jobstore::Item};
use std::collections::HashSet;

const FOLDER_RESCAN: std::time::Duration = std::time::Duration::from_secs(300);

fn folder_wait(item: &Item) -> bool {
    item.state() == ItemState::Skipped && item.str("resultCode") == Some("folder-not-writable")
}

fn warning(report: &Report) -> Value {
    if report.has_warning() { json!(report) } else { Value::Null }
}

impl Service {
    fn undiscovered_folder_work(&self, config: &Value, known: &HashSet<&str>) -> SResult<Option<bool>> {
        folder_access::discovery_access(config, |clip| {
            known.contains(clip.value["relativePath"].as_str().unwrap_or(""))
                || self.0.o.skip_discovered.as_ref().is_some_and(|skip| skip(config, &clip.value))
                || self.0.o.converted_index.as_ref().is_some_and(|index| {
                    let mut item = clip.value.clone();
                    item["ino"] = json!(clip.ino);
                    index.has(&item).is_some()
                })
        })
    }

    pub(super) fn start_folder_report(&self, config: &Value) -> SResult<Report> {
        let report = folder_access::scan(config);
        if report.root_blocked || (report.has_warning() && self.undiscovered_folder_work(config, &HashSet::new())? == Some(false)) {
            return Err(report.refusal());
        }
        Ok(report)
    }

    fn record_folder_warning(&self, rt: &Arc<Runtime>, report: &Report) -> SResult<()> {
        let value = warning(report);
        self.update(rt, |s| {
            (s.manifest.get("folderWarning").unwrap_or(&Value::Null) != &value)
                .then(|| Patch::new().set("folderWarning", value))
        })?;
        Ok(())
    }

    pub(super) fn refresh_folder_warning(&self, rt: &Arc<Runtime>, denied: bool) -> SResult<()> {
        let Ok(mut last) = rt.folder_scan_at.try_lock() else { return Ok(()) };
        if last.elapsed() >= FOLDER_RESCAN || (denied && rt.lock().manifest.get("folderWarning").is_none()) {
            let config = rt.lock().manifest.config().clone();
            self.record_folder_warning(rt, &folder_access::scan(&config))?;
            *last = std::time::Instant::now();
        }
        Ok(())
    }

    pub(super) fn folder_preflight(&self, rt: &Arc<Runtime>, item: &Value) -> SResult<()> {
        self.refresh_folder_warning(rt, false)?;
        let config = rt.lock().manifest.config().clone();
        folder_access::check_item(&config, item)
    }

    /// Select only repaired skips, in manifest order. Completed and otherwise
    /// skipped items keep their original records, counters and index entries.
    fn ready_folder_items(&self, rt: &Arc<Runtime>, m: &Manifest, checks: &mut FolderChecks, tried: &HashSet<String>) -> SResult<HashSet<String>> {
        let mut ready = HashSet::new();
        for item in m.items.iter().filter(|i| folder_wait(i) && !tried.contains(i.id())) {
            if self.can_release(m.config(), item.value(), checks) && self.clean_folder_wait(rt, item)? {
                ready.insert(item.id().to_owned());
            }
        }
        Ok(ready)
    }

    // Permission can be lost after a proved share copy was prepared. Its
    // journal and snapshot remain authoritative until guarded cleanup succeeds.
    fn clean_folder_wait(&self, rt: &Arc<Runtime>, item: &Item) -> SResult<bool> {
        let before = ownership_of(item.value());
        if before.paths.is_empty() { return Ok(true); }
        let paths: Vec<_> = before.paths.values().filter_map(Value::as_str).collect();
        let _held = self.0.o.staging.hold(&paths);
        let cleanup = self.cleanup_ownership(rt, item.id(), Some(&before), None, true);
        let after = cleanup.own;
        self.update(rt, |s| {
            let items = with_item(&s.manifest, item.id(), |v| merge(v, &vec![
                ("ownedPaths", Some(Value::Object(after.paths.clone()))),
                ("ownedArtifacts", Some(Value::Object(after.arts.clone()))),
                ("publicationArtifact", after.publication.clone()),
            ]));
            Some(patch_terminal_ownership(Patch::new().items(items), &s.manifest, &before, &after))
        })?;
        Self::set_ownership(rt, item.id(), None);
        Ok(cleanup.cleaned)
    }

    fn can_release(&self, config: &Value, item: &Value, checks: &mut FolderChecks) -> bool {
        // The worker applies changed automatic keep rules before admission.
        (config["autoConvert"] == true && self.0.o.skip_discovered.as_ref().is_some_and(|skip| skip(config, item)))
            || checks.allows(config, item)
    }

    fn release_folder_items(&self, rt: &Arc<Runtime>, ready: &HashSet<String>, report: &Report) -> SResult<()> {
        let value = warning(report);
        let mut queued = vec![];
        self.update(rt, |s| {
            if ready.is_empty() && s.manifest.get("permissionBlock").is_none()
                && s.manifest.get("folderWarning").unwrap_or(&Value::Null) == &value { return None; }
            let mut patch = Patch::new().set("permissionBlock", Value::Null).set("folderWarning", value);
            if !ready.is_empty() {
                patch = patch.items(s.manifest.items.iter().map(|item| {
                    if folder_wait(item) && ready.contains(item.id()) {
                        queued.push(item.id().to_owned());
                        ItemIn::Raw(merge(item.value(), &vec![("state", Some(ItemState::Queued.into())), ("failure", None), ("resultCode", None)]))
                    } else { ItemIn::Trusted(item.clone()) }
                }).collect());
            }
            Some(patch)
        })?;
        let mut s = rt.lock();
        if s.running { s.queue.extend(queued); }
        Ok(())
    }

    pub(super) fn prepare_folder_resume(&self, rt: &Arc<Runtime>) -> SResult<()> {
        let m = rt.manifest();
        let report = folder_access::scan(m.config());
        let mut checks = FolderChecks::default();
        let ready = self.ready_folder_items(rt, &m, &mut checks, &HashSet::new())?;
        let mut blocked = report.root_blocked;
        if !blocked && ready.is_empty() && (report.has_warning() || m.items.iter().any(|i| folder_wait(i))) {
            let remaining = m.items.iter().filter(|i| i.state().is_in_flight());
            let mut access = m.items.iter().any(|i| folder_wait(i)).then_some(false);
            for item in remaining {
                let allowed = self.can_release(m.config(), item.value(), &mut checks);
                access = Some(allowed);
                if allowed { break; }
            }
            if access != Some(true) && m.get("discoveryComplete") == Some(&Value::Bool(false)) {
                let known = m.items.iter().filter_map(|i| i.str("relativePath")).collect();
                access = self.undiscovered_folder_work(m.config(), &known)?.or(access);
            }
            blocked = access == Some(false);
        }
        if blocked {
            let value = warning(&report);
            self.update(rt, |s| {
                let mut patch = Patch::new().set("folderWarning", value.clone());
                if s.manifest.get("permissionBlock").is_some() {
                    patch = patch.set("permissionBlock", json!(&report));
                }
                (s.manifest.get("folderWarning") != Some(&value) ||
                    s.manifest.get("permissionBlock").is_some_and(|v| v != &json!(&report))).then_some(patch)
            })?;
            return Err(report.refusal());
        }
        *rt.folder_scan_at.lock().unwrap() = std::time::Instant::now();
        self.release_folder_items(rt, &ready, &report)
    }

    /// Recheck waits at the drain boundary. A folder may already have been
    /// repaired while workers were busy elsewhere.
    pub(super) fn retry_repaired_at_drain(&self, rt: &Arc<Runtime>) -> SResult<()> {
        // A filesystem can reject a write despite its access check. Retry each
        // clip at most once per run, including repairs made during other retries.
        let mut tried = HashSet::new();
        loop {
            let m = rt.manifest();
            {
                let s = rt.lock();
                if s.stopped() || s.pause_requested || s.recovery_required || s.halted || m.state().is_terminal() { return Ok(()); }
            }
            let ready = self.ready_folder_items(rt, &m, &mut FolderChecks::default(), &tried)?;
            if ready.is_empty() { return Ok(()); }
            let report = folder_access::scan(m.config());
            if report.root_blocked { return Ok(()); }
            self.release_folder_items(rt, &ready, &report)?;
            tried.extend(ready);
            self.consume(rt)?;
        }
    }

    pub(super) fn finish_folder_wait(&self, rt: &Arc<Runtime>, m: &Manifest) -> SResult<bool> {
        if !m.items.iter().any(|i| folder_wait(i)) { return Ok(false); }
        let report = folder_access::scan(m.config());
        self.update(rt, |s| {
            let mut patch = Patch::new().state(JobState::Paused).set("activeItemId", Value::Null)
                .set("folderWarning", warning(&report));
            // A pause already claimed by the user must wait for their Resume.
            if !s.pause_requested { patch = patch.set("permissionBlock", json!(&report)); }
            Some(patch)
        })?;
        self.emit(rt, "paused", vec![]);
        Ok(true)
    }
}

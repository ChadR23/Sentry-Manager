//! staging.js: staging the original, the encode output, copying assets,
//! publishing to a separate folder, and replacing the original (prepare,
//! swap in the save slot, rollback).

use super::*;

/// A save prepared outside the save slot (only this module makes one).
#[derive(Debug, Clone)]
pub struct Prepared {
    pub kind: &'static str,
    pub job_id: String,
    pub item_id: String,
    pub codec: Option<String>,
    pub artifact: Artifact,
    pub expected_source: Option<SourceAuthority>,
    pub source: String,
    pub source_root: String,
    pub backup: String,
    pub backup_nonce: String,
    pub candidate_mtime_ns: Option<String>,
    pub destination: String,
    pub partial: String,
    pub partial_mtime_ns: Option<String>,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
    _private: (),
}

pub struct Staged {
    pub staged_source: String,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
    pub source_bytes: u64,
    pub expected_source: SourceAuthority,
}

pub struct Reserved {
    pub path: String,
    pub nonce: String,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
}

pub struct Adopted {
    pub path: String,
    pub output_bytes: u64,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
}

fn journal_mark(size: u64, sha: &str) -> Journal {
    Journal { committed: Some(Mark { size, sha256: sha.into() }), pending: None }
}

fn cleanup_pending_of(arts: &Artifacts) -> Vec<String> {
    arts.iter().filter(|(_, m)| m.state == ArtifactState::CleanupPending).map(|(k, _)| k.clone()).collect()
}

impl Tx {
    /// stageSource: a private copy of the original in the temp folder.
    pub fn stage_source(&self, op: &Op) -> R<Staged> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let source = valid_abs(op.source.as_deref())?;
        abort_if(op.cancel)?;
        if self.staged.lock().unwrap().len() >= self.max_leases {
            return Err(txe("STAGING_BUSY"));
        }
        let expected = match &op.expected_source {
            Some(e) => Some(validate_source_authority(Some(e))?),
            None => None,
        };
        let resume = op.resume.as_ref();
        let nonce = resume.and_then(|r| r.1.get("stagedSource")).map(|m| m.nonce.clone()).unwrap_or_else(new_nonce);
        let dest = self.staged_path(&job, &item, &nonce, &source);
        if let Some(r) = resume {
            if !r.0.get("stagedSource").is_some_and(|p| same_path(p, &dest)) {
                return Err(unsafe_path("stage-source", &dest, "resume: recorded stagedSource path differs"));
            }
        }
        self.staged.lock().unwrap().push(PathBuf::from(&dest));
        let paths: Paths = resume.map(|r| r.0.clone()).unwrap_or_else(|| [("stagedSource".to_string(), dest.clone())].into_iter().collect());
        let mut arts: Artifacts = resume.map(|r| r.1.clone()).unwrap_or_else(|| [("stagedSource".to_string(), artifact_metadata(&dest, &nonce, ArtifactState::Intent, None, None, 0, None))].into_iter().collect());
        let r = (|| -> R<Staged> {
            let real_temp = canonical_existing(&s(&self.temp_root))?;
            let canon = canonical_for_new(&dest)?;
            if !contained(Path::new(&real_temp), Path::new(&canon)) {
                return Err(unsafe_path("stage-source", &dest, "real path is outside the temp folder"));
            }
            let mut resume_copy = None;
            if resume.is_some() {
                let m = arts.get("stagedSource").cloned().ok_or_else(|| unsafe_path("stage-source", &dest, "resume: no stagedSource record"))?;
                if m.journal.is_none() || m.state == ArtifactState::Intent {
                    return Err(unsafe_path("stage-source", &dest, format!("resume: record {} (state {})", if m.journal.is_none() { "has no journal" } else { "not resumable" }, m.state)));
                }
                resume_copy = Some(m);
            } else {
                persist(op, Snap::new(&paths, &arts).step("staged-source-intent"))?;
            }
            // Nothing ever resumes a staged copy with identity cleanup: no journal of its own.
            let journaled = resume_copy.is_some();
            let expected_t = expected.as_ref().map(|e| (e.size, e.sha256.clone(), Some((e.device.clone(), e.inode.clone()))));
            let rc = resume_copy.clone();
            let rj = rc.as_ref().and_then(|m| m.journal.clone());
            let args = CopyArgs {
                permissions: None,
                expected: expected_t,
                cancel: op.cancel,
                collision: "PARTIAL_COLLISION",
                failure: "STAGING_FAILED",
                resume: match (&rc, &rj) {
                    (Some(m), Some(j)) => Some((m, j)),
                    _ => None,
                },
                hooks: if journaled { Hooks { created: true, pending: true, committed: true, reconciled: true } } else { Hooks::default() },
            };
            let copied = {
                let paths_ref = &paths;
                let arts_ref = &mut arts;
                let dest_ref = &dest;
                self.copy_exclusive(&source, &dest, args, &mut |ev, size, sha, st| {
                    match ev {
                        Event::ResumeReconciled | Event::ChunkCommitted => {
                            let mut p = arts_ref["stagedSource"].clone();
                            if ev == Event::ResumeReconciled {
                                p.state = ArtifactState::Writing;
                            }
                            p.size = Some(size);
                            p.sha256 = Some(sha.into());
                            p.journal = Some(journal_mark(size, sha));
                            let mut proposed = arts_ref.clone();
                            proposed.insert("stagedSource".into(), p.clone());
                            let step = if ev == Event::ResumeReconciled { "staged-source-resume-reconciled" } else { "staged-source-chunk-committed" };
                            persist(op, Snap::new(paths_ref, &proposed).step(step))?;
                            arts_ref.insert("stagedSource".into(), p);
                        }
                        Event::Created => {
                            let n = arts_ref["stagedSource"].nonce.clone();
                            arts_ref.insert("stagedSource".into(), artifact_metadata(dest_ref, &n, ArtifactState::Writing, Some(st), Some(sha), size, Some(journal_mark(0, sha))));
                            persist(op, Snap::new(paths_ref, arts_ref).step("staged-source-writing"))?;
                        }
                        Event::ChunkPending => {
                            if let Some(j) = arts_ref.get_mut("stagedSource").and_then(|m| m.journal.as_mut()) {
                                j.pending = Some(Mark { size, sha256: sha.into() });
                            }
                            persist(op, Snap::new(paths_ref, arts_ref).step("staged-source-chunk-pending"))?;
                        }
                    }
                    Ok(())
                })?
            };
            let n = arts["stagedSource"].nonce.clone();
            let j = arts["stagedSource"].journal.clone();
            arts.insert("stagedSource".into(), artifact_metadata(&dest, &n, ArtifactState::Owned, Some(&copied.stat), Some(&copied.sha256), copied.size, j));
            let mut sn = Snap::new(&paths, &arts).step("staged-source-owned");
            if op.record_expected_source {
                sn.item_fields = Some(json!({ "expectedSource": copied.expected_source }));
            }
            persist(op, sn)?;
            abort_if(op.cancel)?;
            Ok(Staged { staged_source: dest.clone(), owned_paths: paths.clone(), owned_artifacts: arts.clone(), source_bytes: copied.size, expected_source: copied.expected_source })
        })();
        match r {
            Ok(v) => Ok(v),
            Err(error) => {
                Self::release_lease(&self.staged, &dest);
                if lstat_or_none(&dest).ok().flatten().is_some() {
                    if let Some(m) = arts.get_mut("stagedSource") {
                        m.state = ArtifactState::CleanupPending;
                    }
                    let pending = vec!["stagedSource".to_string()];
                    let _ = persist(op, Snap::new(&paths, &arts).step("staged-source-cleanup-pending").pending(&pending));
                    let mut f = if error.tx { error } else { txe("STAGING_FAILED") };
                    f.cleanup_pending = Some(pending);
                    return Err(f);
                }
                if error.tx && ["CANCELLED", "STAGING_BUSY", "PARTIAL_COLLISION", "INVALID_TRANSACTION_INPUT", "UNSAFE_OWNED_PATH", "TRANSACTION_STATE_PERSIST_FAILED"].contains(&error.code.as_str()) {
                    return Err(error);
                }
                Err(txe("STAGING_FAILED"))
            }
        }
    }

    /// reserveEncodeOutput: the encode's private output name, recorded first.
    pub fn reserve_encode_output(&self, op: &Op) -> R<Reserved> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        if self.encoded.lock().unwrap().len() >= self.max_leases {
            return Err(txe("STAGING_BUSY"));
        }
        let nonce = new_nonce();
        let target = self.encoded_path(&job, &item, &nonce, op.extension.as_deref().unwrap_or(".mp4"))?;
        let root = canonical_existing(&s(&self.temp_root))?;
        let canon = canonical_for_new(&target)?;
        if !contained(Path::new(&root), Path::new(&canon)) || lstat_or_none(&target)?.is_some() {
            let d = if !contained(Path::new(&root), Path::new(&canon)) { "real path is outside the temp folder" } else { "reserved name already exists" };
            return Err(unsafe_path("reserve-encode-output", &target, d));
        }
        let paths: Paths = [("encodedCandidate".to_string(), target.clone())].into_iter().collect();
        let arts: Artifacts = [("encodedCandidate".to_string(), artifact_metadata(&target, &nonce, ArtifactState::Intent, None, None, 0, None))].into_iter().collect();
        persist(op, Snap::new(&paths, &arts).step("encoded-candidate-intent"))?;
        self.encoded.lock().unwrap().push(PathBuf::from(&target));
        Ok(Reserved { path: target, nonce, owned_paths: paths, owned_artifacts: arts })
    }

    /// adoptEncodeOutput: the finished encode at its reserved name (identity cleanup: nothing new to record).
    pub fn adopt_encode_output(&self, op: &Op) -> R<Adopted> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let paths = op.owned_paths.clone();
        let arts = op.owned_artifacts.clone();
        let target = valid_abs(paths.get("encodedCandidate").map(String::as_str))?;
        let Some(m) = arts.get("encodedCandidate") else { return Err(unsafe_path("adopt-encode-output", &target, "no encodedCandidate record")) };
        if !(m.state == ArtifactState::Intent || m.state == ArtifactState::Owned) || m.path != target || m.nonce.is_empty() || (!Self::leased(&self.encoded, &target) && self.encoded.lock().unwrap().len() >= self.max_leases) {
            let mut d = Vec::new();
            if !(m.state == ArtifactState::Intent || m.state == ArtifactState::Owned) {
                d.push(format!("record state {} not intent/owned", m.state));
            }
            if m.path != target {
                d.push("record path differs from target".into());
            }
            if m.nonce.is_empty() {
                d.push("record nonce empty".into());
            }
            if !Self::leased(&self.encoded, &target) && self.encoded.lock().unwrap().len() >= self.max_leases {
                d.push("no lease slot".into());
            }
            return Err(unsafe_path("adopt-encode-output", &target, d.join("; ")));
        }
        let ext = Path::new(&target).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let expected = self.encoded_path(&job, &item, &m.nonce, &ext)?;
        if !same_path(&expected, &target) {
            return Err(unsafe_path("adopt-encode-output", &target, "name is not the reserved encode name"));
        }
        let st = self.remember_owned(&target)?;
        if !Self::leased(&self.encoded, &target) {
            self.encoded.lock().unwrap().push(PathBuf::from(&target));
        }
        Ok(Adopted { path: target, output_bytes: st.size(), owned_paths: paths, owned_artifacts: arts })
    }

    /// copyAsset: a non-video file of a clip folder, copied to the destination.
    pub fn copy_asset(&self, op: &Op) -> R<Saved> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let (source, _, _) = self.assert_source_contained(op.source.as_deref(), op.source_root.as_deref())?;
        let droot = valid_abs(op.destination_root.as_deref())?;
        let dest = valid_abs(op.destination.as_deref())?;
        let real_droot = canonical_existing(&droot).map_err(|e| unsafe_path("copy-asset", &dest, format!("destination root realpath {}", e.code)))?;
        let canon_dest = canonical_for_new(&dest).map_err(|e| if e.code == "UNSAFE_OWNED_PATH" { e } else { unsafe_path("copy-asset", &dest, format!("destination realpath {}", e.code)) })?;
        if !contained(Path::new(&droot), Path::new(&dest)) || !contained(Path::new(&real_droot), Path::new(&canon_dest)) {
            return Err(unsafe_path("copy-asset", &dest, "destination is outside the destination root"));
        }
        if lstat_or_none(&dest)?.is_some() {
            return Err(txe("DESTINATION_COLLISION"));
        }
        let nonce = new_nonce();
        let partial = publication_partial(&dest, &job, &item, &nonce);
        let mut paths: Paths = [("destinationPartial".to_string(), partial.clone())].into_iter().collect();
        let mut arts: Artifacts = [("destinationPartial".to_string(), artifact_metadata(&partial, &nonce, ArtifactState::Intent, None, None, 0, None))].into_iter().collect();
        let mut final_created = false;
        let mut final_verified = false;
        let r = (|| -> R<Saved> {
            let canon_partial = canonical_for_new(&partial)?;
            if !same_pathbuf(&dirname(&canon_partial), &dirname(&canon_dest)) {
                return Err(unsafe_path("copy-asset", &partial, "partial and destination real folders differ"));
            }
            persist(op, Snap::new(&paths, &arts).step("asset-partial-intent"))?;
            let copied = {
                let (pr, ar, part) = (&paths, &mut arts, &partial);
                self.copy_exclusive(
                    &source,
                    &partial,
                    CopyArgs { permissions: None, expected: None, cancel: op.cancel, collision: "PARTIAL_COLLISION", failure: "DESTINATION_WRITE_FAILED", resume: None, hooks: Hooks { created: true, pending: true, committed: true, reconciled: false } },
                    &mut |ev, size, sha, st| {
                        match ev {
                            Event::Created => {
                                ar.insert("destinationPartial".into(), artifact_metadata(part, &nonce, ArtifactState::Writing, Some(st), Some(sha), size, Some(journal_mark(0, sha))));
                                persist(op, Snap::new(pr, ar).step("asset-partial-writing"))
                            }
                            Event::ChunkPending => {
                                if let Some(j) = ar.get_mut("destinationPartial").and_then(|m| m.journal.as_mut()) {
                                    j.pending = Some(Mark { size, sha256: sha.into() });
                                }
                                persist(op, Snap::new(pr, ar).step("asset-partial-chunk-pending"))
                            }
                            _ => {
                                let mut p = ar["destinationPartial"].clone();
                                p.size = Some(size);
                                p.sha256 = Some(sha.into());
                                p.journal = Some(journal_mark(size, sha));
                                let proposed: Artifacts = [("destinationPartial".to_string(), p.clone())].into_iter().collect();
                                persist(op, Snap::new(pr, &proposed).step("asset-partial-chunk-committed"))?;
                                ar.insert("destinationPartial".into(), p);
                                Ok(())
                            }
                        }
                    },
                )?
            };
            let j = arts["destinationPartial"].journal.clone();
            arts.insert("destinationPartial".into(), artifact_metadata(&partial, &nonce, ArtifactState::Owned, Some(&copied.stat), Some(&copied.sha256), copied.size, j));
            persist(op, Snap::new(&paths, &arts).step("asset-partial-owned"))?;
            self.validate_readable_meta(&partial, &arts["destinationPartial"], op.verify_readable, "DESTINATION_VALIDATION_FAILED")?;
            persist(op, Snap::new(&paths, &arts).step("asset-promotion-intent"))?;
            let e = arts["destinationPartial"].expected();
            let (_, removed) = self.promote_no_replace(&partial, &dest, "DESTINATION_COLLISION", Some(&e), false, false)?;
            final_created = true;
            if removed {
                return Err(txe("ATOMIC_PROMOTION_UNSUPPORTED"));
            }
            arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
            self.validate_readable_meta(&dest, &arts["destinationPartial"], op.verify_readable, "DESTINATION_VALIDATION_FAILED")?;
            final_verified = true;
            let pending = vec!["destinationPartial".to_string()];
            persist(op, Snap::new(&paths, &arts).step("asset-complete-cleanup-pending").pending(&pending))?;
            Ok(Saved { final_path: dest.clone(), output_bytes: copied.size, phase: None, owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: pending })
        })();
        let Err(mut error) = r else { return r };
        if final_created && !final_verified {
            arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
            match self.remove_exact_owned(&dest, arts.get("destinationPartial"), false, true, None, None) {
                Ok(_) => final_created = false,
                Err(_) => {
                    if error.tx {
                        error.cleanup_pending = Some(vec!["destinationPartial".into()]);
                    }
                }
            }
        }
        if !final_created && arts.get("destinationPartial").is_some_and(|m| m.state != ArtifactState::Intent) {
            match self.remove_exact_owned(&partial, arts.get("destinationPartial"), true, false, None, None) {
                Ok(_) => {
                    paths.shift_remove("destinationPartial");
                    arts.shift_remove("destinationPartial");
                }
                Err(_) => {
                    arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                    if error.tx {
                        error.cleanup_pending = Some(vec!["destinationPartial".into()]);
                    }
                }
            }
        }
        if final_created && !final_verified {
            arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
            if error.tx {
                error.cleanup_pending = Some(vec!["destinationPartial".into()]);
            }
        }
        if final_created && final_verified && error.tx {
            arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
            error.cleanup_pending = Some(vec!["destinationPartial".into()]);
            error.valid_final = Some(Box::new(Saved { final_path: dest.clone(), output_bytes: arts["destinationPartial"].size.unwrap_or(0), phase: None, owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: vec!["destinationPartial".into()] }));
        }
        Err(if error.tx { error } else { txe("DESTINATION_WRITE_FAILED") })
    }

    /// publishSeparate: the verified snapshot to the destination in one call.
    pub fn publish_separate(&self, op: &Op) -> R<Saved> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let dest = valid_abs(op.destination.as_deref())?;
        let artifact = norm_artifact(op.publication_artifact.as_ref())?;
        let pn = new_nonce();
        let partial = publication_partial(&dest, &job, &item, &pn);
        let mut paths: Paths = [("destinationPartial".to_string(), partial.clone()), ("publicationSnapshot".to_string(), artifact.path.clone())].into_iter().collect();
        let mut arts: Artifacts = IndexMap::new();
        let mut pending: Vec<String> = Vec::new();
        let (mut trusted, mut final_created, mut final_verified) = (false, false, false);
        let r = (|| -> R<Saved> {
            arts.insert("publicationSnapshot".into(), self.capture_publication(&artifact, None)?);
            trusted = true;
            persist(op, Snap::new(&paths, &arts).step("separate-snapshot-owned").artifact(Some(&artifact)))?;
            abort_if(op.cancel)?;
            if lstat_or_none(&dest)?.is_some() {
                return Err(txe("DESTINATION_COLLISION"));
            }
            let cp = canonical_for_new(&partial)?;
            let cd = canonical_for_new(&dest)?;
            if !same_pathbuf(&dirname(&cp), &dirname(&cd)) {
                return Err(unsafe_path("publish-separate", &partial, "partial and destination real folders differ"));
            }
            arts.insert("destinationPartial".into(), artifact_metadata(&partial, &pn, ArtifactState::Intent, None, None, 0, None));
            persist(op, Snap::new(&paths, &arts).step("separate-partial-intent").artifact(Some(&artifact)))?;
            let copied = {
                let (pr, ar, part, art) = (&paths, &mut arts, &partial, &artifact);
                self.copy_exclusive(
                    &artifact.path,
                    &partial,
                    CopyArgs { permissions: None, expected: Some((artifact.size, artifact.sha256.clone(), None)), cancel: op.cancel, collision: "PARTIAL_COLLISION", failure: "PUBLICATION_ARTIFACT_CHANGED", resume: None, hooks: Hooks { created: true, pending: true, committed: true, reconciled: false } },
                    &mut |ev, size, sha, st| match ev {
                        Event::Created => {
                            let n = ar["destinationPartial"].nonce.clone();
                            ar.insert("destinationPartial".into(), artifact_metadata(part, &n, ArtifactState::Writing, Some(st), Some(sha), size, Some(journal_mark(0, sha))));
                            persist(op, Snap::new(pr, ar).step("separate-partial-writing").artifact(Some(art)))
                        }
                        Event::ChunkPending => {
                            if let Some(j) = ar.get_mut("destinationPartial").and_then(|m| m.journal.as_mut()) {
                                j.pending = Some(Mark { size, sha256: sha.into() });
                            }
                            persist(op, Snap::new(pr, ar).step("separate-partial-chunk-pending").artifact(Some(art)))
                        }
                        _ => {
                            let mut p = ar["destinationPartial"].clone();
                            p.size = Some(size);
                            p.sha256 = Some(sha.into());
                            p.journal = Some(journal_mark(size, sha));
                            let mut proposed = ar.clone();
                            proposed.insert("destinationPartial".into(), p.clone());
                            persist(op, Snap::new(pr, &proposed).step("separate-partial-chunk-committed").artifact(Some(art)))?;
                            ar.insert("destinationPartial".into(), p);
                            Ok(())
                        }
                    },
                )?
            };
            let (n, j) = (arts["destinationPartial"].nonce.clone(), arts["destinationPartial"].journal.clone());
            arts.insert("destinationPartial".into(), artifact_metadata(&partial, &n, ArtifactState::Owned, Some(&copied.stat), Some(&copied.sha256), copied.size, j));
            persist(op, Snap::new(&paths, &arts).step("separate-partial-owned").artifact(Some(&artifact)))?;
            abort_if(op.cancel)?;
            self.validate_readable(&partial, &artifact, op.verify_readable, "DESTINATION_VALIDATION_FAILED")?;
            abort_if(op.cancel)?;
            persist(op, Snap::new(&paths, &arts).step("separate-promotion-intent").artifact(Some(&artifact)))?;
            let e = arts["destinationPartial"].expected();
            let (_, removed) = self.promote_no_replace(&partial, &dest, "DESTINATION_COLLISION", Some(&e), false, false)?;
            final_created = true;
            if !removed {
                arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                pending.push("destinationPartial".into());
            }
            self.validate_readable(&dest, &artifact, op.verify_readable, "DESTINATION_VALIDATION_FAILED")?;
            final_verified = true;
            abort_if(op.cancel)?;
            if removed {
                paths.shift_remove("destinationPartial");
                arts.shift_remove("destinationPartial");
            }
            if self.cleanup_publication(Some(&artifact), arts.get("publicationSnapshot"))? {
                paths.shift_remove("publicationSnapshot");
                arts.shift_remove("publicationSnapshot");
            } else {
                arts.get_mut("publicationSnapshot").unwrap().state = ArtifactState::CleanupPending;
                pending.push("publicationSnapshot".into());
            }
            let step = if pending.is_empty() { "separate-complete" } else { "separate-complete-cleanup-pending" };
            persist(op, Snap::new(&paths, &arts).step(step).artifact(Some(&artifact)).pending(&pending))?;
            Ok(Saved { final_path: dest.clone(), output_bytes: artifact.size, phase: None, owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: pending.clone() })
        })();
        let Err(mut error) = r else { return r };
        let mut failed: Vec<String> = Vec::new();
        if final_created && !final_verified && arts.contains_key("destinationPartial") {
            if self.remove_exact_owned(&dest, arts.get("destinationPartial"), true, true, None, None).is_err() {
                arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                failed.push("destinationPartial".into());
            }
        }
        if arts.get("destinationPartial").is_some_and(|m| m.state != ArtifactState::Intent) && !failed.iter().any(|f| f == "destinationPartial") {
            match self.remove_exact_owned(&partial, arts.get("destinationPartial"), true, false, None, None) {
                Ok(_) => {
                    paths.shift_remove("destinationPartial");
                    arts.shift_remove("destinationPartial");
                }
                Err(_) => {
                    arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                    failed.push("destinationPartial".into());
                }
            }
        }
        if trusted {
            match self.cleanup_publication(Some(&artifact), arts.get("publicationSnapshot")) {
                Ok(true) => {
                    paths.shift_remove("publicationSnapshot");
                    arts.shift_remove("publicationSnapshot");
                }
                Ok(false) => {
                    if let Some(m) = arts.get_mut("publicationSnapshot") {
                        m.state = ArtifactState::CleanupPending;
                    }
                    failed.push("publicationSnapshot".into());
                }
                Err(e) => return Err(e),
            }
        }
        if !failed.is_empty() {
            let _ = persist(op, Snap::new(&paths, &arts).step("separate-failed-cleanup-pending").artifact(Some(&artifact)).pending(&failed));
            if error.tx {
                error.cleanup_pending = Some(failed.clone());
            }
        }
        if final_created && final_verified && error.tx {
            let mut all: Vec<String> = Vec::new();
            for k in pending.iter().chain(failed.iter()).cloned().chain(cleanup_pending_of(&arts)) {
                if !all.contains(&k) {
                    all.push(k);
                }
            }
            error.valid_final = Some(Box::new(Saved { final_path: dest.clone(), output_bytes: artifact.size, phase: None, owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: all }));
        }
        Err(if error.tx { error } else { txe("DESTINATION_WRITE_FAILED") })
    }

    /// rollbackReplacement: the original back at its name, the copy gone.
    pub fn rollback_replacement(&self, op: &Op) -> R<Saved> {
        let (source, source_root, _) = self.assert_source_or_missing_contained(op.source.as_deref(), op.source_root.as_deref())?;
        let artifact = norm_artifact(op.publication_artifact.as_ref())?;
        let mut paths = op.owned_paths.clone();
        let mut arts = op.owned_artifacts.clone();
        let candidate = valid_abs(paths.get("replacementCandidate").map(String::as_str))?;
        let backup = valid_abs(paths.get("replacementBackup").map(String::as_str))?;
        let persisted = paths.get("publicationSnapshot").filter(|p| same_path(p, &artifact.path)).map(|_| artifact.clone());
        self.assert_replacement_names(&source, &candidate, &backup, &validate_id(&op.job_id)?, &validate_id(&op.item_id)?, &arts, op.codec.as_deref())?;
        let _held = self.hold(&[&source, &backup]);
        let r = (|| -> R<Saved> {
            if let Some(a) = &persisted {
                self.validate_publication(a, Validate::Reconcile(a))?;
            }
            persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::RollbackStarted).artifact(persisted.as_ref()))?;
            // stopped between linking the backup and the rename over the original
            self.drop_backup_alias(&source, &backup)?;
            if let (Some(bm), Some(e)) = (arts.get("replacementBackup"), op.expected_source.as_ref()) {
                self.drop_split_backup(&source, &backup, bm, e)?;
            }
            let ss = lstat_or_none(&source)?;
            let bs = lstat_or_none(&backup)?;
            if let (Some(ss), Some(_)) = (&ss, &bs) {
                let bm = arts.get("replacementBackup").filter(|m| m.path == backup && m.state != ArtifactState::Intent)
                    .ok_or_else(|| txe("ROLLBACK_FAILED"))?;
                let be = self.expected_at(&backup, &bm.expected(), "ROLLBACK_FAILED")?;
                let mut cm = arts.get("replacementCandidate").cloned().ok_or_else(|| txe("ROLLBACK_FAILED"))?;
                if !matches_stat(Some(&cm), ss) {
                    if cm.path != candidate || cm.size != Some(artifact.size) || cm.sha256.as_ref() != Some(&artifact.sha256) {
                        return Err(txe("ROLLBACK_FAILED"));
                    }
                    let proof = self.prove_single_copy(&source, artifact.size, &artifact.sha256, "ROLLBACK_FAILED", None)?;
                    cm.device = Some(proof.stat.dev().to_string());
                    cm.inode = Some(proof.stat.ino().to_string());
                }
                self.remove_exact_owned(&source, Some(&cm), false, true, Some((&backup, &be, false)), None)?;
            }
            if lstat_or_none(&backup)?.is_some() {
                if lstat_or_none(&source)?.is_some() {
                    return Err(txe("ROLLBACK_FAILED"));
                }
                let Some(bm) = arts.get("replacementBackup").cloned() else { return Err(txe("ROLLBACK_FAILED")) };
                self.read_exact_meta(&backup, &bm, "ROLLBACK_FAILED")?;
                let (_, removed) = self.promote_no_replace(&backup, &source, "ROLLBACK_FAILED", Some(&bm.expected()), true, false)?;
                if !removed {
                    arts.get_mut("replacementBackup").unwrap().state = ArtifactState::CleanupPending;
                } else {
                    paths.shift_remove("replacementBackup");
                    arts.shift_remove("replacementBackup");
                }
            } else {
                paths.shift_remove("replacementBackup");
                arts.shift_remove("replacementBackup");
            }
            if lstat_or_none(&candidate)?.is_some() {
                if let Err(e) = self.remove_exact_owned(&candidate, arts.get("replacementCandidate"), false, false, None, None) {
                    if e.tx && e.code == "OWNED_CLEANUP_FAILED" {
                        arts.get_mut("replacementCandidate").unwrap().state = ArtifactState::CleanupPending;
                    }
                    return Err(e);
                }
            }
            paths.shift_remove("replacementCandidate");
            arts.shift_remove("replacementCandidate");
            if lstat_or_none(&source)?.is_none() {
                return Err(txe("ROLLBACK_FAILED"));
            }
            self.assert_source_contained(Some(&source), Some(&source_root))?;
            if let Some(a) = &persisted {
                if self.cleanup_publication(Some(a), arts.get("publicationSnapshot"))? {
                    paths.shift_remove("publicationSnapshot");
                    arts.shift_remove("publicationSnapshot");
                } else if let Some(m) = arts.get_mut("publicationSnapshot") {
                    m.state = ArtifactState::CleanupPending;
                }
            }
            let pending = cleanup_pending_of(&arts);
            persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::BackupRestored).artifact(persisted.as_ref()).pending(&pending))?;
            Ok(Saved { final_path: source.clone(), output_bytes: 0, phase: Some(ReplacementPhase::BackupRestored), owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: pending })
        })();
        r.map_err(|_| {
            let pending = cleanup_pending_of(&arts);
            let _ = persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::RollbackFailed).artifact(persisted.as_ref()).pending(&pending));
            let mut f = txe("ROLLBACK_FAILED");
            f.cleanup_pending = Some(pending);
            f
        })
    }

    pub(super) fn assert_replacement_names(&self, source: &str, candidate: &str, backup: &str, job: &str, item: &str, arts: &Artifacts, codec: Option<&str>) -> R<()> {
        let (c, b) = recorded_replacement_paths(source, job, item, arts, codec)?;
        if !same_path(&c, candidate) || !same_path(&b, backup) {
            let d = match (same_path(&c, candidate), same_path(&b, backup)) {
                (false, false) => "candidate and backup names differ from the recorded ones",
                (false, true) => "candidate name differs from the recorded one",
                _ => "backup name differs from the recorded one",
            };
            return Err(unsafe_path("replacement-names", source, d));
        }
        Ok(())
    }

    /// dropUnfinishedCopy: a copy prepare could not finish, removed if provably the snapshot's prefix.
    fn drop_unfinished_copy(&self, op: &Op, target: &str, field: &str, paths: &mut Paths, arts: &mut Artifacts, artifact: &Artifact, error: &mut TxError) {
        if arts.get(field).is_some_and(|m| m.state == ArtifactState::Intent) && lstat_or_none(target).ok().flatten().is_none() {
            paths.shift_remove(field);
            arts.shift_remove(field);
        } else {
            let removed = self.bind_relocated_copy(op, target, field, paths, arts, Some(artifact), "UNSAFE_OWNED_PATH")
                .and_then(|_| self.remove_share_copy(target, &arts[field], Some(artifact)));
            match removed {
                Ok(_) => {
                    paths.shift_remove(field);
                    arts.shift_remove(field);
                }
                _ => {
                    if let Some(m) = arts.get_mut(field) {
                        if m.state == ArtifactState::Owned {
                            m.state = ArtifactState::CleanupPending;
                        }
                    }
                    if error.tx {
                        error.cleanup_pending = Some(vec![field.into()]);
                    }
                    return;
                }
            }
        }
        let step = if field == "replacementCandidate" { "replacement-prepare-failed" } else { "separate-prepare-failed" };
        let clears = [field];
        let _ = persist(op, Snap::new(paths, arts).step(step).artifact(Some(artifact)).clears(&clears));
    }

    /// prepareReplacement: outside the save slot, the snapshot copied beside the original as TEMP-<codec>-<name>.
    pub fn prepare_replacement(&self, op: &Op) -> R<Prepared> {
        use std::os::unix::fs::PermissionsExt;
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let artifact = norm_artifact(op.publication_artifact.as_ref())?;
        let expected = validate_source_authority(op.expected_source.as_ref())?;
        let (source, source_root, real_root) = self.assert_source_contained(op.source.as_deref(), op.source_root.as_deref())?;
        let original = self.assert_source_identity(&source, &expected)?;
        let (cn, bn) = (new_nonce(), new_nonce());
        let (candidate, backup) = replacement_paths(&source, &job, &item, Some(&cn), Some(&bn), op.codec.as_deref())?;
        // (the copy is written beside the original: a leftover tidy never takes the name meanwhile)
        let _held = self.hold(&[&source, &candidate, &backup]);
        if lstat_or_none(&candidate)?.is_some() || lstat_or_none(&backup)?.is_some() {
            return Err(txe("REPLACEMENT_COLLISION"));
        }
        let cc = canonical_for_new(&candidate)?;
        let cb = canonical_for_new(&backup)?;
        if !contained(Path::new(&real_root), Path::new(&cc)) || !contained(Path::new(&real_root), Path::new(&cb)) {
            return Err(txe("SOURCE_OUTSIDE_ROOT"));
        }
        self.assert_replacement_space(&source, artifact.size)?;
        let mut paths: Paths = [("publicationSnapshot".to_string(), artifact.path.clone()), ("replacementCandidate".to_string(), candidate.clone())].into_iter().collect();
        let mut arts: Artifacts = IndexMap::new();
        arts.insert("publicationSnapshot".into(), self.capture_publication(&artifact, None)?);
        arts.insert("replacementCandidate".into(), artifact_metadata(&candidate, &cn, ArtifactState::Intent, None, None, 0, None));
        persist(op, Snap::new(&paths, &arts).step("replacement-prepare").artifact(Some(&artifact)))?;
        let r = (|| -> R<Option<String>> {
            {
                let (pr, ar, cand, art) = (&paths, &mut arts, &candidate, &artifact);
                self.copy_exclusive(
                    &artifact.path,
                    &candidate,
                    CopyArgs { permissions: Some(fs::Permissions::from_mode(original.mode() & 0o777)), expected: Some((artifact.size, artifact.sha256.clone(), None)), cancel: op.cancel, collision: "REPLACEMENT_COLLISION", failure: "PUBLICATION_ARTIFACT_CHANGED", resume: None, hooks: Hooks { created: true, ..Default::default() } },
                    &mut |_, _, sha, st| {
                        ar.insert("replacementCandidate".into(), artifact_metadata(cand, &cn, ArtifactState::Writing, Some(st), Some(sha), 0, Some(journal_mark(0, sha))));
                        persist(op, Snap::new(pr, ar).step("replacement-candidate-writing").artifact(Some(art)))
                    },
                )?
            };
            let proof = self.prove_single_copy(&candidate, artifact.size, &artifact.sha256, "PUBLICATION_ARTIFACT_CHANGED", op.cancel)?;
            let mt = proven_mtime(&proof);
            arts.insert("replacementCandidate".into(), artifact_metadata(&candidate, &cn, ArtifactState::Owned, Some(&proof.stat), Some(&artifact.sha256), artifact.size, None));
            persist(op, Snap::new(&paths, &arts).step("replacement-candidate-owned").artifact(Some(&artifact)))?;
            Ok(mt)
        })();
        let mtime = match r {
            Ok(m) => m,
            Err(mut e) => {
                self.drop_unfinished_copy(op, &candidate, "replacementCandidate", &mut paths, &mut arts, &artifact, &mut e);
                return Err(if e.tx { e } else { txe("REPLACEMENT_FAILED") });
            }
        };
        Ok(Prepared {
            kind: "replacement",
            job_id: job,
            item_id: item,
            codec: op.codec.clone(),
            artifact,
            expected_source: Some(expected),
            source,
            source_root,
            backup,
            backup_nonce: bn,
            candidate_mtime_ns: mtime,
            destination: String::new(),
            partial: String::new(),
            partial_mtime_ns: None,
            owned_paths: paths,
            owned_artifacts: arts,
            _private: (),
        })
    }

    /// swapReplacement: in the save slot. The original becomes BACKUP-<name> (a second link),
    /// the verified copy is renamed over its name, the backup is removed with the final held.
    /// A failure before the backup is gone puts the original back.
    pub fn swap_replacement(&self, op: &Op) -> R<Saved> {
        let p = op.prepared.filter(|p| p.kind == "replacement").ok_or_else(|| txe("INVALID_TRANSACTION_INPUT"))?;
        let (artifact, source, source_root, backup) = (&p.artifact, &p.source, &p.source_root, &p.backup);
        let expected = p.expected_source.clone().ok_or_else(|| txe("INVALID_TRANSACTION_INPUT"))?;
        let candidate = p.owned_paths["replacementCandidate"].clone();
        let _held = self.hold(&[source, backup, &candidate]);
        let mut paths = p.owned_paths.clone();
        paths.insert("replacementBackup".into(), backup.clone());
        let mut arts = p.owned_artifacts.clone();
        arts.insert("replacementBackup".into(), artifact_metadata(backup, &p.backup_nonce, ArtifactState::Intent, None, None, 0, None));
        persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::CandidateWritten).artifact(Some(artifact)))?;
        let mut backup_deleted = false;
        let r = (|| -> R<Saved> {
            // still the same original, and the same complete copy beside it
            self.assert_source_contained(Some(source), Some(source_root))?;
            let src = self.assert_source_identity(source, &expected)?;
            let expected = SourceAuthority { device: src.dev().to_string(), inode: src.ino().to_string(), ..expected.clone() };
            let Some(cst) = lstat_or_none(&candidate)?.filter(|c| is_regular(c) && single_link(c) && c.size() == artifact.size) else {
                return Err(txe("PUBLICATION_ARTIFACT_CHANGED"));
            };
            let mut quick = quick_expected(&arts["replacementCandidate"], p.candidate_mtime_ns.as_deref(), Some(&cst));
            if quick.is_none() && (p.candidate_mtime_ns.is_some() || !matches_identity(arts.get("replacementCandidate"), &cst)) {
                // changed since prepare read it back: read in full again before the original is touched
                let proof = self.prove_single_copy(&candidate, artifact.size, &artifact.sha256, "PUBLICATION_ARTIFACT_CHANGED", op.cancel)?;
                let cm = arts.get_mut("replacementCandidate").unwrap();
                cm.device = Some(proof.stat.dev().to_string());
                cm.inode = Some(proof.stat.ino().to_string());
                quick = quick_expected(cm, proven_mtime(&proof).as_deref(), Some(&proof.stat));
            }
            let proven_backup = mtime_stamp(lstat_or_none(source)?.as_ref());
            self.before_replace(source, source_root, &expected, &p.job_id, &p.item_id)?;
            let backup_mtime;
            let source_removed;
            if self.link_backup_aside(source, backup, &expected)? {
                let (rec, mt) = self.backup_record(backup, &p.backup_nonce, true, &expected, proven_backup.as_deref())?;
                arts.insert("replacementBackup".into(), rec);
                backup_mtime = mt;
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::OriginalBackedUp).artifact(Some(artifact)))?;
                let ec = quick.clone().unwrap_or_else(|| arts["replacementCandidate"].expected());
                if let Err(e) = self.replace_over_original(&candidate, source, backup, &ec, quick.is_some(), &expected) {
                    // still the original at its name: only the backup name goes
                    if self.drop_backup_alias(source, backup).unwrap_or(false) {
                        arts.insert("replacementBackup".into(), artifact_metadata(backup, &p.backup_nonce, ArtifactState::Intent, None, None, 0, None));
                    }
                    return Err(e);
                }
                source_removed = true;
            } else {
                // no hard links on this file system: the original is moved aside instead
                let (_, removed) = self.promote_no_replace(source, backup, "REPLACEMENT_COLLISION", Some(&expected.expected()), true, false).map_err(|e| if e.tx && e.code == "UNSAFE_OWNED_PATH" { source_changed("move-original-aside", e.detail.as_deref().unwrap_or("")) } else { e })?;
                let (rec, mt) = self.backup_record(backup, &p.backup_nonce, removed, &expected, proven_backup.as_deref())?;
                arts.insert("replacementBackup".into(), rec);
                backup_mtime = mt;
                let pend: Vec<String> = if removed { vec![] } else { vec!["replacementBackup".into()] };
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::OriginalBackedUp).artifact(Some(artifact)).pending(&pend))?;
                if !removed {
                    return Err(txe("REPLACEMENT_FAILED"));
                }
                let ec = quick.clone().unwrap_or_else(|| arts["replacementCandidate"].expected());
                let (_, r2) = self.promote_no_replace(&candidate, source, "REPLACEMENT_COLLISION", Some(&ec), true, quick.is_some())?;
                source_removed = r2;
            }
            if !source_removed {
                arts.get_mut("replacementCandidate").unwrap().state = ArtifactState::CleanupPending;
            }
            let pend: Vec<String> = if source_removed { vec![] } else { vec!["replacementCandidate".into()] };
            persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::CandidatePromoted).artifact(Some(artifact)).pending(&pend))?;
            if op.verify_readable.is_some() {
                self.validate_readable(source, artifact, op.verify_readable, "FINAL_VALIDATION_FAILED")?;
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::FinalValidated).artifact(Some(artifact)))?;
            }
            let ef = if source_removed { arts.get("replacementCandidate").cloned() } else { None };
            self.remove_replacement_backup(backup, arts.get("replacementBackup"), source, artifact, ef.as_ref(), quick.as_ref().and_then(|q| q.mtime_ns.as_deref()), backup_mtime.as_deref())?;
            paths.shift_remove("replacementBackup");
            arts.shift_remove("replacementBackup");
            backup_deleted = true;
            let mut pending = vec![];
            if arts.get("replacementCandidate").is_some_and(|m| m.state == ArtifactState::CleanupPending) {
                pending.push("replacementCandidate".to_string());
            } else {
                paths.shift_remove("replacementCandidate");
                arts.shift_remove("replacementCandidate");
            }
            Ok(Saved { final_path: source.clone(), output_bytes: artifact.size, phase: Some(ReplacementPhase::BackupDeleted), owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: pending })
        })();
        let Err(error) = r else { return r };
        if !backup_deleted {
            let rop = Op {
                job_id: p.job_id.clone(),
                item_id: p.item_id.clone(),
                codec: p.codec.clone(),
                source: Some(source.clone()),
                source_root: Some(source_root.clone()),
                expected_source: Some(expected.clone()),
                owned_paths: paths.clone(),
                owned_artifacts: arts.clone(),
                publication_artifact: Some(artifact.clone()),
                persist: op.persist,
                persist_phase: op.persist_phase,
                verify_readable: op.verify_readable,
                ..Default::default()
            };
            let rolled = match self.rollback_replacement(&rop) {
                Ok(r) => r,
                Err(re) => {
                    if re.tx && re.code == "ROLLBACK_FAILED" {
                        return Err(re);
                    }
                    let mut f = txe("ROLLBACK_FAILED");
                    f.cleanup_pending = Some(vec![]);
                    return Err(f);
                }
            };
            let mut f = if error.tx { error } else { txe("REPLACEMENT_FAILED") };
            f.cleanup_pending = Some(rolled.cleanup_pending.clone());
            f.rolled_back = Some((rolled.owned_paths, rolled.owned_artifacts));
            return Err(f);
        }
        let mut f = if error.tx { error } else { txe("REPLACEMENT_FAILED") };
        f.valid_final = Some(Box::new(Saved { final_path: source.clone(), output_bytes: artifact.size, phase: Some(ReplacementPhase::BackupDeleted), owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: cleanup_pending_of(&arts) }));
        Err(f)
    }

    /// replaceOriginal: prepare, swap, the snapshot's removal and the final record in one call.
    pub fn replace_original(&self, op: &Op) -> R<Saved> {
        let prepared = self.prepare_replacement(op)?;
        let sop = Op { prepared: Some(&prepared), persist: op.persist, persist_phase: op.persist_phase, verify_readable: op.verify_readable, cancel: op.cancel, ..Default::default() };
        let mut result = match self.swap_replacement(&sop) {
            Ok(r) => r,
            Err(e) => match e.valid_final {
                Some(v) => *v,
                None => return Err(e),
            },
        };
        if result.owned_paths.contains_key("publicationSnapshot") {
            if self.cleanup_publication(Some(&prepared.artifact), result.owned_artifacts.get("publicationSnapshot"))? {
                result.owned_paths.shift_remove("publicationSnapshot");
                result.owned_artifacts.shift_remove("publicationSnapshot");
            } else {
                result.owned_artifacts.get_mut("publicationSnapshot").unwrap().state = ArtifactState::CleanupPending;
                result.cleanup_pending.push("publicationSnapshot".into());
            }
        }
        persist(op, Snap::new(&result.owned_paths, &result.owned_artifacts).phase(ReplacementPhase::BackupDeleted).artifact(Some(&prepared.artifact)).pending(&result.cleanup_pending))?;
        result.phase = Some(ReplacementPhase::BackupDeleted);
        Ok(result)
    }

    /// preparePublication: outside the save slot, the snapshot copied beside the destination as .partial.
    pub fn prepare_publication(&self, op: &Op) -> R<Prepared> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let dest = valid_abs(op.destination.as_deref())?;
        let artifact = norm_artifact(op.publication_artifact.as_ref())?;
        if lstat_or_none(&dest)?.is_some() {
            return Err(txe("DESTINATION_COLLISION"));
        }
        let pn = new_nonce();
        let partial = publication_partial(&dest, &job, &item, &pn);
        let cp = canonical_for_new(&partial)?;
        let cd = canonical_for_new(&dest)?;
        if !same_pathbuf(&dirname(&cp), &dirname(&cd)) {
            return Err(unsafe_path("prepare-publication", &partial, "partial and destination real folders differ"));
        }
        let mut paths: Paths = [("publicationSnapshot".to_string(), artifact.path.clone()), ("destinationPartial".to_string(), partial.clone())].into_iter().collect();
        let mut arts: Artifacts = IndexMap::new();
        arts.insert("publicationSnapshot".into(), self.capture_publication(&artifact, None)?);
        arts.insert("destinationPartial".into(), artifact_metadata(&partial, &pn, ArtifactState::Intent, None, None, 0, None));
        persist(op, Snap::new(&paths, &arts).step("separate-prepare").artifact(Some(&artifact)))?;
        let r = (|| -> R<Option<String>> {
            {
                let (pr, ar, part, art) = (&paths, &mut arts, &partial, &artifact);
                self.copy_exclusive(
                    &artifact.path,
                    &partial,
                    CopyArgs { permissions: None, expected: Some((artifact.size, artifact.sha256.clone(), None)), cancel: op.cancel, collision: "PARTIAL_COLLISION", failure: "PUBLICATION_ARTIFACT_CHANGED", resume: None, hooks: Hooks { created: true, ..Default::default() } },
                    &mut |_, _, sha, st| {
                        ar.insert("destinationPartial".into(), artifact_metadata(part, &pn, ArtifactState::Writing, Some(st), Some(sha), 0, Some(journal_mark(0, sha))));
                        persist(op, Snap::new(pr, ar).step("separate-partial-writing").artifact(Some(art)))
                    },
                )?
            };
            let proof = self.prove_single_copy(&partial, artifact.size, &artifact.sha256, "PUBLICATION_ARTIFACT_CHANGED", op.cancel)?;
            let mt = proven_mtime(&proof);
            arts.insert("destinationPartial".into(), artifact_metadata(&partial, &pn, ArtifactState::Owned, Some(&proof.stat), Some(&artifact.sha256), artifact.size, None));
            persist(op, Snap::new(&paths, &arts).step("separate-partial-owned").artifact(Some(&artifact)))?;
            Ok(mt)
        })();
        let mtime = match r {
            Ok(m) => m,
            Err(mut e) => {
                self.drop_unfinished_copy(op, &partial, "destinationPartial", &mut paths, &mut arts, &artifact, &mut e);
                return Err(if e.tx { e } else { txe("DESTINATION_WRITE_FAILED") });
            }
        };
        Ok(Prepared {
            kind: "separate",
            job_id: job,
            item_id: item,
            codec: None,
            artifact,
            expected_source: None,
            source: String::new(),
            source_root: String::new(),
            backup: String::new(),
            backup_nonce: String::new(),
            candidate_mtime_ns: None,
            destination: dest,
            partial,
            partial_mtime_ns: mtime,
            owned_paths: paths,
            owned_artifacts: arts,
            _private: (),
        })
    }

    /// commitPublication: in the save slot, the prepared copy moved to the destination (never replaces).
    pub fn commit_publication(&self, op: &Op) -> R<Saved> {
        let p = op.prepared.filter(|p| p.kind == "separate").ok_or_else(|| txe("INVALID_TRANSACTION_INPUT"))?;
        let mut paths = p.owned_paths.clone();
        let mut arts = p.owned_artifacts.clone();
        let mut pending = vec![];
        let quick = match &p.partial_mtime_ns {
            Some(t) => quick_expected(&arts["destinationPartial"], Some(t), lstat_or_none(&p.partial)?.as_ref()),
            None => None,
        };
        let e = quick.clone().unwrap_or_else(|| arts["destinationPartial"].expected());
        let (_, removed) = self.promote_no_replace(&p.partial, &p.destination, "DESTINATION_COLLISION", Some(&e), true, quick.is_some())?;
        if removed {
            paths.shift_remove("destinationPartial");
            arts.shift_remove("destinationPartial");
        } else {
            arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
            pending.push("destinationPartial".into());
        }
        Ok(Saved { final_path: p.destination.clone(), output_bytes: p.artifact.size, phase: None, owned_paths: paths, owned_artifacts: arts, cleanup_pending: pending })
    }
}

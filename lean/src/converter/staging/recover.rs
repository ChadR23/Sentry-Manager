//! staging.js: recovery after a stop (recoverReplacement, recoverCopy,
//! completeRecoveredCopy) and cleanupOwnedArtifacts, which removes only
//! files whose recorded identity (and, on the share, content) proves they
//! are the converter's own. A replacement backup, possibly the last copy of
//! an original, is never removed here.

use super::*;

pub struct Recovered {
    pub phase: Option<ReplacementPhase>,
    pub action: Option<&'static str>,
    pub final_path: Option<String>,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
    pub cleanup_pending: Vec<String>,
    pub publication_artifact: Option<Artifact>,
}

impl Recovered {
    fn phase(phase: ReplacementPhase, paths: Paths, arts: Artifacts, pending: Vec<String>) -> Recovered {
        Recovered { phase: Some(phase), action: None, final_path: None, owned_paths: paths, owned_artifacts: arts, cleanup_pending: pending, publication_artifact: None }
    }
}

pub struct Cleaned {
    pub cleaned: bool,
    pub cleanup_pending: Vec<String>,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
    pub clear_owned_keys: Vec<String>,
    pub publication_artifact: Option<Artifact>,
}

fn snapshot_cleanup(tx: &Tx, a: Option<&Artifact>, paths: &mut Paths, arts: &mut Artifacts, pending: &mut Vec<String>) -> R<()> {
    let Some(a) = a else { return Ok(()) };
    if tx.cleanup_publication(Some(a), arts.get("publicationSnapshot"))? {
        paths.shift_remove("publicationSnapshot");
        arts.shift_remove("publicationSnapshot");
    } else {
        if let Some(m) = arts.get_mut("publicationSnapshot") {
            m.state = ArtifactState::CleanupPending;
        }
        pending.push("publicationSnapshot".into());
    }
    Ok(())
}

impl Tx {
    /// completeRecoveredCopy: an interrupted copy of the snapshot finished from its journal, then proven.
    fn complete_recovered_copy(&self, op: &Op, artifact: &Artifact, target: &str, field: &str, prefix: &str, paths: &Paths, arts: &mut Artifacts, failure: &str) -> R<Meta> {
        let mut m = arts.get(field).cloned().ok_or_else(|| unsafe_path("complete-recovered-copy", target, format!("no {field} record")))?;
        if let Some(journal) = m.journal.clone() {
            let s_reconciled = format!("{prefix}-resume-reconciled");
            let s_pending = format!("{prefix}-chunk-pending");
            let s_committed = format!("{prefix}-chunk-committed");
            let copied = {
                let mc = m.clone();
                let ar = &mut *arts;
                self.copy_exclusive(
                    &artifact.path,
                    target,
                    CopyArgs { expected: Some((artifact.size, artifact.sha256.clone(), None)), cancel: op.cancel, collision: "PARTIAL_COLLISION", failure, resume: Some((&mc, &journal)), hooks: Hooks { created: false, pending: true, committed: true, reconciled: true } },
                    &mut |ev, size, sha, _| {
                        if ev == Event::ChunkPending {
                            let f = ar.get_mut(field).unwrap();
                            f.state = ArtifactState::Writing;
                            f.journal.get_or_insert_with(Journal::default).pending = Some(Mark { size, sha256: sha.into() });
                            return persist(op, Snap::new(paths, ar).step(&s_pending).artifact(Some(artifact)));
                        }
                        let mut p = ar[field].clone();
                        p.state = ArtifactState::Writing;
                        p.size = Some(size);
                        p.sha256 = Some(sha.into());
                        p.journal = Some(Journal { committed: Some(Mark { size, sha256: sha.into() }), pending: None });
                        let mut proposed = ar.clone();
                        proposed.insert(field.into(), p.clone());
                        let step = if ev == Event::ResumeReconciled { &s_reconciled } else { &s_committed };
                        persist(op, Snap::new(paths, &proposed).step(step).artifact(Some(artifact)))?;
                        ar.insert(field.into(), p);
                        Ok(())
                    },
                )?
            };
            let j = arts[field].journal.clone();
            arts.insert(field.into(), artifact_metadata(target, &m.nonce, ArtifactState::Owned, Some(&copied.stat), Some(&copied.sha256), copied.size, j));
            let step = format!("{prefix}-owned");
            persist(op, Snap::new(paths, arts).step(&step).artifact(Some(artifact)))?;
            m = arts[field].clone();
        }
        if m.size != Some(artifact.size) || m.sha256.as_deref() != Some(&artifact.sha256) {
            return Err(txe("MANUAL_INTERVENTION"));
        }
        self.read_exact_meta(target, &m, failure)?;
        Ok(m)
    }

    /// recoverReplacement({ action, ... }): one step of putting a stopped replacement right.
    pub fn recover_replacement(&self, op: &Op) -> R<Recovered> {
        const ALLOWED: [&str; 9] = ["backup-original", "promote-candidate", "validate-final", "restart-replacement", "restore-backup", "delete-backup", "finish-replacement", "rollback-complete", "manual-intervention"];
        let action = op.action.as_deref().unwrap_or("");
        if !ALLOWED.contains(&action) {
            return Err(txe("RECOVERY_ACTION_INVALID"));
        }
        if action == "manual-intervention" {
            return Err(txe("MANUAL_INTERVENTION"));
        }
        let expected = validate_source_authority(op.expected_source.as_ref())?;
        let (source, source_root, _) = self.assert_source_or_missing_contained(op.source.as_deref(), op.source_root.as_deref())?;
        let artifact = norm_artifact(op.publication_artifact.as_ref())?;
        let mut paths = op.owned_paths.clone();
        let mut arts = op.owned_artifacts.clone();
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let (ec, eb) = recorded_replacement_paths(&source, &job, &item, &arts, op.codec.as_deref())?;
        let candidate = valid_abs(Some(paths.get("replacementCandidate").cloned().unwrap_or(ec).as_str()))?;
        let backup = valid_abs(Some(paths.get("replacementBackup").cloned().unwrap_or(eb).as_str()))?;
        let persisted = paths.get("publicationSnapshot").filter(|p| same_path(p, &artifact.path)).map(|_| artifact.clone());
        self.assert_replacement_names(&source, &candidate, &backup, &job, &item, &arts, op.codec.as_deref())?;
        if persisted.is_some() && !arts.contains_key("publicationSnapshot") {
            return Err(txe("INVALID_PUBLICATION_ARTIFACT"));
        }
        self.validate_publication(&artifact, Validate::Reconcile(&artifact))?;
        let pa = persisted.as_ref();

        // A stop between linking the backup name and renaming the copy over the original.
        if self.drop_backup_alias(&source, &backup)? {
            if let Some(b) = arts.get("replacementBackup").cloned() {
                arts.insert("replacementBackup".into(), artifact_metadata(&backup, &b.nonce, ArtifactState::Intent, None, None, 0, None));
                persist(op, Snap::new(&paths, &arts).step("recovery-backup-alias-dropped").artifact(pa))?;
            }
        }
        // A stop between moving the original to its backup name and recording it.
        if action != "backup-original" && arts.get("replacementBackup").is_some_and(|m| m.state == ArtifactState::Intent) {
            if let Some(bst) = lstat_or_none(&backup)? {
                if !is_regular(&bst) || !single_link(&bst) || bst.dev().to_string() != expected.device || bst.ino().to_string() != expected.inode || bst.size() != expected.size {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                let n = arts["replacementBackup"].nonce.clone();
                arts.insert("replacementBackup".into(), artifact_metadata(&backup, &n, ArtifactState::Owned, Some(&bst), Some(&expected.sha256), expected.size, None));
                persist(op, Snap::new(&paths, &arts).step("recovery-backup-adopted").artifact(pa))?;
            }
        }

        match action {
            "backup-original" => {
                if lstat_or_none(&backup)?.is_some() {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                self.assert_source_authority(&source, &expected, op.cancel)?;
                if lstat_or_none(&source)?.is_none() || lstat_or_none(&backup)?.is_some() {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                if !arts.get("replacementBackup").is_some_and(|m| m.state == ArtifactState::Intent && same_path(&m.path, &backup)) {
                    let d = match arts.get("replacementBackup") {
                        None => "no replacementBackup record".to_string(),
                        Some(m) if m.state != ArtifactState::Intent => format!("backup record state {} != intent", m.state),
                        Some(_) => "backup record path differs".to_string(),
                    };
                    return Err(unsafe_path("recover-backup-original", &backup, d));
                }
                persist(op, Snap::new(&paths, &arts).step("recovery-backup-intent").artifact(pa))?;
                self.before_replace(&source, &source_root, &expected, &job, &item)?;
                if arts.contains_key("replacementCandidate") {
                    self.complete_recovered_copy(op, &artifact, &candidate, "replacementCandidate", "recovery-candidate", &paths, &mut arts, "PUBLICATION_ARTIFACT_CHANGED")?;
                    if self.link_backup_aside(&source, &backup, &expected)? {
                        let linked = exact_lstat(&backup)?;
                        let n = arts["replacementBackup"].nonce.clone();
                        arts.insert("replacementBackup".into(), artifact_metadata(&backup, &n, ArtifactState::Owned, Some(&linked), Some(&expected.sha256), expected.size, None));
                        persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::OriginalBackedUp).artifact(pa))?;
                        if let Err(e) = self.replace_over_original(&candidate, &source, &backup, &arts["replacementCandidate"].expected(), false, &expected) {
                            if self.drop_backup_alias(&source, &backup).unwrap_or(false) {
                                let n = arts["replacementBackup"].nonce.clone();
                                arts.insert("replacementBackup".into(), artifact_metadata(&backup, &n, ArtifactState::Intent, None, None, 0, None));
                                let _ = persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::CandidateWritten).artifact(pa));
                            }
                            return Err(e);
                        }
                        persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::CandidatePromoted).artifact(pa))?;
                        return Ok(Recovered::phase(ReplacementPhase::CandidatePromoted, paths, arts, vec![]));
                    }
                }
                let (_, removed) = self.promote_no_replace(&source, &backup, "REPLACEMENT_COLLISION", Some(&expected.expected()), true, false)?;
                let o = self.inspect_exact_file(&backup, op.cancel, "REPLACEMENT_FAILED")?;
                let n = arts["replacementBackup"].nonce.clone();
                arts.insert("replacementBackup".into(), artifact_metadata(&backup, &n, if removed { ArtifactState::Owned } else { ArtifactState::CleanupPending }, Some(&o.stat), Some(&o.sha256), o.size, None));
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::OriginalBackedUp).artifact(pa))?;
                Ok(Recovered::phase(ReplacementPhase::OriginalBackedUp, paths, arts, vec![]))
            }
            "promote-candidate" => {
                if !arts.contains_key("replacementCandidate") {
                    return Err(unsafe_path("recover-promote-candidate", &candidate, "no replacementCandidate record"));
                }
                if lstat_or_none(&source)?.is_some() {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                self.complete_recovered_copy(op, &artifact, &candidate, "replacementCandidate", "recovery-candidate", &paths, &mut arts, "PUBLICATION_ARTIFACT_CHANGED")?;
                persist(op, Snap::new(&paths, &arts).step("recovery-promotion-intent").artifact(pa))?;
                self.before_replace(&source, &source_root, &expected, &job, &item)?;
                let (_, removed) = self.promote_no_replace(&candidate, &source, "REPLACEMENT_COLLISION", Some(&arts["replacementCandidate"].expected()), true, false)?;
                if !removed {
                    arts.get_mut("replacementCandidate").unwrap().state = ArtifactState::CleanupPending;
                }
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::CandidatePromoted).artifact(pa))?;
                Ok(Recovered::phase(ReplacementPhase::CandidatePromoted, paths, arts, vec![]))
            }
            "validate-final" => match self.validate_readable(&source, &artifact, op.verify_readable, "FINAL_VALIDATION_FAILED").and_then(|_| persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::FinalValidated).artifact(pa))) {
                Ok(()) => Ok(Recovered::phase(ReplacementPhase::FinalValidated, paths, arts, vec![])),
                Err(e) => {
                    let rop = self.rollback_op(op, &source, &source_root, &paths, &arts, &artifact);
                    self.rollback_replacement(&rop)?;
                    Err(e)
                }
            },
            "delete-backup" => {
                self.validate_readable(&source, &artifact, op.verify_readable, "FINAL_VALIDATION_FAILED")?;
                self.read_exact_artifact(&source, &artifact, "FINAL_VALIDATION_FAILED", None)?;
                persist(op, Snap::new(&paths, &arts).step("recovery-delete-backup-intent").artifact(pa))?;
                let mut pending = vec![];
                match self.remove_replacement_backup(&backup, arts.get("replacementBackup"), &source, &artifact, None, None, None) {
                    Ok(_) => {
                        paths.shift_remove("replacementBackup");
                        arts.shift_remove("replacementBackup");
                    }
                    Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                        arts.get_mut("replacementBackup").unwrap().state = ArtifactState::CleanupPending;
                        pending.push("replacementBackup".into());
                    }
                    Err(e) => return Err(e),
                }
                snapshot_cleanup(self, pa, &mut paths, &mut arts, &mut pending)?;
                paths.shift_remove("replacementCandidate");
                arts.shift_remove("replacementCandidate");
                let phase = if arts.contains_key("replacementBackup") { ReplacementPhase::FinalValidated } else { ReplacementPhase::BackupDeleted };
                persist(op, Snap::new(&paths, &arts).phase(phase.clone()).artifact(pa).pending(&pending))?;
                Ok(Recovered::phase(phase, paths, arts, pending))
            }
            "restore-backup" => {
                let rop = self.rollback_op(op, &source, &source_root, &paths, &arts, &artifact);
                let r = self.rollback_replacement(&rop)?;
                Ok(Recovered::phase(ReplacementPhase::BackupRestored, r.owned_paths, r.owned_artifacts, r.cleanup_pending))
            }
            "restart-replacement" => {
                persist(op, Snap::new(&paths, &arts).step("restart-replacement-cleanup-intent").artifact(pa))?;
                let mut pending = vec![];
                if lstat_or_none(&candidate)?.is_some() {
                    match self.remove_exact_owned(&candidate, arts.get("replacementCandidate"), false, false, None, None) {
                        Ok(_) => {
                            paths.shift_remove("replacementCandidate");
                            arts.shift_remove("replacementCandidate");
                        }
                        Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                            arts.get_mut("replacementCandidate").unwrap().state = ArtifactState::CleanupPending;
                            pending.push("replacementCandidate".into());
                        }
                        Err(e) => return Err(e),
                    }
                } else {
                    paths.shift_remove("replacementCandidate");
                    arts.shift_remove("replacementCandidate");
                }
                if lstat_or_none(&source)?.is_none() || lstat_or_none(&backup)?.is_some() {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                paths.shift_remove("replacementBackup");
                arts.shift_remove("replacementBackup");
                snapshot_cleanup(self, pa, &mut paths, &mut arts, &mut pending)?;
                let step = if pending.is_empty() { "restart-replacement" } else { "restart-replacement-cleanup-pending" };
                persist(op, Snap::new(&paths, &arts).step(step).artifact(pa).pending(&pending))?;
                let keep = arts.contains_key("publicationSnapshot").then(|| artifact.clone());
                Ok(Recovered { phase: None, action: Some("restart-replacement"), final_path: None, owned_paths: paths, owned_artifacts: arts, cleanup_pending: pending, publication_artifact: keep })
            }
            "rollback-complete" => {
                if lstat_or_none(&source)?.is_none() || lstat_or_none(&backup)?.is_some() {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                persist(op, Snap::new(&paths, &arts).step("rollback-complete-cleanup-intent").artifact(pa))?;
                paths.shift_remove("replacementBackup");
                arts.shift_remove("replacementBackup");
                let mut pending = vec![];
                if lstat_or_none(&candidate)?.is_some() {
                    match self.remove_exact_owned(&candidate, arts.get("replacementCandidate"), false, false, None, None) {
                        Ok(_) => {}
                        Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                            arts.get_mut("replacementCandidate").unwrap().state = ArtifactState::CleanupPending;
                            pending.push("replacementCandidate".into());
                        }
                        Err(e) => return Err(e),
                    }
                }
                snapshot_cleanup(self, pa, &mut paths, &mut arts, &mut pending)?;
                if !pending.iter().any(|p| p == "replacementCandidate") {
                    paths.shift_remove("replacementCandidate");
                    arts.shift_remove("replacementCandidate");
                }
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::BackupRestored).artifact(pa).pending(&pending))?;
                Ok(Recovered::phase(ReplacementPhase::BackupRestored, paths, arts, pending))
            }
            "finish-replacement" => {
                self.validate_readable(&source, &artifact, op.verify_readable, "FINAL_VALIDATION_FAILED")?;
                persist(op, Snap::new(&paths, &arts).step("recovery-finish-cleanup-intent").artifact(pa))?;
                let mut pending = vec![];
                if lstat_or_none(&backup)?.is_some() {
                    let bm = arts.get("replacementBackup").cloned().ok_or_else(|| unsafe_path("recover-finish-replacement", &backup, "no replacementBackup record"))?;
                    self.read_exact_meta(&backup, &bm, "UNSAFE_OWNED_PATH")?;
                    match self.remove_replacement_backup(&backup, Some(&bm), &source, &artifact, None, None, None) {
                        Ok(_) => {
                            paths.shift_remove("replacementBackup");
                            arts.shift_remove("replacementBackup");
                        }
                        Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                            arts.get_mut("replacementBackup").unwrap().state = ArtifactState::CleanupPending;
                            pending.push("replacementBackup".into());
                        }
                        Err(e) => return Err(e),
                    }
                } else {
                    // removed but for its last step (still under a quarantine name)
                    let fst = exact_lstat(&source)?;
                    let ge = Expected { device: fst.dev().to_string(), inode: fst.ino().to_string(), size: artifact.size, sha256: artifact.sha256.clone(), mtime_ns: None };
                    self.remove_quarantined(&backup, arts.get("replacementBackup"), Some((&source, &ge)));
                    paths.shift_remove("replacementBackup");
                    arts.shift_remove("replacementBackup");
                }
                if lstat_or_none(&candidate)?.is_some() {
                    let fst = exact_lstat(&source)?;
                    let cst = exact_lstat(&candidate)?;
                    if !same_identity(&fst, &cst) {
                        return Err(txe("MANUAL_INTERVENTION"));
                    }
                    let cm = arts.get("replacementCandidate").cloned().ok_or_else(|| unsafe_path("recover-finish-replacement", &candidate, "no replacementCandidate record"))?;
                    self.read_exact_meta(&candidate, &cm, "UNSAFE_OWNED_PATH")?;
                    match self.remove_exact_owned(&candidate, Some(&cm), false, false, None, None) {
                        Ok(_) => {
                            paths.shift_remove("replacementCandidate");
                            arts.shift_remove("replacementCandidate");
                        }
                        Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                            arts.get_mut("replacementCandidate").unwrap().state = ArtifactState::CleanupPending;
                            pending.push("replacementCandidate".into());
                        }
                        Err(e) => return Err(e),
                    }
                } else {
                    paths.shift_remove("replacementCandidate");
                    arts.shift_remove("replacementCandidate");
                }
                snapshot_cleanup(self, pa, &mut paths, &mut arts, &mut pending)?;
                persist(op, Snap::new(&paths, &arts).phase(ReplacementPhase::BackupDeleted).artifact(pa).pending(&pending))?;
                Ok(Recovered::phase(ReplacementPhase::BackupDeleted, paths, arts, pending))
            }
            _ => unreachable!(),
        }
    }

    fn rollback_op<'a>(&self, op: &Op<'a>, source: &str, root: &str, paths: &Paths, arts: &Artifacts, artifact: &Artifact) -> Op<'a> {
        Op {
            job_id: op.job_id.clone(),
            item_id: op.item_id.clone(),
            codec: op.codec.clone(),
            source: Some(source.into()),
            source_root: Some(root.into()),
            owned_paths: paths.clone(),
            owned_artifacts: arts.clone(),
            publication_artifact: Some(artifact.clone()),
            persist: op.persist,
            persist_phase: op.persist_phase,
            verify_readable: op.verify_readable,
            cancel: op.cancel,
            ..Default::default()
        }
    }

    /// recoverCopy({ action: restart-copy | resume-copy | finalize-copy, ... })
    pub fn recover_copy(&self, op: &Op) -> R<Recovered> {
        let action = op.action.as_deref().unwrap_or("");
        if !["restart-copy", "resume-copy", "finalize-copy"].contains(&action) {
            return Err(txe("RECOVERY_ACTION_INVALID"));
        }
        let dest = valid_abs(op.destination.as_deref())?;
        if action == "restart-copy" {
            if !op.owned_paths.is_empty() || !op.owned_artifacts.is_empty() {
                return Err(txe("MANUAL_INTERVENTION"));
            }
            return Ok(Recovered { phase: None, action: Some("restart-copy"), final_path: Some(dest), owned_paths: IndexMap::new(), owned_artifacts: IndexMap::new(), cleanup_pending: vec![], publication_artifact: None });
        }
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let artifact = norm_artifact(op.publication_artifact.as_ref())?;
        let mut paths = op.owned_paths.clone();
        let mut arts = op.owned_artifacts.clone();
        let nonce = arts.get("destinationPartial").map(|m| m.nonce.clone()).unwrap_or_else(|| "undefined".into());
        let expected_partial = publication_partial(&dest, &job, &item, &nonce);
        if !paths.get("destinationPartial").is_some_and(|p| same_path(p, &expected_partial)) || !paths.get("publicationSnapshot").is_some_and(|p| same_path(p, &artifact.path)) || !arts.contains_key("destinationPartial") || !arts.contains_key("publicationSnapshot") {
            let mut d = Vec::new();
            if !paths.get("destinationPartial").is_some_and(|p| same_path(p, &expected_partial)) {
                d.push("destinationPartial path differs from the expected partial name");
            }
            if !paths.get("publicationSnapshot").is_some_and(|p| same_path(p, &artifact.path)) {
                d.push("publicationSnapshot path differs from the artifact");
            }
            if !arts.contains_key("destinationPartial") {
                d.push("no destinationPartial record");
            }
            if !arts.contains_key("publicationSnapshot") {
                d.push("no publicationSnapshot record");
            }
            return Err(unsafe_path("recover-copy", &expected_partial, d.join("; ")));
        }
        self.validate_publication(&artifact, Validate::Reconcile(&artifact))?;
        let mut promotion_pending = false;
        let mut promoted = false;
        let mut final_verified = false;
        if action == "resume-copy" {
            if lstat_or_none(&dest)?.is_some() {
                return Err(txe("DESTINATION_COLLISION"));
            }
            self.complete_recovered_copy(op, &artifact, &expected_partial, "destinationPartial", "copy-recovery-partial", &paths, &mut arts, "PUBLICATION_ARTIFACT_CHANGED")?;
            persist(op, Snap::new(&paths, &arts).step("copy-recovery-promotion-intent").artifact(Some(&artifact)))?;
            let (_, removed) = self.promote_no_replace(&expected_partial, &dest, "DESTINATION_COLLISION", Some(&arts["destinationPartial"].expected()), false, false)?;
            promoted = true;
            if !removed {
                arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                promotion_pending = true;
            }
        } else {
            self.validate_readable(&dest, &artifact, op.verify_readable, "DESTINATION_VALIDATION_FAILED")?;
            final_verified = true;
            if let Ok(pst) = exact_lstat(&expected_partial) {
                let fst = exact_lstat(&dest)?;
                if !same_identity(&pst, &fst) {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                // the partial name is a second link of the verified destination
                arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
            }
        }
        let r = (|| -> R<Recovered> {
            self.validate_readable(&dest, &artifact, op.verify_readable, "DESTINATION_VALIDATION_FAILED")?;
            final_verified = true;
            persist(op, Snap::new(&paths, &arts).step("copy-recovery-cleanup-intent").artifact(Some(&artifact)))?;
            if !promotion_pending && lstat_or_none(&expected_partial)?.is_some() {
                let pm = arts["destinationPartial"].clone();
                self.read_exact_meta(&expected_partial, &pm, "UNSAFE_OWNED_PATH")?;
                match self.remove_exact_owned(&expected_partial, Some(&pm), false, false, None, None) {
                    Ok(_) => {}
                    Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                        arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                        promotion_pending = true;
                    }
                    Err(e) => return Err(e),
                }
            }
            if !promotion_pending {
                paths.shift_remove("destinationPartial");
                arts.shift_remove("destinationPartial");
            }
            if self.cleanup_publication(Some(&artifact), arts.get("publicationSnapshot"))? {
                paths.shift_remove("publicationSnapshot");
                arts.shift_remove("publicationSnapshot");
            } else {
                arts.get_mut("publicationSnapshot").unwrap().state = ArtifactState::CleanupPending;
            }
            let mut pending = vec![];
            if promotion_pending {
                pending.push("destinationPartial".to_string());
            }
            if arts.contains_key("publicationSnapshot") {
                pending.push("publicationSnapshot".into());
            }
            let step = if pending.is_empty() { "copy-complete" } else { "copy-complete-cleanup-pending" };
            persist(op, Snap::new(&paths, &arts).step(step).artifact(Some(&artifact)).pending(&pending))?;
            Ok(Recovered { phase: None, action: None, final_path: Some(dest.clone()), owned_paths: paths.clone(), owned_artifacts: arts.clone(), cleanup_pending: pending, publication_artifact: None })
        })();
        let Err(mut error) = r else { return r };
        let mut failed: Vec<String> = vec![];
        if promoted && !final_verified {
            if self.remove_exact_owned(&dest, arts.get("destinationPartial"), true, true, None, None).is_err() {
                arts.get_mut("destinationPartial").unwrap().state = ArtifactState::CleanupPending;
                failed.push("destinationPartial".into());
            }
            if !failed.iter().any(|f| f == "destinationPartial") && lstat_or_none(&expected_partial)?.is_some() {
                match self.remove_exact_owned(&expected_partial, arts.get("destinationPartial"), true, false, None, None) {
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
        }
        if self.cleanup_publication(Some(&artifact), arts.get("publicationSnapshot"))? {
            paths.shift_remove("publicationSnapshot");
            arts.shift_remove("publicationSnapshot");
        } else {
            if let Some(m) = arts.get_mut("publicationSnapshot") {
                m.state = ArtifactState::CleanupPending;
            }
            failed.push("publicationSnapshot".into());
        }
        if !failed.is_empty() {
            let _ = persist(op, Snap::new(&paths, &arts).step("copy-recovery-failed-cleanup-pending").artifact(Some(&artifact)).pending(&failed));
            if error.tx {
                error.cleanup_pending = Some(failed);
            }
        }
        Err(error)
    }

    /// cleanupOwnedArtifacts({ jobId, itemId, ownedPaths, ownedArtifacts, publicationArtifact, source, sourceRoot, codec })
    pub fn cleanup_owned_artifacts(&self, op: &Op) -> R<Cleaned> {
        let job = validate_id(&op.job_id)?;
        let item = validate_id(&op.item_id)?;
        let gp = &op.owned_paths;
        let ga = &op.owned_artifacts;
        if gp.keys().any(|k| !OWNED_PATH_FIELDS.contains(&k.as_str())) || ga.keys().any(|k| !OWNED_PATH_FIELDS.contains(&k.as_str())) || gp.iter().any(|(k, p)| !ga.get(k).is_some_and(|m| &m.path == p)) {
            return Err(txe("INVALID_TRANSACTION_INPUT"));
        }
        let mut paths = gp.clone();
        let mut arts = ga.clone();
        let given: Vec<String> = gp.keys().cloned().collect();
        let artifact = match &op.publication_artifact {
            Some(a) => Some(norm_artifact(Some(a))?),
            None => None,
        };
        let source = match &op.source {
            Some(s) => Some(valid_abs(Some(s))?),
            None => None,
        };
        let source_root = match &op.source_root {
            Some(s) => Some(valid_abs(Some(s))?),
            None => None,
        };
        let real_temp = canonical_existing(&s(&self.temp_root))?;
        if let Some(p) = paths.get("encodedCandidate") {
            self.release_owned_lease(p);
        }
        let mut pending: Vec<String> = vec![];
        // copies on the share first: an interrupted one is proven against the snapshot
        const ORDER: [&str; 6] = ["destinationPartial", "replacementCandidate", "encodedCandidate", "stagedSource", "publicationSnapshot", "replacementBackup"];
        for field in ORDER {
            let Some(raw) = paths.get(field).cloned() else { continue };
            let target = valid_abs(Some(&raw))?;
            if field == "replacementBackup" {
                // possibly the last original: only replacement recovery may remove it
                if arts.get(field).is_some_and(|m| m.state == ArtifactState::Intent) && lstat_or_none(&target)?.is_none() {
                    paths.shift_remove(field);
                    arts.shift_remove(field);
                    continue;
                }
                pending.push(field.into());
                continue;
            }
            if field == "publicationSnapshot" {
                let Some(a) = artifact.as_ref().filter(|a| same_path(&target, &a.path)) else {
                    return Err(unsafe_path("cleanup-owned", &target, if artifact.is_none() { "publicationSnapshot: no publication artifact" } else { "publicationSnapshot path differs from the artifact" }));
                };
                self.validate_publication(a, Validate::Reconcile(a))?;
                if !self.cleanup_publication(Some(a), arts.get(field))? {
                    arts.get_mut(field).unwrap().state = ArtifactState::CleanupPending;
                    pending.push(field.into());
                }
                continue;
            }
            let m = arts[field].clone();
            if field == "stagedSource" || field == "encodedCandidate" {
                let canon = canonical_for_new(&target)?;
                let prefix = format!("{job}-{item}-{}-", m.nonce);
                let base = Path::new(&target).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if !contained(Path::new(&real_temp), Path::new(&canon)) || !base.starts_with(&prefix) {
                    let d = if !contained(Path::new(&real_temp), Path::new(&canon)) { "real path is outside the temp folder" } else { "name lacks the job-item-nonce prefix" };
                    return Err(unsafe_path("cleanup-owned", &target, format!("{field}: {d}")));
                }
                match self.remove_private_file(&target, &m, &real_temp) {
                    Ok(_) => {}
                    Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                        arts.get_mut(field).unwrap().state = ArtifactState::CleanupPending;
                        pending.push(field.into());
                    }
                    Err(e) => return Err(e),
                }
                continue;
            } else if field == "destinationPartial" {
                let suffix = format!(".sentry-six-{job}-{item}-{}.partial", m.nonce);
                if !target.ends_with(&suffix) {
                    return Err(unsafe_path("cleanup-owned", &target, "destinationPartial: name lacks the job-item-nonce suffix"));
                }
                let expected = publication_partial(&target[..target.len() - suffix.len()], &job, &item, &m.nonce);
                if !same_path(&expected, &target) {
                    return Err(unsafe_path("cleanup-owned", &target, "destinationPartial: name is not the expected partial name"));
                }
            } else {
                let (Some(src), Some(root)) = (&source, &source_root) else { return Err(unsafe_path("cleanup-owned", &target, format!("{field}: no source or source root"))) };
                self.assert_source_or_missing_contained(Some(src), Some(root))?;
                let (c, b) = recorded_replacement_paths(src, &job, &item, &arts, op.codec.as_deref())?;
                let expected = if field == "replacementCandidate" { c } else { b };
                if !same_path(&expected, &target) {
                    return Err(unsafe_path("cleanup-owned", &target, format!("{field}: name differs from the recorded replacement name")));
                }
            }
            let res = if field == "destinationPartial" || field == "replacementCandidate" { self.remove_share_copy(&target, &m, artifact.as_ref()) } else { self.remove_exact_owned(&target, Some(&m), true, false, None, None) };
            match res {
                Ok(_) => {}
                Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => {
                    arts.get_mut(field).unwrap().state = ArtifactState::CleanupPending;
                    pending.push(field.into());
                }
                Err(e) => return Err(e),
            }
        }
        if pending.is_empty() {
            return Ok(Cleaned { cleaned: true, cleanup_pending: vec![], owned_paths: IndexMap::new(), owned_artifacts: IndexMap::new(), clear_owned_keys: vec![], publication_artifact: None });
        }
        for f in &given {
            if pending.contains(f) || !paths.contains_key(f) {
                continue;
            }
            paths.shift_remove(f);
            arts.shift_remove(f);
        }
        let clears: Vec<String> = given.iter().filter(|k| !paths.contains_key(*k)).cloned().collect();
        let clear_refs: Vec<&str> = clears.iter().map(String::as_str).collect();
        let keep_artifact = if paths.contains_key("publicationSnapshot") { artifact.clone() } else { None };
        persist(op, Snap::new(&paths, &arts).step("owned-cleanup-pending").artifact(keep_artifact.as_ref()).pending(&pending).clears(&clear_refs))?;
        for f in &pending {
            if f == "stagedSource" || f == "encodedCandidate" {
                if let Some(p) = paths.get(f) {
                    self.release_owned_lease(p);
                }
            }
        }
        Ok(Cleaned { cleaned: false, cleanup_pending: pending, owned_paths: paths, owned_artifacts: arts, clear_owned_keys: clears, publication_artifact: keep_artifact })
    }
}

//! The next step of an interrupted replacement: jobStore.js
//! REPLACEMENT_TRUTH_TABLES / replacementAction, from the files on disk
//! (runtime.js createRecoveryInspector) and the last phase recorded.

use super::jobstore::states::ReplacementPhase;
use super::snapshot::Artifact;
use super::tesla_sei::hex;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Facts {
    pub candidate_exists: bool,
    pub partial_exists: bool,
    pub final_exists: bool,
    pub source_exists: bool,
    pub backup_exists: bool,
    pub final_valid: bool,
    pub partial_final_proven: bool,
}

fn table(phase: &ReplacementPhase) -> Option<&'static [(&'static str, &'static str)]> {
    use ReplacementPhase::*;
    Some(match phase {
        CandidateWritten => &[
            ("1100", "backup-original"),
            ("1110", "backup-original"),
            ("1010", "promote-candidate"),
            ("0110", "validate-final"),
            ("0100", "restart-replacement"),
            ("0010", "restore-backup"),
            ("0111", "delete-backup"),
            ("0101", "finish-replacement"),
        ],
        OriginalBackedUp => &[("1110", "backup-original"), ("1010", "promote-candidate"), ("0110", "validate-final"), ("0010", "restore-backup"), ("0111", "delete-backup"), ("0101", "finish-replacement")],
        CandidatePromoted => &[("1010", "promote-candidate"), ("0110", "validate-final"), ("0010", "restore-backup"), ("0111", "delete-backup"), ("0101", "finish-replacement")],
        FinalValidated => &[("0111", "delete-backup"), ("0101", "finish-replacement"), ("0010", "restore-backup")],
        BackupDeleted => &[("0111", "delete-backup"), ("0101", "finish-replacement"), ("0100", "finish-replacement"), ("0010", "restore-backup")],
        RollbackStarted | BackupRestored | RollbackFailed => &[("0100", "rollback-complete"), ("0010", "restore-backup"), ("1010", "restore-backup"), ("1110", "restore-backup")],
        Unknown(_) => return None,
    })
}

/// The actions recovery may record for a phase (REPLACEMENT_ACTIONS_BY_PHASE,
/// without 'manual-intervention', which every phase allows).
pub fn phase_actions(phase: &ReplacementPhase) -> Option<Vec<&'static str>> {
    table(phase).map(|t| t.iter().map(|(_, a)| *a).collect())
}

/// replacementAction(manifest, facts)
pub fn replacement_action(phase: Option<&ReplacementPhase>, facts: Option<&Facts>, has_expected_source: bool) -> &'static str {
    let Some(f) = facts else { return "manual-intervention" };
    if !has_expected_source || f.partial_exists || f.final_exists {
        return "manual-intervention";
    }
    let Some(t) = phase.and_then(table) else { return "manual-intervention" };
    let b = |x: bool| if x { '1' } else { '0' };
    let key: String = [b(f.candidate_exists), b(f.source_exists), b(f.backup_exists), b(f.final_valid)].iter().collect();
    t.iter().find(|(k, _)| *k == key).map(|(_, a)| *a).unwrap_or("manual-intervention")
}

fn exists(p: Option<&str>) -> std::io::Result<bool> {
    let Some(p) = p else { return Ok(false) };
    match std::fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// A separate destination was published if it still names the recorded
/// partial inode, or the record says promotion already happened. Identical
/// bytes at a pre-existing destination alone do not establish that history.
pub fn recorded_copy_pair(partial: &str, m: &super::staging::Meta, dest: &std::fs::Metadata, a: &Artifact) -> bool {
    use super::jobstore::states::ArtifactState;
    use std::os::unix::fs::MetadataExt;
    m.path == partial && !m.nonce.is_empty() && m.size == Some(a.size) && m.sha256.as_deref() == Some(&a.sha256)
        && matches!(m.state, ArtifactState::Owned | ArtifactState::CleanupPending) && dest.is_file() && dest.nlink() == 1
        && (m.state == ArtifactState::CleanupPending || (m.device == Some(dest.dev().to_string()) && m.inode == Some(dest.ino().to_string())))
}

/// matchesDigest: the file holds exactly the artifact's bytes.
pub fn matches_digest(target: &str, a: &Artifact, cancel: Option<&AtomicBool>) -> std::io::Result<bool> {
    let mut f = match File::open(target) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };
    let st = f.metadata()?;
    if !st.is_file() || st.len() != a.size {
        return Ok(false);
    }
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut off = 0u64;
    while off < st.len() {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "CANCELLED"));
        }
        let req = buf.len().min((st.len() - off) as usize);
        let mut n = 0;
        while n < req {
            let r = f.read(&mut buf[n..req])?;
            if r == 0 {
                return Ok(false);
            }
            n += r;
        }
        h.update(&buf[..n]);
        off += n as u64;
    }
    Ok(hex(&h.finalize()) == a.sha256)
}

/// createRecoveryInspector for a replace-mode job.
pub struct ReplaceState<'a> {
    pub replacing: bool,
    pub copying: bool,
    pub source: &'a str,
    /// the destination path in separate mode (None in replace mode)
    pub separate_final: Option<&'a str>,
    pub replacement_candidate: Option<&'a str>,
    pub encoded_candidate: Option<&'a str>,
    pub destination_partial: Option<&'a str>,
    pub replacement_backup: Option<&'a str>,
    pub artifact: Option<&'a Artifact>,
}

pub fn inspect(s: &ReplaceState, cancel: Option<&AtomicBool>) -> std::io::Result<Facts> {
    let final_path = if s.separate_final.is_some() { s.separate_final } else if s.replacing { Some(s.source) } else { None };
    let candidate = if s.replacing { s.replacement_candidate } else if s.copying { None } else { s.encoded_candidate };
    let candidate_exists = exists(candidate)?;
    let partial_exists = exists(s.destination_partial)?;
    let final_exists = exists(if s.replacing { None } else { final_path })?;
    let source_exists = exists(if s.replacing { Some(s.source) } else { None })?;
    let backup_exists = exists(s.replacement_backup)?;
    let check = if s.replacing { source_exists } else { final_exists };
    let final_valid = match (check, final_path, s.artifact) {
        (true, Some(p), Some(a)) => matches_digest(p, a, cancel)?,
        _ => false,
    };
    let mut same = false;
    if partial_exists && final_exists {
        use std::os::unix::fs::MetadataExt;
        let a = std::fs::symlink_metadata(s.destination_partial.unwrap())?;
        let b = std::fs::symlink_metadata(final_path.unwrap())?;
        same = a.is_file() && b.is_file() && a.dev() == b.dev() && a.ino() == b.ino();
    }
    let _ = Path::new(s.source);
    Ok(Facts { candidate_exists, partial_exists, final_exists, source_exists, backup_exists, final_valid, partial_final_proven: same })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truth_tables() {
        let f = |c, s, b, v| Facts { candidate_exists: c, source_exists: s, backup_exists: b, final_valid: v, ..Default::default() };
        let p = ReplacementPhase::parse;
        assert_eq!(replacement_action(Some(&p("candidate-written")), Some(&f(true, true, true, false)), true), "backup-original");
        assert_eq!(replacement_action(Some(&p("original-backed-up")), Some(&f(true, false, true, false)), true), "promote-candidate");
        assert_eq!(replacement_action(Some(&p("candidate-promoted")), Some(&f(false, true, true, true)), true), "delete-backup");
        assert_eq!(replacement_action(Some(&p("backup-deleted")), Some(&f(false, true, false, false)), true), "finish-replacement");
        assert_eq!(replacement_action(Some(&p("rollback-started")), Some(&f(true, true, true, false)), true), "restore-backup");
        assert_eq!(replacement_action(Some(&p("final-validated")), Some(&f(true, true, true, true)), true), "manual-intervention");
        assert_eq!(replacement_action(Some(&p("candidate-written")), Some(&f(true, true, true, false)), false), "manual-intervention", "no recorded original");
        let partial = Facts { partial_exists: true, ..f(true, true, false, false) };
        assert_eq!(replacement_action(Some(&p("candidate-written")), Some(&partial), true), "manual-intervention");
        assert_eq!(replacement_action(Some(&p("nonsense")), Some(&f(true, true, false, false)), true), "manual-intervention");
        assert_eq!(replacement_action(Some(&p("candidate-written")), None, true), "manual-intervention");
    }
}

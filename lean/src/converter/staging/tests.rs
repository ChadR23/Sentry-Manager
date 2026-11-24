//! test/stagingSplit.test.js and test/ownedCleanup.test.js, plus the crash
//! points of a replacement: a stop after every journal record, recovered
//! from that record alone, must leave the original or its verified
//! replacement at the original's name, and never remove anything not
//! provably the converter's own.

use super::*;
use crate::converter::snapshot::Registry;
use std::sync::Arc;

const JOB: &str = "job-1";
const ITEM: &str = "item-000001";

#[test]
fn memory_bound_cleaned_publication_releases_its_capability() {
    let e = setup("cleaned-capability");
    assert!(e.tx.cleanup_publication(Some(&e.artifact), None).unwrap());
    assert!(!Path::new(&e.artifact.path).exists());
    assert!(!e.registry.validate(&e.artifact, crate::converter::snapshot::Validate::Consume), "cleanup before publication must release the live capability too");
}

fn sha(b: &[u8]) -> String {
    crate::converter::tesla_sei::sha256_hex(b)
}

fn random(n: usize, seed: u8) -> Vec<u8> {
    let mut x: u32 = 0x9e37_79b9 ^ seed as u32;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

pub struct Env {
    pub root: PathBuf,
    pub temp_root: PathBuf,
    pub footage: PathBuf,
    pub source: String,
    pub original: Vec<u8>,
    pub conversion: Vec<u8>,
    pub artifact: Artifact,
    pub expected: SourceAuthority,
    pub tx: Tx,
    pub registry: Arc<Registry>,
    pub writes: Arc<Mutex<Vec<Value>>>,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::process::Command::new("chmod").args(["-R", "u+w"]).arg(&self.root).status();
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn setup(tag: &str) -> Env {
    let base = std::env::temp_dir().join(format!("lean-staging-{tag}-{}-{}", std::process::id(), new_nonce()));
    fs::create_dir_all(&base).unwrap();
    let root = fs::canonicalize(&base).unwrap();
    let temp_root = root.join("tmp/sentry-six-converter");
    let footage = root.join("footage");
    let folder = root.join("tmp/sentry-six-verification-abc");
    for d in [&temp_root, &footage, &folder] {
        fs::create_dir_all(d).unwrap();
    }
    let conversion = random(150_000, 1);
    let token = new_nonce();
    let snap = folder.join(format!("{token}.mp4"));
    fs::write(&snap, &conversion).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&snap, fs::Permissions::from_mode(0o400)).unwrap();
    let artifact = Artifact { path: s(&snap), token, sha256: sha(&conversion), size: conversion.len() as u64 };
    let source = footage.join("2026-10-20_07-40-00-front.mp4");
    let original = random(400_000, 2);
    fs::write(&source, &original).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
    let st = fs::symlink_metadata(&source).unwrap();
    let expected = SourceAuthority { size: original.len() as u64, sha256: sha(&original), device: st.dev().to_string(), inode: st.ino().to_string() };
    let registry = Arc::new(Registry::new(root.join("tmp")));
    registry.insert_live(artifact.clone());
    let tx = Tx::new(Options { temp_root: temp_root.clone(), chunk_size: 16 * 1024, max_active_leases: 4, before_replace_original: None, replacement_free_space: Some(Box::new(|_| Ok(u64::MAX / 4))) }, registry.clone()).unwrap();
    Env { root, temp_root, footage, source: s(&source), original, conversion, artifact, expected, tx, registry, writes: Arc::new(Mutex::new(vec![])) }
}

impl Env {
    pub fn recorder(&self) -> impl Fn(&Value) -> Result<(), String> + Sync + '_ {
        move |v: &Value| {
            self.writes.lock().unwrap().push(v.clone());
            Ok(())
        }
    }
    pub(super) fn op<'a>(&self, persist: PersistFn<'a>) -> Op<'a> {
        Op {
            job_id: JOB.into(),
            item_id: ITEM.into(),
            codec: Some("h265".into()),
            source: Some(self.source.clone()),
            source_root: Some(s(&self.footage)),
            expected_source: Some(self.expected.clone()),
            publication_artifact: Some(self.artifact.clone()),
            persist: Some(persist),
            ..Default::default()
        }
    }
    fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(&self.footage).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn candidate(&self) -> String {
        s(&self.footage.join(format!("TEMP-H265-{}", Path::new(&self.source).file_name().unwrap().to_string_lossy())))
    }
    fn stat_meta(&self, path: &str, nonce: &str, state: &str, sha256: &str) -> Meta {
        let st = fs::symlink_metadata(path).unwrap();
        Meta { path: path.into(), nonce: nonce.into(), state: ArtifactState::parse(state), size: Some(st.size()), sha256: Some(sha256.into()), device: Some(st.dev().to_string()), inode: Some(st.ino().to_string()), journal: None }
    }
    fn cleanup(&self, paths: Vec<(&str, String)>, arts: Vec<(&str, Meta)>) -> R<recover::Cleaned> {
        let rec = self.recorder();
        let op = Op {
            owned_paths: paths.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            owned_artifacts: arts.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            ..self.op(&rec)
        };
        self.tx.cleanup_owned_artifacts(&op)
    }
}

fn mode(p: &str) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn prepare_copies_beside_the_original_and_swap_puts_it_in_place() {
    let env = setup("split");
    let rec = env.recorder();
    let prepared = env.tx.prepare_replacement(&env.op(&rec)).unwrap();
    let temp = env.candidate();
    assert_eq!(fs::read(&temp).unwrap(), env.conversion);
    assert_eq!(mode(&temp), 0o644, "with the original's permissions");
    assert_eq!(fs::read(&env.source).unwrap(), env.original, "the original is untouched");
    let states: Vec<String> = env.writes.lock().unwrap().iter().map(|w| w["ownedArtifacts"]["replacementCandidate"]["state"].as_str().unwrap().to_string()).collect();
    assert_eq!(states, ["intent", "writing", "owned"], "announced, created, complete; no progress records in between");
    assert!(env.writes.lock().unwrap().iter().all(|w| w.get("phase").is_none() && w["ownedPaths"].get("replacementBackup").is_none()));
    assert!(prepared.candidate_mtime_ns.is_some());
    env.writes.lock().unwrap().clear();
    let result = env.tx.swap_replacement(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() }).unwrap();
    assert_eq!(result.phase, Some(ReplacementPhase::BackupDeleted));
    let phases: Vec<String> = env.writes.lock().unwrap().iter().map(|w| w["phase"].as_str().unwrap().to_string()).collect();
    assert_eq!(phases, ["candidate-written", "original-backed-up", "candidate-promoted"]);
    assert_eq!(env.writes.lock().unwrap()[0]["ownedArtifacts"]["replacementBackup"]["state"], "intent");
    assert_eq!(fs::read(&env.source).unwrap(), env.conversion);
    assert_eq!(env.names(), [Path::new(&env.source).file_name().unwrap().to_string_lossy().to_string()]);
    assert_eq!(result.owned_paths.keys().collect::<Vec<_>>(), ["publicationSnapshot"], "only the private snapshot is left to remove");
}

#[test]
fn a_copy_rewritten_after_prepare_is_refused_before_the_original_is_touched() {
    let env = setup("rewritten-copy");
    let rec = env.recorder();
    let prepared = env.tx.prepare_replacement(&env.op(&rec)).unwrap();
    let temp = env.candidate();
    let mut rewritten = env.conversion.clone();
    rewritten[999] ^= 0xff;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o644)).unwrap();
    fs::OpenOptions::new().write(true).open(&temp).unwrap().write_all_at(&rewritten, 0).unwrap();
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    fs::File::options().write(true).open(&temp).unwrap().set_modified(later).unwrap();
    let e = env.tx.swap_replacement(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() }).unwrap_err();
    assert!(["PUBLICATION_ARTIFACT_CHANGED", "ROLLBACK_FAILED"].contains(&e.code.as_str()), "{e}");
    assert_eq!(fs::read(&env.source).unwrap(), env.original);
    assert_eq!(fs::read(&temp).unwrap(), rewritten, "the rewritten copy is not removed");
}

#[test]
fn a_separate_output_is_read_back_by_prepare_and_moved_by_identity() {
    let env = setup("separate");
    let rec = env.recorder();
    let out = env.root.join("out");
    fs::create_dir_all(&out).unwrap();
    let dest = s(&out.join("clip.mp4"));
    let prepared = env.tx.prepare_publication(&Op { destination: Some(dest.clone()), ..env.op(&rec) }).unwrap();
    assert!(prepared.partial_mtime_ns.as_deref().is_some_and(|t| t.bytes().all(|b| b.is_ascii_digit())));
    let result = env.tx.commit_publication(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() }).unwrap();
    assert_eq!(result.final_path, dest);
    assert_eq!(fs::read(&dest).unwrap(), env.conversion);

    // rewritten in place after prepare: the full check refuses it
    let env2 = setup("separate2");
    let rec2 = env2.recorder();
    let other = s(&out.join("other.mp4"));
    let again = env2.tx.prepare_publication(&Op { destination: Some(other.clone()), ..env2.op(&rec2) }).unwrap();
    fs::write(&again.partial, vec![7u8; env2.conversion.len()]).unwrap();
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    fs::File::options().write(true).open(&again.partial).unwrap().set_modified(later).unwrap();
    assert!(env2.tx.commit_publication(&Op { prepared: Some(&again), persist: Some(&rec2), ..Default::default() }).is_err());
    assert!(!Path::new(&other).exists());
}

#[test]
fn an_original_rewritten_after_prepare_is_refused_and_kept() {
    let env = setup("rewritten-original");
    let rec = env.recorder();
    let prepared = env.tx.prepare_replacement(&env.op(&rec)).unwrap();
    let mut rewritten = env.original.clone();
    rewritten[1234] ^= 0xff;
    fs::OpenOptions::new().write(true).open(&env.source).unwrap().write_all_at(&rewritten, 0).unwrap();
    let e = env.tx.swap_replacement(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() }).unwrap_err();
    assert_eq!(e.code, "SOURCE_CHANGED");
    assert_eq!(fs::read(&env.source).unwrap(), rewritten, "the original stays as it is now");
    assert_eq!(env.names().len(), 1, "its copy and any backup are gone");
    assert_eq!(env.writes.lock().unwrap().last().unwrap()["phase"], "backup-restored");
}

#[test]
fn a_snapshot_that_is_not_the_verified_conversion_stops_the_save() {
    let env = setup("bad-snapshot");
    let rec = env.recorder();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&env.artifact.path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&env.artifact.path, vec![1u8; env.conversion.len()]).unwrap();
    let e = env.tx.prepare_replacement(&env.op(&rec)).unwrap_err();
    assert_eq!(e.code, "PUBLICATION_ARTIFACT_CHANGED");
    assert_eq!(env.names().len(), 1, "the copy was compared and removed");
    assert_eq!(fs::read(&env.source).unwrap(), env.original);
}

#[test]
fn replace_original_in_one_call_and_a_failed_hook_keeps_the_original() {
    let env = setup("whole");
    let rec = env.recorder();
    let r = env.tx.replace_original(&env.op(&rec)).unwrap();
    assert!(r.owned_paths.is_empty() && r.cleanup_pending.is_empty());
    assert_eq!(fs::read(&env.source).unwrap(), env.conversion);
    assert!(!Path::new(&env.artifact.path).exists(), "the private snapshot went");

    // the Sentry USB checksum record fails: nothing of the original changes
    let mut env2 = setup("hook");
    env2.tx.before_replace_original = Some(Box::new(|_| Err("share down".into())));
    let rec2 = env2.recorder();
    let e = env2.tx.replace_original(&env2.op(&rec2)).unwrap_err();
    assert_eq!(e.code, "CHECKSUM_RECORD_FAILED");
    assert_eq!(fs::read(&env2.source).unwrap(), env2.original);
    assert_eq!(env2.names().len(), 1);
}

// ---- test/ownedCleanup.test.js

fn empty_journal() -> Journal {
    Journal { committed: Some(Mark { size: 0, sha256: empty_sha() }), pending: None }
}

#[test]
fn an_interrupted_copy_is_removed_when_it_holds_exactly_the_first_bytes() {
    let env = setup("torn");
    let cand = env.candidate();
    fs::write(&cand, &env.conversion[..77_777]).unwrap();
    let mut rec = env.stat_meta(&cand, "n-cand", "writing", &empty_sha());
    rec.size = Some(0);
    rec.journal = Some(empty_journal());
    let snap = env.stat_meta(&env.artifact.path, "n-snap", "owned", &env.artifact.sha256);
    let r = env.cleanup(vec![("replacementCandidate", cand.clone()), ("publicationSnapshot", env.artifact.path.clone())], vec![("replacementCandidate", rec), ("publicationSnapshot", snap)]).unwrap();
    assert!(r.cleaned);
    assert!(!Path::new(&cand).exists());
    assert!(!Path::new(&env.artifact.path).exists(), "the snapshot went after it");
    assert!(!dirname(&env.artifact.path).exists(), "with its folder");
    assert_eq!(env.names().len(), 1);
}

#[test]
fn a_copy_that_is_not_the_conversion_or_another_file_is_never_removed() {
    let env = setup("not-prefix");
    let cand = env.candidate();
    let mut bytes = env.conversion[..50_000].to_vec();
    bytes[100..200].fill(7);
    fs::write(&cand, &bytes).unwrap();
    let mut rec = env.stat_meta(&cand, "n-cand", "writing", &empty_sha());
    rec.size = Some(0);
    rec.journal = Some(empty_journal());
    let e = env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", rec.clone())]).err().unwrap();
    assert_eq!(e.code, "UNSAFE_OWNED_PATH", "not a prefix of the conversion");
    assert!(Path::new(&cand).exists());
    // the same bytes in another file at that name: written beside it while the
    // recorded one still exists, then renamed over it, so it can never reuse the
    // recorded inode (deleting first and writing again could, on a busy machine)
    let other = env.footage.join("other");
    fs::write(&other, &env.conversion[..50_000]).unwrap();
    fs::rename(&other, &cand).unwrap();
    let e = env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", rec)]).err().unwrap();
    assert_eq!(e.code, "UNSAFE_OWNED_PATH", "not the recorded file");
    assert!(Path::new(&cand).exists());
    assert!(Path::new(&env.source).exists(), "the original is never touched");
}

#[test]
fn a_copy_only_announced_is_removed_while_empty_and_kept_once_it_holds_anything() {
    let env = setup("intent");
    let cand = env.candidate();
    let intent = Meta { path: cand.clone(), nonce: "n-cand".into(), state: ArtifactState::Intent, size: None, sha256: None, device: None, inode: None, journal: None };
    fs::write(&cand, b"").unwrap();
    assert!(env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", intent.clone())]).unwrap().cleaned);
    assert!(!Path::new(&cand).exists());
    fs::write(&cand, "not ours").unwrap();
    assert_eq!(env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", intent.clone())]).err().unwrap().code, "UNSAFE_OWNED_PATH");
    assert_eq!(fs::read_to_string(&cand).unwrap(), "not ours");
    fs::remove_file(&cand).unwrap();
    assert!(env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", intent)]).unwrap().cleaned, "never created: nothing to do");
}

#[test]
fn an_encode_output_the_writer_changed_is_removed_by_name_and_identity() {
    let env = setup("encoded");
    let enc = s(&env.temp_root.join(format!("{JOB}-{ITEM}-n-enc-encoded.mp4")));
    fs::write(&enc, random(5000, 3)).unwrap();
    let rec = env.stat_meta(&enc, "n-enc", "owned", &sha(&fs::read(&enc).unwrap()));
    fs::File::options().write(true).open(&enc).unwrap().set_len(0).unwrap();
    let other = env.temp_root.join("other");
    fs::write(&other, "x").unwrap();
    assert!(env.cleanup(vec![("encodedCandidate", enc.clone())], vec![("encodedCandidate", rec.clone())]).unwrap().cleaned);
    assert!(!Path::new(&enc).exists());
    fs::rename(&other, &enc).unwrap();
    assert_eq!(env.cleanup(vec![("encodedCandidate", enc.clone())], vec![("encodedCandidate", rec)]).err().unwrap().code, "UNSAFE_OWNED_PATH");
    assert!(Path::new(&enc).exists());
}

#[test]
fn a_backup_only_announced_is_forgotten_and_kept_when_it_is_there() {
    let env = setup("backup");
    let backup = s(&env.footage.join(format!("BACKUP-{}", Path::new(&env.source).file_name().unwrap().to_string_lossy())));
    let intent = Meta { path: backup.clone(), nonce: "n-back".into(), state: ArtifactState::Intent, size: None, sha256: None, device: None, inode: None, journal: None };
    assert!(env.cleanup(vec![("replacementBackup", backup.clone())], vec![("replacementBackup", intent.clone())]).unwrap().cleaned);
    fs::rename(&env.source, &backup).unwrap();
    let kept = env.cleanup(vec![("replacementBackup", backup.clone())], vec![("replacementBackup", intent)]).unwrap();
    assert!(!kept.cleaned);
    assert_eq!(kept.cleanup_pending, ["replacementBackup"]);
    assert!(Path::new(&backup).exists(), "a possible original is never removed by generic cleanup");
}

// ---- crash points of a replacement

/// What the job file would hold after the n-th record: the item's owned
/// paths and artifacts, folded as jobStore applies transaction snapshots.
fn fold(writes: &[Value], n: usize) -> (Paths, Artifacts, Option<String>, Option<Artifact>) {
    let mut paths = Paths::new();
    let mut arts = Artifacts::new();
    let mut phase = None;
    let mut artifact = None;
    for w in &writes[..n] {
        for (k, v) in w["ownedPaths"].as_object().unwrap() {
            paths.insert(k.clone(), v.as_str().unwrap().into());
        }
        for (k, v) in w["ownedArtifacts"].as_object().unwrap() {
            arts.insert(k.clone(), serde_json::from_value(v.clone()).unwrap());
        }
        for k in w.get("clearOwnedKeys").and_then(|c| c.as_array()).into_iter().flatten() {
            let k = k.as_str().unwrap();
            if !w["ownedPaths"].as_object().unwrap().contains_key(k) {
                paths.shift_remove(k);
                arts.shift_remove(k);
            }
        }
        if let Some(p) = w.get("phase").and_then(|p| p.as_str()) {
            phase = Some(p.to_string());
        }
        if let Some(a) = w.get("publicationArtifact") {
            artifact = Some(serde_json::from_value(a.clone()).unwrap());
        }
        if w.get("clearPublicationArtifact") == Some(&json!(true)) {
            artifact = None;
        }
    }
    (paths, arts, phase, artifact)
}

/// A crash just before record `n + 1` of a replacement becomes durable
/// (the callback panics: nothing after it runs, no rollback, the files stay
/// exactly as the crash leaves them), then recovery as jobService runs it
/// after a restart: the truth table picks each step from the files and the
/// last phase, up to six steps. The original's name must hold the original
/// or the verified conversion, and what is left is either proven gone or
/// still recorded.
#[test]
fn a_crash_before_any_record_of_a_replacement_recovers_safely() {
    use crate::converter::recovery::{inspect, replacement_action, ReplaceState};
    let probe = setup("crash-probe");
    let rec = probe.recorder();
    probe.tx.replace_original(&probe.op(&rec)).unwrap();
    let total = probe.writes.lock().unwrap().len();
    assert_eq!(total, 7, "prepare, writing, owned, candidate-written, original-backed-up, candidate-promoted, backup-deleted");
    let mut outcomes = Vec::new();
    for n in 0..total {
        let env = setup(&format!("crash-{n}"));
        let count = std::sync::atomic::AtomicUsize::new(0);
        let crash = |v: &Value| -> Result<(), String> {
            if count.fetch_add(1, Ordering::SeqCst) >= n {
                panic!("crash before record {}", n + 1);
            }
            env.writes.lock().unwrap().push(v.clone());
            Ok(())
        };
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| env.tx.replace_original(&env.op(&crash)))).is_err();
        std::panic::set_hook(prev);
        assert!(crashed, "record {n}");
        let writes = env.writes.lock().unwrap().clone();
        let (mut paths, mut arts, phase, artifact) = fold(&writes, n);
        // a new process: a new transaction manager (no leases, no memory)
        let rec = env.recorder();
        let fresh = Tx::new(Options { temp_root: env.temp_root.clone(), chunk_size: 16 * 1024, max_active_leases: 4, before_replace_original: None, replacement_free_space: Some(Box::new(|_| Ok(u64::MAX / 4))) }, env.registry.clone()).unwrap();
        let outcome: &str = match (phase.clone(), artifact.clone()) {
            (None, _) => {
                // not yet replacing: the clip's leftovers go and it is converted again
                let op = Op { owned_paths: paths.clone(), owned_artifacts: arts.clone(), publication_artifact: artifact.clone(), ..env.op(&rec) };
                match fresh.cleanup_owned_artifacts(&op) {
                    Ok(c) if c.cleaned => "requeue",
                    _ => "park",
                }
            }
            (Some(_), None) => "recorded",
            (Some(mut phase), Some(a)) => {
                let mut out = "park";
                for _ in 0..6 {
                    let facts = inspect(
                        &ReplaceState {
                            replacing: true,
                            copying: false,
                            source: &env.source,
                            separate_final: None,
                            replacement_candidate: paths.get("replacementCandidate").map(String::as_str),
                            encoded_candidate: None,
                            destination_partial: paths.get("destinationPartial").map(String::as_str),
                            replacement_backup: paths.get("replacementBackup").map(String::as_str),
                            artifact: Some(&a),
                        },
                        None,
                    )
                    .ok();
                    let action = replacement_action(Some(&ReplacementPhase::parse(&phase)), facts.as_ref(), true);
                    if action == "manual-intervention" {
                        break;
                    }
                    let op = Op { action: Some(action.into()), owned_paths: paths.clone(), owned_artifacts: arts.clone(), publication_artifact: Some(a.clone()), ..env.op(&rec) };
                    let Ok(r) = fresh.recover_replacement(&op) else { break };
                    paths = r.owned_paths.clone();
                    arts = r.owned_artifacts.clone();
                    if r.action == Some("restart-replacement") || r.phase == Some(ReplacementPhase::BackupRestored) {
                        let op = Op { owned_paths: paths.clone(), owned_artifacts: arts.clone(), publication_artifact: r.publication_artifact.clone().or(Some(a.clone())), ..env.op(&rec) };
                        out = match fresh.cleanup_owned_artifacts(&op) {
                            Ok(c) if c.cleaned => "requeue",
                            _ => "requeue-pending",
                        };
                        break;
                    }
                    if r.phase == Some(ReplacementPhase::BackupDeleted) {
                        out = "complete";
                        break;
                    }
                    phase = r.phase.map(|p| p.to_string()).unwrap_or_default();
                }
                out
            }
        };
        let bytes = fs::read(&env.source).unwrap_or_else(|_| panic!("crash {n} ({phase:?}): the original's name is empty"));
        match outcome {
            "complete" => assert_eq!(bytes, env.conversion, "crash {n}: completed with the conversion"),
            "requeue" => assert_eq!(bytes, env.original, "crash {n}: the original is back"),
            _ => assert!(bytes == env.original || bytes == env.conversion, "crash {n}: the original's name holds something else"),
        }
        if outcome == "complete" || outcome == "requeue" {
            let left: Vec<String> = env.names().into_iter().filter(|x| !x.starts_with("2026")).collect();
            assert!(left.is_empty(), "crash {n} ({phase:?}, {outcome}): left {left:?}");
        }
        outcomes.push(format!("{n}:{}:{outcome}", phase.unwrap_or_default()));
    }
    eprintln!("crash outcomes: {outcomes:?}");
    // no crash point leaves the clip waiting for a decision
    assert!(outcomes.iter().all(|o| !o.ends_with(":park")), "{outcomes:?}");
}


// ---- unsafe-owned-path refusals name their check and the values that differ

/// The refusal's detail; the code stays UNSAFE_OWNED_PATH.
fn refusal(e: TxError) -> String {
    assert_eq!(e.code, "UNSAFE_OWNED_PATH", "{e}");
    assert_eq!(e.message, message_of("UNSAFE_OWNED_PATH"), "the message is unchanged");
    e.detail.expect("an UNSAFE_OWNED_PATH refusal says which check refused")
}

fn owned_meta(path: &str, nonce: &str, state: &str) -> Meta {
    let st = fs::symlink_metadata(path).unwrap();
    let sha = sha(&fs::read(path).unwrap());
    Meta { path: path.into(), nonce: nonce.into(), state: ArtifactState::parse(state), size: Some(st.size()), sha256: Some(sha), device: Some(st.dev().to_string()), inode: Some(st.ino().to_string()), journal: None }
}

/// The SMB failure as the owner's share showed it: right after the
/// candidate is renamed over the original, the backup still reports two
/// links (the CIFS client's cached link count). The backup removal refuses,
/// the swap rolls back to the original, and the refusal says it was the
/// backup's link count.
#[test]
fn a_backup_that_still_reports_two_links_names_the_link_count() {
    let env = setup("stale-nlink");
    let rec = env.recorder();
    let prepared = env.tx.prepare_replacement(&env.op(&rec)).unwrap();
    let (source, backup) = (PathBuf::from(&env.source), PathBuf::from(&prepared.backup));
    let extra = env.footage.join("second-link-of-backup");
    let (b2, x2) = (backup.clone(), extra.clone());
    *crate::converter::owned::TEST_HOOK.write().unwrap() = Some(Arc::new(move |event: &str, _from: &Path, to: &Path| {
        if event == "replace-after" && to == source.as_path() {
            fs::hard_link(&b2, &x2)?;
        }
        Ok(())
    }));
    let r = env.tx.swap_replacement(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() });
    *crate::converter::owned::TEST_HOOK.write().unwrap() = None;
    let e = r.err().expect("refused");
    assert!(e.rolled_back.is_some(), "rolled back");
    assert_eq!(refusal(e), "remove-exact-owned: nlink 2 != 1 (state owned)");
    assert_eq!(fs::read(&env.source).unwrap(), env.original, "the original is back");
    assert!(!backup.exists() && !Path::new(&env.candidate()).exists());
    assert_eq!(env.writes.lock().unwrap().last().unwrap()["phase"], "backup-restored");
    fs::remove_file(&extra).unwrap();
}

#[test]
fn remove_exact_owned_names_each_record_field_that_differs() {
    let env = setup("remove-exact");
    let f = s(&env.footage.join("BACKUP-x.mp4"));
    fs::write(&f, "backup bytes").unwrap();
    let m = owned_meta(&f, "n-b", "owned");
    // missing and unrecorded
    let gone = s(&env.footage.join("gone.mp4"));
    assert_eq!(refusal(env.tx.remove_exact_owned(&gone, Some(&m), false, false, None, None).err().expect("refused")), "remove-exact-owned: lstat ENOENT (missing)");
    assert_eq!(refusal(env.tx.remove_exact_owned(&f, None, false, false, None, None).err().expect("refused")), "remove-exact-owned: no record");
    // another file at that name (new inode, new size), and a second link
    let ino = fs::metadata(&f).unwrap().ino();
    let other = env.footage.join("other");
    fs::write(&other, "someone else's").unwrap();
    let new_ino = fs::metadata(&other).unwrap().ino();
    fs::rename(&other, &f).unwrap();
    assert_eq!(refusal(env.tx.remove_exact_owned(&f, Some(&m), false, false, None, None).err().expect("refused")), format!("remove-exact-owned: ino {new_ino} != {ino}; size 14 != 12"));
    let wrong_path = Meta { path: "/elsewhere".into(), nonce: String::new(), ..owned_meta(&f, "n", "owned") };
    assert_eq!(refusal(env.tx.remove_exact_owned(&f, Some(&wrong_path), false, false, None, None).err().expect("refused")), "remove-exact-owned: record path differs from target; record nonce empty");
    let now = owned_meta(&f, "n-b", "owned");
    fs::hard_link(&f, env.footage.join("alias")).unwrap();
    assert_eq!(refusal(env.tx.remove_exact_owned(&f, Some(&now), false, false, None, None).err().expect("refused")), "remove-exact-owned: nlink 2 != 1 (state owned)");
    fs::remove_file(env.footage.join("alias")).unwrap();
    // same inode and size, other bytes: the adapter's held-open hash refuses
    let bad = Meta { sha256: Some("0".repeat(64)), ..now.clone() };
    assert_eq!(refusal(env.tx.remove_exact_owned(&f, Some(&bad), false, false, None, None).err().expect("refused")), "remove-exact-owned: remove victim: full hash: sha256 differs from record (full hash)");
    // the right record: removed, nothing refuses
    assert!(env.tx.remove_exact_owned(&f, Some(&now), false, false, None, None).unwrap());
    assert!(Path::new(&env.source).exists());
}

#[test]
fn the_guard_of_a_backup_removal_names_the_final_files_mismatch() {
    let env = setup("guard");
    let b = s(&env.footage.join("BACKUP-x.mp4"));
    let fin = s(&env.footage.join("x.mp4"));
    fs::write(&b, "old").unwrap();
    fs::write(&fin, "new").unwrap();
    let m = owned_meta(&b, "n-b", "owned");
    let st = fs::metadata(&fin).unwrap();
    let wrong = Expected { device: st.dev().to_string(), inode: st.ino().to_string(), size: 3, sha256: "0".repeat(64), mtime_ns: Some("7".into()) };
    let d = refusal(env.tx.remove_exact_owned(&b, Some(&m), false, false, Some((&fin, &wrong, true)), None).err().expect("refused"));
    let real = st.mtime() as i128 * 1_000_000_000 + st.mtime_nsec() as i128;
    assert_eq!(d, format!("remove-exact-owned: remove guard (kept file): identity-only: mtime_ns {real} != 7 (full hash)"));
    assert!(Path::new(&b).exists(), "the backup is kept");
}

#[test]
fn replace_over_original_names_the_name_that_is_no_longer_the_original() {
    let env = setup("replace-over");
    let cand = env.candidate();
    fs::write(&cand, &env.conversion).unwrap();
    let ec = crate::converter::owned::identity(Path::new(&cand)).unwrap();
    let backup = s(&env.footage.join("BACKUP-x.mp4"));
    // the backup name is a different file, not a second link of the original
    fs::write(&backup, &env.original).unwrap();
    let b = fs::metadata(&backup).unwrap();
    let d = refusal(env.tx.replace_over_original(&cand, &env.source, &backup, &ec, false, &env.expected).err().expect("refused"));
    assert_eq!(d, format!("replace-over-original: replace-over before rename: backup name lstat: dev:ino {}:{} != {}:{}", b.dev(), b.ino(), env.expected.device, env.expected.inode));
    // a candidate whose recorded time is not its time now (identity-only)
    fs::remove_file(&backup).unwrap();
    fs::hard_link(&env.source, &backup).unwrap();
    let stale = Expected { mtime_ns: Some("11".into()), ..ec.clone() };
    let d = refusal(env.tx.replace_over_original(&cand, &env.source, &backup, &stale, true, &env.expected).err().expect("refused"));
    assert!(d.starts_with("replace-over-original: replace-over candidate: identity-only: mtime_ns ") && d.ends_with(" != 11"), "{d}");
    assert_eq!(fs::read(&env.source).unwrap(), env.original, "nothing was replaced");
}

#[test]
fn promote_no_replace_names_the_sources_mismatch() {
    let env = setup("promote");
    let cand = env.candidate();
    fs::write(&cand, &env.conversion).unwrap();
    let mut e = crate::converter::owned::identity(Path::new(&cand)).unwrap();
    e.size += 1;
    let to = s(&env.footage.join("promoted.mp4"));
    let d = refusal(env.tx.promote_no_replace(&cand, &to, "REPLACEMENT_COLLISION", Some(&e), true, false).err().expect("refused"));
    assert_eq!(d, format!("promote-no-replace: promote source: fstat: size {} != {}", e.size - 1, e.size));
    assert!(!Path::new(&to).exists() && Path::new(&cand).exists());
}

#[test]
fn private_work_files_name_the_link_count_folder_or_identity() {
    let env = setup("private");
    let real_temp = s(&env.temp_root);
    let enc = s(&env.temp_root.join(format!("{JOB}-{ITEM}-n-enc-encoded.mp4")));
    fs::write(&enc, "encoded").unwrap();
    let m = owned_meta(&enc, "n-enc", "owned");
    fs::hard_link(&enc, env.temp_root.join("alias")).unwrap();
    assert_eq!(refusal(env.tx.remove_private_file(&enc, &m, &real_temp).err().expect("refused")), "remove-private-file: nlink 2 != 1");
    fs::remove_file(env.temp_root.join("alias")).unwrap();
    assert_eq!(refusal(env.tx.remove_private_file(&enc, &m, &s(&env.footage)).err().expect("refused")), "remove-private-file: folder realpath is not the temp folder");
    let moved = Meta { inode: Some("1".into()), ..m.clone() };
    let ino = fs::metadata(&enc).unwrap().ino();
    assert_eq!(refusal(env.tx.remove_private_file(&enc, &moved, &real_temp).err().expect("refused")), format!("remove-private-file: ino {ino} != 1"));
    assert!(Path::new(&enc).exists());

    // the private snapshot
    fs::hard_link(&env.artifact.path, env.temp_root.join("snap-alias")).unwrap();
    assert_eq!(refusal(env.tx.remove_private_snapshot(&env.artifact, None).err().expect("refused")), "remove-private-snapshot: nlink 2 != 1");
    fs::remove_file(env.temp_root.join("snap-alias")).unwrap();
    let snap = owned_meta(&env.artifact.path, "n-s", "owned");
    let other = Meta { device: Some("9".into()), ..snap };
    let dev = fs::metadata(&env.artifact.path).unwrap().dev();
    assert_eq!(refusal(env.tx.remove_private_snapshot(&env.artifact, Some(&other)).err().expect("refused")), format!("remove-private-snapshot: dev {dev} != 9"));
    assert!(Path::new(&env.artifact.path).exists());
}

#[test]
fn share_copies_and_the_adapter_name_what_differs() {
    let env = setup("share-copy");
    let cand = env.candidate();
    let intent = Meta { path: cand.clone(), nonce: "n-cand".into(), state: ArtifactState::Intent, size: None, sha256: None, device: None, inode: None, journal: None };
    fs::write(&cand, "not ours").unwrap();
    let e = env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", intent.clone())]).err().unwrap();
    assert_eq!(refusal(e), "remove-share-copy: size 8 != 0 (state intent)");
    fs::hard_link(&cand, env.footage.join("alias")).unwrap();
    assert_eq!(refusal(env.tx.remove_share_copy(&cand, &intent, None).err().expect("refused")), "remove-share-copy: nlink 2 != 1 (state intent)");
    fs::remove_file(env.footage.join("alias")).unwrap();
    // a copy in progress: larger than the snapshot, or another inode
    fs::write(&cand, vec![1u8; env.conversion.len() + 5]).unwrap();
    let mut writing = env.stat_meta(&cand, "n-cand", "writing", &empty_sha());
    let big = fs::metadata(&cand).unwrap().size();
    assert_eq!(refusal(env.tx.remove_share_copy(&cand, &writing, Some(&env.artifact)).err().expect("refused")), format!("remove-share-copy: size {big} > snapshot size {}", env.artifact.size));
    writing.inode = Some("1".into());
    let ino = fs::metadata(&cand).unwrap().ino();
    assert!(refusal(env.tx.remove_share_copy(&cand, &writing, Some(&env.artifact)).err().expect("refused")).starts_with(&format!("remove-share-copy: ino {ino} != 1")));
    assert_eq!(refusal(env.tx.remove_share_copy(&cand, &writing, None).err().expect("refused")), "remove-share-copy: no publication artifact");
    // the adapter's own check (prefix of the conversion): its reason comes through
    fs::write(&cand, b"xx").unwrap();
    let st = fs::metadata(&cand).unwrap();
    let e = Expected { device: st.dev().to_string(), inode: st.ino().to_string(), size: 2, sha256: sha(b"yy"), mtime_ns: None };
    assert_eq!(refusal(env.tx.adapter_remove(&cand, &e, None).err().expect("refused")), "adapter-remove: remove victim: full hash: sha256 differs from record");
    assert!(Path::new(&cand).exists());
}

#[test]
fn encode_outputs_name_the_record_or_the_link_count() {
    let env = setup("adopt");
    let rec = env.recorder();
    let r = env.tx.reserve_encode_output(&env.op(&rec)).unwrap();
    fs::write(&r.path, "encoded").unwrap();
    // a record that is not intent/owned
    let mut arts = r.owned_artifacts.clone();
    arts.get_mut("encodedCandidate").unwrap().state = ArtifactState::Writing;
    let e = env.tx.adopt_encode_output(&Op { owned_paths: r.owned_paths.clone(), owned_artifacts: arts, ..env.op(&rec) }).err().expect("refused");
    assert_eq!(refusal(e), "adopt-encode-output: record state writing not intent/owned");
    let e = env.tx.adopt_encode_output(&Op { owned_paths: r.owned_paths.clone(), owned_artifacts: Artifacts::new(), ..env.op(&rec) }).err().expect("refused");
    assert_eq!(refusal(e), "adopt-encode-output: no encodedCandidate record");
    // a second link: the unaliased check
    fs::hard_link(&r.path, env.temp_root.join("alias")).unwrap();
    let e = env.tx.adopt_encode_output(&Op { owned_paths: r.owned_paths.clone(), owned_artifacts: r.owned_artifacts.clone(), ..env.op(&rec) }).err().expect("refused");
    assert_eq!(refusal(e), "regular-unaliased: nlink 2 != 1");
    fs::remove_file(env.temp_root.join("alias")).unwrap();
    assert!(env.tx.adopt_encode_output(&Op { owned_paths: r.owned_paths.clone(), owned_artifacts: r.owned_artifacts.clone(), ..env.op(&rec) }).is_ok());
    // the remembered identity: another file at that name
    let other = env.temp_root.join("other");
    fs::write(&other, "x").unwrap();
    let (old, new) = (ident(&fs::metadata(&r.path).unwrap()), ident(&fs::metadata(&other).unwrap()));
    fs::rename(&other, &r.path).unwrap();
    let e = env.tx.adopt_encode_output(&Op { owned_paths: r.owned_paths.clone(), owned_artifacts: r.owned_artifacts.clone(), ..env.op(&rec) }).err().expect("refused");
    assert_eq!(refusal(e), format!("regular-unaliased: dev:ino {new} != {old}"));
}

#[test]
fn a_staged_resume_or_asset_outside_its_folder_names_why() {
    let env = setup("stage");
    let rec = env.recorder();
    let resume: (Paths, Artifacts) = ([("stagedSource".to_string(), "/elsewhere/x.mp4".to_string())].into_iter().collect(), Artifacts::new());
    let e = env.tx.stage_source(&Op { resume: Some(resume), ..env.op(&rec) }).err().expect("refused");
    assert_eq!(refusal(e), "stage-source: resume: recorded stagedSource path differs");
    let out = env.root.join("out");
    fs::create_dir_all(&out).unwrap();
    let e = env.tx.copy_asset(&Op { destination_root: Some(s(&out)), destination: Some(s(&env.root.join("x.mp4"))), ..env.op(&rec) }).err().expect("refused");
    assert_eq!(refusal(e), "copy-asset: destination is outside the destination root");
}

#[test]
fn recorded_names_that_differ_are_named() {
    let env = setup("names");
    let (_, backup) = recorded_replacement_paths(&env.source, JOB, ITEM, &Artifacts::new(), Some("h265")).unwrap();
    let e = env.tx.assert_replacement_names(&env.source, "/elsewhere/TEMP", &backup, JOB, ITEM, &Artifacts::new(), Some("h265")).err().expect("refused");
    assert_eq!(refusal(e), "replacement-names: candidate name differs from the recorded one");
    // cleanup of a candidate recorded at another name
    let wrong = s(&env.footage.join("TEMP-H265-other.mp4"));
    fs::write(&wrong, "x").unwrap();
    let m = owned_meta(&wrong, "n", "owned");
    let e = env.cleanup(vec![("replacementCandidate", wrong.clone())], vec![("replacementCandidate", m)]).err().unwrap();
    assert_eq!(refusal(e), "cleanup-owned: replacementCandidate: name differs from the recorded replacement name");
    assert!(Path::new(&wrong).exists());
    // a work file in the temp folder without its job-item-nonce prefix
    let stray = s(&env.temp_root.join("stray.mp4"));
    fs::write(&stray, "x").unwrap();
    let m = owned_meta(&stray, "n", "owned");
    let e = env.cleanup(vec![("encodedCandidate", stray.clone())], vec![("encodedCandidate", m)]).err().unwrap();
    assert_eq!(refusal(e), "cleanup-owned: encodedCandidate: name lacks the job-item-nonce prefix");
}

#[test]
fn an_exact_read_for_recovery_names_the_field() {
    let env = setup("read-exact");
    let f = s(&env.footage.join("BACKUP-x.mp4"));
    fs::write(&f, "abc").unwrap();
    let m = owned_meta(&f, "n", "owned");
    let bad = Meta { sha256: Some("0".repeat(64)), size: Some(4), ..m };
    assert_eq!(refusal(env.tx.read_exact_meta(&f, &bad, "UNSAFE_OWNED_PATH").err().expect("refused")), "read-exact: bytes read 3 != size 4; fstat size 3/3 != 4; sha256 differs from record");
    assert_eq!(refusal(env.tx.read_exact_meta(&s(&env.footage.join("none")), &bad, "UNSAFE_OWNED_PATH").err().expect("refused")), "read-exact: io ENOENT");
    // any other code carries no detail
    let e = env.tx.read_exact_meta(&f, &bad, "FINAL_VALIDATION_FAILED").err().expect("refused");
    assert_eq!((e.code.as_str(), e.detail), ("FINAL_VALIDATION_FAILED", None));
}

#[test]
fn a_detail_is_bounded_and_kept_through_or_tx() {
    let long = "x".repeat(5000);
    let e = unsafe_path("check", "/a/b.mp4", &long);
    assert_eq!(e.detail.as_ref().unwrap().len(), MAX_DETAIL);
    assert!(e.detail.as_ref().unwrap().starts_with("check: xxx"));
    let kept: R<()> = Err(e.clone());
    assert_eq!(kept.or_tx("OTHER").err().expect("refused").detail, e.detail, "a refusal keeps its detail through or_tx");
}

#[test]
fn a_link_count_read_again_never_hides_a_real_second_link() {
    // (cifs: a cached count of 2 is read again from the server; on any file system a real
    // second link still counts 2, so the one-link checks still refuse it)
    let env = setup("fresh-nlink");
    let f = env.footage.join("BACKUP-fresh.mp4");
    fs::write(&f, "backup bytes").unwrap();
    let link = env.footage.join("second-link");
    fs::hard_link(&f, &link).unwrap();
    assert_eq!(super::exact_lstat(&s(&f)).unwrap().nlink(), 2);
    assert_eq!(super::lstat_or_none(&s(&f)).unwrap().unwrap().nlink(), 2);
    fs::remove_file(&link).unwrap();
    assert_eq!(super::exact_lstat(&s(&f)).unwrap().nlink(), 1);
    assert!(super::lstat_or_none(&s(&env.footage.join("missing"))).unwrap().is_none());
}

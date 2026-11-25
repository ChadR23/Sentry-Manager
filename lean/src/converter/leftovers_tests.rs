//! The leftover BACKUP- tidy (leftovers.rs): each shape it acts on, every trap it
//! leaves alone, the races it notices, and the job records that keep a name.

use super::*;
use crate::converter::jobstore::JobStore;
use crate::converter::snapshot::Registry;
use crate::converter::staging::{self, Tx};
use serde_json::json;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, Mutex};

struct Env {
    _tmp: crate::converter::testutil::TempDir,
    root: PathBuf,
    dir: PathBuf,
    tx: Tx,
    /// the check of a converted copy (Tidy::verify): by default a stand-in that trusts the
    /// header (the copies here are header-only fakes); the real verifier in its own tests
    verify: Option<Box<VerifyConverted<'static>>>,
    /// what the check was asked (original, converted copy, codec)
    asked: Arc<Mutex<Vec<(PathBuf, PathBuf, String)>>>,
}

fn env() -> Env {
    let tmp = crate::converter::testutil::tempdir().unwrap();
    let root = tmp.path().join("TeslaCam");
    let dir = root.join("SentryClips/2026-08-30_20-53-04");
    fs::create_dir_all(&dir).unwrap();
    let temp = tmp.path().join("temp");
    fs::create_dir_all(&temp).unwrap();
    let tx = Tx::new(staging::Options { temp_root: temp.join("tx"), chunk_size: 0, max_active_leases: 4, before_replace_original: None, replacement_free_space: None }, Arc::new(Registry::new(temp))).unwrap();
    let asked: Arc<Mutex<Vec<(PathBuf, PathBuf, String)>>> = Arc::default();
    let a = asked.clone();
    let verify: Box<VerifyConverted<'static>> = Box::new(move |o: &Path, c: &Path, codec: &'static str| {
        a.lock().unwrap().push((o.to_path_buf(), c.to_path_buf(), codec.to_string()));
        Ok(())
    });
    Env { _tmp: tmp, root, dir, tx, verify: Some(verify), asked }
}

/// A real H.264 clip, and the same bytes with its sample entry named hvc1 (what the
/// header check reads: a converted copy, as far as the tidy can tell).
fn h264() -> Vec<u8> {
    fs::read(crate::reference::dir().join("job-clip.mp4")).unwrap()
}
fn h265() -> Vec<u8> {
    let mut b = h264();
    let stsd = b.windows(4).position(|w| w == b"stsd").expect("a sample description");
    let at = stsd + b[stsd..].windows(4).position(|w| w == b"avc1").expect("an avc1 sample entry");
    b[at..at + 4].copy_from_slice(b"hvc1");
    b
}

#[derive(Default)]
struct FakeBin {
    adopted: Mutex<Vec<(PathBuf, PathBuf)>>,
    holds: Vec<PathBuf>,
    refuse: Option<String>,
    into: Option<PathBuf>,
}

impl OriginalsBin for FakeBin {
    fn adopt_original(&self, backup: &Path, original: &Path, dev: u64, ino: u64) -> Result<String, String> {
        if let Some(r) = &self.refuse {
            return Err(r.clone());
        }
        let st = fs::symlink_metadata(backup).unwrap();
        assert_eq!((st.dev(), st.ino()), (dev, ino), "the bin is given the file that was checked");
        if let Some(into) = &self.into {
            fs::rename(backup, into.join(original.file_name().unwrap())).unwrap();
        }
        self.adopted.lock().unwrap().push((backup.to_path_buf(), original.to_path_buf()));
        Ok("bin-item-1".into())
    }
    fn holds(&self, original: &Path) -> bool {
        self.holds.iter().any(|h| h == original)
    }
}

fn found(dir: &Path) -> Vec<Found> {
    let mut v: Vec<Found> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| is_leftover_name(&e.file_name().to_string_lossy()))
        .map(|e| {
            let t = e.file_type().unwrap();
            Found { name: e.file_name().to_string_lossy().into_owned(), kind: if t.is_symlink() { Kind::Link } else if t.is_dir() { Kind::Dir } else if t.is_file() { Kind::File } else { Kind::Other } }
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

fn run_with(e: &Env, bin: Option<&dyn OriginalsBin>, owners: &dyn Fn() -> Result<Owners, String>) -> Vec<(String, Outcome)> {
    let f = found(&e.dir);
    let real_root = fs::canonicalize(&e.root).unwrap();
    let real_dir = real_root.join(e.dir.strip_prefix(&e.root).unwrap());
    tidy_folder(&Tidy { tx: &e.tx, bin, verify: e.verify.as_deref(), owners }, &Folder { real_root: &real_root, dir: &e.dir, real_dir: &real_dir, found: &f })
}

fn run(e: &Env, bin: Option<&dyn OriginalsBin>) -> Vec<(String, Outcome)> {
    run_with(e, bin, &|| Ok(Owners::default()))
}

fn outcome<'a>(r: &'a [(String, Outcome)], name: &str) -> &'a Outcome {
    &r.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("{name} in {r:?}")).1
}

fn kept_why<'a>(r: &'a [(String, Outcome)], name: &str) -> &'a str {
    match outcome(r, name) {
        Outcome::Kept(w) => w,
        o => panic!("{name}: {o:?}"),
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

/// The tidy hook is one for the whole process: tests that set it take turns, or one clears
/// or replaces another's while it runs.
fn hook_test() -> std::sync::MutexGuard<'static, ()> {
    static ONE: Mutex<()> = Mutex::new(());
    ONE.lock().unwrap_or_else(|p| p.into_inner())
}

const A: &str = "2026-08-30_20-53-04-front.mp4";
const B: &str = "2026-08-30_20-53-04-back.mp4";
const C: &str = "2026-08-30_20-53-04-left_repeater.mp4";

#[test]
fn a_second_name_goes_and_the_clip_stays() {
    let e = env();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    let ino = fs::metadata(&x).unwrap().ino();
    let r = run(&e, None);
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Removed);
    let st = fs::metadata(&x).unwrap();
    assert_eq!((st.ino(), st.nlink()), (ino, 1), "the same file, now with one name");
    assert_eq!(fs::read(&x).unwrap(), h264());
    assert_eq!(names(&e.dir), vec![A.to_string()], "no quarantine name left");
    assert_eq!(log_line("SentryClips/2026-08-30_20-53-04", &format!("BACKUP-{A}"), &Outcome::Removed), format!("[CONVERTER] BACKUP cleanup: removed the second name \"BACKUP-{A}\" in \"SentryClips/2026-08-30_20-53-04/\" (the same file as \"{A}\", 2 names; the clip is kept)"));
}

#[test]
fn a_third_name_keeps_both() {
    let e = env();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    fs::hard_link(&x, e.root.join("elsewhere.mp4")).unwrap();
    let r = run(&e, None);
    assert!(kept_why(&r, &format!("BACKUP-{A}")).contains("3 names"), "{r:?}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 3);
}

#[test]
fn a_missing_clip_gets_its_original_back() {
    let e = env();
    fs::write(e.dir.join(format!("BACKUP-{A}")), h264()).unwrap();
    let ino = fs::metadata(e.dir.join(format!("BACKUP-{A}"))).unwrap().ino();
    let r = run(&e, None);
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Restored);
    assert_eq!(fs::metadata(e.dir.join(A)).unwrap().ino(), ino);
    assert_eq!(fs::read(e.dir.join(A)).unwrap(), h264());
    assert_eq!(names(&e.dir), vec![A.to_string()]);
}

#[test]
fn a_clip_that_appears_while_it_is_put_back_keeps_both() {
    let e = env();
    // (a name of this test only: the hook is shared by every test)
    let clip = "2026-08-30_20-53-04-pillar_race.mp4";
    let backup = format!("BACKUP-{clip}");
    fs::write(e.dir.join(&backup), b"original").unwrap();
    let dir = e.dir.clone();
    let _one = hook_test();
    *TEST_HOOK.write().unwrap() = Some(Arc::new(move |ev: &str, _from: &str, to: &str| {
        if ev == "rename-before" && to == clip {
            fs::write(dir.join(clip), b"someone else").unwrap();
        }
        Ok(())
    }));
    let r = run(&e, None);
    *TEST_HOOK.write().unwrap() = None;
    assert!(kept_why(&r, &backup).contains("appeared meanwhile; both kept"), "{r:?}");
    assert_eq!(fs::read(e.dir.join(&backup)).unwrap(), b"original");
    assert_eq!(fs::read(e.dir.join(clip)).unwrap(), b"someone else");
}

#[test]
fn a_clip_in_the_bin_is_not_brought_back_its_original_joins_it() {
    let e = env();
    fs::write(e.dir.join(format!("BACKUP-{A}")), h264()).unwrap();
    let real = fs::canonicalize(&e.dir).unwrap();
    let bin = FakeBin { holds: vec![real.join(A)], ..Default::default() };
    let r = run(&e, Some(&bin));
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Binned { item: "bin-item-1".into(), codec: None });
    assert!(!e.dir.join(A).exists(), "the clip the owner binned is not resurrected");
    assert_eq!(bin.adopted.lock().unwrap()[0], (real.join(format!("BACKUP-{A}")), real.join(A)));
}

#[test]
fn an_original_beside_its_converted_copy_goes_to_the_recycle_bin() {
    let e = env();
    let into = e.root.join("bin");
    fs::create_dir_all(&into).unwrap();
    for (n, x, b) in [(A, h265(), h264()), (B, h264(), h264()), (C, h265(), h265())] {
        fs::write(e.dir.join(n), x).unwrap();
        fs::write(e.dir.join(format!("BACKUP-{n}")), b).unwrap();
    }
    // without a bin: kept, and the page says what to do
    let r = run(&e, None);
    assert!(kept_why(&r, &format!("BACKUP-{A}")).contains("converted H.265 copy); this folder has no Recycle Bin, delete it by hand"), "{r:?}");
    assert!(kept_why(&r, &format!("BACKUP-{B}")).contains("(H.264) is not a converted copy of this H.264 original (H.264)"), "{r:?}");
    assert!(kept_why(&r, &format!("BACKUP-{C}")).contains("(H.265) is not a converted copy of this H.264 original (H.265)"), "{r:?}");
    // a bin that refuses: kept, with its reason
    let refusing = FakeBin { refuse: Some("the share is not writable right now".into()), ..Default::default() };
    let r = run(&e, Some(&refusing));
    assert!(kept_why(&r, &format!("BACKUP-{A}")).ends_with("not moved to the Recycle Bin: the share is not writable right now"), "{r:?}");
    let bin = FakeBin { into: Some(into.clone()), ..Default::default() };
    let r = run(&e, Some(&bin));
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Binned { item: "bin-item-1".into(), codec: Some("h265".into()) });
    assert_eq!(fs::read(into.join(A)).unwrap(), h264(), "the original, whole");
    assert_eq!(fs::read(e.dir.join(A)).unwrap(), h265(), "the converted copy stays");
    assert_eq!(bin.adopted.lock().unwrap().len(), 1, "only the converted copy's original");
    {
        let asked = e.asked.lock().unwrap();
        let (o, c, codec) = asked.last().expect("the copy was checked before its original moved");
        assert_eq!((o.file_name().unwrap().to_string_lossy().into_owned(), c.file_name().unwrap().to_string_lossy().into_owned(), codec.as_str()), (format!("BACKUP-{A}"), A.to_string(), "h265"));
        assert!(o.starts_with("/proc/self/fd/"), "read through the pinned folder: {o:?}");
    }
    assert!(e.dir.join(format!("BACKUP-{B}")).exists() && e.dir.join(format!("BACKUP-{C}")).exists());
    assert!(log_line("", &format!("BACKUP-{A}"), outcome(&r, &format!("BACKUP-{A}"))).contains("to the Recycle Bin as the original of \"2026-08-30_20-53-04-front.mp4\" (item bin-item-1; \"2026-08-30_20-53-04-front.mp4\" is the converted H.265 copy)"));
}

#[test]
fn traps_are_reported_and_never_touched() {
    let e = env();
    let outside = e.root.parent().unwrap().join("passwd");
    fs::write(&outside, b"root:x:0:0").unwrap();
    std::os::unix::fs::symlink(&outside, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    fs::create_dir(e.dir.join("BACKUP-dir")).unwrap();
    fs::write(e.dir.join(format!("backup-{B}")), b"lower").unwrap();
    fs::write(e.dir.join("BACKUP-notes.txt"), b"notes").unwrap();
    fs::write(e.dir.join(format!("BACKUP-BACKUP-{B}")), b"twice").unwrap();
    // the clip is a folder, or a link
    fs::create_dir(e.dir.join(C)).unwrap();
    fs::write(e.dir.join(format!("BACKUP-{C}")), h264()).unwrap();
    let pillar = "2026-08-30_20-53-04-left_pillar.mp4";
    std::os::unix::fs::symlink(&outside, e.dir.join(pillar)).unwrap();
    fs::write(e.dir.join(format!("BACKUP-{pillar}")), h264()).unwrap();
    let before = names(&e.dir);
    let r = run(&e, Some(&FakeBin::default()));
    assert!(kept_why(&r, &format!("BACKUP-{A}")).contains("symbolic link"));
    assert!(kept_why(&r, "BACKUP-dir").contains("a folder"));
    assert!(kept_why(&r, &format!("backup-{B}")).contains("other letter case"));
    assert!(kept_why(&r, "BACKUP-notes.txt").contains("not a Tesla clip name"));
    assert!(kept_why(&r, &format!("BACKUP-BACKUP-{B}")).contains("a leftover name of a leftover name"));
    assert!(kept_why(&r, &format!("BACKUP-{C}")).contains("is a folder"));
    assert!(kept_why(&r, &format!("BACKUP-{pillar}")).contains("is a symbolic link"));
    assert_eq!(names(&e.dir), before);
    assert_eq!(fs::read(&outside).unwrap(), b"root:x:0:0");
}

#[test]
fn a_folder_reached_through_a_link_is_refused() {
    let e = env();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    // the folder is swapped for a link to a copy of it after the listing
    let moved = e.root.join("moved");
    fs::rename(&e.dir, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &e.dir).unwrap();
    let r = run(&e, None);
    assert!(kept_why(&r, &format!("BACKUP-{A}")).contains("reached through a link"), "{r:?}");
    assert_eq!(fs::metadata(moved.join(A)).unwrap().nlink(), 2, "untouched");
}

#[test]
fn a_backup_swapped_while_it_is_tidied_is_put_back() {
    let e = env();
    let clip = "2026-08-30_20-53-04-swap_race.mp4";
    let backup = format!("BACKUP-{clip}");
    let x = e.dir.join(clip);
    fs::write(&x, b"original").unwrap();
    fs::hard_link(&x, e.dir.join(&backup)).unwrap();
    let dir = e.dir.clone();
    let b2 = backup.clone();
    let _one = hook_test();
    *TEST_HOOK.write().unwrap() = Some(Arc::new(move |ev: &str, from: &str, to: &str| {
        if ev == "quarantined" && from == b2 {
            // another file takes the quarantine name: the check after the move sees it
            fs::rename(dir.join(to), dir.join("kept-aside")).unwrap();
            fs::write(dir.join(to), b"another").unwrap();
        }
        Ok(())
    }));
    let r = run(&e, None);
    *TEST_HOOK.write().unwrap() = None;
    assert!(kept_why(&r, &backup).starts_with("it changed while it was tidied"), "{r:?}");
    assert_eq!(fs::read(&x).unwrap(), b"original");
    assert_eq!(fs::read(e.dir.join(&backup)).unwrap(), b"another", "put back at the backup name, nothing deleted");
    assert_eq!(fs::read(e.dir.join("kept-aside")).unwrap(), b"original");
}

#[test]
fn a_name_a_conversion_holds_is_kept() {
    let e = env();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    let held = e.tx.hold(&[&x.to_string_lossy(), &e.dir.join(format!("BACKUP-{A}")).to_string_lossy()]);
    let r = std::thread::scope(|s| s.spawn(|| run(&e, None)).join().unwrap());
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), "in use by a conversion right now");
    drop(held);
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2);
    assert_eq!(outcome(&run(&e, None), &format!("BACKUP-{A}")), &Outcome::Removed);
}

fn clip_item(i: usize, src: &Path, rel: &str, state: &str) -> Value {
    json!({
        "id": format!("item-{:06}", i), "state": state, "kind": "video", "group": "SentryClips", "eventId": "2026-08-30_20-53-04",
        "relativePath": rel, "sourcePath": src.to_string_lossy(), "sourceBytes": 4000,
        "mtimeMs": 1760000000000.0, "timestampKey": "2026-08-30_20-53-04", "camera": "front", "attempts": 0
    })
}

fn job(store: &JobStore, root: &Path, state: &str, items: Vec<Value>, top: Vec<(&str, Value)>) -> String {
    let mut m = serde_json::Map::new();
    m.insert("state".into(), json!(state));
    m.insert("config".into(), json!({
        "sourceRoot": root, "destinationRoot": null, "codec": "h265", "profileId": "balanced", "networkMode": "auto", "outputMode": "replace",
        "includedGroups": ["SavedClips", "SentryClips", "RecentClips"], "replacementConfirmed": true, "concurrency": 1, "verifyMode": "quick"
    }));
    m.insert("items".into(), Value::Array(items));
    m.insert("discoveryComplete".into(), json!(true));
    if state == "completed" {
        m.insert("summaryDismissed".into(), json!(true));
    }
    for (k, v) in top {
        m.insert(k.into(), v);
    }
    store.create(&m).unwrap().id().to_string()
}

fn owners_of(store: &JobStore, calling: Option<&str>) -> Result<Owners, String> {
    let mut o = Owners::default();
    let s = store.list_strict()?;
    for m in s.manifests {
        o.add_manifest(&m, Some(m.id()) == calling);
    }
    for d in s.damaged {
        o.add_damaged(&d.id, &d.parts)?;
    }
    Ok(o)
}

#[test]
fn a_name_a_job_record_owns_or_could_recover_is_kept() {
    let e = env();
    let jobs = e.root.parent().unwrap().join("jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    let backup = e.dir.join(format!("BACKUP-{A}"));
    fs::hard_link(&x, &backup).unwrap();
    let rel = format!("SentryClips/2026-08-30_20-53-04/{A}");
    // a job that was replacing this clip when it stopped (needs recovery): its record names the backup
    let stopped = job(&store, &e.root, "paused", vec![clip_item(1, &x, &rel, "processing")], vec![("activeItemId", json!("item-000001")), ("replacementPhase", json!("original-backed-up")), ("recovery", json!({ "fromState": "replacing", "phase": "original-backed-up", "action": "manual-intervention" })), ("ownedPaths", json!({ "replacementBackup": backup.to_string_lossy() }))]);
    let o = owners_of(&store, None).unwrap();
    let r = run_with(&e, None, &|| Ok(Owners { paths: o.paths.clone(), sources: o.sources.clone(), roots: o.roots.clone(), mine: o.mine.clone(), ..Default::default() }));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {stopped} still names it in its record"));
    // the same without the recorded name: recovery would derive it
    let mut o2 = owners_of(&store, None).unwrap();
    o2.paths.clear();
    assert_eq!(o2.why(&[super::super::owned::resolve(&x)], &[]), Some(format!("job {stopped} can still recover this clip from it")));
    o2.sources.clear();
    assert_eq!(o2.why(&[super::super::owned::resolve(&x)], &[]), Some(format!("job {stopped} still has files to settle in this folder")));
    // the calling job's own unfinished clip
    let o3 = owners_of(&store, Some(&stopped)).unwrap();
    assert!(o3.mine.contains(&super::super::owned::resolve(&x)) && o3.roots.is_empty());
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2);
    // discarded (set aside): no owner any more, and the name is tidied
    assert!(store.discard(&stopped).unwrap());
    let o = owners_of(&store, None).unwrap();
    assert!(o.paths.is_empty() && o.sources.is_empty() && o.roots.is_empty());
    // a finished job elsewhere does not keep it either
    job(&store, &e.root.join("RecentClips"), "completed", vec![], vec![]);
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Removed);
}

#[test]
fn records_that_cannot_all_be_read_keep_the_folder() {
    let e = env();
    let jobs = e.root.parent().unwrap().join("jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    job(&store, &e.root.join("RecentClips"), "completed", vec![], vec![]);
    // a job folder with a journal and no job file
    let lost = jobs.join("9b3c7e2a-1111-4222-8333-944455556666");
    fs::create_dir_all(&lost).unwrap();
    fs::write(lost.join("job.journal"), b"{}\n").unwrap();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    let r = run_with(&e, None, &|| owners_of(&store, None).map_err(|e| format!("the Encoder's job records could not all be read: {e}")));
    let why = kept_why(&r, &format!("BACKUP-{A}"));
    assert!(why.starts_with("the Encoder's job records could not all be read: job 9b3c7e2a-1111-4222-8333-944455556666 has "), "{why}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2);
}

#[test]
fn an_unfinished_copy_beside_its_clip_goes() {
    let e = env();
    // the state a replace killed after linking the backup leaves: X twice named, its copy beside it
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    fs::write(e.dir.join(format!("TEMP-H265-{A}")), h265()).unwrap();
    // a copy whose clip is missing, one that is not what its name says, one in AV1 named so
    fs::write(e.dir.join(format!("TEMP-H265-{B}")), h265()).unwrap();
    fs::write(e.dir.join(C), h264()).unwrap();
    fs::write(e.dir.join(format!("TEMP-AV1-{C}")), h265()).unwrap();
    fs::write(e.dir.join(format!("temp-h265-{C}")), h265()).unwrap();
    let r = run(&e, None);
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Removed);
    assert_eq!(outcome(&r, &format!("TEMP-H265-{A}")), &Outcome::RemovedCopy("h265".into()));
    assert!(kept_why(&r, &format!("TEMP-H265-{B}")).contains("is missing: the copy is kept"), "{r:?}");
    assert!(kept_why(&r, &format!("TEMP-AV1-{C}")).contains("not a whole AV1 copy (H.265)"), "{r:?}");
    assert!(kept_why(&r, &format!("temp-h265-{C}")).contains("other letter case"), "{r:?}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 1);
    assert_eq!(fs::read(&x).unwrap(), h264(), "the original, untouched");
    let mut want = vec![A.to_string(), C.to_string(), format!("TEMP-AV1-{C}"), format!("TEMP-H265-{B}"), format!("temp-h265-{C}")];
    want.sort();
    assert_eq!(names(&e.dir), want);
    assert_eq!(log_line("", &format!("TEMP-H265-{A}"), &Outcome::RemovedCopy("h265".into())), format!("[CONVERTER] BACKUP cleanup: removed the unfinished copy \"TEMP-H265-{A}\" (H.265; the clip \"{A}\" is kept)"));
}

#[test]
fn a_record_that_names_the_backup_through_a_link_to_its_folder_owns_it() {
    let e = env();
    let jobs = e.root.parent().unwrap().join("jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    let alias = e.root.parent().unwrap().join("alias");
    std::os::unix::fs::symlink(&e.root, &alias).unwrap();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    let backup = e.dir.join(format!("BACKUP-{A}"));
    fs::hard_link(&x, &backup).unwrap();
    let via = alias.join("SentryClips/2026-08-30_20-53-04");
    let rel = format!("SentryClips/2026-08-30_20-53-04/{A}");
    // a paused job that needs recovery, its record written through the link (a finished
    // job's folder elsewhere, so only its recorded names keep this one)
    let stopped = job(&store, &e.root.join("RecentClips"), "paused", vec![clip_item(1, &via.join(A), &rel, "processing")], vec![("activeItemId", json!("item-000001")), ("replacementPhase", json!("original-backed-up")), ("recovery", json!({ "fromState": "replacing", "phase": "original-backed-up", "action": "manual-intervention" })), ("ownedPaths", json!({ "replacementBackup": via.join(format!("BACKUP-{A}")).to_string_lossy() }))]);
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {stopped} still names it in its record"));
    // the clip alone, and the job's source folder alone, through the link
    let mut o = owners_of(&store, None).unwrap();
    o.paths.clear();
    assert_eq!(o.why(&[super::super::owned::resolve(&x)], &[]), Some(format!("job {stopped} can still recover this clip from it")));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "untouched");
    assert!(store.discard(&stopped).unwrap());
    let other = job(&store, &alias, "paused", vec![], vec![]);
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {other} still has files to settle in this folder"));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "untouched");
}

#[test]
fn a_damaged_record_keeps_its_source_folder() {
    let e = env();
    let jobs = e.root.parent().unwrap().join("jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    let id = job(&store, &e.root, "completed", vec![], vec![]);
    // a journal that does not replay: the job is listed nowhere, its job file is still there
    fs::write(jobs.join(&id).join("job.journal"), b"{\"add\":\"not a list\"}\n").unwrap();
    assert!(store.list().unwrap().is_empty());
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {id} still has files to settle in this folder"));
    // its job file unreadable as well: nothing is touched anywhere
    fs::write(jobs.join(&id).join("job.json"), b"{not json").unwrap();
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert!(kept_why(&r, &format!("BACKUP-{A}")).contains("is damaged"), "{r:?}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "untouched");
    // once the job folder is gone, the name is tidied
    fs::remove_dir_all(jobs.join(&id)).unwrap();
    assert_eq!(outcome(&run_with(&e, None, &|| owners_of(&store, None)), &format!("BACKUP-{A}")), &Outcome::Removed);
}

fn quarantine_names(dir: &Path) -> Vec<String> {
    names(dir).into_iter().filter(|n| n.starts_with(QUARANTINE)).collect()
}

#[test]
fn a_tidy_stopped_after_its_quarantine_rename_is_settled_next_time() {
    let e = env();
    let clip = "2026-08-30_20-53-04-stop_after_rename.mp4";
    let copy_clip = "2026-08-30_20-53-04-stop_copy.mp4";
    let x = e.dir.join(clip);
    fs::write(&x, b"original").unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{clip}"))).unwrap();
    fs::write(e.dir.join(copy_clip), h264()).unwrap();
    fs::write(e.dir.join(format!("TEMP-H265-{copy_clip}")), h265()).unwrap();
    let (c1, c2) = (format!("BACKUP-{clip}"), format!("TEMP-H265-{copy_clip}"));
    let _one = hook_test();
    *TEST_HOOK.write().unwrap() = Some(Arc::new(move |ev: &str, from: &str, _to: &str| {
        if ev == "quarantined" && (from == c1 || from == c2) {
            // the server stops here
            return Err(io::Error::from_raw_os_error(libc::EINTR));
        }
        Ok(())
    }));
    let r = run(&e, None);
    *TEST_HOOK.write().unwrap() = None;
    assert!(matches!(outcome(&r, &format!("BACKUP-{clip}")), Outcome::Kept(_)), "{r:?}");
    let q = quarantine_names(&e.dir);
    assert_eq!(q.len(), 2, "{:?}", names(&e.dir));
    assert!(q.iter().any(|n| n.ends_with(&format!("-BACKUP-{clip}"))) && q.iter().any(|n| n.ends_with(&format!("-TEMP-H265-{copy_clip}"))), "{q:?}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "a hidden second name");
    // the next tidy settles both as the names they stand for
    let r = run(&e, None);
    let qb = q.iter().find(|n| n.contains("-BACKUP-")).unwrap();
    let qc = q.iter().find(|n| n.contains("-TEMP-H265-")).unwrap();
    assert_eq!(outcome(&r, qb), &Outcome::Removed);
    assert_eq!(outcome(&r, qc), &Outcome::RemovedCopy("h265".into()));
    assert!(quarantine_names(&e.dir).is_empty());
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 1);
    assert_eq!(fs::read(&x).unwrap(), b"original");
    assert_eq!(fs::read(e.dir.join(copy_clip)).unwrap(), h264());
    assert_eq!(log_line("", qb, &Outcome::Removed), format!("[CONVERTER] BACKUP cleanup: removed the second name \"{qb}\" (the same file as \"{clip}\", 2 names; the clip is kept)"));
}

#[test]
fn a_rename_stopped_between_its_link_and_unlink_is_settled() {
    let e = env();
    // (without renameat2, a stop between link and unlink leaves three names of one file)
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    let q = format!("{QUARANTINE}0123456789abcdef-BACKUP-{A}");
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    fs::hard_link(&x, e.dir.join(&q)).unwrap();
    // and a TEMP copy with its quarantine name beside it
    fs::write(e.dir.join(B), h264()).unwrap();
    let qc = format!("{QUARANTINE}fedcba9876543210-TEMP-H265-{B}");
    fs::write(e.dir.join(format!("TEMP-H265-{B}")), h265()).unwrap();
    fs::hard_link(e.dir.join(format!("TEMP-H265-{B}")), e.dir.join(&qc)).unwrap();
    // a quarantine name of a file with a name elsewhere too is kept
    let qs = format!("{QUARANTINE}00000000000000aa-BACKUP-{C}");
    fs::write(e.dir.join(C), b"c").unwrap();
    fs::hard_link(e.dir.join(C), e.dir.join(format!("BACKUP-{C}"))).unwrap();
    fs::hard_link(e.dir.join(C), e.dir.join(&qs)).unwrap();
    fs::hard_link(e.dir.join(C), e.root.join("elsewhere")).unwrap();
    let r = run(&e, None);
    assert_eq!(outcome(&r, &q), &Outcome::RemovedExtra(format!("BACKUP-{A}")));
    assert_eq!(outcome(&r, &format!("BACKUP-{A}")), &Outcome::Removed);
    assert_eq!(outcome(&r, &qc), &Outcome::RemovedExtra(format!("TEMP-H265-{B}")));
    assert_eq!(outcome(&r, &format!("TEMP-H265-{B}")), &Outcome::RemovedCopy("h265".into()));
    assert!(kept_why(&r, &qs).contains("with 4 names (this folder has 3 of them)"), "{r:?}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 1);
    assert_eq!(fs::read(&x).unwrap(), h264());
    assert_eq!(fs::metadata(e.dir.join(C)).unwrap().nlink(), 4, "untouched");
    let mut want = vec![A.to_string(), B.to_string(), C.to_string(), format!("BACKUP-{C}"), qs.clone()];
    want.sort();
    assert_eq!(names(&e.dir), want);
    assert!(log_line("", &q, &Outcome::RemovedExtra(format!("BACKUP-{A}"))).contains("a name an earlier tidy left (one more name of \"BACKUP-"));
}

#[test]
fn a_quarantined_original_whose_clip_is_missing_is_put_back() {
    let e = env();
    let q = format!("{QUARANTINE}0123456789abcdef-BACKUP-{A}");
    fs::write(e.dir.join(&q), h264()).unwrap();
    // not the tidy's names: other hex, no name after it, a quarantine of a quarantine
    for n in [format!("{QUARANTINE}0123456789ABCDEF-BACKUP-{B}"), format!("{QUARANTINE}0123456789abcdef-"), format!("{QUARANTINE}0123456789abcdef-{QUARANTINE}0123456789abcdef-BACKUP-{B}")] {
        fs::write(e.dir.join(n), b"x").unwrap();
    }
    let r = run(&e, None);
    assert_eq!(outcome(&r, &q), &Outcome::Restored);
    assert_eq!(fs::read(e.dir.join(A)).unwrap(), h264());
    assert!(kept_why(&r, &format!("{QUARANTINE}0123456789abcdef-{QUARANTINE}0123456789abcdef-BACKUP-{B}")).contains("a leftover name of a leftover name"), "{r:?}");
    assert_eq!(r.len(), 2, "{r:?}");
    assert!(!is_leftover_name(&format!("{QUARANTINE}0123456789ABCDEF-BACKUP-{B}")) && !is_leftover_name(&format!("{QUARANTINE}0123456789abcdef-")));
}

// ---- other mount points of the folder (bind mounts), and copies nobody proved good

/// A bind mount of `from` at `at` (needs root; None, and the test skips, without it).
struct Bind(PathBuf);
impl Drop for Bind {
    fn drop(&mut self) {
        let _ = std::process::Command::new("umount").arg(&self.0).status();
    }
}
fn bind(from: &Path, at: &Path) -> Option<Bind> {
    fs::create_dir_all(at).unwrap();
    let ok = std::process::Command::new("mount").arg("--bind").arg(from).arg(at).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
    if !ok {
        eprintln!("skipped: a bind mount needs root");
        return None;
    }
    let b = Bind(at.to_path_buf());
    assert_eq!(fs::canonicalize(at).unwrap(), at, "canonicalize keeps the bind spelling");
    Some(b)
}

#[test]
fn a_record_through_a_bind_mount_of_the_folder_owns_it() {
    let e = env();
    let jobs = e.root.parent().unwrap().join("jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    let at = e.root.parent().unwrap().join("bind");
    let Some(_b) = bind(&e.root, &at) else { return };
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    let via = at.join("SentryClips/2026-08-30_20-53-04");
    let rel = format!("SentryClips/2026-08-30_20-53-04/{A}");
    // a paused job that needs recovery, its record (root, clip and backup) through the bind mount
    let stopped = job(&store, &at, "paused", vec![clip_item(1, &via.join(A), &rel, "processing")], vec![("activeItemId", json!("item-000001")), ("replacementPhase", json!("original-backed-up")), ("recovery", json!({ "fromState": "replacing", "phase": "original-backed-up", "action": "manual-intervention" })), ("ownedPaths", json!({ "replacementBackup": via.join(format!("BACKUP-{A}")).to_string_lossy() }))]);
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {stopped} still names it in its record"));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "both names kept");
    // only the root through the bind mount (a job with files to settle there): still kept
    let jobs2 = e.root.parent().unwrap().join("jobs2");
    fs::create_dir_all(&jobs2).unwrap();
    let store2 = JobStore::new(&jobs2).unwrap();
    let paused = job(&store2, &at, "paused", vec![], vec![]);
    let r = run_with(&e, None, &|| owners_of(&store2, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {paused} still has files to settle in this folder"));
    // and a job of a folder above it, through the bind mount
    let jobs3 = e.root.parent().unwrap().join("jobs3");
    fs::create_dir_all(&jobs3).unwrap();
    let store3 = JobStore::new(&jobs3).unwrap();
    let above = job(&store3, &at.join("SentryClips"), "paused", vec![], vec![]);
    let r = run_with(&e, None, &|| owners_of(&store3, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {above} still has files to settle in this folder"));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "both names kept");
}

#[test]
fn a_hold_through_a_bind_mount_blocks_the_tidy() {
    let e = env();
    let at = e.root.parent().unwrap().join("bind2");
    let Some(_b) = bind(&e.root, &at) else { return };
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    let via = at.join("SentryClips/2026-08-30_20-53-04");
    let (s, b) = (via.join(A).to_string_lossy().into_owned(), via.join(format!("BACKUP-{A}")).to_string_lossy().into_owned());
    // a swap of another job holds the clip through the bind spelling
    let h = e.tx.hold(&[&s, &b]);
    let r = std::thread::scope(|sc| sc.spawn(|| run(&e, None)).join().unwrap());
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), "in use by a conversion right now");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2);
    drop(h);
    assert_eq!(outcome(&run(&e, None), &format!("BACKUP-{A}")), &Outcome::Removed, "once let go");
}

#[test]
fn a_source_folder_that_cannot_be_reached_keeps_every_folder() {
    let e = env();
    let jobs = e.root.parent().unwrap().join("jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    // an unsettled job of a mount that is gone (it may be this folder mounted elsewhere)
    let gone = e.root.parent().unwrap().join("old-mount/TeslaCam");
    let stopped = job(&store, &gone, "paused", vec![clip_item(1, &gone.join(format!("SentryClips/2026-08-30_20-53-04/{A}")), &format!("SentryClips/2026-08-30_20-53-04/{A}"), "queued")], vec![]);
    let r = run_with(&e, None, &|| owners_of(&store, None));
    let why = kept_why(&r, &format!("BACKUP-{A}"));
    assert!(why.starts_with(&format!("job {stopped} still has files to settle in \"{}\", which cannot be reached now", gone.display())), "{why}");
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2);
}

/// The verifier's fixtures (converter/tests.rs): Tesla-like originals and real encodes of
/// them, good and broken. None without ffmpeg and ffprobe.
fn real_encodes() -> Option<&'static PathBuf> {
    let have = |c: &str| std::process::Command::new(c).arg("-version").output().is_ok_and(|o| o.status.success());
    if !have("ffmpeg") || !have("ffprobe") {
        eprintln!("skipped: needs ffmpeg and ffprobe");
        return None;
    }
    crate::converter::tests::fixtures()
}

/// The real check (verify_converted with ffprobe and ffmpeg), its snapshots under `snaps`.
fn real_verify(e: &mut Env, snaps: &Path) {
    fs::create_dir_all(snaps).unwrap();
    let registry = Arc::new(Registry::new(snaps.to_path_buf()));
    let runner = crate::converter::process::BoundedRunner { timeout_ms: 120_000, max_output_bytes: 4 * 1024 * 1024, ..Default::default() };
    e.verify = Some(Box::new(move |o: &Path, c: &Path, codec: &'static str| verify_converted(o, c, codec, "ffprobe", "ffmpeg", &runner, &registry, None)));
}

#[test]
fn an_original_beside_a_broken_converted_copy_is_kept() {
    let Some(fx) = real_encodes() else { return };
    let mut e = env();
    let snaps = e.root.parent().unwrap().join("snaps");
    real_verify(&mut e, &snaps);
    let original = fs::read(fx.join("plain.mp4")).unwrap();
    let good = fs::read(fx.join("verify/plain.h265.good.mp4")).unwrap();
    // X: the converted copy's header with its picture data gone (zeros), as a copy that
    // failed final validation and whose rollback did not finish
    let mut zeroed = good.clone();
    let mdat = good.windows(4).position(|w| w == b"mdat").unwrap();
    let moov = good.windows(4).position(|w| w == b"moov").unwrap();
    let (from, to) = if mdat > moov { (mdat + 8, good.len()) } else { (mdat + 8, moov - 8) };
    zeroed[from..to].iter_mut().for_each(|b| *b = 0);
    const D: &str = "2026-08-30_20-53-04-right_repeater.mp4";
    const F: &str = "2026-08-30_20-53-04-left_pillar.mp4";
    let shapes: [(&str, Vec<u8>, Vec<u8>); 5] = [
        (A, zeroed, original.clone()),
        // cut short (a copy killed before it was whole)
        (B, fs::read(fx.join("verify/plain.h265.short.mp4")).unwrap(), original.clone()),
        // telemetry changed
        (C, fs::read(fx.join("verify/plain.h265.tampered.mp4")).unwrap(), original.clone()),
        // a good copy, but of another original
        (D, fs::read(fx.join("verify/first.h265.good.mp4")).unwrap(), original.clone()),
        // a good copy of this original
        (F, good.clone(), original.clone()),
    ];
    for (n, x, b) in &shapes {
        fs::write(e.dir.join(n), x).unwrap();
        fs::write(e.dir.join(format!("BACKUP-{n}")), b).unwrap();
    }
    let into = e.root.join("bin");
    fs::create_dir_all(&into).unwrap();
    let bin = FakeBin { into: Some(into.clone()), ..Default::default() };
    let r = run(&e, Some(&bin));
    for n in [A, B, C, D] {
        let why = kept_why(&r, &format!("BACKUP-{n}"));
        // (the short copy has no whole header: refused before the check)
        if n != B {
            assert!(why.starts_with(&format!("{UNVERIFIED} (the H.265 copy \"{n}\" failed the check: ")), "{n}: {why}");
        }
        assert_eq!(fs::read(e.dir.join(format!("BACKUP-{n}"))).unwrap(), original, "{n}: the original stays where it was");
    }
    assert!(kept_why(&r, &format!("BACKUP-{A}")).contains("decode-failed") || kept_why(&r, &format!("BACKUP-{A}")).contains("probe-failed"), "{r:?}");
    assert_eq!(outcome(&r, &format!("BACKUP-{F}")), &Outcome::Binned { item: "bin-item-1".into(), codec: Some("h265".into()) }, "{r:?}");
    assert_eq!(fs::read(into.join(F)).unwrap(), original, "the original of the good copy, whole, in the bin");
    assert_eq!(fs::read(e.dir.join(F)).unwrap(), good, "the good copy stays");
    assert_eq!(bin.adopted.lock().unwrap().len(), 1);
    // the check only read: every copy as it was, and no snapshot of the verifier left
    for (n, x, _) in &shapes {
        assert_eq!(&fs::read(e.dir.join(n)).unwrap(), x, "{n}");
    }
    assert_eq!(fs::read_dir(&snaps).unwrap().count(), 0, "the verifier's snapshots are removed");
    // and without a check: kept, never binned
    let mut e2 = env();
    e2.verify = None;
    fs::write(e2.dir.join(F), &good).unwrap();
    fs::write(e2.dir.join(format!("BACKUP-{F}")), &original).unwrap();
    let r = run(&e2, Some(&bin));
    assert_eq!(kept_why(&r, &format!("BACKUP-{F}")), format!("{UNVERIFIED} (it cannot be checked here)"));
    assert_eq!(fs::read(e2.dir.join(format!("BACKUP-{F}"))).unwrap(), original);
}

#[test]
fn a_job_of_a_folder_above_a_bind_mount_point_owns_it() {
    let e = env();
    let tmp = e.root.parent().unwrap().to_path_buf();
    let jobs = tmp.join("rc2jobs");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    // only SentryClips is bind-mounted, under another folder "view"
    let view = tmp.join("view");
    let Some(_b) = bind(&e.root.join("SentryClips"), &view.join("SentryClips")) else { return };
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    // a paused job whose root is "view": view/SentryClips/... is this folder
    let paused = job(&store, &view, "paused", vec![], vec![]);
    let r = run_with(&e, None, &|| owners_of(&store, None));
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {paused} still has files to settle in this folder"));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "both names kept");
}

#[test]
fn a_job_of_the_real_folder_owns_it_through_a_bind_mount_point_below() {
    let e = env();
    let tmp = e.root.parent().unwrap().to_path_buf();
    let jobs = tmp.join("rc2jobs2");
    fs::create_dir_all(&jobs).unwrap();
    let store = JobStore::new(&jobs).unwrap();
    let view = tmp.join("view2");
    let Some(_b) = bind(&e.root.join("SentryClips"), &view.join("SentryClips")) else { return };
    let x = e.dir.join(A);
    fs::write(&x, h264()).unwrap();
    fs::hard_link(&x, e.dir.join(format!("BACKUP-{A}"))).unwrap();
    // a paused job whose root is the real TeslaCam; the tidy goes through the bind spelling
    let paused = job(&store, &e.root, "paused", vec![], vec![]);
    let via = view.join("SentryClips/2026-08-30_20-53-04");
    let f = found(&via);
    let owners = || owners_of(&store, None);
    let r = tidy_folder(&Tidy { tx: &e.tx, bin: None, verify: e.verify.as_deref(), owners: &owners }, &Folder { real_root: &view, dir: &via, real_dir: &via, found: &f });
    assert_eq!(kept_why(&r, &format!("BACKUP-{A}")), format!("job {paused} still has files to settle in this folder"));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 2, "both names kept");
    // a job of an unrelated folder does not keep it
    let other = tmp.join("other/TeslaCam");
    fs::create_dir_all(&other).unwrap();
    let jobs3 = tmp.join("rc2jobs3");
    fs::create_dir_all(&jobs3).unwrap();
    let store3 = JobStore::new(&jobs3).unwrap();
    job(&store3, &other, "paused", vec![], vec![]);
    let owners = || owners_of(&store3, None);
    let r = tidy_folder(&Tidy { tx: &e.tx, bin: None, verify: e.verify.as_deref(), owners: &owners }, &Folder { real_root: &view, dir: &via, real_dir: &via, found: &f });
    assert!(matches!(outcome(&r, &format!("BACKUP-{A}")), Outcome::Removed), "{:?}", outcome(&r, &format!("BACKUP-{A}")));
    assert_eq!(fs::metadata(&x).unwrap().nlink(), 1, "the second name went");
}

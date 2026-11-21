//! The footage area on generated archives (ports of test/security.test.js's
//! Recycle Bin tests, binAutoEmpty.test.js, catalogResume.test.js,
//! catalog.test.js's "files moved without a scan", lightRescan.test.js,
//! integrity.test.js and the stars and protect routes of server.test.js).
//! Everything here writes only inside its own temporary folder.

use sentry_lean::app::App;
use sentry_lean::catalog::Catalog;
use sentry_lean::footage::bin::{self, BIN_DIR};
use sentry_lean::footage::ctx::{Caller, Ctx, Fail, Level, LocalCore};
use sentry_lean::footage::mdb::{BinFile, BinItem, ManagerDb};
use sentry_lean::footage::routes::{self, Reply};
use sentry_lean::footage::vehicles::{Options, Vehicles};
use sentry_lean::footage::{integrity, policies};
use sentry_lean::thumbnails::Thumbnails;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// LocalCore with the converter's clips in hand settable.
struct TestCore {
    inner: LocalCore,
    busy: Mutex<HashSet<PathBuf>>,
    jobs: Mutex<Vec<(String, String)>>,
    /// what the CAN area answers with cannot be read (its key-to-car map)
    can_unread: std::sync::atomic::AtomicBool,
}

impl Ctx for TestCore {
    fn db(&self) -> &ManagerDb {
        self.inner.db()
    }
    fn data_dir(&self) -> PathBuf {
        self.inner.data_dir()
    }
    fn announce(&self, topic: &str) {
        self.inner.announce(topic)
    }
    fn audit(&self, level: Level, line: &str) {
        self.inner.audit(level, line)
    }
    fn log(&self, scope: &str, level: Level, line: &str) {
        self.inner.log(scope, level, line)
    }
    fn job_start(&self, typ: &str, vid: Option<&str>, title: &str) -> Result<i64, String> {
        self.inner.job_start(typ, vid, title)
    }
    fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<Value>) {
        self.jobs.lock().unwrap().push((status.into(), detail.into()));
        self.inner.job_finish(id, status, detail, result)
    }
    fn busy_paths(&self) -> HashSet<PathBuf> {
        self.busy.lock().unwrap().clone()
    }
    fn car_summary(&self, _vehicle: &Value) -> Result<Value, Fail> {
        self.can()?;
        Ok(Value::Null)
    }
    fn can_with(&self, _vid: &str, _rels: &[String], _until: Option<f64>) -> Result<Option<Value>, Fail> {
        self.can()?;
        Ok(None)
    }
    #[allow(clippy::type_complexity)]
    fn has_can(&self, _vid: &str) -> Result<Option<Box<dyn Fn(&sentry_lean::footage::inventory::Recording) -> bool>>, Fail> {
        self.can()?;
        Ok(None)
    }
}

impl TestCore {
    fn can(&self) -> Result<(), Fail> {
        if self.can_unread.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Fail::internal("the CAN settings could not be read"));
        }
        Ok(())
    }
}

struct Fixture {
    dir: PathBuf,
    root: PathBuf,
    app: Arc<App>,
    core: Arc<TestCore>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.app.vehicles.stop_all();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lean-footage-{name}-{}-{}", std::process::id(), sentry_lean::footage::random_hex(3)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(root: &Path, rel: &str, data: &[u8]) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, data).unwrap();
}

const ROOT_MOUNT: &str = "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n";

/// The mount table the server reads: "/" and these (mount point, "fs-type source", minor number),
/// each mounted in turn on what held its folder then (the deepest one listed before it).
fn mounts(f: &Fixture, more: &[(&Path, &str, u32)]) {
    let mut t = ROOT_MOUNT.to_string();
    let mut done: Vec<(usize, &Path)> = Vec::new();
    for (i, (at, what, minor)) in more.iter().enumerate() {
        let id = 40 + i;
        let parent = done.iter().filter(|(_, p)| at.starts_with(p)).max_by_key(|(_, p)| p.as_os_str().len()).map_or(1, |(id, _)| *id);
        t.push_str(&format!("{id} {parent} 0:{minor} / {} rw - {what} rw\n", at.display()));
        done.push((id, at));
    }
    std::fs::write(f.dir.join("mountinfo"), t).unwrap();
}

/// A folder vehicle "car" on `files` (rel -> content), scanned.
fn fixture(name: &str, files: &[(&str, &[u8])]) -> Fixture {
    let dir = tmp(name);
    let footage = dir.join("footage");
    let root = footage.join("car");
    std::fs::create_dir_all(&root).unwrap();
    for (rel, data) in files {
        write(&root, rel, data);
    }
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let core = Arc::new(TestCore { inner: LocalCore::open(&data).unwrap(), busy: Mutex::new(HashSet::new()), jobs: Mutex::new(Vec::new()), can_unread: Default::default() });
    // (the mount table the server reads: one file system; mounts() changes it)
    std::fs::write(dir.join("mountinfo"), ROOT_MOUNT).unwrap();
    let vehicles = Vehicles::new(core.clone(), Options { footage_root: footage.clone(), folder_roots: vec![footage.clone()], protected_dirs: vec![data.clone()], mountinfo: dir.join("mountinfo"), default_tz: None });
    let catalog = Catalog::open(&data.join("lean-catalog.sqlite")).unwrap();
    let app = App::new(vehicles, core.clone(), catalog, dir.clone(), Thumbnails::new(data.join("thumbnails"), "ffmpeg".into(), 1));
    app.vehicles.add(&json!({ "id": "car", "name": "Car", "source": { "type": "path", "path": root.to_string_lossy() } })).unwrap();
    wait(|| app.vehicles.share("car").is_some_and(|s| s.is_writable()));
    app.scan_now("car", false).unwrap();
    Fixture { dir, root, app, core }
}

fn wait(mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out");
}

fn ids(app: &App) -> Vec<(String, String)> {
    app.state_of("car").unwrap().recordings.iter().map(|r| (r.id.clone(), r.start.clone().unwrap_or_default())).collect()
}

fn id_at(app: &App, start: &str) -> String {
    ids(app).into_iter().find(|(_, s)| s == start).unwrap_or_else(|| panic!("no recording at {start}")).0
}

fn admin() -> Caller {
    Caller { user: Some("admin".into()), client: "127.0.0.1".into(), admin_here: true, confirmed: true }
}

fn call(f: &Fixture, method: &str, path: &str, body: Value) -> Result<Value, (u16, Value)> {
    let seg: Vec<&str> = path.split('/').collect();
    match routes::handle(&f.app, &admin(), method, &seg, &HashMap::new(), Some(&body)).expect("a footage route") {
        Ok(Reply::Json(v)) => Ok(v),
        Ok(Reply::Thumbnail { file, .. }) => Ok(json!({ "file": file.to_string_lossy() })),
        Err(e) => Err(e.body()),
    }
}

const A: &str = "TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4";
const A2: &str = "TeslaCam/RecentClips/2020-01-01_08-00-00-back.mp4";
const B: &str = "TeslaCam/RecentClips/2020-01-01_09-00-00-front.mp4";
const EV: &str = "TeslaCam/SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4";
const EVT: &str = "TeslaCam/SentryClips/2020-01-02_12-30-00/thumb.png";

#[test]
fn trash_restore_and_delete_forever() {
    let f = fixture("bin", &[(A, b"clip"), (A2, b"clip!"), (B, b"other"), (EV, b"event"), (EVT, b"png")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    let out = call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a, "nope"] })).unwrap();
    assert_eq!(out, json!({ "moved": [a], "skipped": [], "bytes": 9 }));
    assert!(!f.root.join(A).exists() && f.root.join("TeslaCam/RecentClips").is_dir(), "files moved, the clip folder stays");
    let items = call(&f, "GET", "bin", json!(null)).unwrap()["items"].clone();
    assert_eq!(items.as_array().unwrap().len(), 1);
    let item = &items[0];
    assert_eq!((item["label"].as_str(), item["category"].as_str(), item["bytes"].as_u64(), item["reason"].as_str()), (Some("Recent 2020-01-01 08:00:00"), Some("Recent"), Some(9), Some("manual")));
    let id = item["id"].as_str().unwrap().to_string();
    assert_eq!(item["files"][0], json!({ "rel": A2, "binRel": format!("{BIN_DIR}/{id}/{A2}.binned"), "size": 5 }));
    assert!(f.root.join(format!("{BIN_DIR}/{id}/{A}.binned")).is_file());
    // the inventory and the catalog follow at once
    assert!(!ids(&f.app).iter().any(|(i, _)| *i == a));
    assert_eq!(f.app.catalog.previous("car").unwrap().files.len(), 3);
    // the bin's numbers on the vehicle list
    let list = call(&f, "GET", "vehicles", json!(null)).unwrap();
    assert_eq!((list["vehicles"][0]["binBytes"].as_u64(), list["vehicles"][0]["binItems"].as_u64()), (Some(9), Some(1)));

    // restore: a file whose spot is taken stays in the bin
    write(&f.root, A2, b"new one");
    let r = call(&f, "POST", &format!("bin/{id}/restore"), json!({})).unwrap();
    assert_eq!(r, json!({ "restored": 1, "conflicts": 1 }));
    assert_eq!(std::fs::read(f.root.join(A)).unwrap(), b"clip");
    let left = f.core.db().bin_item(&id).unwrap().unwrap();
    assert_eq!(left.files, vec![BinFile { rel: A2.into(), bin_rel: format!("{BIN_DIR}/{id}/{A2}.binned"), size: 5, pending: false, conflict: true }]);
    assert_eq!(left.bytes, 5);

    // delete forever: the password first, then confirm
    assert_eq!(call(&f, "POST", &format!("bin/{id}/delete"), json!({})).unwrap_err(), (400, json!({ "error": "Confirm permanent deletion." })));
    let who = Caller { confirmed: false, ..admin() };
    let refused = routes::handle(&f.app, &who, "POST", &["bin", &id, "delete"], &HashMap::new(), Some(&json!({ "confirm": true }))).unwrap();
    assert_eq!(refused.err().unwrap().body(), (403, json!({ "error": "Enter your password to confirm this change.", "code": "CONFIRM_PASSWORD" })));
    assert_eq!(call(&f, "POST", &format!("bin/{id}/delete"), json!({ "confirm": true })).unwrap(), json!({ "bytes": 5 }));
    assert!(!f.root.join(format!("{BIN_DIR}/{id}")).exists());
    assert_eq!(call(&f, "POST", &format!("bin/{id}/delete"), json!({ "confirm": true })).unwrap_err(), (404, json!({ "error": "Not in the Recycle Bin." })));
    assert_eq!(call(&f, "POST", "bin/nope/restore", json!({})).unwrap_err(), (404, json!({ "error": "Not in the Recycle Bin." })));
    // a clip deleted for good is remembered for the archive check (an old one is not)
    assert_eq!(f.core.db().get("deleted-clips:car").unwrap(), None);
    assert!(f.core.inner.audits.lock().unwrap().iter().any(|l| l == "Deleted forever from the Recycle Bin: Recent 2020-01-01 08:00:00 (5 B): admin from 127.0.0.1"));

    // an event with its thumbnail: the bin shows the picture
    let ev = id_at(&f.app, "2020-01-02 12:29:00");
    call(&f, "POST", "vehicles/car/trash", json!({ "ids": [ev] })).unwrap();
    let item = f.core.db().bin_items(Some("car")).unwrap()[0].clone();
    let thumb = call(&f, "GET", &format!("bin/{}/thumbnail", item.id), json!(null)).unwrap();
    assert!(thumb["file"].as_str().unwrap().ends_with("thumb.png.binned"));
    assert!(!f.root.join("TeslaCam/SentryClips/2020-01-02_12-30-00").exists(), "the emptied event folder goes");
    assert!(f.root.join("TeslaCam/SentryClips").is_dir(), "the clip folder stays");
    // empty the bin
    assert_eq!(call(&f, "POST", "bin/empty", json!({ "confirm": true, "vehicle": "nope" })).unwrap_err().0, 404);
    assert_eq!(call(&f, "POST", "bin/empty", json!({ "confirm": true })).unwrap(), json!({ "deleted": 1, "failed": 0, "bytes": 8 }));
    assert_eq!(f.core.db().bin_items(None).unwrap().len(), 0);
    assert_eq!(f.core.jobs.lock().unwrap().last().unwrap(), &("done".to_string(), "8 B freed".to_string()));
}

#[test]
fn only_the_clip_a_conversion_has_in_hand_is_refused() {
    let f = fixture("busy", &[(A, b"clip"), (B, b"clip")]);
    f.core.busy.lock().unwrap().insert(f.root.join(B));
    let (a, b) = (id_at(&f.app, "2020-01-01 08:00:00"), id_at(&f.app, "2020-01-01 09:00:00"));
    let out = bin::trash(&f.app, "car", &[a.clone(), b.clone()], "manual").unwrap();
    assert_eq!(out.moved, vec![a]);
    assert_eq!(out.skipped.iter().map(|s| (s.id.clone(), s.reason)).collect::<Vec<_>>(), vec![(b, "converting")]);
    assert_eq!(f.core.jobs.lock().unwrap()[0].1, "1 moved (4 B), 1 skipped: 1 being converted right now");
    assert!(f.root.join(B).exists());
}

#[test]
fn protected_recordings_stay_and_protect_counts() {
    let f = fixture("protect", &[(A, b"clip"), (B, b"clip")]);
    let (a, b) = (id_at(&f.app, "2020-01-01 08:00:00"), id_at(&f.app, "2020-01-01 09:00:00"));
    assert_eq!(call(&f, "POST", "vehicles/car/protect", json!({ "ids": [a, "nope"] })).unwrap(), json!({ "ok": true, "count": 1 }));
    assert!(f.app.state_of("car").unwrap().recordings.iter().find(|r| r.id == a).unwrap().protected);
    assert_eq!(call(&f, "POST", "vehicles/car/trash-preview", json!({ "ids": [a, b] })).unwrap(), json!({ "recordings": 1, "can": null }));
    let out = call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a, b] })).unwrap();
    assert_eq!(out["moved"], json!([b]));
    assert_eq!(out["skipped"], json!([{ "id": a, "reason": "protected" }]));
    assert!(f.root.join(A).exists());
    // protected on disk survives a full scan
    f.app.scan_now("car", false).unwrap();
    assert!(f.app.state_of("car").unwrap().recordings[0].protected);
    assert_eq!(call(&f, "POST", "vehicles/car/protect", json!({ "ids": [a], "protected": false })).unwrap()["count"], 1);
    assert!(!f.app.state_of("car").unwrap().recordings[0].protected);
}

#[test]
fn a_folder_swapped_for_a_link_cannot_redirect_a_move() {
    let f = fixture("swap", &[(A, b"clip")]);
    let outside = tmp("outside");
    std::fs::write(outside.join("2020-01-01_08-00-00-front.mp4"), b"NOT THE SHARE").unwrap();
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    // the folder becomes a link out of the share after the scan
    std::fs::remove_dir_all(f.root.join("TeslaCam/RecentClips")).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("TeslaCam/RecentClips")).unwrap();
    let out = bin::trash(&f.app, "car", &[a], "manual").unwrap();
    assert!(out.moved.is_empty());
    assert_eq!(out.skipped[0].reason, "error");
    assert!(out.skipped[0].message.as_deref().unwrap().starts_with("Refusing to follow a link out of the share"));
    assert_eq!(std::fs::read(outside.join("2020-01-01_08-00-00-front.mp4")).unwrap(), b"NOT THE SHARE");
    assert!(f.core.db().bin_items(Some("car")).unwrap().is_empty(), "no bin item left behind");
    let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn a_move_that_fails_half_way_is_put_back() {
    let f = fixture("putback", &[(A, b"clip"), (A2, b"clip")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    // the second file is gone since the scan
    std::fs::remove_file(f.root.join(A2)).unwrap();
    let out = bin::trash(&f.app, "car", &[a], "manual").unwrap();
    assert_eq!(out.skipped[0].reason, "missing");
    assert!(f.root.join(A).exists(), "the file that moved is back");
    assert!(!f.root.join(BIN_DIR).join("x").exists());
    assert!(f.core.db().bin_items(None).unwrap().is_empty());
}

#[test]
fn an_interrupted_move_is_settled_and_unlisted_folders_recovered() {
    let f = fixture("reconcile", &[(A, b"clip"), (A2, b"clip")]);
    let id = "mvh7aaaa-0badf00d";
    let files: Vec<BinFile> = [A, A2].iter().map(|rel| BinFile { rel: rel.to_string(), bin_rel: format!("{BIN_DIR}/{id}/{rel}.binned"), size: 4, pending: true, conflict: false }).collect();
    f.core.db().add_bin_item(&BinItem { id: id.into(), vehicle_id: "car".into(), label: "Recent".into(), category: "Recent".into(), start_at: None, bytes: 8, files: files.clone(), trashed_at: 1.0, reason: "manual".into() }).unwrap();
    // a crash after the first of two files moved
    std::fs::create_dir_all(f.root.join(&files[0].bin_rel).parent().unwrap()).unwrap();
    std::fs::rename(f.root.join(A), f.root.join(&files[0].bin_rel)).unwrap();
    // and a bin folder the database never heard of
    let orphan = format!("{BIN_DIR}/mvh7bbbb-deadbeef/{EV}.binned");
    write(&f.root, &orphan, b"clip");
    write(&f.root, &format!("{BIN_DIR}/mvh7cccc-00000000/x.txt"), b"not binned");
    // a restore of a pending item is refused
    assert_eq!(bin::restore(&f.app, id).unwrap_err().status, 409);
    assert_eq!(bin::reconcile(&f.app, "car").unwrap(), (1, 1));
    let settled = f.core.db().bin_item(id).unwrap().unwrap();
    assert_eq!(settled.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec![A]);
    assert!(!settled.files.iter().any(|f| f.pending));
    let recovered = f.core.db().bin_item("mvh7bbbb-deadbeef").unwrap().unwrap();
    assert_eq!((recovered.category.as_str(), recovered.label.as_str(), recovered.files[0].rel.as_str()), ("Sentry", "Sentry (recovered after a restart)", EV));
    assert!(!f.root.join(format!("{BIN_DIR}/mvh7cccc-00000000")).exists(), "an item folder with nothing binned goes");
    bin::restore(&f.app, id).unwrap();
    bin::restore(&f.app, "mvh7bbbb-deadbeef").unwrap();
    assert!(f.root.join(A).exists() && f.root.join(A2).exists() && f.root.join(EV).exists());
    assert!(f.core.db().bin_items(None).unwrap().is_empty());
}

#[test]
fn a_share_that_is_not_writable_refuses_bin_work() {
    let f = fixture("ro", &[(A, b"clip")]);
    // (the root as a read-only mount: the share's own check says so)
    let info = format!("1 0 0:1 / / rw - ext4 /dev/x rw\n2 1 0:2 / {} ro,relatime - ext4 /dev/y rw\n", f.root.display());
    std::fs::write(f.dir.join("mountinfo"), info).unwrap();
    let share = sentry_lean::footage::share::Share::new("ro", f.root.clone(), None, f.core.clone(), f.dir.join("mountinfo"), Box::new(|_, _| {}));
    let st = share.ensure(true);
    assert_eq!((st["readOnly"].as_bool(), st["writable"].as_bool(), st["healthy"].as_bool(), st["lastError"].is_null()), (Some(true), Some(false), Some(true), true));
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1, "nothing written to a read-only share");
}

#[test]
fn policies_preview_run_and_empty_the_bin_after_days() {
    let f = fixture("policy", &[(A, b"clip"), (B, b"clip2"), (EV, b"event")]);
    let p = call(&f, "GET", "vehicles/car/policy", json!(null)).unwrap();
    assert_eq!(p["policy"], policies::default_policy());
    assert_eq!(p["preview"], json!({ "recordings": 0, "bytes": 0, "byCategory": {}, "overLimit": 0, "ids": [] }));
    let put = call(&f, "PUT", "vehicles/car/policy", json!({ "keepDays": { "Recent": 30 }, "binDays": 10 })).unwrap();
    assert_eq!(put["preview"]["recordings"], 2);
    assert_eq!(put["preview"]["byCategory"], json!({ "Recent": { "recordings": 2, "bytes": 9 } }));
    assert_eq!(call(&f, "PUT", "vehicles/nope/policy", json!({})).unwrap_err(), (404, json!({ "error": "No such vehicle." })));
    // a run confirmed for another rule does nothing
    let refused = call(&f, "POST", "vehicles/car/policy/run", json!({ "expect": { "keepDays": { "Recent": 7 }, "binDays": 10 } })).unwrap_err();
    assert_eq!(refused, (409, json!({ "error": "The cleanup rule changed after you confirmed. Check it and run it again." })));
    assert!(f.root.join(A).exists());
    // an old item in the bin goes for good at the run; a new one stays
    let old = BinItem { id: "old-00000000".into(), vehicle_id: "car".into(), label: "old".into(), category: "Recent".into(), start_at: None, bytes: 100, files: vec![], trashed_at: 1.0, reason: "manual".into() };
    f.core.db().add_bin_item(&old).unwrap();
    let out = call(&f, "POST", "vehicles/car/policy/run", json!({ "expect": { "keepDays": { "Recent": 30, "Sentry": null }, "binDays": 10 } })).unwrap();
    assert_eq!(out["moved"].as_array().unwrap().len(), 2);
    assert!(!f.root.join(A).exists() && f.root.join(EV).exists());
    let after = policies::get(&f.app, "car").unwrap();
    assert_eq!(after["lastResult"], json!({ "moved": 2, "skipped": 0, "bytes": 9, "emptied": 1, "freed": 0 }));
    assert!(after["lastRunAt"].as_f64().unwrap() > 0.0);
    assert!(f.core.db().bin_item("old-00000000").unwrap().is_none());
    assert_eq!(f.core.db().bin_items(Some("car")).unwrap().len(), 2);
}

#[test]
fn max_gb_takes_the_oldest_unprotected_past_the_limit() {
    // (sizes as the Node test: 12 GB in four recordings, a limit of 7 GB: sparse files)
    let f = fixture("maxgb", &[]);
    let gb = 1024u64.pow(3);
    for (rel, _) in [("TeslaCam/RecentClips/2026-11-01_10-00-00-front.mp4", 0), ("TeslaCam/SentryClips/2026-11-02_10-00-00/2026-11-02_10-00-00-front.mp4", 1), ("TeslaCam/RecentClips/2026-11-03_10-00-00-front.mp4", 2), ("TeslaCam/RecentClips/2026-11-04_10-00-00-front.mp4", 3)] {
        write(&f.root, rel, b"");
        std::fs::File::options().write(true).open(f.root.join(rel)).unwrap().set_len(3 * gb).unwrap();
    }
    f.app.scan_now("car", false).unwrap();
    let sentry = id_at(&f.app, "2026-11-02 10:00:00");
    call(&f, "POST", "vehicles/car/protect", json!({ "ids": [sentry] })).unwrap();
    let out = call(&f, "PUT", "vehicles/car/policy", json!({ "maxGB": 7 })).unwrap()["preview"].clone();
    assert_eq!(out["ids"], json!([id_at(&f.app, "2026-11-01 10:00:00"), id_at(&f.app, "2026-11-03 10:00:00")]));
    assert_eq!(out["overLimit"], 2);
}

#[test]
fn trash_days_counts_and_moves_a_day() {
    let f = fixture("days", &[(A, b"clip"), (B, b"clip"), (EV, b"event")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    call(&f, "POST", "vehicles/car/protect", json!({ "ids": [a] })).unwrap();
    assert_eq!(call(&f, "POST", "vehicles/car/trash-days", json!({ "day": "2020-1-1" })).unwrap_err(), (400, json!({ "error": "Choose a day." })));
    let preview = call(&f, "POST", "vehicles/car/trash-days", json!({ "day": "2020-01-02", "through": true, "preview": true })).unwrap();
    assert_eq!(preview, json!({ "recordings": 2, "bytes": 9, "protected": 1, "days": 2, "oldest": "2020-01-01", "can": null, "started": false }));
    let one = call(&f, "POST", "vehicles/car/trash-days", json!({ "day": "2020-01-01", "category": "Sentry" })).unwrap();
    assert_eq!(one, json!({ "recordings": 0, "bytes": 0, "protected": 0, "days": 0, "oldest": null, "can": null, "started": false }));
    let started = call(&f, "POST", "vehicles/car/trash-days", json!({ "day": "2020-01-01" })).unwrap();
    assert_eq!(started["started"], true);
    wait(|| !f.root.join(B).exists());
    assert!(f.root.join(A).exists(), "the protected one stays");
}

#[test]
fn stars_protect_their_recording_until_the_last_goes() {
    let f = fixture("stars", &[(A, b"clip"), (B, b"clip")]);
    assert_eq!(call(&f, "POST", "stars", json!({ "vehicle": "car", "clip": "2020-01-01", "second": 3 })).unwrap_err(), (400, json!({ "error": "Give the clip and second to star." })));
    assert_eq!(call(&f, "POST", "stars", json!({ "vehicle": "nope" })).unwrap_err().0, 404);
    let one = call(&f, "POST", "stars", json!({ "vehicle": "car", "clip": "2020-01-01_08-00-00", "second": 12.7, "note": " hard\nbrake " })).unwrap();
    assert_eq!(one["protected"], true);
    let star = one["star"].clone();
    assert_eq!((star["second"].as_i64(), star["note"].as_str(), star["day"].as_str()), (Some(12), Some("hard brake"), Some("2020-01-01")));
    assert_eq!(star["protects"], json!(id_at(&f.app, "2020-01-01 08:00:00")));
    let two = call(&f, "POST", "stars", json!({ "vehicle": "car", "clip": "2020-01-01_08-00-00", "second": 40 })).unwrap();
    assert!(two["star"].get("protects").is_none(), "already protected");
    // a watch-only account's star protects nothing
    let viewer = Caller { admin_here: false, ..admin() };
    let three = routes::handle(&f.app, &viewer, "POST", &["stars"], &HashMap::new(), Some(&json!({ "vehicle": "car", "clip": "2020-01-01_09-00-00", "second": 1 }))).unwrap();
    let Ok(Reply::Json(three)) = three else { panic!() };
    assert_eq!(three["protected"], false);
    let list = call(&f, "GET", "stars", json!(null)).unwrap()["stars"].clone();
    assert_eq!(list.as_array().unwrap().iter().map(|s| s["second"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 40, 12]);
    let id1 = star["id"].as_str().unwrap();
    assert_eq!(call(&f, "PATCH", &format!("stars/{id1}"), json!({ "note": "x" })).unwrap()["star"]["note"], "x");
    // the protecting star goes while another star still marks a clip of the recording (index.js:
    // any star, protecting or not): it stays protected
    call(&f, "DELETE", &format!("stars/{id1}"), json!(null)).unwrap();
    assert!(f.app.state_of("car").unwrap().recordings.iter().find(|r| r.start.as_deref() == Some("2020-01-01 08:00:00")).unwrap().protected);
    let id2 = two["star"]["id"].as_str().unwrap();
    call(&f, "DELETE", &format!("stars/{id2}"), json!(null)).unwrap();
    assert_eq!(call(&f, "DELETE", &format!("stars/{id2}"), json!(null)).unwrap_err(), (404, json!({ "error": "No such starred moment." })));
}

#[test]
fn the_last_protecting_star_unprotects() {
    let f = fixture("star1", &[(A, b"clip")]);
    let one = call(&f, "POST", "stars", json!({ "vehicle": "car", "clip": "2020-01-01_08-00-00", "second": 1 })).unwrap();
    assert!(f.app.state_of("car").unwrap().recordings[0].protected);
    call(&f, "DELETE", &format!("stars/{}", one["star"]["id"].as_str().unwrap()), json!(null)).unwrap();
    assert!(!f.app.state_of("car").unwrap().recordings[0].protected);
}

#[test]
fn the_first_scan_resumes_from_the_catalog_and_still_sees_changes() {
    let f = fixture("resume", &[(A, b"clip"), (B, b"clip")]);
    // a restart: a new server state on the same catalog; files changed while down
    let catalog = Catalog::open(&f.dir.join("data/lean-catalog.sqlite")).unwrap();
    let app2 = App::new(f.app.vehicles.clone(), f.core.clone(), catalog, f.dir.clone(), Thumbnails::new(f.dir.join("data/t"), "ffmpeg".into(), 1));
    std::fs::remove_file(f.root.join(B)).unwrap();
    write(&f.root, "TeslaCam/RecentClips/2020-01-01_10-00-00-front.mp4", b"new");
    let e = app2.scan_now("car", true).unwrap();
    assert_eq!(e.light_scans, 1, "a light scan, from the catalog");
    let starts: Vec<String> = e.recordings.iter().filter_map(|r| r.start.clone()).collect();
    assert_eq!(starts, vec!["2020-01-01 10:00:00", "2020-01-01 08:00:00"]);
    // another folder for the vehicle: the catalog cannot vouch for it
    let other = Catalog::open(&f.dir.join("data/lean-catalog.sqlite")).unwrap();
    assert!(other.resume("car", "/elsewhere").unwrap().is_none());
    assert!(other.resume("car", &f.root.to_string_lossy()).unwrap().is_some());
}

#[test]
fn the_footage_check_finds_broken_clips_and_goes_on_after_a_restart() {
    let mp4 = |boxes: &[(&[u8; 4], usize)]| -> Vec<u8> {
        boxes.iter().flat_map(|(t, n)| {
            let mut b = ((n + 8) as u32).to_be_bytes().to_vec();
            b.extend_from_slice(*t);
            b.resize(n + 8, 0);
            b
        }).collect()
    };
    let good = mp4(&[(b"ftyp", 16), (b"moov", 40), (b"mdat", 100)]);
    let cut = mp4(&[(b"ftyp", 16), (b"mdat", 100), (b"moov", 40)])[..60].to_vec();
    let f = fixture("integrity", &[(A, &good), (B, &cut), ("TeslaCam/RecentClips/2020-01-01_10-00-00-front.mp4", b""), ("TeslaCam/RecentClips/2020-01-01_11-00-00-front.mp4", b"text, not a video")]);
    // it was running when the server stopped: the scan goes on with it
    f.core.db().set("integrity-running:car", &json!(true)).unwrap();
    integrity::resume(&f.app, "car");
    wait(|| integrity::status(&f.app, "car")["running"] == false && integrity::status(&f.app, "car")["total"] == 4);
    let res = call(&f, "GET", "vehicles/car/integrity", json!(null)).unwrap();
    assert_eq!((res["checked"].as_u64(), res["files"].as_u64(), res["more"].as_u64()), (Some(4), Some(4), Some(0)));
    let problems: Vec<(String, String)> = res["problems"].as_array().unwrap().iter().map(|p| (p["rel"].as_str().unwrap()[32..40].to_string(), p["problem"].as_str().unwrap().to_string())).collect();
    assert_eq!(problems, vec![
        ("11-00-00".to_string(), "not an MP4 file".to_string()),
        ("10-00-00".to_string(), "empty file".to_string()),
        ("09-00-00".to_string(), "cut off while recording (no index): it will not play".to_string()),
    ]);
    assert_eq!(f.core.db().get("integrity-running:car").unwrap(), Some(json!(false)));
    // unchanged files are not read again
    let again = call(&f, "POST", "vehicles/car/integrity", json!(null)).unwrap();
    assert_eq!(again["running"], true);
    wait(|| integrity::status(&f.app, "car")["running"] == false);
    assert_eq!(integrity::status(&f.app, "car")["total"], 0);
    assert!(f.dir.join("data/integrity/car.json").is_file());
}

#[test]
fn vehicles_routes_answer_as_node() {
    let f = fixture("vroutes", &[(A, b"clip")]);
    let list = call(&f, "GET", "vehicles", json!(null)).unwrap();
    let v = &list["vehicles"][0];
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["id", "name", "timezone", "source", "root", "studioRoot", "share", "security", "inventory", "scanning", "binBytes", "binItems", "policy", "saved", "storage", "car"]);
    assert_eq!(v["share"]["mode"], "local");
    assert_eq!(v["share"]["writable"], true);
    assert_eq!(v["car"]["source"], "default");
    assert_eq!(list["carModels"][0]["id"], "3");
    assert_eq!(v["storage"]["capped"], false);
    // a second vehicle where the first one is: refused
    let r = call(&f, "POST", "vehicles", json!({ "name": "Twin", "source": { "type": "path", "path": f.root.join("TeslaCam").to_string_lossy() } })).unwrap_err();
    assert_eq!(r.0, 400);
    // renaming is audited
    call(&f, "PUT", "vehicles/car", json!({ "name": "Car 2" })).unwrap();
    assert!(f.core.inner.audits.lock().unwrap().iter().any(|l| l == "Vehicle car renamed or time zone changed: admin from 127.0.0.1"));
    call(&f, "PUT", "vehicles/car", json!({ "car": { "model": "Y", "generation": "Y-2025" } })).unwrap();
    assert!(f.core.inner.audits.lock().unwrap().iter().any(|l| l == "Vehicle car car model: Automatic -> Model Y 2025 and later (Juniper): admin from 127.0.0.1"));
    let r = call(&f, "POST", "vehicles/car/reconnect", json!({})).unwrap();
    assert_eq!(r["share"]["healthy"], true);
    assert_eq!(call(&f, "POST", "vehicles/test-smb", json!({ "source": { "share": "nope" } })).unwrap()["stage"], "details");
    let scan = call(&f, "POST", "vehicles/car/scan", json!({})).unwrap();
    assert_eq!(scan["ok"], true);
    assert!(scan["jobId"].as_i64().is_some());
    call(&f, "DELETE", "vehicles/car", json!(null)).unwrap();
    assert!(call(&f, "GET", "vehicles", json!(null)).unwrap()["vehicles"].as_array().unwrap().is_empty());
    assert!(f.root.join(A).exists(), "its footage is untouched");
}

#[test]
fn clip_codecs_an_older_server_kept_in_its_settings_move_into_the_catalog_and_are_not_read_again() {
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/RecentClips/2026-11-10_06-00-00-back.mp4";
    let c = "TeslaCam/RecentClips/2026-11-10_06-01-00-front.mp4";
    let f = fixture("codecs-kept", &[(a, b"x"), (b, b"x"), (c, b"xy")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    // as an older server left it: no codecs in the catalog, the list in one settings value
    let read = f.app.catalog.codecs("car").unwrap();
    assert_eq!(read.len(), 3);
    f.app.catalog.update_codecs("car", &[], &read.keys().cloned().collect::<Vec<_>>()).unwrap();
    let (sa, ma, _) = read[a].clone();
    let (sb, mb, _) = read[b].clone();
    let (sc, mc, _) = read[c].clone();
    let mut kept = serde_json::Map::new();
    // (a's file is no clip, so a read would name no codec: "h265" can only come from the list)
    kept.insert(a.into(), json!([sa, ma, "h265"]));
    kept.insert(b.into(), json!([sb, mb, null]));
    kept.insert(c.into(), json!([sc + 7, mc, "h265"]));
    f.core.db().set("codecs:car", &Value::Object(kept)).unwrap();
    f.app.scan_now("car", false).unwrap();
    wait(|| !f.app.jobs.busy("codecs:car"));
    assert_eq!(f.app.catalog.codec("car", a).unwrap(), Some((sa, ma, Some("h265".into()))), "kept, not read again");
    assert_eq!(f.app.catalog.codec("car", b).unwrap(), Some((sb, mb, None)));
    assert_eq!(f.app.catalog.codec("car", c).unwrap(), Some((sc, mc, None)), "a clip whose size changed is read again");
    assert_eq!(f.app.state_of("car").unwrap().codecs.get(a), Some(Some("h265")));
    assert_eq!(f.core.db().get("codecs:car").unwrap(), None, "the settings value is moved, not kept");
}

#[test]
fn footage_a_scan_cannot_read_keeps_what_the_last_scan_saw_and_its_codecs() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let c = "TeslaCam/SentryClips/2026-11-10_08-00-00/2026-11-10_07-59-00-front.mp4";
    let f = fixture("keep-unread", &[(a, b"x"), (b, b"x"), (c, b"x")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    let codecs = f.app.catalog.codecs("car").unwrap();
    assert_eq!(codecs.len(), 3);
    let event = f.root.join("TeslaCam/SentryClips/2026-11-10_07-00-00");
    mode(&event, 0o000);
    if std::fs::read_dir(&event).is_ok() {
        // (permissions do not stop root)
        mode(&event, 0o755);
        return;
    }
    // b's event cannot be read while c's goes for real
    std::fs::remove_dir_all(f.root.join("TeslaCam/SentryClips/2026-11-10_08-00-00")).unwrap();
    f.app.scan_now("car", false).unwrap();
    wait(|| !f.app.jobs.busy("codecs:car"));
    let st = f.app.state_of("car").unwrap();
    assert!(st.file_list.contains_key(a) && st.file_list.contains_key(b), "b as the last scan saw it");
    assert!(!st.file_list.contains_key(c), "gone from a folder listed whole: gone");
    assert!(st.last_error.as_deref().is_some_and(|e| e.contains("could not be read")), "{:?}", st.last_error);
    let now = f.app.catalog.codecs("car").unwrap();
    assert_eq!((now.get(b), now.get(c)), (codecs.get(b), None), "b's codec is kept, so it is not read again");
    // the cleanup does not count footage it could not see
    let refused = policies::run(&f.app, "car", None).unwrap_err();
    assert_eq!(refused.status, 503, "{}", refused.message);
    // after a restart (a new server state on the same catalog), from the catalog
    let catalog = Catalog::open(&f.dir.join("data/lean-catalog.sqlite")).unwrap();
    let app2 = App::new(f.app.vehicles.clone(), f.core.clone(), catalog, f.dir.clone(), Thumbnails::new(f.dir.join("data/t"), "ffmpeg".into(), 1));
    let st2 = app2.scan_now("car", false).unwrap();
    assert!(st2.file_list.contains_key(a) && st2.file_list.contains_key(b) && st2.kept == 1, "b as the catalog has it");
    // the catalog cannot be read (a new server state on it, its scans table gone): nothing changes
    let catalog = Catalog::open(&f.dir.join("data/lean-catalog.sqlite")).unwrap();
    let app3 = App::new(f.app.vehicles.clone(), f.core.clone(), catalog, f.dir.clone(), Thumbnails::new(f.dir.join("data/t"), "ffmpeg".into(), 1));
    let raw = rusqlite::Connection::open(f.dir.join("data/lean-catalog.sqlite")).unwrap();
    raw.execute_batch("ALTER TABLE catalog_scans RENAME TO catalog_scans_away").unwrap();
    let blind = app3.scan_now("car", false);
    raw.execute_batch("ALTER TABLE catalog_scans_away RENAME TO catalog_scans").unwrap();
    let blind = blind.err().unwrap();
    assert!(blind.status == 503 && blind.message.contains("catalog"), "{}", blind.message);
    // asked through the route: the 503 comes back, and the inventory is announced
    f.core.inner.topics.lock().unwrap().clear();
    assert_eq!(call(&f, "POST", "vehicles/car/policy/run", json!({})).err().map(|e| e.0), Some(503));
    assert!(f.core.inner.topics.lock().unwrap().iter().any(|t| t == "inventory"));
    mode(&event, 0o755);
    // the footage on a drive mounted at TeslaCam (a scan notes where it found footage)
    let drive = f.root.join("TeslaCam");
    mounts(&f, &[(&drive, "ext4 /dev/sdb1", 17)]);
    f.app.scan_now("car", false).unwrap();
    wait(|| !f.app.jobs.busy("codecs:car"));
    let now = f.app.catalog.codecs("car").unwrap();
    // the drive not mounted, its mount point left empty: nothing changes until it is back
    let away = f.dir.join("away");
    std::fs::rename(&drive, &away).unwrap();
    std::fs::create_dir(&drive).unwrap();
    mounts(&f, &[]);
    let empty = f.app.scan_now("car", true);
    let st = f.app.state_of("car").unwrap();
    assert_eq!(empty.err().map(|e| e.status), Some(503));
    assert!(!st.scanning && st.last_error.as_deref().is_some_and(|e| e.contains("not mounted")), "{:?}", st.last_error);
    assert!(st.file_list.contains_key(a) && st.file_list.contains_key(b));
    assert_eq!(f.app.catalog.codecs("car").unwrap(), now, "the codecs stay");
    // mounted again: the scan goes on from there and the warning clears
    std::fs::remove_dir(&drive).unwrap();
    std::fs::rename(&away, &drive).unwrap();
    mounts(&f, &[(&drive, "ext4 /dev/sdb1", 17)]);
    f.app.scan_now("car", true).unwrap();
    wait(|| !f.app.jobs.busy("codecs:car"));
    let st = f.app.state_of("car").unwrap();
    assert!(st.last_error.is_none() && st.file_list.contains_key(b) && st.file_list.len() == 2);
    assert_eq!(f.app.catalog.codecs("car").unwrap(), now);
    // emptied with the drive mounted: the footage was deleted, and the scan says so
    std::fs::rename(&drive, &away).unwrap();
    std::fs::create_dir(&drive).unwrap();
    let st = f.app.scan_now("car", true).unwrap();
    assert!(st.last_error.is_none() && st.file_list.is_empty(), "{:?}", st.last_error);
}

#[test]
fn no_footage_where_some_was_is_a_drive_gone_only_when_another_mount_holds_its_folder() {
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let f = fixture("mount-gone", &[(a, b"x")]);
    let share = f.root.join("TeslaCam");
    // a share mounted there, then mounted again (another device number): the same share
    mounts(&f, &[(&share, "cifs //nas/cam", 52)]);
    f.app.scan_now("car", false).unwrap();
    mounts(&f, &[(&share, "cifs //nas/cam", 58)]);
    std::fs::remove_file(f.root.join(a)).unwrap();
    let st = f.app.scan_now("car", false).unwrap();
    assert!(st.file_list.is_empty() && st.last_error.is_none(), "deleted on the share: {:?}", st.last_error);
    // footage again, then the share not mounted (an empty folder left under its mount point):
    // nothing changes until it is back
    write(&f.root, a, b"x");
    f.app.scan_now("car", false).unwrap();
    std::fs::remove_file(f.root.join(a)).unwrap();
    mounts(&f, &[]);
    assert_eq!(f.app.scan_now("car", false).err().map(|e| e.status), Some(503));
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(a));
    // no mount table to tell: as with no note, no footage where the catalog saw some changes nothing
    std::fs::remove_file(f.dir.join("mountinfo")).unwrap();
    assert_eq!(f.app.scan_now("car", false).err().map(|e| e.status), Some(503));
    // where the footage was not noted (a server from before the notes): kept too
    mounts(&f, &[(&share, "cifs //nas/cam", 58)]);
    f.core.db().del("footageMount:car").unwrap();
    assert_eq!(f.app.scan_now("car", false).err().map(|e| e.status), Some(503));
}

#[test]
fn a_drive_mounted_below_the_footage_folder_that_is_gone_changes_nothing_until_it_is_back() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("two-mounts", &[(r, b"x"), (s, b"x")]);
    let (recent, sentry) = (f.root.join("TeslaCam/RecentClips"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&recent, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // the Sentry drive unplugged, an empty folder in its place; a new clip on the other one
    let away = f.dir.join("away");
    std::fs::rename(&sentry, &away).unwrap();
    std::fs::create_dir(&sentry).unwrap();
    let r2 = "TeslaCam/RecentClips/2026-11-10_06-01-00-front.mp4";
    write(&f.root, r2, b"x");
    mounts(&f, &[(&recent, "ext4 /dev/sdb1", 17)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("TeslaCam/SentryClips is not mounted"), "{}", gone.message);
    let st = f.app.state_of("car").unwrap();
    assert!(st.file_list.contains_key(r) && st.file_list.contains_key(s) && !st.file_list.contains_key(r2), "nothing changes until it is back");
    // plugged in again: read again
    std::fs::remove_dir(&sentry).unwrap();
    std::fs::rename(&away, &sentry).unwrap();
    mounts(&f, &[(&recent, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    let st = f.app.scan_now("car", false).unwrap();
    assert!(st.kept == 0 && st.last_error.is_none() && st.file_list.len() == 3, "{:?}", st.last_error);
}

#[test]
fn a_drive_inside_another_does_not_stand_for_it_and_one_mounted_at_another_folder_moved() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("nested-mounts", &[(r, b"x"), (s, b"x")]);
    let (outer, inner) = (f.root.join("TeslaCam"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&outer, "ext4 /dev/sdb1", 17), (&inner, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // the outer drive gone while the one mounted inside it is still there with its clip
    std::fs::remove_file(f.root.join(r)).unwrap();
    mounts(&f, &[(&inner, "ext4 /dev/sdc1", 33)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("mounted at TeslaCam is not mounted"), "{}", gone.message);
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(r));
    // both there, the inner drive mounted at SavedClips instead: moved, read where it is now
    write(&f.root, r, b"x");
    let saved = f.root.join("TeslaCam/SavedClips");
    std::fs::rename(&inner, &saved).unwrap();
    mounts(&f, &[(&outer, "ext4 /dev/sdb1", 17), (&saved, "ext4 /dev/sdc1", 33)]);
    let st = f.app.scan_now("car", false).unwrap();
    let moved = "TeslaCam/SavedClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    assert!(st.file_list.contains_key(moved) && !st.file_list.contains_key(s) && st.last_error.is_none(), "{:?}", st.last_error);
}

#[test]
fn two_mounts_that_look_the_same_are_told_apart_by_their_folders() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("same-mounts", &[(r, b"x"), (s, b"x")]);
    let (recent, sentry, outer) = (f.root.join("TeslaCam/RecentClips"), f.root.join("TeslaCam/SentryClips"), f.root.join("TeslaCam"));
    let away = f.dir.join("away");
    // one share mounted at two folders; the one at SentryClips gone: not taken for it moving
    mounts(&f, &[(&recent, "cifs //nas/cam", 52), (&sentry, "cifs //nas/cam", 53)]);
    f.app.scan_now("car", false).unwrap();
    // (a note from before the mounts seen were kept never tells a move)
    let mut note = f.core.db().get("footageMount:car").unwrap().unwrap();
    note.as_object_mut().unwrap().remove("seen");
    f.core.db().set("footageMount:car", &note).unwrap();
    std::fs::rename(&sentry, &away).unwrap();
    std::fs::create_dir(&sentry).unwrap();
    mounts(&f, &[(&recent, "cifs //nas/cam", 52)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("SentryClips is not mounted"), "{}", gone.message);
    // mounted at TeslaCam and inside it at SentryClips; the inner one gone: what holds its folder
    // looks the same, and it is still gone
    std::fs::remove_dir(&sentry).unwrap();
    std::fs::rename(&away, &sentry).unwrap();
    mounts(&f, &[(&outer, "cifs //nas/cam", 51), (&sentry, "cifs //nas/cam", 53)]);
    f.app.scan_now("car", false).unwrap();
    std::fs::rename(&sentry, &away).unwrap();
    std::fs::create_dir(&sentry).unwrap();
    mounts(&f, &[(&outer, "cifs //nas/cam", 51)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("SentryClips is not mounted"), "{}", gone.message);
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(s));
}

#[test]
fn the_footage_folder_s_drive_and_one_below_it_that_look_the_same_are_told_apart() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("root-same", &[(r, b"x"), (s, b"x")]);
    let sentry = f.root.join("TeslaCam/SentryClips");
    let both = |f: &Fixture| mounts(f, &[(&f.root, "cifs //nas/cam", 51), (&sentry, "cifs //nas/cam", 53)]);
    both(&f);
    f.app.scan_now("car", false).unwrap();
    // the lower one gone, its folder left empty: the one holding it looks the same, and it is gone
    let away = f.dir.join("away");
    std::fs::rename(&sentry, &away).unwrap();
    std::fs::create_dir(&sentry).unwrap();
    mounts(&f, &[(&f.root, "cifs //nas/cam", 51)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("SentryClips is not mounted"), "{}", gone.message);
    // back; then the footage folder's own gone (its clip with it) while the lower one stays
    std::fs::remove_dir(&sentry).unwrap();
    std::fs::rename(&away, &sentry).unwrap();
    both(&f);
    f.app.scan_now("car", false).unwrap();
    std::fs::remove_file(f.root.join(r)).unwrap();
    mounts(&f, &[(&sentry, "cifs //nas/cam", 53)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("footage folder is on is not mounted"), "{}", gone.message);
}

#[test]
fn a_drive_mounted_where_another_one_was_is_read_there() {
    let saved = "TeslaCam/SavedClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let sentry = "TeslaCam/SentryClips/2026-11-11_07-00-00/2026-11-11_06-59-00-front.mp4";
    let f = fixture("swap", &[(saved, b"x"), (sentry, b"x")]);
    let (a, b) = (f.root.join("TeslaCam/SavedClips"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&a, "ext4 /dev/sdb1", 17), (&b, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // the SentryClips drive unplugged, and the SavedClips drive mounted in its place: its footage
    // is what that folder holds now
    std::fs::rename(&b, f.dir.join("b-away")).unwrap();
    std::fs::rename(&a, &b).unwrap();
    std::fs::create_dir(&a).unwrap();
    mounts(&f, &[(&b, "ext4 /dev/sdb1", 17)]);
    let st = f.app.scan_now("car", false).unwrap();
    let now = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    assert!(st.file_list.contains_key(now) && !st.file_list.contains_key(saved) && !st.file_list.contains_key(sentry), "{:?}", st.last_error);
}

#[test]
fn a_recycle_bin_move_s_rebuild_leaves_in_a_file_back_at_its_place_and_other_sources_alone() {
    use std::os::unix::fs::PermissionsExt;
    let sv = "TeslaCam/SavedClips/2020-01-03_10-00-00/2020-01-03_09-59-00-front.mp4";
    let f = fixture("rebuild-back", &[(A, b"clip"), (B, b"clip"), (EV, b"clip"), (sv, b"clip")]);
    let key = f.root.to_string_lossy().into_owned();
    let gone: HashSet<String> = [A, B, EV, sv].iter().map(|r| r.to_string()).collect();
    // sv is in the Recycle Bin and its folder is now a link to one holding a file of its name:
    // that file is not it (the scan does not follow links either)
    let sv_dir = f.root.join(sv).parent().unwrap().to_path_buf();
    let other = f.dir.join("other-event");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join(Path::new(sv).file_name().unwrap()), b"clip").unwrap();
    std::fs::remove_dir_all(&sv_dir).unwrap();
    std::os::unix::fs::symlink(&other, &sv_dir).unwrap();
    // the run moved all three; A came back (restored while it went on), B is in the Recycle Bin,
    // and EV's folder cannot be looked at now
    std::fs::rename(f.root.join(A), f.dir.join("a-binned")).unwrap();
    std::fs::rename(f.dir.join("a-binned"), f.root.join(A)).unwrap();
    std::fs::rename(f.root.join(B), f.dir.join("b-binned")).unwrap();
    let event = f.root.join(EV).parent().unwrap().to_path_buf();
    std::fs::set_permissions(&event, std::fs::Permissions::from_mode(0o000)).unwrap();
    let shut = std::fs::read_dir(&event).is_err();
    // a move in the footage source the vehicle had before, or a state of another source: nothing
    f.app.rebuild_without("car", &gone, "/elsewhere");
    let was = f.app.state_of("car").unwrap().root;
    f.app.state.write().unwrap().get_mut("car").unwrap().root = "/elsewhere".into();
    f.app.rebuild_without("car", &gone, &key);
    f.app.state.write().unwrap().get_mut("car").unwrap().root = was;
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(B));
    f.app.rebuild_without("car", &gone, &key);
    std::fs::set_permissions(&event, std::fs::Permissions::from_mode(0o755)).unwrap();
    let st = f.app.state_of("car").unwrap();
    let catalog = f.app.catalog.previous("car").unwrap().files;
    assert!(st.file_list.contains_key(A) && catalog.contains_key(A), "back at its place: in");
    assert!(!st.file_list.contains_key(B) && !catalog.contains_key(B), "in the Recycle Bin: out");
    assert!(!st.file_list.contains_key(sv) && !catalog.contains_key(sv), "reached through a link: out");
    if shut {
        assert!(st.file_list.contains_key(EV) && catalog.contains_key(EV), "its place not to be looked at: kept");
    }
}

#[test]
fn a_drive_the_recycle_bin_took_the_last_clip_from_is_not_noted_and_may_go() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("bin-last", &[(r, b"x"), (s, b"x")]);
    let sentry = f.root.join("TeslaCam/SentryClips");
    mounts(&f, &[(&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    let id = f.app.state_of("car").unwrap().recordings.iter().find(|x| x.files().any(|(rel, _)| rel == s)).unwrap().id.clone();
    bin::trash(&f.app, "car", &[id], "trash").unwrap();
    let noted = f.core.db().get("footageMount:car").unwrap().unwrap();
    assert!(!noted["mounts"].as_array().unwrap().iter().any(|m| m["at"] == "TeslaCam/SentryClips"), "{noted}");
    // then unplugged: nothing of it is left, so the scan goes on
    mounts(&f, &[]);
    let st = f.app.scan_now("car", false).unwrap();
    assert!(st.file_list.contains_key(r) && st.last_error.is_none(), "{:?}", st.last_error);
}

#[test]
fn with_a_mount_table_it_cannot_read_a_noted_drive_s_folder_without_footage_changes_nothing() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("unread-table", &[(r, b"x"), (s, b"x")]);
    let (recent, sentry) = (f.root.join("TeslaCam/RecentClips"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&recent, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // a mount over "/" now (a table it does not read), and the Sentry drive's folder without
    // footage while the other has some: nothing changes
    let mut table = std::fs::read_to_string(f.dir.join("mountinfo")).unwrap();
    table.push_str("70 1 0:70 / / rw - tmpfs tmpfs rw\n");
    std::fs::write(f.dir.join("mountinfo"), table).unwrap();
    let away = f.dir.join("away");
    std::fs::rename(&sentry, &away).unwrap();
    std::fs::create_dir(&sentry).unwrap();
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("SentryClips is not mounted"), "{}", gone.message);
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(s));
    // its footage there again: read
    std::fs::remove_dir(&sentry).unwrap();
    std::fs::rename(&away, &sentry).unwrap();
    assert_eq!(f.app.scan_now("car", false).unwrap().file_list.len(), 2);
}

/// The fixture's mount table with a mount over "/" added: a table the server does not read.
fn unreadable_table(f: &Fixture) {
    let mut table = std::fs::read_to_string(f.dir.join("mountinfo")).unwrap();
    table.push_str("70 1 0:70 / / rw - tmpfs tmpfs rw\n");
    std::fs::write(f.dir.join("mountinfo"), table).unwrap();
}

#[test]
fn with_a_mount_table_it_cannot_read_footage_on_a_drive_mounted_deeper_does_not_stand_for_the_one_above() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("unread-nested", &[(r, b"x"), (s, b"x")]);
    let (tesla, sentry) = (f.root.join("TeslaCam"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&tesla, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // the TeslaCam drive's footage gone while the Sentry drive below it still has some: nothing changes
    unreadable_table(&f);
    let (recent, away) = (f.root.join("TeslaCam/RecentClips"), f.dir.join("away"));
    std::fs::rename(&recent, &away).unwrap();
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("mounted at TeslaCam is not mounted"), "{}", gone.message);
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(r));
    std::fs::rename(&away, &recent).unwrap();
    assert_eq!(f.app.scan_now("car", false).unwrap().file_list.len(), 2);
}

#[test]
fn with_a_mount_table_it_cannot_read_a_drive_the_recycle_bin_took_the_last_clip_from_is_not_noted_either() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("unread-bin", &[(r, b"x"), (s, b"x")]);
    let (tesla, sentry) = (f.root.join("TeslaCam"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&tesla, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // the Recycle Bin takes the TeslaCam drive's only clip (the Sentry drive below it keeps its own)
    unreadable_table(&f);
    let id = f.app.state_of("car").unwrap().recordings.iter().find(|x| x.files().any(|(rel, _)| rel == r)).unwrap().id.clone();
    bin::trash(&f.app, "car", &[id], "trash").unwrap();
    let noted = f.core.db().get("footageMount:car").unwrap().unwrap();
    let ats: Vec<&str> = noted["mounts"].as_array().unwrap().iter().filter_map(|m| m["at"].as_str()).collect();
    assert_eq!(ats, ["TeslaCam/SentryClips"], "{noted}");
    // the next scans go on
    let st = f.app.scan_now("car", false).unwrap();
    assert!(st.file_list.contains_key(s) && !st.file_list.contains_key(r) && st.last_error.is_none(), "{:?}", st.last_error);
}

#[test]
fn with_a_mount_table_it_cannot_read_a_noted_drive_whose_footage_could_only_be_kept_is_not_gone() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let r2 = "TeslaCam/RecentClips/2026-11-10_06-01-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("unread-kept", &[(r, b"x"), (s, b"x")]);
    let (recent, sentry) = (f.root.join("TeslaCam/RecentClips"), f.root.join("TeslaCam/SentryClips"));
    mounts(&f, &[(&recent, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // a table it does not read, the Sentry drive's only event cannot be read and a new clip on the
    // other drive: the scan goes on, the event kept
    unreadable_table(&f);
    let event = sentry.join("2026-11-10_07-00-00");
    mode(&event, 0o000);
    if std::fs::read_dir(&event).is_ok() {
        // (permissions do not stop root)
        mode(&event, 0o755);
        return;
    }
    write(&f.root, r2, b"x");
    let st = f.app.scan_now("car", false);
    mode(&event, 0o755);
    let st = st.unwrap();
    assert_eq!(st.kept, 1);
    assert!(st.file_list.contains_key(s) && st.file_list.contains_key(r2));
}

#[test]
fn not_noted_no_footage_found_but_some_kept_is_not_a_drive_gone() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("unread-unnoted", &[(s, b"x")]);
    // never a table it reads (nothing noted), and the only event cannot be read: kept
    unreadable_table(&f);
    f.core.db().del("footageMount:car").unwrap();
    let event = f.root.join("TeslaCam/SentryClips/2026-11-10_07-00-00");
    mode(&event, 0o000);
    if std::fs::read_dir(&event).is_ok() {
        // (permissions do not stop root)
        mode(&event, 0o755);
        return;
    }
    let st = f.app.scan_now("car", false);
    mode(&event, 0o755);
    assert_eq!(st.unwrap().kept, 1);
    assert!(f.core.db().get("footageMount:car").unwrap().is_none());
}

#[test]
fn a_mount_over_the_footage_folder_hides_the_drives_mounted_below_it() {
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("hidden", &[(s, b"x")]);
    let event = f.root.join("TeslaCam/SentryClips/2026-11-10_07-00-00");
    mounts(&f, &[(&event, "ext4 /dev/sdd1", 49)]);
    f.app.scan_now("car", false).unwrap();
    // an empty file system mounted over the footage folder after it: the event's drive is still in
    // the mount table, but no path reaches it
    let mut table = std::fs::read_to_string(f.dir.join("mountinfo")).unwrap();
    table.push_str(&format!("60 1 0:61 / {} rw - tmpfs tmpfs rw\n", f.root.display()));
    std::fs::write(f.dir.join("mountinfo"), table).unwrap();
    let away = f.dir.join("away");
    std::fs::rename(f.root.join("TeslaCam"), &away).unwrap();
    let gone = f.app.scan_now("car", false).err();
    std::fs::rename(&away, f.root.join("TeslaCam")).unwrap();
    assert_eq!(gone.map(|e| e.status), Some(503));
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(s));
}

#[test]
fn a_drive_whose_footage_could_only_be_kept_stays_noted_and_its_going_changes_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("kept-mount", &[(r, b"x"), (s, b"x")]);
    let sentry = f.root.join("TeslaCam/SentryClips");
    mounts(&f, &[(&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // its only event cannot be read: kept, and the drive stays noted
    let event = sentry.join("2026-11-10_07-00-00");
    mode(&event, 0o000);
    if std::fs::read_dir(&event).is_ok() {
        // (permissions do not stop root)
        mode(&event, 0o755);
        return;
    }
    let st = f.app.scan_now("car", false);
    mode(&event, 0o755);
    assert_eq!(st.unwrap().kept, 1);
    let noted = f.core.db().get("footageMount:car").unwrap().unwrap();
    assert!(noted["mounts"].as_array().unwrap().iter().any(|m| m["at"] == "TeslaCam/SentryClips"), "{noted}");
    // then unplugged: nothing changes
    std::fs::rename(&sentry, f.dir.join("away")).unwrap();
    std::fs::create_dir(&sentry).unwrap();
    mounts(&f, &[]);
    assert_eq!(f.app.scan_now("car", false).err().map(|e| e.status), Some(503));
    assert!(f.app.state_of("car").unwrap().file_list.contains_key(s));
}

#[test]
fn the_footage_folder_s_own_drive_gone_while_one_below_stays_and_a_mount_folder_gone_with_its_drive() {
    let r = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let s = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("root-gone", &[(r, b"x"), (s, b"x")]);
    let sentry = f.root.join("TeslaCam/SentryClips");
    mounts(&f, &[(&f.root, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    // the footage folder's drive gone (its clip with it), the one below it still there
    std::fs::remove_file(f.root.join(r)).unwrap();
    mounts(&f, &[(&sentry, "ext4 /dev/sdc1", 33)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("The drive the footage folder is on is not mounted"), "{}", gone.message);
    // both back; then the lower one gone, its folder with it
    write(&f.root, r, b"x");
    mounts(&f, &[(&f.root, "ext4 /dev/sdb1", 17), (&sentry, "ext4 /dev/sdc1", 33)]);
    f.app.scan_now("car", false).unwrap();
    std::fs::rename(&sentry, f.dir.join("away")).unwrap();
    mounts(&f, &[(&f.root, "ext4 /dev/sdb1", 17)]);
    let gone = f.app.scan_now("car", false).err().unwrap();
    assert!(gone.status == 503 && gone.message.contains("SentryClips is not mounted"), "{}", gone.message);
}

#[test]
fn a_scan_that_waited_behind_one_that_walked_before_a_restore_does_not_take_its_answer() {
    let f = fixture("restore-waiter", &[(A, b"clip")]);
    let lock = f.app.footage.scan_lock("car");
    let writing = lock.writing.lock().unwrap();
    let app = f.app.clone();
    let before = std::thread::spawn(move || app.scan_now("car", false));
    // (it walked; then a file is put back and counted, as a restore does)
    std::thread::sleep(Duration::from_millis(300));
    write(&f.root, B, b"clip");
    lock.restores.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // someone asks for a scan now: it waits behind the one that walked before the restore
    let app = f.app.clone();
    let asked = std::thread::spawn(move || app.scan_now("car", false));
    std::thread::sleep(Duration::from_millis(300));
    drop(writing);
    assert!(!before.join().unwrap().unwrap().file_list.contains_key(B), "(it walked before)");
    assert!(asked.join().unwrap().unwrap().file_list.contains_key(B), "its answer has the restored file");
}

#[test]
fn a_recycle_bin_run_skips_what_is_left_once_the_vehicle_s_footage_folder_changes() {
    let f = fixture("bin-midrun", &[(A, b"clip"), (B, b"clip")]);
    let id = f.app.state_of("car").unwrap().recordings.iter().find(|r| r.files().any(|(rel, _)| rel == B)).unwrap().id.clone();
    // the run waits for the Recycle Bin's lock; meanwhile the vehicle moves to another folder
    let held = f.app.footage.bin_lock("car");
    let guard = held.lock().unwrap();
    let app = f.app.clone();
    let run = std::thread::spawn(move || bin::trash(&app, "car", &[id], "trash"));
    std::thread::sleep(Duration::from_millis(300));
    let other = f.dir.join("footage").join("other");
    write(&other, B, b"clip");
    f.app.vehicles.update("car", &json!({ "name": "Car", "source": { "type": "path", "path": other.to_string_lossy() } })).unwrap();
    drop(guard);
    let out = run.join().unwrap().unwrap();
    assert!(out.moved.is_empty() && out.skipped.len() == 1, "nothing moved");
    assert!(other.join(B).exists() && f.root.join(B).exists());
}

#[test]
fn a_restore_while_a_scan_runs_is_followed_by_a_scan_that_walks_after_it() {
    let f = fixture("restore-midscan", &[(A, b"clip"), (B, b"clip")]);
    let id = f.app.state_of("car").unwrap().recordings.iter().find(|r| r.files().any(|(rel, _)| rel == B)).unwrap().id.clone();
    bin::trash(&f.app, "car", &[id], "trash").unwrap();
    let item = f.core.db().bin_items(Some("car")).unwrap()[0].id.clone();
    // a scan that walked before the restore waits to write
    let lock = f.app.footage.scan_lock("car");
    let writing = lock.writing.lock().unwrap();
    let app = f.app.clone();
    let before = std::thread::spawn(move || app.scan_now("car", false));
    std::thread::sleep(Duration::from_millis(300));
    let key = f.root.to_string_lossy().into_owned();
    lock.moved.lock().unwrap().extend([("/elsewhere".to_string(), B.to_string()), (key.clone(), B.to_string())]);
    bin::restore(&f.app, &item).unwrap();
    assert_eq!(lock.restores.load(std::sync::atomic::Ordering::SeqCst), 1, "the restore is counted");
    let marks = lock.moved.lock().unwrap().clone();
    assert!(marks.contains(&("/elsewhere".to_string(), B.to_string())) && !marks.contains(&(key, B.to_string())), "only its own source's mark is taken off");
    drop(writing);
    assert!(!before.join().unwrap().unwrap().file_list.contains_key(B), "(it walked before the restore)");
    wait(|| f.app.state_of("car").unwrap().file_list.contains_key(B));
}

#[test]
fn a_cleanup_that_meets_footage_it_cannot_read_is_tried_again_soon_not_tomorrow() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let f = fixture("policy-retry", &[(a, b"x"), (b, b"x")]);
    policies::set(&f.app, "car", &json!({ "enabled": true, "runAt": "00:00" })).unwrap();
    let event = f.root.join("TeslaCam/SentryClips/2026-11-10_07-00-00");
    mode(&event, 0o000);
    if std::fs::read_dir(&event).is_ok() {
        // (permissions do not stop root)
        mode(&event, 0o755);
        return;
    }
    let ran = policies::tick(&f.app, chrono::Local::now());
    mode(&event, 0o755);
    let saved = || policies::get(&f.app, "car").unwrap();
    assert!(ran && saved()["lastRunAt"].is_null(), "tried, and not the day's run");
    assert!(saved()["lastResult"]["error"].as_str().is_some_and(|e| e.contains("could not be read")), "{}", saved());
    assert!(!policies::tick(&f.app, chrono::Local::now()), "not again right away");
    // (15 minutes later)
    f.app.footage.policy_retry.lock().unwrap().clear();
    assert!(policies::tick(&f.app, chrono::Local::now()));
    assert!(saved()["lastRunAt"].is_number(), "{}", saved());
    assert!(!policies::tick(&f.app, chrono::Local::now()), "once a day");
}

#[test]
fn the_recycle_bin_moves_only_recordings_of_the_vehicle_s_footage_and_a_scan_after_it_took_all_is_empty() {
    let f = fixture("bin-source", &[(A, b"clip"), (A2, b"clip")]);
    let id = f.app.state_of("car").unwrap().recordings[0].id.clone();
    // the state still of the footage the vehicle had before (its new one not scanned yet)
    f.app.state.write().unwrap().get_mut("car").unwrap().root = "/elsewhere".into();
    assert_eq!(bin::trash(&f.app, "car", &[id], "trash").err().map(|e| e.status), Some(409));
    f.app.scan_now("car", false).unwrap();
    let id = f.app.state_of("car").unwrap().recordings[0].id.clone();
    assert_eq!(bin::trash(&f.app, "car", &[id], "trash").unwrap().moved.len(), 1);
    // all of it in the Recycle Bin: the scan finds no footage, and that is what there is
    let st = f.app.scan_now("car", false).unwrap();
    assert!(st.file_list.is_empty() && st.last_error.is_none(), "{:?}", st.last_error);
}

#[test]
fn files_the_recycle_bin_moves_while_a_scan_walks_are_not_put_back_by_it() {
    let f = fixture("moved-while-walking", &[(A, b"clip"), (B, b"clip")]);
    let lock = f.app.footage.scan_lock("car");
    let writing = lock.writing.lock().unwrap();
    let app = f.app.clone();
    let scan = std::thread::spawn(move || app.scan_now("car", false));
    // (the walk is done and the scan waits to write; the Recycle Bin moves B now)
    std::thread::sleep(Duration::from_millis(300));
    std::fs::rename(f.root.join(B), f.dir.join("b-moved")).unwrap();
    lock.moved.lock().unwrap().insert((f.root.to_string_lossy().into_owned(), B.to_string()));
    // (a mark from another source the vehicle had does not take A out)
    lock.moved.lock().unwrap().insert(("/elsewhere".to_string(), A.to_string()));
    drop(writing);
    let st = scan.join().unwrap().unwrap();
    assert!(st.file_list.contains_key(A) && !st.file_list.contains_key(B), "B is not put back");
    assert!(!f.app.catalog.previous("car").unwrap().files.contains_key(B));
}

#[test]
fn a_vehicle_moved_to_another_footage_folder_keeps_nothing_of_the_old_one() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/SentryClips/2026-11-10_07-00-00/2026-11-10_06-59-00-front.mp4";
    let c = "TeslaCam/RecentClips/2026-11-11_06-00-00-front.mp4";
    let f = fixture("keep-unread-moved", &[(a, b"x"), (b, b"x")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    // the new folder has the same event, unreadable there
    let other = f.dir.join("footage").join("other");
    write(&other, c, b"x");
    write(&other, b, b"x");
    let shut = other.join("TeslaCam/SentryClips/2026-11-10_07-00-00");
    mode(&shut, 0o000);
    if std::fs::read_dir(&shut).is_ok() {
        // (permissions do not stop root)
        mode(&shut, 0o755);
        return;
    }
    f.app.vehicles.update("car", &json!({ "name": "Car", "source": { "type": "path", "path": other.to_string_lossy() } })).unwrap();
    wait(|| f.app.vehicles.share("car").is_some_and(|s| s.is_healthy()));
    let st = f.app.scan_now("car", false);
    mode(&shut, 0o755);
    let st = st.unwrap();
    assert!(st.file_list.contains_key(c), "the new folder's own clip");
    assert!(!st.file_list.contains_key(a) && !st.file_list.contains_key(b), "nothing of the old folder, not even where the new one could not be read");
}

#[test]
fn a_scan_that_waited_behind_one_of_the_old_footage_folder_reads_the_new_one() {
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let c = "TeslaCam/RecentClips/2026-11-11_06-00-00-front.mp4";
    let f = fixture("waiter-moved", &[(a, b"x")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    let other = f.dir.join("footage").join("other");
    write(&other, c, b"x");
    // a scan of the old folder is running: the vehicle moves, and a scan of the new one waits for it
    let lock = f.app.footage.scan_lock("car");
    let running = lock.running.lock().unwrap();
    f.app.vehicles.update("car", &json!({ "name": "Car", "source": { "type": "path", "path": other.to_string_lossy() } })).unwrap();
    wait(|| f.app.vehicles.share("car").is_some_and(|s| s.is_healthy()));
    let app = f.app.clone();
    let waiter = std::thread::spawn(move || app.scan_now("car", false));
    std::thread::sleep(std::time::Duration::from_millis(300));
    // (the old folder's scan ends: what it left is the old folder's)
    lock.done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    drop(running);
    let st = waiter.join().unwrap().unwrap();
    assert!(st.file_list.contains_key(c) && !st.file_list.contains_key(a), "the new folder's clips, not the old one's");
    // one that waited behind a scan of this folder that saw nothing gets that answer
    let running = lock.running.lock().unwrap();
    let app = f.app.clone();
    let waiter = std::thread::spawn(move || app.scan_now("car", false));
    std::thread::sleep(std::time::Duration::from_millis(300));
    *lock.failed.lock().unwrap() = Some((other.to_string_lossy().into_owned(), Fail::new(503, "not this time")));
    lock.done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    drop(running);
    assert_eq!(waiter.join().unwrap().err().map(|e| e.message), Some("not this time".to_string()));
    // one that walks itself (after a restore) does not take that answer
    let running = lock.running.lock().unwrap();
    let app = f.app.clone();
    let fresh = std::thread::spawn(move || app.scan_fresh("car", false));
    std::thread::sleep(std::time::Duration::from_millis(300));
    *lock.failed.lock().unwrap() = Some((other.to_string_lossy().into_owned(), Fail::new(503, "not this time")));
    lock.done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    drop(running);
    assert!(fresh.join().unwrap().unwrap().file_list.contains_key(c));
}

#[test]
fn a_kept_codec_list_beside_codecs_the_catalog_has_only_fills_in_what_it_lacks() {
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/RecentClips/2026-11-10_06-01-00-front.mp4";
    let f = fixture("codecs-kept-partial", &[(a, b"x"), (b, b"x")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    // as a move cut short left it: a in the catalog, b only in the kept list
    let (sa, ma, codec_a) = f.app.catalog.codec("car", a).unwrap().unwrap();
    let (sb, mb, _) = f.app.catalog.codec("car", b).unwrap().unwrap();
    f.app.catalog.update_codecs("car", &[], &[b.to_string()]).unwrap();
    let mut kept = serde_json::Map::new();
    kept.insert(a.into(), json!([sa, ma, "h265"]));
    kept.insert(b.into(), json!([sb, mb, "h265"]));
    f.core.db().set("codecs:car", &Value::Object(kept)).unwrap();
    f.app.scan_now("car", false).unwrap();
    wait(|| !f.app.jobs.busy("codecs:car"));
    assert_eq!(f.app.catalog.codec("car", a).unwrap(), Some((sa, ma, codec_a)), "the catalog's own row is kept");
    assert_eq!(f.app.catalog.codec("car", b).unwrap(), Some((sb, mb, Some("h265".into()))), "the missing row comes from the list, not a read");
    assert_eq!(f.core.db().get("codecs:car").unwrap(), None);
}

#[test]
fn a_codec_probe_waiting_through_a_newer_scan_works_on_the_newer_list() {
    use sentry_lean::jobs::Priority;
    use std::sync::Condvar;
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/RecentClips/2026-11-10_06-01-00-front.mp4";
    let f = fixture("codec-probe", &[(a, b"x")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    // b's codec saved earlier (b was there, went, and comes back unchanged)
    let when = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    f.app.catalog.update_codecs("car", &[(b.to_string(), 1, 1_700_000_000_000.0, Some("h265".into()))], &[]).unwrap();
    // every job worker held, so the probe queued after the next scan waits
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    for i in 0..8 {
        let g = gate.clone();
        f.app.jobs.submit(format!("hold:{i}"), Priority::High, move || {
            let (open, cv) = &*g;
            let mut o = open.lock().unwrap();
            while !*o {
                o = cv.wait(o).unwrap();
            }
        });
    }
    f.app.scan_now("car", false).unwrap();
    assert!(f.app.jobs.busy("codecs:car"));
    write(&f.root, b, b"x");
    std::fs::File::options().write(true).open(f.root.join(b)).unwrap().set_modified(when).unwrap();
    f.app.scan_now("car", false).unwrap();
    {
        let (open, cv) = &*gate;
        *open.lock().unwrap() = true;
        cv.notify_all();
    }
    wait(|| (0..8).all(|i| !f.app.jobs.busy(&format!("hold:{i}"))) && !f.app.jobs.busy("codecs:car"));
    assert!(f.app.catalog.codec("car", b).unwrap().is_some(), "the newer list's clip kept its saved codec");
    assert_eq!(f.app.state_of("car").unwrap().codecs.get(b), Some(Some("h265")));
}

#[test]
fn a_codec_row_forgotten_for_an_older_list_comes_back_when_the_newer_list_holds_the_clip() {
    use sentry_lean::jobs::Priority;
    use sentry_lean::scanner::FileEntry;
    use std::sync::Condvar;
    let a = "TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4";
    let b = "TeslaCam/RecentClips/2026-11-10_06-01-00-front.mp4";
    let f = fixture("codec-forget", &[(a, b"x")]);
    wait(|| !f.app.jobs.busy("codecs:car"));
    f.app.catalog.update_codecs("car", &[(b.to_string(), 1, 1_700_000_000_000.0, Some("h265".into()))], &[]).unwrap();
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    for i in 0..8 {
        let g = gate.clone();
        f.app.jobs.submit(format!("hold:{i}"), Priority::High, move || {
            let (open, cv) = &*g;
            let mut o = open.lock().unwrap();
            while !*o {
                o = cv.wait(o).unwrap();
            }
        });
    }
    f.app.scan_now("car", false).unwrap();
    // the catalog held, so the probe (b gone from its list) stops at forgetting b
    let db = rusqlite::Connection::open(f.dir.join("data/lean-catalog.sqlite")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    {
        let (open, cv) = &*gate;
        *open.lock().unwrap() = true;
        cv.notify_all();
    }
    std::thread::sleep(Duration::from_millis(800));
    // meanwhile a newer list with b (as the Recycle Bin's restore leaves it) is put in place
    let mut files: Vec<FileEntry> = f.app.state_of("car").unwrap().file_list.to_vec();
    let c = sentry_lean::footage::classify(b).unwrap();
    files.push(FileEntry { rel: b.into(), size: 1, mtime_ms: 1_700_000_000_000.0, ctime_ms: 0.0, birthtime_ms: 0.0, kind: c.kind, typ: c.typ, day: "2026-11-10".into(), camera: c.camera, event_id: c.event_id });
    let app = f.app.clone();
    let rebuild = std::thread::spawn(move || app.rebuild("car", Some(files)));
    wait(|| f.app.state_of("car").unwrap().file_list.contains_key(b));
    db.execute_batch("COMMIT").unwrap();
    rebuild.join().unwrap();
    wait(|| (0..8).all(|i| !f.app.jobs.busy(&format!("hold:{i}"))) && !f.app.jobs.busy("codecs:car"));
    assert!(f.app.catalog.codec("car", b).unwrap().is_some(), "b's saved codec is back");
    assert_eq!(f.app.state_of("car").unwrap().codecs.get(b), Some(Some("h265")));
}

/// manager.db as a failing disk leaves it: `sql` (a trigger that refuses a write, a table read
/// through a view of one that is gone) run on a connection of its own.
fn manager_db(f: &Fixture, sql: &str) {
    rusqlite::Connection::open(f.dir.join("data/manager.db")).unwrap().execute_batch(sql).unwrap();
}

/// Reads (and writes) of `table` fail until `mend_in_db`.
fn unreadable_in_db(f: &Fixture, table: &str) {
    manager_db(f, &format!("CREATE TABLE gone (x); ALTER TABLE {table} RENAME TO {table}_kept; CREATE VIEW {table} AS SELECT * FROM gone; DROP TABLE gone;"));
}

fn mend_in_db(f: &Fixture, table: &str) {
    manager_db(f, &format!("DROP VIEW {table}; ALTER TABLE {table}_kept RENAME TO {table};"));
}

fn internal() -> (u16, Value) {
    (500, json!({ "error": "Internal error" }))
}

#[test]
fn a_recycle_bin_move_whose_protected_clips_cannot_be_read_moves_nothing_and_answers_500() {
    let f = fixture("bin-unread", &[(A, b"clip"), (B, b"clip")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    unreadable_in_db(&f, "protected");
    assert_eq!(call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a] })).unwrap_err(), internal());
    assert!(f.root.join(A).exists(), "nothing moved");
    assert!(f.core.db().bin_items(None).unwrap().is_empty());
    assert_eq!(f.core.jobs.lock().unwrap().last().unwrap().0, "failed");
}

#[test]
fn a_recycle_bin_move_whose_item_cannot_be_kept_moves_nothing_and_one_not_settled_stays_listed_as_moving() {
    let f = fixture("bin-unkept", &[(A, b"clip"), (B, b"clip")]);
    let (a, b) = (id_at(&f.app, "2020-01-01 08:00:00"), id_at(&f.app, "2020-01-01 09:00:00"));
    manager_db(&f, "CREATE TRIGGER refused BEFORE INSERT ON bin_items BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    assert_eq!(call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a.clone(), b.clone()] })).unwrap_err(), internal());
    assert!(f.root.join(A).exists() && f.root.join(B).exists(), "nothing moves without its item");
    // the files moved and their item was not settled: a 500, the run stops there, the item stays
    // listed as still moving, and a restart's settling lists what is in the bin
    manager_db(&f, "DROP TRIGGER refused; CREATE TRIGGER refused BEFORE UPDATE ON bin_items BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    assert_eq!(call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a.clone(), b.clone()] })).unwrap_err(), internal());
    assert_eq!([A, B].iter().filter(|r| f.root.join(r).exists()).count(), 1, "stopped after the first");
    let items = f.core.db().bin_items(None).unwrap();
    assert!(items.len() == 1 && items[0].files.iter().all(|x| x.pending));
    let moved = if f.root.join(A).exists() { b } else { a };
    assert!(!ids(&f.app).iter().any(|(i, _)| *i == moved), "the inventory follows what moved");
    manager_db(&f, "DROP TRIGGER refused;");
    assert_eq!(bin::reconcile(&f.app, "car").unwrap(), (1, 0));
    assert!(!f.core.db().bin_items(None).unwrap()[0].files.iter().any(|x| x.pending));
}

#[test]
fn a_restore_whose_bin_list_cannot_be_written_answers_500_with_the_files_back() {
    let f = fixture("restore-unkept", &[(A, b"clip"), (B, b"clip")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a] })).unwrap();
    let id = f.core.db().bin_items(None).unwrap()[0].id.clone();
    manager_db(&f, "CREATE TRIGGER refused BEFORE DELETE ON bin_items BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    assert_eq!(call(&f, "POST", &format!("bin/{id}/restore"), json!({})).unwrap_err(), internal());
    assert!(f.root.join(A).exists(), "the files are back");
    assert_eq!(f.core.db().bin_items(None).unwrap().len(), 1, "listed until it can be written");
}

#[test]
fn emptying_the_bin_stops_at_the_first_item_whose_removal_cannot_be_written() {
    let f = fixture("empty-unkept", &[(A, b"clip"), (B, b"clip")]);
    let (a, b) = (id_at(&f.app, "2020-01-01 08:00:00"), id_at(&f.app, "2020-01-01 09:00:00"));
    call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a, b] })).unwrap();
    manager_db(&f, "CREATE TRIGGER refused BEFORE DELETE ON bin_items BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    assert_eq!(call(&f, "POST", "bin/empty", json!({ "confirm": true })).unwrap_err(), internal());
    let folders = std::fs::read_dir(f.root.join(BIN_DIR)).unwrap().filter(|e| e.as_ref().unwrap().file_type().unwrap().is_dir()).count();
    assert_eq!(folders, 1, "the second item stays, files and all");
    assert_eq!(f.core.db().bin_items(None).unwrap().len(), 2);
    assert_eq!(f.core.jobs.lock().unwrap().last().unwrap().0, "failed");
}

#[test]
fn a_recycle_bin_vehicle_or_star_list_that_cannot_be_read_answers_500_not_an_empty_one() {
    let f = fixture("lists-unread", &[(A, b"clip")]);
    unreadable_in_db(&f, "bin_items");
    assert_eq!(call(&f, "GET", "bin", json!(null)).unwrap_err(), internal());
    assert_eq!(call(&f, "GET", "vehicles", json!(null)).unwrap_err(), internal(), "a vehicle's bin numbers");
    mend_in_db(&f, "bin_items");
    unreadable_in_db(&f, "settings");
    assert_eq!(call(&f, "GET", "vehicles", json!(null)).unwrap_err(), internal());
    assert_eq!(call(&f, "GET", "vehicles/car/policy", json!(null)).unwrap_err(), internal(), "not \"no such vehicle\"");
    assert_eq!(call(&f, "GET", "stars", json!(null)).unwrap_err(), internal());
    mend_in_db(&f, "settings");
    assert_eq!(call(&f, "GET", "vehicles", json!(null)).unwrap()["vehicles"].as_array().unwrap().len(), 1);
}

#[test]
fn what_the_can_area_cannot_read_is_a_500_for_the_vehicle_list_and_a_recycle_bin_preview() {
    let f = fixture("can-unread", &[(A, b"clip")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    f.core.can_unread.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(call(&f, "GET", "vehicles", json!(null)).unwrap_err(), internal(), "not a car without its summary");
    assert_eq!(call(&f, "POST", "vehicles/car/trash-preview", json!({ "ids": [a] })).unwrap_err(), internal());
    assert_eq!(call(&f, "POST", "vehicles/car/trash-days", json!({ "day": "2020-01-01", "preview": true })).unwrap_err(), internal());
}

#[test]
fn protected_clips_that_cannot_be_read_change_no_scan_and_a_rebuild_keeps_the_protection() {
    let f = fixture("protect-unread", &[(A, b"clip"), (B, b"clip")]);
    let a = id_at(&f.app, "2020-01-01 08:00:00");
    call(&f, "POST", "vehicles/car/protect", json!({ "ids": [a] })).unwrap();
    let protected = |f: &Fixture| f.app.state_of("car").unwrap().recordings.iter().find(|r| r.id == a).is_some_and(|r| r.protected);
    write(&f.root, "TeslaCam/RecentClips/2020-01-01_10-00-00-front.mp4", b"new");
    unreadable_in_db(&f, "protected");
    assert_eq!(f.app.scan_now("car", false).err().map(|e| e.status), Some(503));
    assert_eq!(ids(&f.app).len(), 2, "nothing changes until they can be read");
    assert!(protected(&f));
    f.app.rebuild("car", None);
    assert!(protected(&f), "a rebuild keeps the protection it had");
    mend_in_db(&f, "protected");
    f.app.scan_now("car", false).unwrap();
    assert_eq!(ids(&f.app).len(), 3);
    assert!(protected(&f));
}

#[test]
fn days_and_recordings_answer_500_when_their_can_tags_or_the_vehicles_cannot_be_read() {
    let f = fixture("slice-unread", &[(A, b"clip")]);
    let get = |path: &str| sentry_lean::api::slice_route(&f.app, &axum::http::Method::GET, path, &HashMap::new(), &axum::http::HeaderMap::new()).unwrap().status().as_u16();
    assert_eq!((get("/api/vehicles/car/days"), get("/api/vehicles/car/recordings"), get("/api/vehicles/nope/days")), (200, 200, 404));
    f.core.can_unread.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(get("/api/vehicles/car/days"), 500, "not days without their CAN tags");
    assert_eq!(get("/api/vehicles/car/recordings"), 500);
    f.core.can_unread.store(false, std::sync::atomic::Ordering::SeqCst);
    unreadable_in_db(&f, "settings");
    assert_eq!(get("/api/vehicles/car/days"), 500, "not \"no such vehicle\"");
}

#[test]
fn a_policy_save_restore_or_deletion_whose_vehicle_list_cannot_be_read_answers_500_not_no_such_vehicle() {
    let f = fixture("vehicles-unread", &[(A, b"clip"), (B, b"clip")]);
    let (a, b) = (id_at(&f.app, "2020-01-01 08:00:00"), id_at(&f.app, "2020-01-01 09:00:00"));
    call(&f, "POST", "vehicles/car/trash", json!({ "ids": [a, b] })).unwrap();
    let items: Vec<String> = f.core.db().bin_items(None).unwrap().into_iter().map(|i| i.id).collect();
    unreadable_in_db(&f, "settings");
    assert_eq!(call(&f, "PUT", "vehicles/car/policy", json!({ "enabled": true })).unwrap_err(), internal());
    assert_eq!(call(&f, "POST", &format!("bin/{}/restore", items[0]), json!({})).unwrap_err(), internal());
    assert_eq!(call(&f, "POST", &format!("bin/{}/delete", items[1]), json!({ "confirm": true })).unwrap_err(), internal());
    mend_in_db(&f, "settings");
    assert_eq!(f.core.db().bin_items(None).unwrap().len(), 2, "both stay in the bin, files and all");
    assert!(!f.root.join(A).exists() && !f.root.join(B).exists());
}

#[test]
fn a_recycle_bin_run_whose_vehicle_cannot_be_read_again_moves_nothing_and_is_an_error_not_a_skip() {
    let f = fixture("bin-midrun-unread", &[(A, b"clip"), (B, b"clip")]);
    let id = id_at(&f.app, "2020-01-01 09:00:00");
    // the run waits for the Recycle Bin's lock; meanwhile manager.db stops giving the vehicles
    let held = f.app.footage.bin_lock("car");
    let guard = held.lock().unwrap();
    let app = f.app.clone();
    let run = std::thread::spawn(move || bin::trash(&app, "car", &[id], "trash"));
    std::thread::sleep(Duration::from_millis(300));
    unreadable_in_db(&f, "settings");
    drop(guard);
    assert_eq!(run.join().unwrap().err().map(|e| e.status), Some(0));
    mend_in_db(&f, "settings");
    assert!(f.root.join(B).exists(), "nothing moved");
    assert!(f.core.db().bin_items(None).unwrap().is_empty());
}

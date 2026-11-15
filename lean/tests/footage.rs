//! The footage area on generated archives (ports of test/security.test.js's
//! Recycle Bin tests, binAutoEmpty.test.js, catalogResume.test.js,
//! catalog.test.js's "files moved without a scan", lightRescan.test.js,
//! integrity.test.js and the stars and protect routes of server.test.js).
//! Everything here writes only inside its own temporary folder.

use sentry_lean::app::App;
use sentry_lean::catalog::Catalog;
use sentry_lean::footage::bin::{self, BIN_DIR};
use sentry_lean::footage::ctx::{Caller, Ctx, Level, LocalCore};
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
    fn job_start(&self, typ: &str, vid: Option<&str>, title: &str) -> i64 {
        self.inner.job_start(typ, vid, title)
    }
    fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<Value>) {
        self.jobs.lock().unwrap().push((status.into(), detail.into()));
        self.inner.job_finish(id, status, detail, result)
    }
    fn busy_paths(&self) -> HashSet<PathBuf> {
        self.busy.lock().unwrap().clone()
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
    let core = Arc::new(TestCore { inner: LocalCore::open(&data).unwrap(), busy: Mutex::new(HashSet::new()), jobs: Mutex::new(Vec::new()) });
    let vehicles = Vehicles::new(core.clone(), Options { footage_root: footage.clone(), folder_roots: vec![footage.clone()], protected_dirs: vec![data.clone()], mountinfo: dir.join("no-mountinfo"), default_tz: None });
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
    let left = f.core.db().bin_item(&id).unwrap();
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
    assert_eq!(f.core.db().get("deleted-clips:car"), None);
    assert!(f.core.inner.audits.lock().unwrap().iter().any(|l| l == "Deleted forever from the Recycle Bin: Recent 2020-01-01 08:00:00 (5 B): admin from 127.0.0.1"));

    // an event with its thumbnail: the bin shows the picture
    let ev = id_at(&f.app, "2020-01-02 12:29:00");
    call(&f, "POST", "vehicles/car/trash", json!({ "ids": [ev] })).unwrap();
    let item = f.core.db().bin_items(Some("car"))[0].clone();
    let thumb = call(&f, "GET", &format!("bin/{}/thumbnail", item.id), json!(null)).unwrap();
    assert!(thumb["file"].as_str().unwrap().ends_with("thumb.png.binned"));
    assert!(!f.root.join("TeslaCam/SentryClips/2020-01-02_12-30-00").exists(), "the emptied event folder goes");
    assert!(f.root.join("TeslaCam/SentryClips").is_dir(), "the clip folder stays");
    // empty the bin
    assert_eq!(call(&f, "POST", "bin/empty", json!({ "confirm": true, "vehicle": "nope" })).unwrap_err().0, 404);
    assert_eq!(call(&f, "POST", "bin/empty", json!({ "confirm": true })).unwrap(), json!({ "deleted": 1, "failed": 0, "bytes": 8 }));
    assert_eq!(f.core.db().bin_items(None).len(), 0);
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
    assert!(f.core.db().bin_items(Some("car")).is_empty(), "no bin item left behind");
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
    assert!(f.core.db().bin_items(None).is_empty());
}

#[test]
fn an_interrupted_move_is_settled_and_unlisted_folders_recovered() {
    let f = fixture("reconcile", &[(A, b"clip"), (A2, b"clip")]);
    let id = "mvh7aaaa-0badf00d";
    let files: Vec<BinFile> = [A, A2].iter().map(|rel| BinFile { rel: rel.to_string(), bin_rel: format!("{BIN_DIR}/{id}/{rel}.binned"), size: 4, pending: true, conflict: false }).collect();
    f.core.db().add_bin_item(&BinItem { id: id.into(), vehicle_id: "car".into(), label: "Recent".into(), category: "Recent".into(), start_at: None, bytes: 8, files: files.clone(), trashed_at: 1.0, reason: "manual".into() });
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
    let settled = f.core.db().bin_item(id).unwrap();
    assert_eq!(settled.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec![A]);
    assert!(!settled.files.iter().any(|f| f.pending));
    let recovered = f.core.db().bin_item("mvh7bbbb-deadbeef").unwrap();
    assert_eq!((recovered.category.as_str(), recovered.label.as_str(), recovered.files[0].rel.as_str()), ("Sentry", "Sentry (recovered after a restart)", EV));
    assert!(!f.root.join(format!("{BIN_DIR}/mvh7cccc-00000000")).exists(), "an item folder with nothing binned goes");
    bin::restore(&f.app, id).unwrap();
    bin::restore(&f.app, "mvh7bbbb-deadbeef").unwrap();
    assert!(f.root.join(A).exists() && f.root.join(A2).exists() && f.root.join(EV).exists());
    assert!(f.core.db().bin_items(None).is_empty());
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
    f.core.db().add_bin_item(&old);
    let out = call(&f, "POST", "vehicles/car/policy/run", json!({ "expect": { "keepDays": { "Recent": 30, "Sentry": null }, "binDays": 10 } })).unwrap();
    assert_eq!(out["moved"].as_array().unwrap().len(), 2);
    assert!(!f.root.join(A).exists() && f.root.join(EV).exists());
    let after = policies::get(&f.app, "car");
    assert_eq!(after["lastResult"], json!({ "moved": 2, "skipped": 0, "bytes": 9, "emptied": 1, "freed": 0 }));
    assert!(after["lastRunAt"].as_f64().unwrap() > 0.0);
    assert!(f.core.db().bin_item("old-00000000").is_none());
    assert_eq!(f.core.db().bin_items(Some("car")).len(), 2);
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
    f.core.db().set("integrity-running:car", &json!(true));
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
    assert_eq!(f.core.db().get("integrity-running:car"), Some(json!(false)));
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

//! CAN logs deleted here on purpose are not sent again (the owner's rule): each leaves a
//! tombstone, `status` answers it as delivered (the owner's deletes and the rules that hold for
//! good: always; the others while it is older than all the footage its car keeps, else
//! missing), a copy sent again is checked and dropped again, logs deleted before
//! this server kept tombstones get theirs from trust.json, and logs from before the checks are
//! judged in the background. Also: no stored file is hashed before `100 Continue`.

use p256::ecdsa::{signature::Signer, Signature, SigningKey};

use sentry_lean::can::ctx::{CanCtx, Car, FootFile, Scan};
use sentry_lean::can::json::stringify;
use sentry_lean::can::logs::{CanLogs, Kept};
use sentry_lean::can::routes::Can;
use sentry_lean::can::trust::{base64, fingerprint_of, signed_message, CanTrust};
use sentry_lean::can::{tz, util};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const KEY: &str = "abcdef123456";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!("can-deleted-{}-{}-{}", std::process::id(), tag, N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
/// A log of 2026-11-08 at 14:mm (UTC).
fn nm(i: usize) -> String {
    format!("{}_20261108T14{:02}00Z_{}.log.xz", KEY, i, i + 1)
}
fn at(i: usize) -> f64 {
    tz::utc_ms(2026, 11, 8, 14, i as i64, 0) as f64
}
fn side(name: &str) -> String {
    format!("{}.json", name)
}

struct Bridge {
    sk: SigningKey,
    der: Vec<u8>,
    index: u64,
    prev: (String, String),
    /// the sidecar's end_wall_ms for the next log (None: not written)
    end: Option<f64>,
}

impl Bridge {
    fn new(seed: u8) -> Bridge {
        let mut bytes = [seed; 32];
        bytes[0] = 1;
        let sk = SigningKey::from_bytes(&bytes.into()).unwrap();
        let mut der = vec![0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00];
        der.extend_from_slice(sk.verifying_key().to_encoded_point(false).as_bytes());
        Bridge { sk, der, index: 0, prev: ("-".into(), ZERO.into()), end: None }
    }
    /// The log and its signed sidecar, as the bridge writes them (into `dir`/KEY).
    fn log(&mut self, dir: &Path, name: &str, body: &[u8]) -> (Vec<u8>, Vec<u8>) {
        std::fs::create_dir_all(dir.join(KEY)).unwrap();
        let sha = util::sha256_hex(body);
        let msg = signed_message(KEY, name, &sha, body.len() as f64, self.index as f64, &self.prev.0, &self.prev.1);
        let sig: Signature = self.sk.sign(msg.as_bytes());
        let integrity = json!({
            "signed": true, "version": "canbridge-log-sig-v1", "algorithm": "ECDSA-P256-SHA256", "public_key": base64(&self.der), "key_fingerprint": fingerprint_of(&self.der),
            "vehicle_key": KEY, "sha256": sha, "length": body.len(), "index": self.index, "prev_name": self.prev.0, "prev_sha256": self.prev.1,
            "signature": base64(sig.to_der().as_bytes())
        });
        let mut sidecar = json!({ "format": "canbridge-candump-xz/1", "frames": 10, "integrity": integrity });
        if let Some(e) = self.end.take() {
            sidecar["end_wall_ms"] = json!(e);
        }
        let side_bytes = stringify(&sidecar).into_bytes();
        std::fs::write(dir.join(KEY).join(name), body).unwrap();
        std::fs::write(dir.join(KEY).join(side(name)), &side_bytes).unwrap();
        self.prev = (name.to_string(), sha);
        self.index += 1;
        (body.to_vec(), side_bytes)
    }
}

fn send(logs: &CanLogs, name: &str, body: &[u8]) -> Result<Value, sentry_lean::can::logs::CanError> {
    logs.receive(name, body, 0.0, body.len() as f64, &util::sha256_hex(body))
}
fn ask(logs: &CanLogs, names: &[String]) -> Value {
    logs.status(Some(&json!(names)), Some(KEY)).unwrap()["files"].clone()
}

/// CanLogs and CanTrust with a footage answer the test sets.
fn checked(dir: &Path) -> (Arc<CanLogs>, Arc<CanTrust>, Arc<Mutex<Kept>>) {
    let logs = CanLogs::new(dir.to_path_buf(), Box::new(|| f64::INFINITY), Box::new(util::now_ms));
    let trust = CanTrust::new(dir.to_path_buf(), Box::new(util::now_ms));
    logs.set_trust(trust.clone());
    let kept = Arc::new(Mutex::new(Kept::Nothing));
    let k = kept.clone();
    logs.set_footage(Box::new(move |_| *k.lock().unwrap()));
    (logs, trust, kept)
}

// ---- A. nothing hashed before 100 Continue

#[test]
fn precheck_never_hashes_a_stored_file_its_decision_waits_for_the_body() {
    let dir = tmp("precheck");
    let (logs, _, _) = checked(&dir);
    let body = b"a log all here";
    let sha = util::sha256_hex(body);
    send(&logs, &nm(0), body).unwrap();
    let len = body.len() as f64;
    // the same file, and another copy: both need the stored file's hash, so both read the body
    assert_eq!(logs.precheck(&nm(0), Some(body.len() as u64), 0.0, len, &sha).unwrap(), None);
    assert_eq!(logs.precheck(&nm(0), Some(body.len() as u64), 0.0, len, &util::sha256_hex(b"another copy!!")).unwrap(), None);
    assert_eq!(logs.precheck(&nm(0), Some(3), 0.0, 3.0, &util::sha256_hex(b"abc")).unwrap(), None, "another length too");
    // then the body decides as before
    assert_eq!(send(&logs, &nm(0), body).unwrap()["already"], true);
    assert_eq!(send(&logs, &nm(0), b"another copy!!").unwrap_err().code, "exists_different");
    // checks with no hashing still answer at once
    assert_eq!(logs.precheck(&nm(1), Some(5), 4.0, 9.0, &sha).unwrap_err().code, "offset_mismatch");
    assert_eq!(logs.precheck(&nm(1), Some(12), 0.0, 9.0, &sha).unwrap_err().code, "past_end");
}

// ---- B. tombstones and status

#[test]
fn a_deleted_log_leaves_a_tombstone_and_answers_as_delivered_while_older_than_the_footage() {
    let src = tmp("tomb-bridge");
    let dir = tmp("tomb");
    let (logs, t, kept) = checked(&dir);
    let mut b = Bridge::new(41);
    let (l0, s0) = b.log(&src, &nm(0), b"log zero, verified");
    send(&logs, &nm(0), &l0).unwrap();
    send(&logs, &side(&nm(0)), &s0).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "verified");
    logs.delete_log(&nm(0), "owner").unwrap();
    assert!(!dir.join(KEY).join(nm(0)).exists() && !dir.join(KEY).join(side(&nm(0))).exists());
    let tomb = t.tomb(KEY, &nm(0)).expect("a tombstone");
    assert_eq!((tomb["size"].as_f64(), tomb["side"].as_f64()), (Some(l0.len() as f64), Some(s0.len() as f64)));
    assert_eq!(tomb["sha256"], json!(util::sha256_hex(&l0)));
    assert_eq!((tomb["check"].as_str(), tomb["why"].as_str()), (Some("verified"), Some("owner")));
    // (its sidecar has no end: the longest a log runs, ten minutes)
    assert!(tomb["at"].as_f64().is_some() && tomb["end"].as_f64() == Some(at(0) + 600_000.0), "{tomb}");
    assert_eq!(t.record(KEY, &nm(0)).unwrap()["deleted"], true, "the record stays for the chain");
    // no footage at all: older than all of it, delivered
    let n0 = nm(0);
    let f = ask(&logs, &[n0.clone(), side(&n0)]);
    let size = l0.len();
    assert_eq!(f[&n0], json!({ "state": "complete", "received": size, "length": size, "size": size, "check": "verified" }));
    assert_eq!(f[&side(&n0)], json!({ "state": "complete", "received": s0.len(), "length": s0.len(), "size": s0.len(), "check": "verified" }));
    // the owner deleted it: delivered whatever footage is kept, or known
    for k in [Kept::Since(at(5)), Kept::Since(at(0) + 30_000.0), Kept::Unknown] {
        *kept.lock().unwrap() = k;
        assert_eq!(ask(&logs, &[n0.clone()])[&n0], json!({ "state": "complete", "received": size, "length": size, "size": size, "check": "verified" }), "{k:?}");
    }
    // one a rule that goes by the footage deleted ("older than the car's footage") goes by the
    // footage kept, with rule "old"'s hour of margin: footage kept from an hour after it ended:
    // delivered; from less than that (footage of its time may be kept again): missing
    *kept.lock().unwrap() = Kept::Nothing;
    let (l2, s2) = b.log(&src, &nm(2), b"log two, older than the footage");
    send(&logs, &nm(2), &l2).unwrap();
    send(&logs, &side(&nm(2)), &s2).unwrap();
    t.check(KEY, &nm(2));
    logs.delete_log(&nm(2), "old").unwrap();
    let n2 = nm(2);
    let size2 = l2.len();
    let end2 = at(2) + 600_000.0;
    *kept.lock().unwrap() = Kept::Since(end2 + 3_600_000.0 + 60_000.0);
    assert_eq!(ask(&logs, &[n2.clone()])[&n2]["check"], "verified");
    *kept.lock().unwrap() = Kept::Since(end2 + 3_600_000.0);
    assert_eq!(ask(&logs, &[n2.clone()])[&n2], json!({ "state": "complete", "received": size2, "length": size2, "size": size2, "check": "verified" }), "ended an hour before the oldest clip starts");
    *kept.lock().unwrap() = Kept::Since(end2 + 3_600_000.0 - 1.0);
    assert_eq!(ask(&logs, &[n2.clone(), side(&n2)]), json!({
        n2.clone(): { "state": "missing", "received": 0, "length": null, "size": 0 },
        side(&n2): { "state": "missing", "received": 0, "length": null, "size": 0 }
    }));
    // the footage not known now (the share away): kept here, ask again
    *kept.lock().unwrap() = Kept::Unknown;
    assert_eq!(ask(&logs, &[n2.clone()])[&n2], json!({ "state": "complete", "received": size2, "length": size2, "size": size2, "check": "pending" }));
    // a log that vanished without being deleted here (a crash, a lost disk): no tombstone
    *kept.lock().unwrap() = Kept::Nothing;
    let (l1, s1) = b.log(&src, &nm(1), b"log one, lost");
    send(&logs, &nm(1), &l1).unwrap();
    send(&logs, &side(&nm(1)), &s1).unwrap();
    t.check(KEY, &nm(1));
    std::fs::remove_file(dir.join(KEY).join(nm(1))).unwrap();
    assert!(t.tomb(KEY, &nm(1)).is_none());
    assert_eq!(ask(&logs, &[nm(1)])[&nm(1)]["state"], "missing");
}

#[test]
fn a_deleted_log_that_failed_answers_failed_with_its_reason() {
    let src = tmp("tomb-failed-bridge");
    let dir = tmp("tomb-failed");
    let (logs, t, _) = checked(&dir);
    let mut b = Bridge::new(42);
    let (l0, s0) = b.log(&src, &nm(0), b"log zero");
    send(&logs, &nm(0), b"log ZERO").unwrap();
    send(&logs, &side(&nm(0)), &s0).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    logs.delete_log(&nm(0), "owner").unwrap();
    let f = ask(&logs, &[nm(0)]);
    assert_eq!((f[&nm(0)]["state"].as_str(), f[&nm(0)]["check"].as_str(), f[&nm(0)]["check_reason"].as_str()), (Some("complete"), Some("failed"), Some("mismatch")));
    assert_eq!(f[&nm(0)]["size"], json!(l0.len()));
    // one deleted before it was judged is judged first, so its tombstone carries a check
    let (l1, s1) = b.log(&src, &nm(1), b"log one");
    send(&logs, &nm(1), &l1).unwrap();
    send(&logs, &side(&nm(1)), &s1).unwrap();
    assert!(t.record(KEY, &nm(1)).is_none());
    logs.delete_log(&nm(1), "owner").unwrap();
    assert_eq!(t.tomb(KEY, &nm(1)).unwrap()["check"], "verified");
}

// ---- C2. logs deleted before tombstones were kept

#[test]
fn tombstones_are_derived_once_from_the_deleted_marks_of_trust_json() {
    let src = tmp("derive-bridge");
    let dir = tmp("derive");
    let (logs, t, _) = checked(&dir);
    let mut b = Bridge::new(43);
    for i in 0..4 {
        let (l, s) = b.log(&src, &nm(i), format!("log {i}").as_bytes());
        send(&logs, &nm(i), &l).unwrap();
        send(&logs, &side(&nm(i)), &s).unwrap();
        t.check(KEY, &nm(i));
    }
    // as an older server deleted them: files first, then the record marked (no tombstone)
    for i in [0, 1] {
        logs.remove(&nm(i)).unwrap();
        t.deleted(KEY, &nm(i));
    }
    // 2: gone without being deleted here (a lost disk); 3: still here
    std::fs::remove_file(dir.join(KEY).join(nm(2))).unwrap();
    std::fs::remove_file(dir.join(KEY).join(side(&nm(2)))).unwrap();
    // until the key's tombstones are worked out: not missing (the bridge would send it again
    // and the copy would be kept), ask again
    assert_eq!(ask(&logs, &[nm(0)])[&nm(0)], json!({ "state": "complete", "received": 5, "length": 5, "size": 5, "check": "pending" }), "before: pending");
    assert_eq!(ask(&logs, &[nm(2)])[&nm(2)]["state"], "missing", "not marked deleted: missing");
    let here = |name: &str| logs.size_of(name).is_some();
    assert_eq!(t.derive_tombstones(KEY, &here), Some((2, 1)));
    let f = ask(&logs, &[nm(0), nm(1), nm(2), nm(3)]);
    assert_eq!((f[&nm(0)]["state"].as_str(), f[&nm(0)]["check"].as_str(), f[&nm(0)]["size"].as_u64()), (Some("complete"), Some("verified"), Some(5)));
    assert_eq!(f[&nm(1)]["check"], "verified");
    assert_eq!(f[&nm(2)]["state"], "missing", "not known to be deleted on purpose");
    assert_eq!(f[&nm(3)]["check"], "verified");
    // the sidecar's size was not kept: it answers missing (sent, it is checked and dropped)
    assert_eq!(ask(&logs, &[side(&nm(0))])[&side(&nm(0))]["state"], "missing");
    assert_eq!(t.tomb(KEY, &nm(0)).unwrap()["why"], "before-tombstones");
    // once only, kept in trust.json
    assert_eq!(t.derive_tombstones(KEY, &here), None);
    let again = CanTrust::new(dir.clone(), Box::new(util::now_ms));
    assert_eq!(again.derive_tombstones(KEY, &here), None);
    assert!(again.tomb(KEY, &nm(1)).is_some());
}

// ---- the CAN area: footage, prune, re-uploads, the background checks

struct FootCtx {
    data: PathBuf,
    settings: Mutex<HashMap<String, Value>>,
    clips: Mutex<Vec<String>>,
    logs: Mutex<Vec<String>>,
    /// no vehicles at all
    no_cars: std::sync::atomic::AtomicBool,
}
impl CanCtx for FootCtx {
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn setting(&self, key: &str) -> Result<Option<Value>, String> {
        Ok(self.settings.lock().unwrap().get(key).cloned())
    }
    fn set_setting(&self, key: &str, value: Value) -> Result<(), String> {
        self.settings.lock().unwrap().insert(key.into(), value);
        Ok(())
    }
    fn vehicles(&self) -> Vec<Car> {
        if self.no_cars.load(Ordering::SeqCst) {
            return Vec::new();
        }
        vec![
            Car { id: "car1".into(), name: "Car".into(), timezone: String::new(), root: None, studio_root: None, car: None },
            Car { id: "car2".into(), name: "Other".into(), timezone: String::new(), root: None, studio_root: None, car: None },
        ]
    }
    fn scan_of(&self, vid: &str) -> Option<Scan> {
        if vid != "car1" {
            return None;
        }
        let files = self.clips.lock().unwrap().iter().map(|c| FootFile { rel: format!("SavedClips/{c}"), kind: "clip".into(), camera: Some("front".into()) }).collect::<Vec<_>>();
        Some(Scan { scanned: true, scanned_at: Some(util::now_ms()), files, generation: self.clips.lock().unwrap().len() as u64, ..Default::default() })
    }
    fn rescan(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn announce(&self, _: &str) {}
    fn audit(&self, _: &str, _: &str) {}
    fn log(&self, level: &str, line: &str) {
        self.logs.lock().unwrap().push(format!("{level}: {line}"));
    }
}

/// A clip of 2026-11-08 at hh:mm (UTC).
fn clip(h: u32, m: u32) -> String {
    format!("2026-11-08_{h:02}-{m:02}-00-front.mp4")
}

fn area(tag: &str, clips: &[String]) -> (Arc<Can>, Arc<FootCtx>, PathBuf) {
    let data = tmp(tag);
    let ctx = Arc::new(FootCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), clips: Mutex::new(clips.to_vec()), logs: Mutex::new(Vec::new()), no_cars: Default::default() });
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "car1" }));
    (Can::new(ctx.clone()), ctx, data.join("can"))
}

/// Logs 0..n from one bridge, uploaded and judged.
fn uploaded(can: &Can, src: &Path, b: &mut Bridge, range: std::ops::Range<usize>) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    for i in range {
        let (l, s) = b.log(src, &nm(i), format!("the log of minute {i}").as_bytes());
        send(&can.logs, &nm(i), &l).unwrap();
        send(&can.logs, &side(&nm(i)), &s).unwrap();
        can.trust.check(KEY, &nm(i));
        out.push((l, s));
    }
    out
}

#[test]
fn the_oldest_footage_kept_is_read_per_car_key() {
    let (can, ctx, _) = area("kept", &[clip(14, 30), clip(16, 0)]);
    assert_eq!(can.kept_footage(KEY), Kept::Since(at(30)));
    // a key chosen for a car with no scan yet: not known
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "car2" }));
    assert_eq!(can.kept_footage(KEY), Kept::Unknown);
    // a car scanned with no footage at all: nothing kept
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "car1" }));
    ctx.clips.lock().unwrap().clear();
    assert_eq!(can.kept_footage(KEY), Kept::Nothing);
    // a key with no car while two cars are here: its car (once chosen) may keep footage of it
    assert_eq!(can.kept_footage("someotherkey"), Kept::Unknown);
}

#[test]
fn every_deletion_path_leaves_tombstones() {
    // footage from 16:00: the logs of 14:00-14:58 are more than an hour older than all of it
    let src = tmp("paths-bridge");
    let (can, ctx, dir) = area("paths", &[clip(16, 0), clip(16, 1)]);
    let mut b = Bridge::new(44);
    uploaded(&can, &src, &mut b, 0..3);
    // "Keeping logs": older than the car's oldest footage
    let out = can.prune.check("car1").unwrap();
    assert_eq!(out["old"], 3, "{out}");
    for i in 0..3 {
        assert!(!dir.join(KEY).join(nm(i)).exists());
        assert_eq!(can.trust.tomb(KEY, &nm(i)).unwrap()["why"], "old");
    }
    let f = ask(&can.logs, &[nm(0), nm(1), nm(2)]);
    for i in 0..3 {
        assert_eq!((f[&nm(i)]["state"].as_str(), f[&nm(i)]["check"].as_str()), (Some("complete"), Some("verified")), "{f}");
    }
    // "Also delete its CAN data": logs of footage moved to the Recycle Bin
    let name = format!("{}_20261108T160000Z_9.log.xz", KEY);
    let (l, s) = b.log(&src, &name, b"the log of 16:00");
    send(&can.logs, &name, &l).unwrap();
    send(&can.logs, &side(&name), &s).unwrap();
    can.trust.check(KEY, &name);
    let rel = format!("SavedClips/{}", clip(16, 0));
    ctx.clips.lock().unwrap().retain(|c| *c != clip(16, 0));
    let out = can.prune.delete_with("car1", &[rel], None, "admin", false);
    assert_eq!(out["removed"], 1, "{out}");
    assert_eq!(can.trust.tomb(KEY, &name).unwrap()["why"], "with-footage");
    // its time (16:00) is older than the footage kept now (16:01): delivered
    assert_eq!(ask(&can.logs, &[name.clone()])[&name]["check"], "verified");
}

#[test]
fn a_deleted_log_sent_again_older_than_the_footage_is_checked_and_dropped_again() {
    let src = tmp("again-bridge");
    let (can, _, dir) = area("again", &[clip(14, 30)]);
    let mut b = Bridge::new(45);
    let files = uploaded(&can, &src, &mut b, 0..2);
    // log 2 arrived as other bytes than its sidecar signed: failed (mismatch)
    let (_, s2) = b.log(&src, &nm(2), b"the log of minute 2");
    send(&can.logs, &nm(2), b"the LOG of minute 2").unwrap();
    send(&can.logs, &side(&nm(2)), &s2).unwrap();
    assert_eq!(can.trust.check(KEY, &nm(2))["status"], "failed");
    for i in 0..3 {
        can.logs.delete_log(&nm(i), "owner").unwrap();
    }
    // the bridge sends log 0 again (its sidecar first), log 2 as it had it, and a bad copy of log 1
    assert_eq!(send(&can.logs, &side(&nm(0)), &files[0].1).unwrap()["complete"], true);
    assert_eq!(send(&can.logs, &nm(0), &files[0].0).unwrap()["complete"], true, "taken as a normal upload");
    send(&can.logs, &nm(2), b"the LOG of minute 2").unwrap();
    send(&can.logs, &side(&nm(2)), &s2).unwrap();
    let mut bad = files[1].0.clone();
    bad[0] ^= 0x20;
    // (not the copy its tombstone recorded: refused, see another_copy_under_a_deleted_name_is_refused_and_the_chain_stays)
    assert_eq!(send(&can.logs, &nm(1), &bad).unwrap_err().code, "exists_different");
    // not indexed meanwhile
    assert_eq!(can.trust.usable(KEY, &nm(0)), (false, None));
    assert_eq!(can.backfill(4, Duration::ZERO), 2);
    for i in 0..3 {
        assert!(!dir.join(KEY).join(nm(i)).exists() && !dir.join(KEY).join(side(&nm(i))).exists(), "deleted again: {i}");
    }
    let t0 = can.trust.tomb(KEY, &nm(0)).unwrap();
    assert_eq!((t0["check"].as_str(), t0["recheckedAt"].is_number()), (Some("verified"), true));
    let f = ask(&can.logs, &[nm(0), nm(1), nm(2)]);
    assert_eq!(f[&nm(0)]["check"], "verified");
    assert_eq!(f[&nm(1)]["check"], "verified", "{f}");
    assert_eq!((f[&nm(2)]["check"].as_str(), f[&nm(2)]["check_reason"].as_str()), (Some("failed"), Some("mismatch")), "{f}");
    assert!(can.trust.tomb(KEY, &nm(2)).unwrap()["recheckedAt"].is_number());
    // the good copy of log 1 sent again: taken, verified (the same rule)
    send(&can.logs, &nm(1), &files[1].0).unwrap();
    send(&can.logs, &side(&nm(1)), &files[1].1).unwrap();
    can.backfill(4, Duration::ZERO);
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)]["check"], "verified");
    assert!(can.trust.tomb(KEY, &nm(1)).unwrap()["recheckedAt"].is_number());
    assert!(!dir.join(KEY).join(nm(1)).exists());
    assert_eq!(can.trust.summary(KEY)["counts"]["verified"], 0, "deleted logs are not counted");
}

#[test]
fn a_deleted_log_sent_again_inside_the_footage_kept_is_kept_as_a_new_log() {
    let src = tmp("inside-bridge");
    let (can, _, dir) = area("inside", &[clip(14, 0)]);
    let mut b = Bridge::new(46);
    let files = uploaded(&can, &src, &mut b, 0..2);
    // (a rule's delete that goes by the footage kept: "older than the car's footage", with
    // older footage kept since, a clip restored from the Recycle Bin)
    can.logs.delete_log(&nm(1), "old").unwrap();
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)]["state"], "missing", "its time still has footage: send it again");
    send(&can.logs, &nm(1), &files[1].0).unwrap();
    send(&can.logs, &side(&nm(1)), &files[1].1).unwrap();
    // before it is judged: not the deleted copy's check
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)]["check"], "pending");
    can.backfill(4, Duration::ZERO);
    assert!(dir.join(KEY).join(nm(1)).exists(), "kept");
    assert!(can.trust.tomb(KEY, &nm(1)).is_none(), "its tombstone goes");
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)]["check"], "verified");
    assert_eq!(can.trust.usable(KEY, &nm(1)), (true, Some("verified")));
    assert_eq!(can.trust.summary(KEY)["counts"]["verified"], 2, "counted again");
}

#[test]
fn the_background_checks_judge_every_log_without_a_record_a_few_at_a_time() {
    let src = tmp("backfill-bridge");
    let (can, ctx, dir) = area("backfill", &[clip(14, 0)]);
    let mut b = Bridge::new(47);
    // logs from before the checks: on disk, no record
    for i in 0..6 {
        let (l, s) = b.log(&src, &nm(i), format!("old log {i}").as_bytes());
        std::fs::create_dir_all(dir.join(KEY)).unwrap();
        std::fs::write(dir.join(KEY).join(nm(i)), l).unwrap();
        std::fs::write(dir.join(KEY).join(side(&nm(i))), s).unwrap();
    }
    assert_eq!(ask(&can.logs, &[nm(0)])[&nm(0)]["check"], "pending");
    let began = std::time::Instant::now();
    assert_eq!(can.backfill(4, Duration::from_millis(100)), 6);
    assert!(began.elapsed() >= Duration::from_millis(100), "a pause after the first four");
    let f = ask(&can.logs, &(0..6).map(nm).collect::<Vec<_>>());
    for i in 0..6 {
        assert_eq!(f[&nm(i)]["check"], "verified", "{f}");
    }
    assert_eq!(can.backfill(4, Duration::ZERO), 0, "nothing left");
    // a copy here whose record still says deleted (sent again before such copies were judged)
    can.trust.deleted(KEY, &nm(2));
    assert_eq!(ask(&can.logs, &[nm(2)])[&nm(2)]["check"], "pending");
    assert_eq!(can.backfill(4, Duration::ZERO), 1);
    assert_eq!(ask(&can.logs, &[nm(2)])[&nm(2)]["check"], "verified");
    assert_eq!(can.trust.summary(KEY)["counts"]["verified"], 6);
    // the tombstones of an older server's deletes, once, logged
    can.logs.remove(&nm(5)).unwrap();
    can.trust.deleted(KEY, &nm(5));
    assert_eq!(can.derive_tombstones(), (1, 0));
    assert!(ctx.logs.lock().unwrap().iter().any(|l| l.contains("1 tombstoned") && l.contains("0 left missing")), "{:?}", ctx.logs.lock().unwrap());
    assert_eq!(can.derive_tombstones(), (0, 0));
}

#[test]
fn through_the_upload_api_a_deleted_log_sent_again_answers_201_and_is_dropped_after_its_check() {
    use axum::http::{HeaderMap, Method};
    use http_body_util::BodyExt;
    let src = tmp("api-bridge");
    let (can, ctx, dir) = area("api", &[clip(15, 0)]);
    let tok_hash = util::sha256_hex(b"the bridge token");
    ctx.settings.lock().unwrap().insert("can".into(), json!({ "enabled": true, "at": null, "tokens": [{ "id": "t1", "hash": tok_hash, "key": KEY, "vehicleId": null }] }));
    let mut b = Bridge::new(48);
    let files = uploaded(&can, &src, &mut b, 0..1);
    can.logs.delete_log(&nm(0), "owner").unwrap();
    let post = |name: &str, body: &[u8]| {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer the bridge token".parse().unwrap());
        h.insert("upload-offset", "0".parse().unwrap());
        h.insert("upload-length", body.len().to_string().parse().unwrap());
        h.insert("upload-sha256", util::sha256_hex(body).parse().unwrap());
        let path = format!("/api/can/logs/{name}");
        let r = sentry_lean::can::routes::Req {
            method: Method::POST,
            path: path.clone(),
            query: HashMap::new(),
            headers: h,
            body: axum::body::Bytes::from(body.to_vec()),
            remote: "127.0.0.1".into(),
            local_port: 10000,
            encrypted: true,
            who: Default::default(),
            confirmed: false,
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let res = can.upload(&r, &path);
        let status = res.status().as_u16();
        let b = futures_util::FutureExt::now_or_never(res.into_body().collect()).unwrap().unwrap().to_bytes();
        (status, serde_json::from_slice::<Value>(&b).unwrap())
    };
    let (s1, a1) = post(&nm(0), &files[0].0);
    let (s2, a2) = post(&side(&nm(0)), &files[0].1);
    assert_eq!((s1, a1["complete"].as_bool(), s2, a2["complete"].as_bool()), (201, Some(true), 201, Some(true)), "{a1} {a2}");
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while dir.join(KEY).join(nm(0)).exists() && std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!dir.join(KEY).join(nm(0)).exists() && !dir.join(KEY).join(side(&nm(0))).exists(), "checked and deleted again");
    assert_eq!(ask(&can.logs, &[nm(0)])[&nm(0)]["check"], "verified");
}

// ---- round 3: a key with no car known, the owner's deletes, the margin, 404s, the start, other copies

/// A log deleted by `why`, after it was uploaded and judged verified.
fn buried_as(can: &Can, src: &Path, b: &mut Bridge, i: usize, why: &str) -> (Vec<u8>, Vec<u8>) {
    let mut v = uploaded(can, src, b, i..i + 1);
    assert_eq!(can.trust.record(KEY, &nm(i)).unwrap()["status"], "verified");
    can.logs.delete_log(&nm(i), why).unwrap();
    v.pop().unwrap()
}

#[test]
fn a_key_whose_car_cannot_be_told_answers_pending_never_delivered() {
    // footage of 14:00 kept: the log of 14:01 (deleted as "old", footage kept again since) is
    // inside it
    let src = tmp("nocar-bridge");
    let (can, ctx, _) = area("nocar", &[clip(14, 0)]);
    let mut b = Bridge::new(50);
    let (l, _) = buried_as(&can, &src, &mut b, 1, "old");
    let size = l.len();
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)]["state"], "missing", "mapped: inside its footage");
    let pending = json!({ "state": "complete", "received": size, "length": size, "size": size, "check": "pending" });
    // unmapped while two cars are here, then mapped to a car since removed: not known
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({}));
    assert_eq!(can.kept_footage(KEY), Kept::Unknown);
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)], pending, "unmapped, two cars");
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "a-removed-car" }));
    assert_eq!(can.kept_footage(KEY), Kept::Unknown);
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)], pending, "mapped to a removed car");
    // no car visible at all (manager.db unreadable, or the car removed to be added again):
    // a rule deleted the log, so a car existed; its footage may still be kept, not known
    ctx.no_cars.store(true, Ordering::SeqCst);
    assert_eq!(can.kept_footage(KEY), Kept::Unknown);
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)], pending, "no car visible");
    // the car back: inside its footage again, missing
    ctx.no_cars.store(false, Ordering::SeqCst);
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "car1" }));
    assert_eq!(ask(&can.logs, &[nm(1)])[&nm(1)]["state"], "missing", "the car back: inside its footage");
}

#[test]
fn the_owners_own_deletes_are_never_asked_for_again_whatever_the_footage() {
    // footage of 14:00 kept: every log here is inside it
    let src = tmp("owner-bridge");
    let (can, _, dir) = area("owner", &[clip(14, 0)]);
    let mut b = Bridge::new(51);
    let f1 = buried_as(&can, &src, &mut b, 1, "owner");
    let f2 = buried_as(&can, &src, &mut b, 2, "with-footage");
    let _ = buried_as(&can, &src, &mut b, 3, "old");
    let f = ask(&can.logs, &[nm(1), side(&nm(1)), nm(2), nm(3)]);
    assert_eq!(f[&nm(1)], json!({ "state": "complete", "received": f1.0.len(), "length": f1.0.len(), "size": f1.0.len(), "check": "verified" }), "{f}");
    assert_eq!(f[&side(&nm(1))]["size"], json!(f1.1.len()));
    assert_eq!(f[&nm(2)]["check"], "verified", "{f}");
    assert_eq!(f[&nm(3)]["state"], "missing", "a rule's that goes by the footage: inside it, may come again");
    // sent again anyway: checked, recorded, deleted again; never kept as a new log
    for (i, files) in [(1, &f1), (2, &f2)] {
        send(&can.logs, &nm(i), &files.0).unwrap();
        send(&can.logs, &side(&nm(i)), &files.1).unwrap();
    }
    can.backfill(4, Duration::ZERO);
    for i in [1, 2] {
        assert!(!dir.join(KEY).join(nm(i)).exists() && !dir.join(KEY).join(side(&nm(i))).exists(), "deleted again: {i}");
        let t = can.trust.tomb(KEY, &nm(i)).expect("its tombstone stays");
        assert!(t["recheckedAt"].is_number(), "{t}");
        assert_eq!(can.trust.usable(KEY, &nm(i)), (false, None));
    }
    assert_eq!(ask(&can.logs, &[nm(1), nm(2)])[&nm(2)]["check"], "verified");
}

#[test]
fn a_log_a_rule_deleted_for_good_answers_its_stored_check_whatever_the_footage() {
    // footage of 14:00 kept: every log here is inside it. Deleted "not linked to footage"
    // (sent again, it would be deleted again a week later, every time) or with its footage
    // deleted for good: delivered for good, as the owner's own deletes
    let src = tmp("forgood-bridge");
    let (can, ctx, dir) = area("forgood", &[clip(14, 0)]);
    let mut b = Bridge::new(56);
    let f1 = buried_as(&can, &src, &mut b, 1, "unlinked");
    let f2 = buried_as(&can, &src, &mut b, 2, "footage");
    // log 3 arrived as other bytes than its sidecar signed: failed (mismatch), then not linked
    let (_, s3) = b.log(&src, &nm(3), b"the log of minute 3");
    send(&can.logs, &nm(3), b"the LOG of minute 3").unwrap();
    send(&can.logs, &side(&nm(3)), &s3).unwrap();
    assert_eq!(can.trust.check(KEY, &nm(3))["status"], "failed");
    can.logs.delete_log(&nm(3), "unlinked").unwrap();
    // (for contrast) a rule that goes by the footage kept
    buried_as(&can, &src, &mut b, 4, "old");
    // a tombstone with no check made: missing (sent, it is checked and dropped)
    can.trust.bury(KEY, &nm(5), json!({ "size": 5, "sha256": util::sha256_hex(b"12345"), "side": null, "check": "pending", "why": "unlinked", "end": at(5) + 600_000.0 }));
    // a log gone with no tombstone (removed by hand): missing
    uploaded(&can, &src, &mut b, 6..7);
    std::fs::remove_file(dir.join(KEY).join(nm(6))).unwrap();
    let all: Vec<String> = (1..7).map(nm).chain([side(&nm(1))]).collect();
    let f = ask(&can.logs, &all);
    let done = |l: &[u8], check: &str| json!({ "state": "complete", "received": l.len(), "length": l.len(), "size": l.len(), "check": check });
    assert_eq!(f[&nm(1)], done(&f1.0, "verified"), "not linked: its check, not missing: {f}");
    assert_eq!(f[&side(&nm(1))], done(&f1.1, "verified"), "{f}");
    assert_eq!(f[&nm(2)], done(&f2.0, "verified"), "its footage deleted for good: {f}");
    assert_eq!((f[&nm(3)]["state"].as_str(), f[&nm(3)]["check"].as_str(), f[&nm(3)]["check_reason"].as_str()), (Some("complete"), Some("failed"), Some("mismatch")), "{f}");
    for i in [4, 5, 6] {
        assert_eq!(f[&nm(i)], json!({ "state": "missing", "received": 0, "length": null, "size": 0 }), "{i}: {f}");
    }
    // the car's footage not known: still its stored check (never pending), and one with no
    // check made still missing; "old" asks again
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "a-removed-car" }));
    assert_eq!(can.kept_footage(KEY), Kept::Unknown);
    let f = ask(&can.logs, &[nm(1), nm(3), nm(4), nm(5)]);
    assert_eq!(f[&nm(1)]["check"], "verified", "{f}");
    assert_eq!(f[&nm(3)]["check"], "failed", "{f}");
    assert_eq!(f[&nm(4)]["check"], "pending", "{f}");
    assert_eq!(f[&nm(5)]["state"], "missing", "{f}");
    ctx.settings.lock().unwrap().insert("can-vehicles".into(), json!({ KEY: "car1" }));
    // another copy under a deleted name: refused, its tombstone as it was
    let tomb1 = can.trust.tomb(KEY, &nm(1)).unwrap();
    let mut bad = f1.0.clone();
    bad[0] ^= 0x20;
    assert_eq!(send(&can.logs, &nm(1), &bad).unwrap_err().code, "exists_different");
    assert_eq!(can.trust.tomb(KEY, &nm(1)).unwrap(), tomb1);
    // sent again anyway (a Resend all): checked, recorded, deleted again; never kept as a new log
    let counted = can.trust.summary(KEY)["counts"]["verified"].clone();
    for (i, files) in [(1, &f1), (2, &f2)] {
        send(&can.logs, &nm(i), &files.0).unwrap();
        send(&can.logs, &side(&nm(i)), &files.1).unwrap();
    }
    send(&can.logs, &nm(3), b"the LOG of minute 3").unwrap();
    send(&can.logs, &side(&nm(3)), &s3).unwrap();
    can.backfill(4, Duration::ZERO);
    for i in [1, 2, 3] {
        assert!(!dir.join(KEY).join(nm(i)).exists() && !dir.join(KEY).join(side(&nm(i))).exists(), "deleted again: {i}");
        let t = can.trust.tomb(KEY, &nm(i)).expect("its tombstone stays");
        assert!(t["recheckedAt"].is_number(), "{t}");
        assert_eq!(can.trust.usable(KEY, &nm(i)), (false, None));
    }
    let f = ask(&can.logs, &[nm(1), nm(2), nm(3)]);
    assert_eq!((f[&nm(1)]["check"].as_str(), f[&nm(2)]["check"].as_str()), (Some("verified"), Some("verified")), "{f}");
    assert_eq!((f[&nm(3)]["check"].as_str(), f[&nm(3)]["check_reason"].as_str()), (Some("failed"), Some("mismatch")), "{f}");
    assert_eq!(can.trust.summary(KEY)["counts"]["verified"], counted, "not counted again");
    assert!(ctx.logs.lock().unwrap().iter().any(|l| l.contains("deleted here, not linked to footage") && l.contains("deleted again")), "{:?}", ctx.logs.lock().unwrap());
    assert!(ctx.logs.lock().unwrap().iter().any(|l| l.contains("its footage deleted for good")), "{:?}", ctx.logs.lock().unwrap());
}

#[test]
fn older_than_the_footage_needs_rule_olds_margin_and_the_longest_log() {
    // with the margin: a log that ended half an hour before the oldest clip is not older
    let t = at(30) + 3_600_000.0;
    assert_eq!(CanLogs::older_than_footage(Kept::Since(t), t - 1_800_000.0), Some(false));
    assert_eq!(CanLogs::older_than_footage(Kept::Since(t), t - 3_600_000.0), Some(true));
    // a log with no end in its sidecar: ten minutes (the longest a log runs), not one
    let src = tmp("margin-bridge");
    let (can, _, _) = area("margin", &[]);
    let mut b = Bridge::new(52);
    buried_as(&can, &src, &mut b, 0, "unlinked");
    assert_eq!(can.trust.tomb(KEY, &nm(0)).unwrap()["end"].as_f64(), Some(at(0) + 600_000.0));
    // a sidecar whose wall clock was set back (its end before the name's time): still ten minutes
    b.end = Some(at(1) - 7_200_000.0);
    buried_as(&can, &src, &mut b, 1, "unlinked");
    assert_eq!(can.trust.tomb(KEY, &nm(1)).unwrap()["end"].as_f64(), Some(at(1) + 600_000.0));
    // an end later than that is kept
    b.end = Some(at(2) + 900_000.0);
    buried_as(&can, &src, &mut b, 2, "unlinked");
    assert_eq!(can.trust.tomb(KEY, &nm(2)).unwrap()["end"].as_f64(), Some(at(2) + 900_000.0));
    // and the tombstones worked out from an older server's records
    let dir = tmp("margin-derive");
    let (logs, tr, _) = checked(&dir);
    let (l, sd) = b.log(&src, &nm(5), b"log five");
    send(&logs, &nm(5), &l).unwrap();
    send(&logs, &side(&nm(5)), &sd).unwrap();
    tr.check(KEY, &nm(5));
    logs.remove(&nm(5)).unwrap();
    tr.deleted(KEY, &nm(5));
    assert_eq!(tr.derive_tombstones(KEY, &|n: &str| logs.size_of(n).is_some()), Some((1, 0)));
    assert_eq!(tr.tomb(KEY, &nm(5)).unwrap()["end"].as_f64(), Some(at(5) + 600_000.0));
}

/// Sets a folder's modification time back (so a catalogue read before still counts as fresh).
fn set_mtime(dir: &Path, t: std::time::SystemTime) {
    std::fs::File::open(dir).unwrap().set_modified(t).unwrap();
}

#[test]
fn a_rule_that_finds_its_log_already_gone_leaves_no_tombstone() {
    // footage from 16:00: the logs of 14:00-14:01 are more than an hour older (rule "old")
    let src = tmp("gone-bridge");
    let (can, _, dir) = area("gone", &[clip(16, 0)]);
    let mut b = Bridge::new(53);
    uploaded(&can, &src, &mut b, 0..2);
    // log 0 vanishes (a lost disk) while the catalogue still lists it
    assert_eq!(can.logs.rows_of(KEY).len(), 2);
    let kdir = dir.join(KEY);
    let m = std::fs::metadata(&kdir).unwrap().modified().unwrap();
    std::fs::remove_file(kdir.join(nm(0))).unwrap();
    std::fs::remove_file(kdir.join(side(&nm(0)))).unwrap();
    set_mtime(&kdir, m);
    assert_eq!(can.logs.rows_of(KEY).len(), 2, "still listed");
    let out = can.prune.check("car1").unwrap();
    assert_eq!(out["old"], 2, "{out}");
    assert!(can.trust.tomb(KEY, &nm(0)).is_none() && can.trust.tomb(KEY, &nm(1)).is_some());
    // its record stays for the chain, hidden, and marked lost: never tombstoned later either
    let r = can.trust.record(KEY, &nm(0)).unwrap();
    assert_eq!((r["deleted"].as_bool(), r["lost"].as_bool()), (Some(true), Some(true)), "{r}");
    assert_eq!(can.derive_tombstones(), (0, 1));
    assert!(can.trust.tomb(KEY, &nm(0)).is_none());
    let f = ask(&can.logs, &[nm(0), nm(1)]);
    assert_eq!(f[&nm(0)]["state"], "missing", "nothing shows it was deleted on purpose: {f}");
    assert_eq!(f[&nm(1)]["check"], "verified");
}

#[test]
fn until_its_key_is_worked_out_a_deleted_record_is_never_missing() {
    let src = tmp("race-bridge");
    let dir = tmp("race");
    let (logs, t, _) = checked(&dir);
    let mut b = Bridge::new(54);
    let (l, s) = b.log(&src, &nm(0), b"deleted by an older server");
    send(&logs, &nm(0), &l).unwrap();
    send(&logs, &side(&nm(0)), &s).unwrap();
    t.check(KEY, &nm(0));
    logs.remove(&nm(0)).unwrap();
    t.deleted(KEY, &nm(0));
    // just after the start, before derive_tombstones ran for this key: ask again, both halves
    let f = ask(&logs, &[nm(0), side(&nm(0))]);
    assert_eq!(f[&nm(0)], json!({ "state": "complete", "received": l.len(), "length": l.len(), "size": l.len(), "check": "pending" }), "{f}");
    assert_eq!((f[&side(&nm(0))]["state"].as_str(), f[&side(&nm(0))]["check"].as_str()), (Some("complete"), Some("pending")), "{f}");
    assert_eq!(t.derive_tombstones(KEY, &|n: &str| logs.size_of(n).is_some()), Some((1, 0)));
    assert_eq!(ask(&logs, &[nm(0)])[&nm(0)]["check"], "verified");
}

#[test]
fn another_copy_under_a_deleted_name_is_refused_and_the_chain_stays() {
    // logs 0-2 from one bridge; log 1 deleted by the owner
    let src = tmp("other-bridge");
    let (can, _, dir) = area("other", &[clip(14, 0)]);
    let mut b = Bridge::new(55);
    let files = uploaded(&can, &src, &mut b, 0..3);
    can.logs.delete_log(&nm(1), "owner").unwrap();
    let tomb = can.trust.tomb(KEY, &nm(1)).unwrap();
    let rec = can.trust.record(KEY, &nm(1)).unwrap();
    // other bytes under log 1's name, signed properly by the same key, index and previous log
    let src2 = tmp("other-bridge2");
    let mut b2 = Bridge::new(55);
    b2.log(&src2, &nm(0), "the log of minute 0".as_bytes());
    let (other, other_side) = b2.log(&src2, &nm(1), b"other bytes under log one's name");
    assert_ne!(other_side, files[1].1);
    // its decision waits for the body (as for a stored file), then 409, nothing written
    let sha = util::sha256_hex(&other);
    assert_eq!(can.logs.precheck(&nm(1), Some(other.len() as u64), 0.0, other.len() as f64, &sha).unwrap(), None);
    assert_eq!(send(&can.logs, &nm(1), &other).unwrap_err().code, "exists_different");
    assert_eq!(send(&can.logs, &side(&nm(1)), &other_side).unwrap_err().code, "exists_different", "the sidecar half too");
    assert!(!dir.join(KEY).join(nm(1)).exists() && !dir.join(KEY).join(side(&nm(1))).exists());
    assert!(std::fs::read_dir(dir.join(KEY)).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")), "no copy left");
    can.backfill(4, Duration::ZERO);
    assert_eq!(can.trust.tomb(KEY, &nm(1)).unwrap(), tomb, "its tombstone as it was");
    assert_eq!(can.trust.record(KEY, &nm(1)).unwrap()["sha256"], rec["sha256"], "its record as it was");
    let f = ask(&can.logs, &[nm(1), nm(2)]);
    assert_eq!((f[&nm(1)]["size"].as_u64(), f[&nm(1)]["check"].as_str()), (Some(files[1].0.len() as u64), Some("verified")), "{f}");
    assert_eq!(f[&nm(2)]["check"], "verified", "the next log's chain link still fits: {f}");
    // the same copy is still taken (checked and dropped again)
    assert_eq!(send(&can.logs, &nm(1), &files[1].0).unwrap()["complete"], true);
    assert_eq!(send(&can.logs, &side(&nm(1)), &files[1].1).unwrap()["complete"], true);
}

#[test]
fn a_derived_tombstones_sidecar_stays_missing_without_a_recorded_size() {
    // what an older server kept of a log has no sidecar size or hash (and chain.json is the
    // bridge's): its sidecar is not guessed
    let src = tmp("derside-bridge");
    let dir = tmp("derside");
    let (logs, t, _) = checked(&dir);
    let mut b = Bridge::new(56);
    let (l, s) = b.log(&src, &nm(0), b"an older server's delete");
    send(&logs, &nm(0), &l).unwrap();
    send(&logs, &side(&nm(0)), &s).unwrap();
    let r = t.check(KEY, &nm(0));
    assert!(r.as_object().unwrap().keys().all(|k| !k.to_lowercase().contains("side")), "{r}");
    logs.remove(&nm(0)).unwrap();
    t.deleted(KEY, &nm(0));
    t.derive_tombstones(KEY, &|n: &str| logs.size_of(n).is_some());
    let tomb = t.tomb(KEY, &nm(0)).unwrap();
    assert!(tomb["side"].is_null(), "{tomb}");
    let f = ask(&logs, &[nm(0), side(&nm(0))]);
    assert_eq!(f[&nm(0)]["check"], "verified");
    assert_eq!(f[&side(&nm(0))], json!({ "state": "missing", "received": 0, "length": null, "size": 0 }));
}

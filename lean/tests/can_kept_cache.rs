//! The oldest footage a car keeps (for the CAN logs deleted here) is worked out once per scan
//! result: a status call does not copy the car's whole file list each time, and a new scan,
//! another time zone or a protect change still count at once.

use sentry_lean::can::ctx::{CanCtx, Car, FootFile, Scan};
use sentry_lean::can::logs::Kept;
use sentry_lean::can::routes::Can;
use sentry_lean::can::{tz, util};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const KEY: &str = "abcdef123456";

struct Ctx {
    data: PathBuf,
    settings: Mutex<HashMap<String, Value>>,
    clips: Mutex<Vec<String>>,
    protected: Mutex<Vec<String>>,
    zone: Mutex<String>,
    generation: AtomicU64,
    /// copies of the whole scan (its file list)
    copies: AtomicUsize,
}
impl Ctx {
    fn rescanned(&self, clips: &[&str]) {
        *self.clips.lock().unwrap() = clips.iter().map(|c| c.to_string()).collect();
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}
impl CanCtx for Ctx {
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
        vec![Car { id: "car1".into(), name: "Car".into(), timezone: self.zone.lock().unwrap().clone(), root: None, studio_root: None, car: None }]
    }
    fn scan_of(&self, _: &str) -> Option<Scan> {
        self.copies.fetch_add(1, Ordering::SeqCst);
        let files = self.clips.lock().unwrap().iter().map(|c| FootFile { rel: format!("RecentClips/{c}"), kind: "clip".into(), camera: Some("front".into()) }).collect();
        Some(Scan { scanned: true, scanned_at: Some(1.0), files, generation: self.generation.load(Ordering::SeqCst), ..Default::default() })
    }
    fn scan_head(&self, _: &str) -> Option<Scan> {
        Some(Scan { scanned: true, scanned_at: Some(1.0), generation: self.generation.load(Ordering::SeqCst), ..Default::default() })
    }
    fn scan_generation(&self, _: &str) -> Option<u64> {
        Some(self.generation.load(Ordering::SeqCst))
    }
    fn protected_rels(&self, _: &str) -> Result<Vec<String>, String> {
        // (as the server's own ctx: read from a set, in another order each time)
        let set: std::collections::HashSet<String> = self.protected.lock().unwrap().iter().cloned().collect();
        Ok(set.into_iter().collect())
    }
    fn rescan(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn announce(&self, _: &str) {}
    fn audit(&self, _: &str, _: &str) {}
    fn log(&self, _: &str, _: &str) {}
}

fn utc(h: i64, m: i64) -> f64 {
    tz::utc_ms(2026, 11, 8, h, m, 0) as f64
}

#[test]
fn the_oldest_footage_kept_is_worked_out_once_per_scan() {
    let data = std::env::temp_dir().join(format!("can-kept-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("can").join(KEY)).unwrap();
    let ctx = Arc::new(Ctx {
        data: data.clone(),
        settings: Mutex::new(HashMap::from([("can-vehicles".to_string(), json!({ KEY: "car1" }))])),
        clips: Mutex::new(vec!["2026-11-08_14-30-00-front.mp4".into(), "2026-11-08_16-00-00-front.mp4".into()]),
        protected: Mutex::new(Vec::new()),
        zone: Mutex::new(String::new()),
        generation: AtomicU64::new(1),
        copies: AtomicUsize::new(0),
    });
    let can = Can::new(ctx.clone());
    // a deleted log the bridge asks about every 15 s
    can.trust.bury(KEY, &format!("{KEY}_20261108T100000Z_1.log.xz"), json!({ "size": 5, "sha256": util::sha256_hex(b"12345"), "side": null, "check": "verified", "why": "unlinked", "end": utc(10, 10) }));
    let names = json!([format!("{KEY}_20261108T100000Z_1.log.xz")]);
    for _ in 0..20 {
        assert_eq!(can.logs.status(Some(&names), Some(KEY)).unwrap()["files"][format!("{KEY}_20261108T100000Z_1.log.xz")]["check"], "verified");
        assert_eq!(can.kept_footage(KEY), Kept::Since(utc(14, 30)));
        assert_eq!(can.kept_starts(KEY).as_deref(), Some(&vec![utc(14, 30), utc(16, 0)]));
    }
    // (once for the oldest clip, once for every clip's start: the logs deleted for good as not
    // linked to footage go by them)
    assert_eq!(ctx.copies.load(Ordering::SeqCst), 2, "the file list copied once each, not per call");
    // a new scan result: worked out again
    ctx.rescanned(&["2026-11-08_15-00-00-front.mp4"]);
    assert_eq!(can.kept_footage(KEY), Kept::Since(utc(15, 0)));
    assert_eq!(can.kept_footage(KEY), Kept::Since(utc(15, 0)));
    assert_eq!(can.kept_starts(KEY).as_deref(), Some(&vec![utc(15, 0)]));
    assert_eq!(can.kept_starts(KEY).as_deref(), Some(&vec![utc(15, 0)]));
    assert_eq!(ctx.copies.load(Ordering::SeqCst), 4);
    // a protected clip (protecting changes no scan): counted at once, and when unprotected
    ctx.protected.lock().unwrap().push("SavedClips/2026-11-08/2026-11-08_09-00-00-front.mp4".into());
    assert_eq!(can.kept_footage(KEY), Kept::Since(utc(9, 0)));
    assert_eq!(can.kept_starts(KEY).as_deref(), Some(&vec![utc(9, 0), utc(15, 0)]));
    ctx.protected.lock().unwrap().clear();
    assert_eq!(can.kept_starts(KEY).as_deref(), Some(&vec![utc(15, 0)]));
    assert_eq!(can.kept_footage(KEY), Kept::Since(utc(15, 0)));
    // another time zone: the clip names read again
    *ctx.zone.lock().unwrap() = "Europe/Berlin".into();
    assert_eq!(can.kept_footage(KEY), Kept::Since(utc(14, 0)));
    assert_eq!(can.kept_starts(KEY).as_deref(), Some(&vec![utc(14, 0)]));
    assert_eq!(ctx.copies.load(Ordering::SeqCst), 8);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn several_protected_clips_read_in_any_order_still_hit_the_cache() {
    let data = std::env::temp_dir().join(format!("can-kept-cache-prot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("can").join(KEY)).unwrap();
    let protected: Vec<String> = (0..8).map(|i| format!("SavedClips/2026-11-08/2026-11-08_09-0{i}-00-front.mp4")).collect();
    let ctx = Arc::new(Ctx {
        data: data.clone(),
        settings: Mutex::new(HashMap::from([("can-vehicles".to_string(), json!({ KEY: "car1" }))])),
        clips: Mutex::new(vec!["2026-11-08_14-30-00-front.mp4".into()]),
        protected: Mutex::new(protected),
        zone: Mutex::new(String::new()),
        generation: AtomicU64::new(1),
        copies: AtomicUsize::new(0),
    });
    let can = Can::new(ctx.clone());
    let name = format!("{KEY}_20261108T100000Z_1.log.xz");
    can.trust.bury(KEY, &name, json!({ "size": 5, "sha256": util::sha256_hex(b"12345"), "side": null, "check": "verified", "why": "unlinked", "end": utc(10, 10) }));
    let names = json!([name.clone()]);
    for _ in 0..20 {
        assert_eq!(can.logs.status(Some(&names), Some(KEY)).unwrap()["files"][&name]["check"], "verified");
        assert_eq!(can.kept_starts(KEY).map(|s| s.len()), Some(9));
    }
    let copies = ctx.copies.load(Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&data);
    assert!(copies <= 2, "the file list was copied {copies} times for 20 status calls with no change");
}

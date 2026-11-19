//! Parity of the arrival checksums with Node (lean/parity/arrival.js; needs
//! node): the same archive, inventory, clock and options through Node's
//! hasher and the Rust one, in turn, on the same files. The share's record
//! and marks, and the index (snapshot and journal), must be byte for byte
//! Node's; the view field for field. Then a second pass after a clip went,
//! one was uploaded again and a new one came; then 60 days of record()
//! calls with pruning.

use sentry_lean::arrival::{Arrival, ArrivalCtx, ArrivedFile, Car, InventoryView, KnownCodec, Options, Recorder};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn node_available() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn node(args: &[&str]) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("parity/arrival.js");
    let out = Command::new("node").arg(script).args(args).output().expect("run node");
    assert!(out.status.success(), "node {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

struct Ctx {
    base: PathBuf,
    inv: InventoryView,
    held: Vec<String>,
    codecs: Vec<(String, KnownCodec)>,
}

impl ArrivalCtx for Ctx {
    fn vehicles(&self) -> Vec<Car> {
        vec![Car { id: "car 1".into(), name: "Car".into(), timezone: "America/Los_Angeles".into() }]
    }
    fn root_of(&self, _vid: &str) -> PathBuf {
        self.base.clone()
    }
    fn vehicle_for_path(&self, p: &str) -> Option<String> {
        let b = self.base.to_string_lossy();
        (p == b || p.starts_with(&format!("{b}/"))).then(|| "car 1".to_string())
    }
    fn inventory(&self, _vid: &str) -> Option<InventoryView> {
        Some(self.inv.clone())
    }
    fn codec(&self, _vid: &str, rel: &str) -> Option<KnownCodec> {
        self.codecs.iter().find(|c| c.0 == rel).map(|c| c.1.clone())
    }
    fn holds(&self, abs: &str) -> bool {
        self.held.iter().any(|h| abs.ends_with(&format!("/{h}")))
    }
    fn older_of(&self, _vid: &str) -> Result<bool, String> {
        Ok(true)
    }
    fn log_warn(&self, line: &str) {
        panic!("unexpected warning: {line}");
    }
}

fn rust_run(dir: &Path, data: &Path, phase: u32) -> Value {
    let given: Value = serde_json::from_str(&fs::read_to_string(dir.join(format!("node-data/inventory-{phase}.json"))).unwrap()).unwrap();
    let now = given["now"].as_f64().unwrap();
    let files = given["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| ArrivedFile {
            rel: f["rel"].as_str().unwrap().into(),
            clip: f["kind"] == "clip",
            size: f["size"].as_u64().unwrap(),
            mtime_ms: f["mtimeMs"].as_f64().unwrap(),
            ctime_ms: f["ctimeMs"].as_f64().unwrap(),
            birthtime_ms: f["birthtimeMs"].as_f64().unwrap_or(0.0),
        })
        .collect();
    let codecs = given["codecs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["rel"].as_str().unwrap().to_string(), KnownCodec { size: c["size"].as_u64().unwrap(), mtime_ms: c["mtimeMs"].as_f64().unwrap(), codec: c["codec"].as_str().map(String::from) }))
        .collect();
    let held = given["held"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_string()).collect();
    let base = dir.join("car");
    let ctx = Arc::new(Ctx { base: base.clone(), inv: InventoryView { files, scanning: false }, held, codecs });
    let c = ctx.clone();
    let recorder = Arc::new(Recorder::new(move |d| c.vehicle_for_path(d).is_some()).with_clock(move || now));
    let mut o = Options::new(data);
    o.now = Box::new(move || now);
    o.settle_ms = 0.0;
    o.rate = 0.0;
    o.save_every = 4;
    o.compact_min = 6;
    o.next_cycle_ms = 60_000;
    o.per_cycle = if phase == 1 { 14 } else { 300 };
    let arrival = Arrival::new(ctx, recorder, o);
    if phase == 1 {
        let n = given["files"].as_array().unwrap().iter().map(|f| f["rel"].as_str().unwrap()).find(|r| r.ends_with("-front.mp4") && fs::read(base.join(r)).unwrap().windows(4).any(|w| w == b"hvc1") && converted_one(dir, r)).unwrap().to_string();
        arrival.converted(&base.join(n).to_string_lossy());
    }
    arrival.kick_wait();
    arrival.stop();
    serde_json::json!({ "view": arrival.view("car 1").unwrap(), "bytes": arrival.hashed_bytes() })
}

/// The H.265 clip Node's run calls converted() for (5340 s before the archive's now).
fn converted_one(dir: &Path, rel: &str) -> bool {
    let now = serde_json::from_str::<Value>(&fs::read_to_string(dir.join("now.json")).unwrap()).unwrap()["now"].as_f64().unwrap();
    let t = chrono::DateTime::from_timestamp_millis((now - 5_340_000.0) as i64).unwrap();
    rel.ends_with(&format!("{}-front.mp4", t.format("%Y-%m-%d_%H-%M-%S")))
}

/// Every file under `dir` (relpath -> bytes), but the Node run's own dumps.
fn files_of(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("inventory-") || n.starts_with("answers-") {
                continue;
            }
            out.insert(n, fs::read(e.path()).unwrap());
        }
    }
    out
}

fn assert_same(what: &str, a: &BTreeMap<String, Vec<u8>>, b: &BTreeMap<String, Vec<u8>>) {
    assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>(), "{what}: the same files");
    for (k, v) in a {
        assert!(v == &b[k], "{what}/{k} differs:\nnode: {}\nrust: {}", String::from_utf8_lossy(v), String::from_utf8_lossy(&b[k]));
    }
}

/// The share's .sentrymanager/ in and out of a store, so each side starts from its own.
fn swap(from: &Path, to: &Path) {
    if from.exists() {
        fs::rename(from, to).unwrap();
    }
}

#[test]
fn arrival_parity_with_node() {
    if !node_available() {
        eprintln!("skipped: node is not installed");
        return;
    }
    let dir = std::env::temp_dir().join(format!("lean-arrival-parity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let dir = fs::canonicalize(&dir).unwrap();
    node(&["make", &dir.to_string_lossy()]);
    let sm = dir.join("car/TeslaCam/.sentrymanager");
    let (nd, rd) = (dir.join("node-data"), dir.join("rust-data"));
    let (nsm, rsm) = (dir.join("node-sm"), dir.join("rust-sm"));
    for phase in [1u32, 2] {
        if phase == 2 {
            node(&["mutate", &dir.to_string_lossy()]);
        }
        swap(&nsm, &sm);
        node(&["run", &dir.to_string_lossy(), &nd.to_string_lossy(), &phase.to_string()]);
        swap(&sm, &nsm);
        swap(&rsm, &sm);
        let answers = rust_run(&dir, &rd, phase);
        swap(&sm, &rsm);
        let want: Value = serde_json::from_str(&fs::read_to_string(nd.join(format!("answers-{phase}.json"))).unwrap()).unwrap();
        assert_eq!(answers, want, "phase {phase}: the answers");
        assert_same(&format!("phase {phase} index"), &files_of(&nd), &files_of(&rd));
        assert_same(&format!("phase {phase} record"), &files_of(&nsm), &files_of(&rsm));
        assert!(files_of(&nsm).contains_key("original-checksums.sha256"));
        if phase == 1 {
            assert!(files_of(&nd).contains_key("car_1.log") && files_of(&nd).contains_key("car_1.json"), "both the snapshot and the journal were written");
        }
    }

    // 60 days of lines, pruned
    let (nrec, rrec) = (dir.join("rec-node"), dir.join("rec-rust"));
    node(&["records", &nrec.to_string_lossy()]);
    fs::create_dir_all(rrec.join("RecentClips")).unwrap();
    let clock = Arc::new(std::sync::Mutex::new(0.0f64));
    let c = clock.clone();
    let rec = Recorder::new(|_| true).with_clock(move || *c.lock().unwrap());
    let start = 1_767_268_800_000.0; // Date.UTC(2026, 0, 1, 12)
    *clock.lock().unwrap() = start;
    let add = |n: &str, h: &str| rec.record(&rrec.join("RecentClips").join(n).to_string_lossy(), Some(&rrec.to_string_lossy()), h).unwrap();
    add("2020-05-05_10-00-00-front.mp4", &"1".repeat(64));
    add("2026-01-01_10-00-00-front.mp4", &"2".repeat(64));
    for day in 1..=60u32 {
        *clock.lock().unwrap() = start + day as f64 * 86_400_000.0;
        let h: String = sha2_hex(day.to_string().as_bytes());
        add(&format!("2026-01-{:02}_11-00-00-front.mp4", 1 + (day % 28)), &h);
        if day % 3 == 0 {
            add(&format!("2026-02-{:02}_11-00-00-back.mp4", 1 + (day % 28)), &format!("{}{}", "A".repeat(63), day % 10));
        }
    }
    assert_same("records", &files_of(&nrec.join(".sentrymanager")), &files_of(&rrec.join(".sentrymanager")));
    let _ = fs::remove_dir_all(&dir);
}

fn sha2_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

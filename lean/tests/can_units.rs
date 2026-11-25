//! Ports of the Node CAN tests (test/canTrust, canColumns, canSearch, canPrune,
//! canLogs, sentryUsb, sentryUsbCar, carFiles, canCalc) that check the pure
//! rules: signatures and pairing with real P-256 signatures, the chain, the
//! columns format against the bridge's own test file, times in queries, which
//! logs go with their footage, the uploads' checks, Sentry USB's files.

use p256::ecdsa::{signature::Signer, Signature, SigningKey};

use sentry_lean::can::json::stringify;
use sentry_lean::can::logs::{parse_name, CanLogs, Row, SideFacts};
use sentry_lean::can::trust::{base64, fingerprint_of, signed_message, CanTrust, Half};
use sentry_lean::can::{prune, reader, search, sentry_usb, tz, util};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const KEY: &str = "abcdef123456";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!("can-units-{}-{}-{}", std::process::id(), tag, N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn nm(i: usize) -> String {
    format!("{}_20261108T14{:02}00Z_{}.log.xz", KEY, i, i + 1)
}

struct Bridge {
    sk: SigningKey,
    der: Vec<u8>,
    index: u64,
    prev: (String, String),
}

impl Bridge {
    fn new(seed: u8) -> Bridge {
        let mut bytes = [seed; 32];
        bytes[0] = 1;
        let sk = SigningKey::from_bytes(&bytes.into()).unwrap();
        let mut der = vec![0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00];
        der.extend_from_slice(sk.verifying_key().to_encoded_point(false).as_bytes());
        Bridge { sk, der, index: 0, prev: ("-".into(), ZERO.into()) }
    }
    fn fp(&self) -> String {
        fingerprint_of(&self.der)
    }
    fn log(&mut self, dir: &Path, name: &str, body: &[u8], key: &str) {
        std::fs::create_dir_all(dir.join(key)).unwrap();
        std::fs::write(dir.join(key).join(name), body).unwrap();
        let sha = util::sha256_hex(body);
        let msg = signed_message(key, name, &sha, body.len() as f64, self.index as f64, &self.prev.0, &self.prev.1);
        let sig: Signature = self.sk.sign(msg.as_bytes());
        let integrity = json!({
            "signed": true, "version": "canbridge-log-sig-v1", "algorithm": "ECDSA-P256-SHA256", "public_key": base64(&self.der), "key_fingerprint": self.fp(),
            "vehicle_key": key, "sha256": sha, "length": body.len(), "index": self.index, "prev_name": self.prev.0, "prev_sha256": self.prev.1,
            "signature": base64(sig.to_der().as_bytes())
        });
        std::fs::write(dir.join(key).join(format!("{}.json", name)), stringify(&json!({ "format": "canbridge-candump-xz/1", "frames": 10, "integrity": integrity }))).unwrap();
        self.prev = (name.to_string(), sha);
        self.index += 1;
    }
}

fn status(r: &Value) -> (String, String) {
    (r["status"].as_str().unwrap_or("").into(), r["reason"].as_str().unwrap_or("").into())
}

#[test]
fn the_signed_message_is_the_spec_lines() {
    assert_eq!(signed_message("k", "n.log.xz", "ab", 3.0, 0.0, "-", ZERO), format!("canbridge-log-sig-v1\nk\nn.log.xz\nab\n3\n0\n-\n{}\n", ZERO));
}

#[test]
fn verified_then_paired_changed_files_and_other_keys_fail() {
    let dir = tmp("trust");
    let t = CanTrust::new(dir.clone(), Box::new(util::now_ms));
    let mut b = Bridge::new(7);
    b.log(&dir, &nm(0), b"first log body", KEY);
    assert_eq!(t.check(KEY, &nm(0))["status"], "verified");
    assert_eq!(t.summary(KEY)["pin"]["fingerprint"], json!(b.fp()));
    assert_eq!(t.usable(KEY, &nm(0)), (true, Some("verified")));
    // one byte changed after signing
    b.log(&dir, &nm(1), b"second log body", KEY);
    let f = dir.join(KEY).join(nm(1));
    let mut bytes = std::fs::read(&f).unwrap();
    bytes[3] ^= 1;
    std::fs::write(&f, &bytes).unwrap();
    assert_eq!(status(&t.check(KEY, &nm(1))), ("failed".into(), "the file is not the one that was signed (SHA-256 differs)".into()));
    assert_eq!(t.usable(KEY, &nm(1)), (false, None));
    // the sidecar edited to match: the signature no longer does
    let sp = dir.join(KEY).join(format!("{}.json", nm(1)));
    let mut side: Value = serde_json::from_slice(&std::fs::read(&sp).unwrap()).unwrap();
    side["integrity"]["sha256"] = json!(util::sha256_hex(&bytes));
    std::fs::write(&sp, stringify(&side)).unwrap();
    assert_eq!(t.check(KEY, &nm(1))["reason"], "the signature does not match");
    t.set_override(KEY, &nm(1), true).unwrap();
    assert_eq!(t.usable(KEY, &nm(1)), (true, Some("override")));
    // another key: failed, offered to the owner, trusted
    let mut other = Bridge::new(9);
    other.log(&dir, &nm(2), b"other", KEY);
    assert_eq!(status(&t.check(KEY, &nm(2))), ("failed".into(), "signed by a key this car is not paired with".into()));
    assert_eq!(t.summary(KEY)["newKey"]["fingerprint"], json!(other.fp()));
    t.trust_key(KEY, &other.fp()).unwrap();
    assert_eq!(t.record(KEY, &nm(2)).unwrap()["status"], "verified");
    assert_eq!(t.summary(KEY)["pin"]["how"], "confirmed by the owner");
    assert!(t.trust_key(KEY, "AA:BB").is_err());
    // signed for another car key
    let dir3 = tmp("trust3");
    let mut b3 = Bridge::new(11);
    b3.log(&dir3, &nm(0), b"x", "ffffff000000");
    std::fs::create_dir_all(dir3.join(KEY)).unwrap();
    std::fs::rename(dir3.join("ffffff000000").join(nm(0)), dir3.join(KEY).join(nm(0))).unwrap();
    std::fs::rename(dir3.join("ffffff000000").join(format!("{}.json", nm(0))), dir3.join(KEY).join(format!("{}.json", nm(0)))).unwrap();
    assert_eq!(CanTrust::new(dir3, Box::new(util::now_ms)).check(KEY, &nm(0))["reason"], "signed for another car key");
}

#[test]
fn unsigned_before_pairing_failed_after_and_waiting_for_a_sidecar() {
    let dir = tmp("unsigned");
    let now = Arc::new(AtomicU64::new(1_000_000));
    let n2 = now.clone();
    let t = CanTrust::new(dir.clone(), Box::new(move || n2.load(Ordering::SeqCst) as f64));
    std::fs::create_dir_all(dir.join(KEY)).unwrap();
    std::fs::write(dir.join(KEY).join(nm(0)), "old bridge").unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "waiting");
    now.fetch_add(11 * 60_000, Ordering::SeqCst);
    assert_eq!(t.check(KEY, &nm(0))["status"], "unsigned");
    assert_eq!(t.usable(KEY, &nm(0)), (true, Some("unsigned")));
    std::fs::write(dir.join(KEY).join(nm(1)), "x").unwrap();
    std::fs::write(dir.join(KEY).join(format!("{}.json", nm(1))), r#"{"integrity":{"signed":false,"error":"keystore unavailable"}}"#).unwrap();
    assert_eq!(status(&t.check(KEY, &nm(1))), ("unsigned".into(), "not signed: keystore unavailable".into()));
    let mut b = Bridge::new(3);
    b.log(&dir, &nm(2), b"signed", KEY);
    assert_eq!(t.check(KEY, &nm(2))["status"], "verified");
    std::fs::write(dir.join(KEY).join(nm(3)), "y").unwrap();
    std::fs::write(dir.join(KEY).join(format!("{}.json", nm(3))), r#"{"frames":1}"#).unwrap();
    assert_eq!(status(&t.check(KEY, &nm(3))), ("failed".into(), "not signed, but this car is paired with a key".into()));
    // the bridge could not sign it, after pairing: a reason of its own
    std::fs::write(dir.join(KEY).join(nm(4)), "z").unwrap();
    std::fs::write(dir.join(KEY).join(format!("{}.json", nm(4))), "{\"integrity\":{\"signed\":false,\"error\":\"JSONException: Value \\u0000\\u0000 of type\"}}").unwrap();
    let r = t.check(KEY, &nm(4));
    assert_eq!(r["kind"], "bridge-could-not-sign");
    assert_eq!(r["reason"], "unsigned: the CAN Bridge could not sign it (JSONException: Value of type)");
    assert_eq!(t.set_override_could_not_sign(KEY, true), vec![nm(4)]);
    assert_eq!(t.summary(KEY)["couldNotSign"], json!({ "count": 1, "used": 1 }));
}

#[test]
fn the_chain_gaps_and_restarts() {
    let dir = tmp("chain");
    let t = CanTrust::new(dir.clone(), Box::new(util::now_ms));
    let mut b = Bridge::new(5);
    for i in 0..4 {
        b.log(&dir, &nm(i), format!("log {}", i).as_bytes(), KEY);
        t.check(KEY, &nm(i));
    }
    assert_eq!(t.chain(KEY), json!({ "count": 4, "first": 0, "last": 3, "issues": [], "restarts": [], "segments": [{ "first": 0, "last": 3, "count": 4 }] }));
    t.deleted(KEY, &nm(1));
    std::fs::remove_file(dir.join(KEY).join(nm(1))).unwrap();
    assert_eq!(t.chain(KEY)["issues"], json!([]));
    b.index += 2;
    b.log(&dir, &nm(6), b"six", KEY);
    t.check(KEY, &nm(6));
    let issues = t.chain(KEY)["issues"].clone();
    assert_eq!(issues[0]["kind"], "gap");
    assert_eq!(issues[0]["text"], "logs 4 to 5 are missing");
    // the bridge starts again at 0
    b.index = 0;
    b.prev = ("-".into(), ZERO.into());
    b.log(&dir, &nm(7), b"seven", KEY);
    t.check(KEY, &nm(7));
    let c = t.chain(KEY);
    assert_eq!(c["restarts"][0]["name"], json!(nm(7)));
    assert_eq!(c["segments"], json!([{ "first": 0, "last": 6, "count": 5 }, { "first": 0, "last": 0, "count": 1 }]), "the deleted log still counts");
}

#[test]
fn columns_sample_decodes_to_the_candump_text() {
    if std::process::Command::new("xz").arg("--version").output().is_err() {
        return;
    }
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/can");
    let text = |f: &str| {
        let mut out = Vec::new();
        let mut found = reader::Found::default();
        reader::read_chunks(&fx.join(f), &reader::Opts::default(), &mut found, |c| {
            out.extend_from_slice(c);
            true
        })
        .unwrap();
        (out, found.format)
    };
    let (a, fa) = text("columns-sample.log.xz");
    let (b, fb) = text("columns-sample.candump.log.xz");
    assert_eq!(fa, Some(reader::FORMAT_COLUMNS));
    assert_eq!(fb, Some(reader::FORMAT_CANDUMP));
    assert_eq!(util::sha256_hex(&b), "94b7e2f631382aaf09df4303fc0256156759c64c20cd34397adbe4fb9b72a5a6");
    assert_eq!(a, b);
    let mut lines = 0;
    reader::read_lines(&fx.join("columns-sample.log.xz"), &reader::Opts::default(), &mut reader::Found::default(), 512, |_| {
        lines += 1;
        true
    })
    .unwrap();
    assert_eq!(lines, 10_851);
    // a cut-off columns body is refused
    let dir = tmp("cols");
    let body = std::process::Command::new("xz").arg("-dc").arg(fx.join("columns-sample.log.xz")).output().unwrap().stdout;
    let cut = &body[..body.len() - 7];
    let mut child = std::process::Command::new("xz").args(["-1", "-c"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(cut).unwrap();
    let packed = child.wait_with_output().unwrap().stdout;
    std::fs::write(dir.join("K_20261108T005818Z_1.log.xz"), packed).unwrap();
    let e = reader::read_chunks(&dir.join("K_20261108T005818Z_1.log.xz"), &reader::Opts::default(), &mut reader::Found::default(), |_| true).unwrap_err();
    assert!(e.refused && e.message.starts_with("could not read K_20261108T005818Z_1.log.xz (canbridge-columns-xz/2): "), "{}", e.message);
}

#[test]
fn times_in_queries() {
    let utc = |y, mo, d, h, mi, s| tz::utc_ms(y, mo, d, h, mi, s) as f64;
    let berlin = |y, mo, d, h, mi, s| tz::zoned_to_utc(y, mo, d, h, mi, s, "Europe/Berlin") as f64;
    assert_eq!(search::parse_when(Some(""), &utc, false).unwrap(), None);
    assert_eq!(search::parse_when(Some("2026-11-08"), &utc, false).unwrap(), Some(utc(2026, 11, 8, 0, 0, 0)));
    assert_eq!(search::parse_when(Some("2026-11-08"), &utc, true).unwrap(), Some(utc(2026, 11, 9, 0, 0, 0) - 1.0));
    assert_eq!(search::parse_when(Some("2026-11-08T14:30"), &berlin, true).unwrap(), Some(utc(2026, 11, 8, 13, 30, 0) + 59_999.0));
    assert_eq!(search::parse_when(Some("2026-11-08T14:30:00+01:00"), &utc, false).unwrap(), Some(utc(2026, 11, 8, 13, 30, 0)));
    assert_eq!(search::parse_when(Some("1794148200000"), &utc, false).unwrap(), Some(1794148200000.0));
    for bad in ["2026-02-30", "2026-11-08T24:00", "yesterday", "2026-11-08T14:61Z"] {
        let e = search::parse_when(Some(bad), &utc, false).unwrap_err();
        assert_eq!(e.status, 400);
        assert!(e.message.contains("is not a time"), "{}", bad);
    }
    assert_eq!(search::local_key(utc(2026, 7, 1, 10, 0, 0), "Europe/Berlin"), "2026-07-01_12-00-00");
    let stamps = vec!["2026-07-01_12-00-00".to_string(), "2026-07-01_12-01-00".to_string()];
    let f = search::footage_at(Some(&stamps), utc(2026, 7, 1, 10, 1, 30), "Europe/Berlin");
    assert_eq!(f["clip"], "2026-07-01_12-01-00");
    assert_eq!(f["second"], 30);
    assert!(search::footage_at(Some(&stamps), utc(2026, 7, 1, 10, 5, 0), "Europe/Berlin").is_null());
}

fn row(name: &str, mtime: f64) -> Row {
    let n = parse_name(name).unwrap();
    Row { name: name.into(), vehicle_key: n.vehicle_key, started_at_ms: n.started_at, seq: n.seq, bytes: 1, mtime_ms: mtime, side_bytes: 0, side_mtime: None, side: None }
}

#[test]
fn logs_spans_and_footage_overlap() {
    let rows = vec![row("K_20261108T140000Z_1.log.xz", 0.0), row("K_20261108T140100Z_2.log.xz", 0.0), row("K_20261108T143000Z_3.log.xz", 0.0)];
    let s = prune::spans(&rows);
    let t0 = tz::utc_ms(2026, 11, 8, 14, 0, 0) as f64;
    assert_eq!((s[0].from, s[0].to), (t0, t0 + 60_000.0));
    assert_eq!(s[1].to - s[1].from, 600_000.0, "the next log 29 minutes later: at most ten");
    assert_eq!(s[2].to - s[2].from, 60_000.0);
    assert!(prune::overlaps(&[t0 - 61_000.0], t0, t0 + 60_000.0), "a clip a minute before reaches into it");
    assert!(!prune::overlaps(&[t0 - 62_000.0], t0, t0 + 60_000.0));
    assert!(!prune::overlaps(&[t0 + 60_000.0], t0, t0 + 60_000.0));
    // the newest: to the end its own sidecar gives, one to ten minutes
    let t3 = tz::utc_ms(2026, 11, 8, 14, 30, 0) as f64;
    for (end, len) in [(Some(t3 + 8.0 * 60_000.0), 480_000.0), (Some(t3 + 10_000.0), 60_000.0), (Some(t3 - 3_600_000.0), 60_000.0), (Some(t3 + 86_400_000.0), 600_000.0), (None, 60_000.0)] {
        let mut rows = rows.clone();
        rows[2].side = Some(SideFacts { end, ..Default::default() });
        rows[0].side = Some(SideFacts { end: Some(t0 + 600_000.0), ..Default::default() });
        let s = prune::spans(&rows);
        assert_eq!(s[2].to - s[2].from, len, "{end:?}");
        assert_eq!(s[0].to - s[0].from, 60_000.0, "the next log's start, not its own end");
    }
}

#[test]
fn uploads_resume_and_check() {
    let dir = tmp("logs");
    let logs = CanLogs::new(dir.clone(), Box::new(|| f64::INFINITY), Box::new(util::now_ms));
    let name = "MY-car_20261108T143000Z_1.log.xz";
    let body = b"0123456789abcdef";
    let sha = util::sha256_hex(body);
    assert_eq!(logs.receive("bad", body, 0.0, 16.0, &sha).unwrap_err().code, "bad_name");
    assert_eq!(logs.receive(name, body, 0.0, 16.0, "xyz").unwrap_err().code, "bad_sha256");
    assert_eq!(logs.receive(name, body, 0.5, 16.0, &sha).unwrap_err().code, "bad_offset");
    assert_eq!(logs.receive(name, &body[..6], 0.0, 16.0, &sha).unwrap(), json!({ "received": 6, "length": 16, "complete": false }));
    let e = logs.receive(name, &body[6..], 5.0, 16.0, &sha).unwrap_err();
    assert_eq!((e.code.as_str(), e.received), ("offset_mismatch", Some(6.0)));
    assert_eq!(logs.receive(name, &body[6..], 6.0, 17.0, &sha).unwrap_err().code, "length_changed");
    assert_eq!(logs.status(Some(&json!([name, "x"])), None).unwrap()["files"][name], json!({ "state": "partial", "received": 6, "length": 16, "size": 16 }));
    assert_eq!(logs.receive(name, &body[6..], 6.0, 16.0, &sha).unwrap(), json!({ "received": 16, "length": 16, "complete": true }));
    assert_eq!(logs.receive(name, body, 0.0, 16.0, &sha).unwrap()["already"], true);
    assert_eq!(logs.receive(name, b"other bytes 1234", 0.0, 16.0, &util::sha256_hex(b"other bytes 1234")).unwrap_err().code, "exists_different");
    let side = format!("{}.json", name);
    assert_eq!(logs.receive(&side, b"not json", 0.0, 8.0, &util::sha256_hex(b"not json")).unwrap_err().code, "bad_sidecar");
    assert_eq!(logs.receive(&side, b"{\"frames\":5}", 0.0, 12.0, &util::sha256_hex(b"{\"frames\":5}")).unwrap()["complete"], true);
    let list = logs.list(200.0);
    assert_eq!(list["count"], 1);
    assert_eq!(list["logs"][0]["frames"], 5);
    assert_eq!(logs.status(Some(&json!([name])), Some("other")).unwrap()["files"][name]["state"], "forbidden");
    logs.remove(name).unwrap();
    assert_eq!(logs.list(200.0)["count"], 0);
    assert_eq!(logs.remove(name).unwrap_err().status, 404);
}

#[test]
fn sentry_usb_files() {
    let s = sentry_usb::parse_status(r#"{"schema":1,"written_unix":1762800000,"state":"transferring","transfer":{"started_unix":1762800000,"files":48,"first_clip":"RecentClips/2026-11-10_12-01-00-front.mp4","last_clip":"RecentClips/2026-11-10_12-00-00-front.mp4","give_up_unix":1762801000},"snapshot_interval_s":3480,"snapshots":[{"started_unix":1762700000},{"started_unix":1762790000,"name":"s2"},{"started_unix":1762790000}]}"#).unwrap();
    let now = sentry_usb::interpret(Some(&s), 1762800500.0 * 1000.0);
    assert!(now.transferring && !now.overdue);
    assert_eq!(now.range.unwrap().0, "2026-11-10_12-00-00-front.mp4");
    assert!(sentry_usb::interpret(Some(&s), 1762801001.0 * 1000.0).overdue);
    let gaps = sentry_usb::snapshot_gaps(s.snapshots.as_ref().unwrap(), 3480);
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0].lost_to_unix, Some(1762790000 - 3600));
    assert!(sentry_usb::parse_status(r#"{"schema":2}"#).is_none());
    // the info file: a bad reading dropped, the rest kept
    let d = sentry_usb::parse_device(r#"{"schema":1,"written_unix":1762800000,"cpu_temp_c":51.24,"car":{"battery":{"pct":89.04},"exterior":{"c":99},"tires":{"fl":{"kpa":290.3},"state":"nope"}}}"#, 1762800000.0 * 1000.0).unwrap();
    assert_eq!(d["cpuTempC"], json!(51.2));
    assert_eq!(d["car"], json!({ "battery": { "pct": 89 }, "tires": { "fl": { "kpa": 290.3 } } }));
    assert!(sentry_usb::parse_device(r#"{"schema":1,"written_unix":1000}"#, 1762800000.0 * 1000.0).is_none());
    // what the car wrote
    let cf = sentry_usb::parse_car_files("# path\tsize\tmtime_unix\tfirst_seen_unix\nRecentClips/2026-11-10_12-00-00-front.mp4\t30\t1762790000\t1762800000\n../x.mp4\t1\t1762790000\t1762800000\nSentryClips/2026-11-10_12-00-00/2026-11-10_11-59-00-back.mp4\t5\t1762790000\t1762800001\n");
    assert_eq!((cf.lines, cf.bad, cf.clips.len()), (3, 1, 2));
    let days = sentry_usb::daily_counts(cf.clips.values());
    assert_eq!(days["2026-11-10"], json!({ "recentFiles": 1, "minutes": 1, "sentryEvents": 1, "savedEvents": 0 }));
}

// ---- the upload API's `check` (POST /api/can/logs/status) and replacing a failed log

fn checked(dir: &Path) -> (Arc<CanLogs>, Arc<CanTrust>) {
    let logs = CanLogs::new(dir.to_path_buf(), Box::new(|| f64::INFINITY), Box::new(util::now_ms));
    let trust = CanTrust::new(dir.to_path_buf(), Box::new(util::now_ms));
    logs.set_trust(trust.clone());
    (logs, trust)
}
fn ask(logs: &CanLogs, names: &[String]) -> Value {
    logs.status(Some(&json!(names)), Some(KEY)).unwrap()["files"].clone()
}
fn check_of(files: &Value, name: &str) -> (String, String) {
    (files[name]["check"].as_str().unwrap_or("-").into(), files[name]["check_reason"].as_str().unwrap_or("-").into())
}
/// A good signature of other bytes.
fn other_sig(b: &Bridge) -> String {
    let sig: Signature = b.sk.sign(b"something else");
    base64(sig.to_der().as_bytes())
}
fn pair(a: &str, b: &str) -> (String, String) {
    (a.into(), b.into())
}

#[test]
fn status_answers_each_check_and_its_reason() {
    let dir = tmp("check");
    let (logs, t) = checked(&dir);
    let kdir = dir.join(KEY);
    let mut b = Bridge::new(7);
    let names: Vec<String> = (0..8).map(nm).collect();
    // 0: signed, the first of its chain
    b.log(&dir, &names[0], b"log zero", KEY);
    // 1: well signed, but it names log 0 with another SHA-256 (swapped or changed)
    b.prev.1 = "11".repeat(32);
    b.log(&dir, &names[1], b"log one!", KEY);
    // 2: follows log 1 as it is here
    b.log(&dir, &names[2], b"log two!", KEY);
    // 3: the signature broken
    b.log(&dir, &names[3], b"log 3333", KEY);
    let sp = kdir.join(format!("{}.json", names[3]));
    let mut side: Value = serde_json::from_str(&std::fs::read_to_string(&sp).unwrap()).unwrap();
    side["integrity"]["signature"] = json!(other_sig(&b));
    std::fs::write(&sp, stringify(&side)).unwrap();
    // 4: the log is not the one signed (same length, other bytes)
    b.log(&dir, &names[4], b"log four", KEY);
    std::fs::write(kdir.join(&names[4]), b"log FOUR").unwrap();
    // 5: the bridge could not sign it
    std::fs::write(kdir.join(&names[5]), b"log five").unwrap();
    std::fs::write(kdir.join(format!("{}.json", names[5])), r#"{"integrity":{"signed":false,"error":"no key"}}"#).unwrap();
    // 6: its sidecar has not arrived; 7: here, not judged yet
    std::fs::write(kdir.join(&names[6]), b"log six!").unwrap();
    std::fs::write(kdir.join(&names[7]), b"log 7777").unwrap();
    let before = ask(&logs, &names);
    for nm_ in &names {
        assert_eq!(check_of(&before, nm_), pair("pending", "-"), "nothing judged yet: {nm_}");
        assert_eq!(before[nm_]["state"], "complete");
        assert_eq!(before[nm_]["size"], 8);
    }
    for nm_ in &names[..7] {
        t.check(KEY, nm_);
    }
    let f = ask(&logs, &names);
    assert_eq!(check_of(&f, &names[0]), pair("verified", "-"));
    assert_eq!(check_of(&f, &names[1]), pair("failed", "chain_break"));
    assert_eq!(check_of(&f, &names[2]), pair("verified", "-"));
    assert_eq!(check_of(&f, &names[3]), pair("failed", "bad_signature"));
    assert_eq!(check_of(&f, &names[4]), pair("failed", "mismatch"));
    assert_eq!(check_of(&f, &names[5]), pair("failed", "unsigned"));
    assert_eq!(check_of(&f, &names[6]), pair("pending", "-"), "waiting for its sidecar");
    assert_eq!(check_of(&f, &names[7]), pair("pending", "-"));
    assert_eq!(f[&names[0]], json!({ "state": "complete", "received": 8, "length": 8, "size": 8, "check": "verified" }));
    // a sidecar answers its log's check; one whose log is not here is pending
    let side0 = format!("{}.json", names[0]);
    let lone = format!("{}.json", nm(9));
    std::fs::write(kdir.join(&lone), "{}").unwrap();
    let s = ask(&logs, &[side0.clone(), lone.clone(), nm(10)]);
    assert_eq!(check_of(&s, &side0), pair("verified", "-"));
    assert_eq!(check_of(&s, &lone), pair("pending", "-"));
    assert_eq!(s[&nm(10)], json!({ "state": "missing", "received": 0, "length": null, "size": 0 }), "no check for a file not here");
    // its sidecar arrives: judged again, verified (it follows log 4, whose own check failed:
    // not log 6's fault)
    b.log(&dir, &names[6], b"log six!", KEY);
    t.check(KEY, &names[6]);
    assert_eq!(check_of(&ask(&logs, &names), &names[6]), pair("verified", "-"));
    // unpaired and unsigned is failed too: the bridge is told it is not verified
    let dir2 = tmp("check-unpaired");
    let (logs2, t2) = checked(&dir2);
    std::fs::create_dir_all(dir2.join(KEY)).unwrap();
    std::fs::write(dir2.join(KEY).join(&names[0]), b"x").unwrap();
    std::fs::write(dir2.join(KEY).join(format!("{}.json", names[0])), "{}").unwrap();
    assert_eq!(t2.check(KEY, &names[0])["status"], "unsigned");
    assert_eq!(check_of(&ask(&logs2, &names[..1]), &names[0]), pair("failed", "unsigned"));
}

/// One file sent through the upload API in `parts` chunks.
fn send(logs: &CanLogs, name: &str, body: &[u8], parts: usize) -> Result<Value, sentry_lean::can::logs::CanError> {
    let sha = util::sha256_hex(body);
    let step = body.len().div_ceil(parts);
    let mut out = Value::Null;
    for (i, chunk) in body.chunks(step).enumerate() {
        out = logs.receive(name, chunk, (i * step) as f64, body.len() as f64, &sha)?;
    }
    Ok(out)
}

#[test]
fn a_failed_log_is_replaced_by_a_resend_a_verified_one_never() {
    let src = tmp("check-bridge");
    let dir = tmp("check-replace");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(9);
    let names: Vec<String> = (0..3).map(nm).collect();
    let bodies: Vec<Vec<u8>> = (0..3).map(|i| format!("the log number {i}, as the bridge wrote it").into_bytes()).collect();
    for i in 0..3 {
        b.log(&src, &names[i], &bodies[i], KEY);
    }
    let side = |i: usize| std::fs::read(src.join(KEY).join(format!("{}.json", names[i]))).unwrap();
    let sname = |i: usize| format!("{}.json", names[i]);
    // log 0 arrives intact; log 1 arrives damaged (the same length); log 2's sidecar broken
    send(&logs, &names[0], &bodies[0], 1).unwrap();
    send(&logs, &sname(0), &side(0), 1).unwrap();
    let mut bad = bodies[1].clone();
    bad[3] ^= 0x20;
    send(&logs, &names[1], &bad, 1).unwrap();
    send(&logs, &sname(1), &side(1), 1).unwrap();
    send(&logs, &names[2], &bodies[2], 1).unwrap();
    let mut s2: Value = serde_json::from_slice(&side(2)).unwrap();
    s2["integrity"]["signature"] = json!(other_sig(&b));
    let bad_side = stringify(&s2).into_bytes();
    send(&logs, &sname(2), &bad_side, 1).unwrap();
    for n_ in &names {
        t.check(KEY, n_);
    }
    let f = ask(&logs, &names);
    assert_eq!(check_of(&f, &names[0]), pair("verified", "-"));
    assert_eq!(check_of(&f, &names[1]), pair("failed", "mismatch"));
    assert_eq!(check_of(&f, &names[2]), pair("failed", "bad_signature"));
    // a verified log is never replaced; its identical copy is "already" as before
    let e = send(&logs, &names[0], b"some other bytes", 1).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (409, "exists_different"));
    assert_eq!(send(&logs, &names[0], &bodies[0], 1).unwrap()["already"], true);
    let e = send(&logs, &sname(0), b"{\"other\":1}", 1).unwrap_err();
    assert_eq!(e.code, "exists_different", "nor the sidecar of a verified log");
    // the failed one's identical copy changes nothing either
    assert_eq!(send(&logs, &names[1], &bad, 1).unwrap()["already"], true);
    // "Resend all": the good copy in two chunks; the bad one stays until it is all here
    let sha = util::sha256_hex(&bodies[1]);
    let half = bodies[1].len() / 2;
    let len = bodies[1].len() as f64;
    assert_eq!(logs.receive(&names[1], &bodies[1][..half], 0.0, len, &sha).unwrap()["complete"], false);
    assert_eq!(std::fs::read(dir.join(KEY).join(&names[1])).unwrap(), bad, "the old copy is kept until the new one is complete");
    assert_eq!(ask(&logs, &names[1..2])[&names[1]], json!({ "state": "partial", "received": half, "length": bodies[1].len(), "size": bodies[1].len() }), "the bridge resumes it");
    let done = logs.receive(&names[1], &bodies[1][half..], half as f64, len, &sha).unwrap();
    assert_eq!(done, json!({ "received": bodies[1].len(), "length": bodies[1].len(), "complete": true, "replaced": true }));
    assert_eq!(std::fs::read(dir.join(KEY).join(&names[1])).unwrap(), bodies[1]);
    assert_eq!(check_of(&ask(&logs, &names), &names[1]), pair("pending", "-"), "not judged again yet");
    t.check(KEY, &names[1]);
    // (log 2 names log 1 as its previous: its own failure is its sidecar's)
    let f = ask(&logs, &names);
    assert_eq!(check_of(&f, &names[1]), pair("verified", "-"));
    assert_eq!(check_of(&f, &names[2]), pair("failed", "bad_signature"));
    // a failed log's sidecar is replaced the same way
    assert_eq!(send(&logs, &sname(2), &side(2), 1).unwrap()["replaced"], true);
    assert_eq!(check_of(&ask(&logs, &names), &names[2]), pair("pending", "-"));
    t.check(KEY, &names[2]);
    let f = ask(&logs, &[names.clone(), vec![sname(2)]].concat());
    assert_eq!(check_of(&f, &names[2]), pair("verified", "-"));
    assert_eq!(check_of(&f, &sname(2)), pair("verified", "-"));
    // now verified: no more replacing
    assert_eq!(send(&logs, &names[1], &bad, 1).unwrap_err().code, "exists_different");
    assert_eq!(t.chain(KEY)["issues"], json!([]), "the chain is whole again");
    assert_eq!(logs.list(10.0)["count"], 3);
}

#[test]
fn five_hundred_names_in_one_status() {
    let dir = tmp("check-500");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(11);
    let names: Vec<String> = (0..500).map(|i| format!("{}_20261108T{:02}{:02}00Z_{}.log.xz", KEY, 10 + i / 60, i % 60, i + 1)).collect();
    for (i, n_) in names.iter().enumerate() {
        b.log(&dir, n_, format!("log {i}").as_bytes(), KEY);
        t.check(KEY, n_);
    }
    let started = std::time::Instant::now();
    let f = ask(&logs, &names);
    let took = started.elapsed();
    assert_eq!(f.as_object().unwrap().len(), 500);
    assert!(names.iter().all(|n_| f[n_]["check"] == "verified"), "{:?}", names.iter().find(|n_| f[*n_]["check"] != "verified").map(|n_| &f[n_]));
    assert!(took < std::time::Duration::from_secs(2), "500 names took {took:?}");
}

#[test]
fn a_key_trusted_as_a_resend_finishes_keeps_the_log_it_verified() {
    let dir = tmp("check-race");
    let (logs, t) = checked(&dir);
    let mut a = Bridge::new(21);
    let mut b = Bridge::new(22);
    // log 0 pins key A; log 1 is signed by key B, which waits for the owner's OK
    a.log(&dir, &nm(0), b"log zero, key A", KEY);
    assert_eq!(t.check(KEY, &nm(0))["status"], "verified");
    b.log(&dir, &nm(1), b"log one!, key B", KEY);
    assert_eq!(status(&t.check(KEY, &nm(1))), ("failed".into(), "signed by a key this car is not paired with".into()));
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("failed", "bad_signature"));
    // a resend of another copy is all here when the owner trusts key B: that verifies the stored
    // copy, which the resend must then not overwrite
    let (t2, fp) = (t.clone(), b.fp());
    logs.set_before_swap(Box::new(move || {
        t2.trust_key(KEY, &fp).unwrap();
    }));
    let e = send(&logs, &nm(1), b"another copy of log one", 2).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (409, "exists_different"));
    assert_eq!(std::fs::read(dir.join(KEY).join(nm(1))).unwrap(), b"log one!, key B", "the verified copy is kept");
    assert_eq!(t.record(KEY, &nm(1)).unwrap()["status"], "verified");
    assert!(!dir.join(KEY).join(format!("{}.part", nm(1))).exists(), "the refused copy's .part is dropped, as before");
    assert!(!dir.join(KEY).join(format!("{}.part.json", nm(1))).exists());
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("verified", "-"));
}

#[test]
fn both_halves_of_a_failed_pair_are_taken_while_the_first_waits() {
    let src = tmp("pair-bridge");
    let dir = tmp("pair");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(23);
    b.log(&src, &nm(0), b"the log as the bridge wrote it", KEY);
    let body = std::fs::read(src.join(KEY).join(nm(0))).unwrap();
    let side = std::fs::read(src.join(KEY).join(format!("{}.json", nm(0)))).unwrap();
    let sname = format!("{}.json", nm(0));
    // both arrived damaged: the log's bytes and its sidecar's signature
    let mut bad = body.clone();
    bad[2] ^= 0x20;
    let mut s: Value = serde_json::from_slice(&side).unwrap();
    s["integrity"]["signature"] = json!(other_sig(&b));
    send(&logs, &nm(0), &bad, 1).unwrap();
    send(&logs, &sname, stringify(&s).as_bytes(), 1).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    // "Resend all": the log first (its record now waits to be judged again), then its sidecar,
    // sent before the judge has run
    assert_eq!(send(&logs, &nm(0), &body, 1).unwrap()["replaced"], true);
    assert_eq!(t.record(KEY, &nm(0)).unwrap()["status"], "waiting");
    assert_eq!(t.record(KEY, &nm(0)).unwrap()["replaced"], "log");
    assert_eq!(send(&logs, &nm(0), &body, 2).unwrap()["already"], true, "the log itself again");
    assert_eq!(send(&logs, &sname, &side, 1).unwrap()["replaced"], true, "the other half of the pair");
    assert_eq!(t.record(KEY, &nm(0)).unwrap()["replaced"], "both");
    assert_eq!(std::fs::read(dir.join(KEY).join(&sname)).unwrap(), side);
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("pending", "-"));
    t.check(KEY, &nm(0));
    let f = ask(&logs, &[nm(0), sname.clone()]);
    assert_eq!(check_of(&f, &nm(0)), pair("verified", "-"));
    assert_eq!(check_of(&f, &sname), pair("verified", "-"));
    // the sidecar first works the same way
    let dir = tmp("pair-side-first");
    let (logs, t) = checked(&dir);
    send(&logs, &nm(0), &bad, 1).unwrap();
    send(&logs, &sname, stringify(&s).as_bytes(), 1).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    assert_eq!(send(&logs, &sname, &side, 1).unwrap()["replaced"], true);
    assert_eq!(send(&logs, &nm(0), &body, 1).unwrap()["replaced"], true);
    t.check(KEY, &nm(0));
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("verified", "-"));
    // once judged (verified), neither half is replaced any more
    assert_eq!(send(&logs, &nm(0), &bad, 1).unwrap_err().code, "exists_different");
    assert_eq!(send(&logs, &sname, stringify(&s).as_bytes(), 1).unwrap_err().code, "exists_different");
}

#[test]
fn a_log_whose_sidecar_has_not_arrived_is_pending_however_long_it_waits() {
    let start = 1_800_000_000_000u64;
    let clocked = |dir: &Path| {
        let clock = Arc::new(AtomicU64::new(start));
        let c = clock.clone();
        let logs = CanLogs::new(dir.to_path_buf(), Box::new(|| f64::INFINITY), Box::new(util::now_ms));
        let t = CanTrust::new(dir.to_path_buf(), Box::new(move || c.load(Ordering::SeqCst) as f64));
        logs.set_trust(t.clone());
        (logs, t, clock)
    };
    let late = start + 11 * 60_000;
    // a paired car: log 1 arrives, its sidecar does not
    let dir = tmp("late-paired");
    let (logs, t, clock) = clocked(&dir);
    let mut b = Bridge::new(25);
    b.log(&dir, &nm(0), b"log zero", KEY);
    assert_eq!(t.check(KEY, &nm(0))["status"], "verified");
    send(&logs, &nm(1), b"log one!", 1).unwrap();
    assert_eq!(t.check(KEY, &nm(1))["status"], "waiting");
    clock.store(late, Ordering::SeqCst);
    let r = t.check(KEY, &nm(1));
    assert_eq!((r["status"].clone(), r["signed"].clone()), (json!("failed"), json!(false)), "the server judges it not signed, as before");
    assert_eq!(t.usable(KEY, &nm(1)), (false, None));
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("pending", "-"), "its sidecar has not arrived");
    let e = send(&logs, &nm(1), b"another copy", 1).unwrap_err();
    assert_eq!(e.code, "exists_different", "nothing here says this copy is bad");
    // the sidecar arrives and says the bridge could not sign it: failed, unsigned (and a resend
    // may replace it)
    send(&logs, &format!("{}.json", nm(1)), br#"{"integrity":{"signed":false,"error":"no key"}}"#, 1).unwrap();
    t.check(KEY, &nm(1));
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("failed", "unsigned"));
    assert_eq!(send(&logs, &nm(1), b"another copy", 1).unwrap()["replaced"], true);
    // a car not paired yet: unsigned, still used by the server, pending for the bridge
    let dir = tmp("late-unpaired");
    let (logs, t, clock) = clocked(&dir);
    send(&logs, &nm(0), b"log zero", 1).unwrap();
    t.check(KEY, &nm(0));
    clock.store(late, Ordering::SeqCst);
    assert_eq!(t.check(KEY, &nm(0))["status"], "unsigned");
    assert_eq!(t.usable(KEY, &nm(0)), (true, Some("unsigned")), "the server's own use is as before");
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("pending", "-"));
    // an unsigned record whose sidecar is here is failed, unsigned
    std::fs::write(dir.join(KEY).join(format!("{}.json", nm(0))), "{}").unwrap();
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("failed", "unsigned"));
}

#[test]
fn a_chain_break_from_the_previous_log_is_never_replaced() {
    let src = tmp("break-bridge");
    let dir = tmp("break");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(27);
    b.log(&src, &nm(0), b"log zero", KEY);
    // log 1 is well signed, but names a log 0 with another SHA-256 than the one here
    b.prev.1 = "22".repeat(32);
    b.log(&src, &nm(1), b"log one!", KEY);
    let file = |i: usize, side: bool| std::fs::read(src.join(KEY).join(if side { format!("{}.json", nm(i)) } else { nm(i) })).unwrap();
    for i in 0..2 {
        send(&logs, &nm(i), &file(i, false), 1).unwrap();
        send(&logs, &format!("{}.json", nm(i)), &file(i, true), 1).unwrap();
        t.check(KEY, &nm(i));
    }
    assert_eq!(t.record(KEY, &nm(1)).unwrap()["status"], "verified", "the stored record itself is good");
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("failed", "chain_break"));
    // resending it: the same bytes are already here; another copy never takes the good one's place
    assert_eq!(send(&logs, &nm(1), &file(1, false), 1).unwrap()["already"], true);
    let e = send(&logs, &nm(1), b"another log one", 1).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (409, "exists_different"));
    assert_eq!(send(&logs, &format!("{}.json", nm(1)), b"{\"other\":1}", 1).unwrap_err().code, "exists_different");
    assert_eq!(std::fs::read(dir.join(KEY).join(nm(1))).unwrap(), file(1, false));
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("failed", "chain_break"), "still reported");
}

#[test]
fn every_status_entry_has_a_size() {
    let dir = tmp("sizes");
    let (logs, _t) = checked(&dir);
    let kdir = dir.join(KEY);
    let body = b"0123456789abcdef";
    let sha = util::sha256_hex(body);
    logs.receive(&nm(0), &body[..6], 0.0, 16.0, &sha).unwrap();
    // a partial upload whose length is not known (what it promised is lost)
    std::fs::write(kdir.join(format!("{}.part", nm(1))), b"abc").unwrap();
    send(&logs, &nm(2), body, 1).unwrap();
    let other = "other_20261108T140000Z_1.log.xz".to_string();
    let f = logs.status(Some(&json!([nm(0), nm(1), nm(2), nm(3), "x", other])), Some(KEY)).unwrap()["files"].clone();
    assert_eq!(f[&nm(0)], json!({ "state": "partial", "received": 6, "length": 16, "size": 16 }), "the whole file's size once known");
    assert_eq!(f[&nm(1)], json!({ "state": "partial", "received": 3, "length": null, "size": 3 }), "the bytes so far");
    assert_eq!(f[&nm(2)], json!({ "state": "complete", "received": 16, "length": 16, "size": 16, "check": "pending" }));
    assert_eq!(f[&nm(3)], json!({ "state": "missing", "received": 0, "length": null, "size": 0 }));
    assert_eq!(f["x"], json!({ "state": "invalid", "received": 0, "length": null, "size": 0 }));
    assert_eq!(f[&other], json!({ "state": "forbidden", "received": 0, "length": null, "size": 0 }));
}

#[test]
fn recheck_if_failed_goes_by_the_stored_record_alone() {
    let dir = tmp("recheck");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(29);
    b.log(&dir, &nm(0), b"log zero", KEY);
    b.prev.1 = "33".repeat(32);
    b.log(&dir, &nm(1), b"log one!", KEY);
    b.log(&dir, &nm(2), b"log two!", KEY);
    std::fs::write(dir.join(KEY).join(nm(2)), b"log TWO!").unwrap();
    for i in 0..3 {
        t.check(KEY, &nm(i));
    }
    assert_eq!(check_of(&ask(&logs, &[nm(1)]), &nm(1)), pair("failed", "chain_break"));
    assert!(!t.recheck_if_failed(KEY, &nm(0), 8.0, Half::Log), "verified");
    assert!(!t.recheck_if_failed(KEY, &nm(1), 8.0, Half::Log), "a chain break worked out from the previous log");
    assert!(!t.recheck_if_failed(KEY, &nm(2), 9.0, Half::Log), "a record of another size");
    assert!(!t.recheck_if_failed(KEY, &nm(5), 8.0, Half::Log), "no record");
    assert!(t.recheck_if_failed(KEY, &nm(2), 8.0, Half::Log), "mismatch");
    assert_eq!(status(&t.record(KEY, &nm(2)).unwrap()), ("waiting".into(), "replaced by a new copy; checking it again".into()));
    assert!(!t.recheck_if_failed(KEY, &nm(2), 8.0, Half::Log), "waiting after a replacement: not the same half again");
    assert!(t.recheck_if_failed(KEY, &nm(2), 123.0, Half::Sidecar), "the other half, of any size");
    assert!(!t.recheck_if_failed(KEY, &nm(2), 8.0, Half::Sidecar), "only once");
    t.check(KEY, &nm(2));
    assert!(t.record(KEY, &nm(2)).unwrap().get("replaced").is_none(), "judged: no half replaced any more");
    // a swap that fails leaves the record as it was
    let e = t.replace_if_failed(KEY, &nm(2), 8.0, Half::Log, || Err(std::io::Error::other("disk full"))).unwrap_err();
    assert_eq!(e.to_string(), "disk full");
    assert_eq!(t.record(KEY, &nm(2)).unwrap()["status"], "failed");
}

#[test]
fn a_replaced_half_is_not_replaced_again_before_its_check() {
    let src = tmp("half-bridge");
    let dir = tmp("half");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(31);
    b.log(&src, &nm(0), b"the log as the bridge wrote it", KEY);
    let body = std::fs::read(src.join(KEY).join(nm(0))).unwrap();
    let side = std::fs::read(src.join(KEY).join(format!("{}.json", nm(0)))).unwrap();
    let sname = format!("{}.json", nm(0));
    let mut bad = body.clone();
    bad[2] ^= 0x20;
    send(&logs, &nm(0), &bad, 1).unwrap();
    send(&logs, &sname, &side, 1).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    // the log is resent: its record waits to be judged again
    assert_eq!(send(&logs, &nm(0), &body, 1).unwrap()["replaced"], true);
    // the same log again is already here; any other copy, of any size, is refused
    assert_eq!(send(&logs, &nm(0), &body, 2).unwrap()["already"], true);
    let e = send(&logs, &nm(0), b"a copy of another size entirely", 1).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (409, "exists_different"));
    assert_eq!(send(&logs, &nm(0), &bad, 1).unwrap_err().code, "exists_different");
    assert_eq!(std::fs::read(dir.join(KEY).join(nm(0))).unwrap(), body, "the resent copy is kept");
    // the other half, once
    let mut s2: Value = serde_json::from_slice(&side).unwrap();
    s2["frames"] = json!(11);
    assert_eq!(send(&logs, &sname, stringify(&s2).as_bytes(), 1).unwrap()["replaced"], true);
    assert_eq!(send(&logs, &sname, stringify(&s2).as_bytes(), 1).unwrap()["already"], true);
    assert_eq!(send(&logs, &sname, &side, 1).unwrap_err().code, "exists_different", "both halves replaced: nothing more");
    assert_eq!(send(&logs, &nm(0), &bad, 1).unwrap_err().code, "exists_different");
    t.check(KEY, &nm(0));
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("verified", "-"));
    // the sidecar first: then only the log may follow
    let dir = tmp("half-side-first");
    let (logs, t) = checked(&dir);
    send(&logs, &nm(0), &bad, 1).unwrap();
    send(&logs, &sname, &side, 1).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    assert_eq!(send(&logs, &sname, stringify(&s2).as_bytes(), 1).unwrap()["replaced"], true);
    assert_eq!(send(&logs, &sname, &side, 1).unwrap_err().code, "exists_different");
    assert_eq!(send(&logs, &nm(0), &body, 1).unwrap()["replaced"], true);
    assert_eq!(send(&logs, &nm(0), &bad, 1).unwrap_err().code, "exists_different");
    t.check(KEY, &nm(0));
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("verified", "-"));
}

#[test]
fn a_replaced_log_that_could_not_be_read_is_not_replaceable_until_judged() {
    let src = tmp("io-bridge");
    let dir = tmp("io");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(33);
    b.log(&src, &nm(0), b"the log as the bridge wrote it", KEY);
    let body = std::fs::read(src.join(KEY).join(nm(0))).unwrap();
    let side = std::fs::read(src.join(KEY).join(format!("{}.json", nm(0)))).unwrap();
    let sname = format!("{}.json", nm(0));
    let mut bad = body.clone();
    bad[2] ^= 0x20;
    send(&logs, &nm(0), &bad, 1).unwrap();
    send(&logs, &sname, &side, 1).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    assert_eq!(send(&logs, &nm(0), &body, 1).unwrap()["replaced"], true);
    // the judge cannot read the log (here: a folder where the file was)
    let file = dir.join(KEY).join(nm(0));
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    t.check(KEY, &nm(0));
    let r = t.record(KEY, &nm(0)).unwrap();
    assert_eq!(r["status"], "waiting", "still to be judged");
    assert_ne!(r["reason"], "replaced by a new copy; checking it again", "but no longer open to a new copy");
    assert!(t.pending().contains(&(KEY.to_string(), nm(0))), "judged again by the pending pass");
    std::fs::remove_dir(&file).unwrap();
    std::fs::write(&file, &body).unwrap();
    let mut s2: Value = serde_json::from_slice(&side).unwrap();
    s2["frames"] = json!(11);
    // the other half of a Resend all meanwhile: not a different file (the bridge would report
    // that as a bug) but a retryable 409 busy, from offset 0
    let e = send(&logs, &sname, stringify(&s2).as_bytes(), 1).unwrap_err();
    assert_eq!((e.status, e.code.as_str(), e.received), (409, "busy", Some(0.0)));
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("pending", "-"));
    t.check(KEY, &nm(0));
    assert_eq!(check_of(&ask(&logs, &[nm(0)]), &nm(0)), pair("verified", "-"));
}

#[test]
fn a_replaced_log_that_could_not_be_read_as_the_other_half_arrives_answers_busy() {
    let src = tmp("io-swap-bridge");
    let dir = tmp("io-swap");
    let (logs, t) = checked(&dir);
    let mut b = Bridge::new(34);
    b.log(&src, &nm(0), b"the log as the bridge wrote it", KEY);
    let body = std::fs::read(src.join(KEY).join(nm(0))).unwrap();
    let side = std::fs::read(src.join(KEY).join(format!("{}.json", nm(0)))).unwrap();
    let sname = format!("{}.json", nm(0));
    let mut bad = body.clone();
    bad[2] ^= 0x20;
    send(&logs, &nm(0), &bad, 1).unwrap();
    send(&logs, &sname, &side, 1).unwrap();
    assert_eq!(t.check(KEY, &nm(0))["status"], "failed");
    assert_eq!(send(&logs, &nm(0), &body, 1).unwrap()["replaced"], true);
    // the sidecar's new copy is all here when the judge fails to read the replaced log
    let (t2, file) = (t.clone(), dir.join(KEY).join(nm(0)));
    logs.set_before_swap(Box::new(move || {
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        t2.check(KEY, &nm(0));
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, b"the log as the bridge wrote it").unwrap();
    }));
    let mut s2: Value = serde_json::from_slice(&side).unwrap();
    s2["frames"] = json!(11);
    let e = send(&logs, &sname, stringify(&s2).as_bytes(), 1).unwrap_err();
    assert_eq!((e.status, e.code.as_str(), e.received), (409, "busy", Some(0.0)), "retryable, not exists_different");
    assert_eq!(std::fs::read(dir.join(KEY).join(&sname)).unwrap(), side, "the stored sidecar stays");
    assert!(!dir.join(KEY).join(format!("{}.part", sname)).exists(), "the new copy's .part is dropped");
}

#[test]
fn a_chain_continued_from_an_older_sidecar_is_no_mismatch() {
    let dir = tmp("chain-fork");
    let t = CanTrust::new(dir.clone(), Box::new(util::now_ms));
    let mut b = Bridge::new(6);
    for i in 0..13 {
        b.log(&dir, &nm(i), format!("log {}", i).as_bytes(), KEY);
        t.check(KEY, &nm(i));
    }
    // logs 10-12 went up from RAM; then RAM and chain.json were lost: the bridge goes on from
    // the newest signed sidecar it still has (log 9), so 10-12 come again under new names
    b.index = 10;
    b.prev = (nm(9), util::sha256_hex(b"log 9"));
    for i in 13..17 {
        b.log(&dir, &nm(i), format!("log {} again", i).as_bytes(), KEY);
        t.check(KEY, &nm(i));
    }
    let c = t.chain(KEY);
    let kinds: Vec<&str> = c["issues"].as_array().unwrap().iter().map(|x| x["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["duplicate", "duplicate", "duplicate"], "{c}");
    assert_eq!(c["issues"][0]["names"], json!([nm(10), nm(13)]));
    // a link that fits no stored copy of the index before is still a mismatch
    b.prev = (nm(16), ZERO.into());
    b.log(&dir, &nm(17), b"a wrong link", KEY);
    t.check(KEY, &nm(17));
    let c = t.chain(KEY);
    let last = c["issues"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["kind"].as_str(), last["index"].as_i64()), (Some("mismatch"), Some(14)), "{c}");
}

#[test]
fn a_previous_log_not_signed_for_want_of_its_sidecar_leaves_the_link_pending() {
    let start = 1_800_000_000_000u64;
    let src = tmp("prev-unsigned-bridge");
    let dir = tmp("prev-unsigned");
    let clock = Arc::new(AtomicU64::new(start));
    let c = clock.clone();
    let logs = CanLogs::new(dir.to_path_buf(), Box::new(|| f64::INFINITY), Box::new(util::now_ms));
    let t = CanTrust::new(dir.to_path_buf(), Box::new(move || c.load(Ordering::SeqCst) as f64));
    logs.set_trust(t.clone());
    let mut b = Bridge::new(35);
    b.log(&src, &nm(0), b"log zero", KEY);
    b.log(&src, &nm(1), b"log one!", KEY);
    let file = |i: usize, side: bool| std::fs::read(src.join(KEY).join(if side { format!("{}.json", nm(i)) } else { nm(i) })).unwrap();
    // log 0 arrives without its sidecar, and after 10 minutes is judged not signed
    send(&logs, &nm(0), &file(0, false), 1).unwrap();
    t.check(KEY, &nm(0));
    clock.store(start + 11 * 60_000, Ordering::SeqCst);
    assert_eq!(t.check(KEY, &nm(0))["status"], "unsigned");
    // log 1 arrives whole and well signed, naming log 0
    send(&logs, &nm(1), &file(1, false), 1).unwrap();
    send(&logs, &format!("{}.json", nm(1)), &file(1, true), 1).unwrap();
    assert_eq!(t.check(KEY, &nm(1))["status"], "verified");
    let f = ask(&logs, &[nm(0), nm(1)]);
    assert_eq!(check_of(&f, &nm(0)), pair("pending", "-"));
    assert_eq!(check_of(&f, &nm(1)), pair("pending", "-"), "not a chain break while log 0 waits for its sidecar");
    // log 0's sidecar arrives: judged, and the link is checked as usual
    send(&logs, &format!("{}.json", nm(0)), &file(0, true), 1).unwrap();
    // while log 0 waits to be judged again (it still carries its old signed:false), log 1's
    // link is not known yet: pending, not verified
    assert!(t.recheck_if_failed(KEY, &nm(0), 8.0, Half::Sidecar));
    let f = ask(&logs, &[nm(1)]);
    assert_eq!(check_of(&f, &nm(1)), pair("pending", "-"), "not verified while log 0 waits to be judged");
    t.check(KEY, &nm(0));
    let f = ask(&logs, &[nm(0), nm(1)]);
    assert_eq!(check_of(&f, &nm(0)), pair("verified", "-"));
    assert_eq!(check_of(&f, &nm(1)), pair("verified", "-"));
}

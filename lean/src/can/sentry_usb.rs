//! Sentry USB's files on a car's share (server/sentryUsb.js, sentryUsbDevice.js,
//! sentryUsbCar.js, carFiles.js; docs/sentry-usb.md): its status file
//! (.sentryusb/archive-status.json: the last archive, a transfer in progress,
//! the snapshots), its info file (device-status.json: version, storage, the
//! car's readings) and its list of what the car wrote (car-files.tsv). Read
//! only, re-read when their size or time changed, never indexed as footage.

use super::ctx::{CanCtx, Car};
use super::json::{self, n};
use super::tz;
use super::util::{self, mtime_ms};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const DIR: &str = ".sentryusb";
pub const FILE: &str = "archive-status.json";
pub const MAX_BYTES: u64 = 256 * 1024;
const ARRIVED_MS: f64 = 1000.0;
const IDLE_LOOK_MS: f64 = 5000.0;
pub const DEFAULT_INTERVAL_S: i64 = 3480;
const SNAP_MARGIN_S: i64 = 7 * 60;
const CAR_KEEPS_S: i64 = 60 * 60;
const MAX_SNAPSHOTS: usize = 1000;
const STALE_MS: f64 = 24.0 * 3600.0 * 1000.0;

fn int(v: Option<&Value>) -> Option<i64> {
    v.and_then(json::safe_int).filter(|x| *x >= 0)
}
fn is_obj(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}
fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    if s.encode_utf16().count() > 1024 {
        return None;
    }
    let clean: String = s.chars().filter(|c| !((*c as u32) < 0x20 || *c as u32 == 0x7f)).collect();
    Some(util::utf16_slice(&clean, max))
}
fn relpath(v: Option<&Value>) -> Option<String> {
    let s = text(v, 512).filter(|s| !s.is_empty())?;
    if s.starts_with('/') || s.split('/').any(|p| p == ".." || p.is_empty()) {
        return None;
    }
    Some(s)
}
fn clip_name(rel: &Option<String>) -> Option<String> {
    rel.as_ref().map(|r| r.rsplit('/').next().unwrap_or(r).to_string())
}
fn interval_of(v: Option<&Value>) -> Option<i64> {
    v.and_then(json::safe_int).filter(|x| (60..=86400).contains(x))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub name: Option<String>,
    pub started_unix: i64,
}

fn snapshots_of(v: Option<&Value>) -> Option<Vec<Snapshot>> {
    let a = v?.as_array()?;
    let mut by: Vec<Snapshot> = Vec::new();
    let mut idx: HashMap<i64, usize> = HashMap::new();
    for e in a.iter().take(MAX_SNAPSHOTS * 4) {
        let Value::Object(e) = e else { continue };
        let Some(t) = e.get("started_unix").and_then(json::safe_int).filter(|t| (1262304000..=4102444800).contains(t)) else { continue };
        let mut name = None;
        match e.get("name") {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) => name = Some(s.clone()),
            _ => continue,
        }
        match idx.get(&t) {
            Some(&i) => {
                if by[i].name.is_none() && name.is_some() {
                    by[i] = Snapshot { name, started_unix: t };
                }
            }
            None => {
                idx.insert(t, by.len());
                by.push(Snapshot { name, started_unix: t });
            }
        }
    }
    by.sort_by_key(|s| s.started_unix);
    let k = by.len().saturating_sub(MAX_SNAPSHOTS);
    Some(by[k..].to_vec())
}

#[derive(Debug, Clone)]
pub struct Gap {
    pub from_unix: i64,
    pub to_unix: i64,
    pub seconds: i64,
    pub lost_to_unix: Option<i64>,
}

pub fn snapshot_gaps(snaps: &[Snapshot], interval_s: i64) -> Vec<Gap> {
    if snaps.len() < 2 {
        return Vec::new();
    }
    let every = if (60..=86400).contains(&interval_s) { interval_s } else { DEFAULT_INTERVAL_S };
    let mut out = Vec::new();
    for i in 1..snaps.len() {
        let (from, to) = (snaps[i - 1].started_unix, snaps[i].started_unix);
        if to - from <= every + SNAP_MARGIN_S {
            continue;
        }
        let lost = to - CAR_KEEPS_S;
        out.push(Gap { from_unix: from, to_unix: to, seconds: to - from, lost_to_unix: (lost > from).then_some(lost) });
    }
    out
}

/// The file's JSON as a normalized status (schema 1), or None.
#[derive(Debug, Clone)]
pub struct Status {
    pub device: Option<String>,
    pub written_unix: Option<i64>,
    pub archive: Archive,
    pub verification: Option<Verification>,
    pub auto_delete: Option<bool>,
    pub state: &'static str,
    pub transfer: Option<Transfer>,
    pub snapshot_interval_s: Option<i64>,
    pub snapshots: Option<Vec<Snapshot>>,
    pub raw_json: Value,
}
#[derive(Debug, Clone, Default)]
pub struct Archive {
    pub result: Option<String>,
    pub started_unix: Option<i64>,
    pub finished_unix: Option<i64>,
    pub files_archived: Option<i64>,
    pub files_not_archived: Option<i64>,
    pub last_clip: Option<String>,
}
#[derive(Debug, Clone, Default)]
pub struct Verification {
    pub enabled: bool,
    pub ran: bool,
    pub matched: Option<i64>,
    pub converted: Option<i64>,
    pub resending: Option<i64>,
    pub no_pi_copy: Option<i64>,
    pub still_queued: Option<i64>,
    pub stopped: Option<String>,
}
#[derive(Debug, Clone, Default)]
pub struct Transfer {
    pub started_unix: Option<i64>,
    pub files: Option<i64>,
    pub bytes: Option<i64>,
    pub first_clip: Option<String>,
    pub last_clip: Option<String>,
    pub expected_finish_unix: Option<i64>,
    pub give_up_unix: Option<i64>,
}

fn opt_i(v: Option<i64>) -> Value {
    v.map(Value::from).unwrap_or(Value::Null)
}
#[allow(dead_code)]
fn opt_s(v: &Option<String>) -> Value {
    v.clone().map(Value::String).unwrap_or(Value::Null)
}

impl Status {
    /// The normalized status as the Node code keeps it (JSON.stringify compares it for changes).
    pub fn to_json(&self) -> Value {
        let a = &self.archive;
        json!({
            "schema": 1, "device": self.device, "writtenUnix": opt_i(self.written_unix),
            "archive": { "result": a.result, "startedUnix": opt_i(a.started_unix), "finishedUnix": opt_i(a.finished_unix), "filesArchived": opt_i(a.files_archived), "filesNotArchived": opt_i(a.files_not_archived), "lastClip": a.last_clip },
            "verification": self.verification.as_ref().map(|v| json!({ "enabled": v.enabled, "ran": v.ran, "matched": opt_i(v.matched), "converted": opt_i(v.converted), "resending": opt_i(v.resending), "noPiCopy": opt_i(v.no_pi_copy), "stillQueued": opt_i(v.still_queued), "stopped": v.stopped })),
            "autoDeleteEnabled": self.auto_delete, "state": self.state,
            "transfer": self.transfer.as_ref().map(|t| json!({ "startedUnix": opt_i(t.started_unix), "files": opt_i(t.files), "bytes": opt_i(t.bytes), "firstClip": t.first_clip, "lastClip": t.last_clip, "expectedFinishUnix": opt_i(t.expected_finish_unix), "giveUpUnix": opt_i(t.give_up_unix) })),
            "snapshotIntervalS": opt_i(self.snapshot_interval_s),
            "snapshots": self.snapshots.as_ref().map(|s| s.iter().map(|x| json!({ "name": x.name, "startedUnix": x.started_unix })).collect::<Vec<_>>())
        })
    }
}

pub fn parse_status(text_in: &str) -> Option<Status> {
    let raw: Value = serde_json::from_str(text_in).ok()?;
    let Value::Object(r) = &raw else { return None };
    if r.get("schema").and_then(|s| s.as_f64()) != Some(1.0) {
        return None;
    }
    let a = r.get("archive").filter(|x| is_obj(Some(x)) || x.is_array()).cloned().unwrap_or(json!({}));
    let v = r.get("verification").filter(|x| is_obj(Some(x)) || x.is_array()).cloned().unwrap_or(json!({}));
    let has_v = is_obj(r.get("verification"));
    let t = r.get("transfer").filter(|x| is_obj(Some(x))).cloned();
    let results = ["in_progress", "ok", "failed", "nothing_new"];
    Some(Status {
        device: text(r.get("device"), 64),
        written_unix: int(r.get("written_unix")),
        archive: Archive {
            result: a.get("result").and_then(|x| x.as_str()).filter(|x| results.contains(x)).map(String::from),
            started_unix: int(a.get("started_unix")),
            finished_unix: int(a.get("finished_unix")),
            files_archived: int(a.get("files_archived")),
            files_not_archived: int(a.get("files_not_archived")),
            last_clip: relpath(a.get("last_clip")),
        },
        verification: has_v.then(|| Verification {
            enabled: v.get("enabled") == Some(&Value::Bool(true)),
            ran: v.get("ran") == Some(&Value::Bool(true)),
            matched: int(v.get("matched")),
            converted: int(v.get("converted")),
            resending: int(v.get("resending")),
            no_pi_copy: int(v.get("no_pi_copy")),
            still_queued: int(v.get("still_queued")),
            stopped: text(v.get("stopped"), 200),
        }),
        auto_delete: r.get("auto_delete_enabled").and_then(|x| x.as_bool()),
        state: if r.get("state").and_then(|s| s.as_str()) == Some("transferring") { "transferring" } else { "idle" },
        transfer: t.map(|t| Transfer {
            started_unix: int(t.get("started_unix")),
            files: int(t.get("files")),
            bytes: int(t.get("bytes")),
            first_clip: relpath(t.get("first_clip")),
            last_clip: relpath(t.get("last_clip")),
            expected_finish_unix: int(t.get("expected_finish_unix")),
            give_up_unix: int(t.get("give_up_unix")),
        }),
        snapshot_interval_s: interval_of(r.get("snapshot_interval_s")),
        snapshots: snapshots_of(r.get("snapshots")),
        raw_json: raw.clone(),
    })
}

#[derive(Debug, Clone, Default)]
pub struct Now {
    pub transferring: bool,
    pub overdue: bool,
    pub range: Option<(String, String)>,
}

pub fn interpret(status: Option<&Status>, now_ms: f64) -> Now {
    let Some(s) = status else { return Now::default() };
    let transferring = s.state == "transferring";
    let t = s.transfer.as_ref();
    let give_up = t.and_then(|t| t.give_up_unix);
    let overdue = transferring && give_up.is_some_and(|g| now_ms / 1000.0 > g as f64);
    let mut range = None;
    if transferring {
        if let Some(t) = t {
            let first = clip_name(&t.first_clip);
            let last = clip_name(&t.last_clip).or(first.clone());
            if let (Some(f), Some(l)) = (first, last) {
                range = Some(if f <= l { (f, l) } else { (l, f) });
            }
        }
    }
    Now { transferring, overdue, range }
}

fn plural(n: i64, w: &str) -> String {
    format!("{} {}{}", n, w, if n == 1 { "" } else { "s" })
}
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
fn zone_or_utc(z: &str) -> &str {
    if z.is_empty() { "UTC" } else { z }
}
/// clock(): "15:07" in the car's zone, with "5 Nov" before it when not today.
fn clock(unix: Option<i64>, zone: &str, now_ms: f64) -> Option<String> {
    let u = unix.filter(|u| *u != 0)?;
    let z = zone_or_utc(zone);
    if !tz::known(z) && z != "UTC" {
        return Some(tz::iso(u * 1000)[11..16].to_string());
    }
    let (y, mo, d, h, mi, _) = tz::parts(z, u * 1000);
    let (ny, nmo, nd, ..) = tz::parts(z, now_ms as i64);
    let time = format!("{:02}:{:02}", h, mi);
    Some(if (y, mo, d) == (ny, nmo, nd) { time } else { format!("{} {} {}", d, MONTHS[(mo - 1) as usize], time) })
}
/// clipClock(): "12:59" of a clip name (the car's clock), with its date when not today.
fn clip_clock(name: &str, zone: &str, now_ms: f64) -> Option<String> {
    let ts = super::search::ts_from(name)?;
    let z = zone_or_utc(zone);
    let today = if tz::known(z) || z == "UTC" {
        let (y, mo, d, ..) = tz::parts(z, now_ms as i64);
        Some(format!("{:04}-{:02}-{:02}", y, mo, d))
    } else {
        None
    };
    let day = &ts[..10];
    let time = format!("{}:{}", &ts[11..13], &ts[14..16]);
    if Some(day) == today.as_deref() {
        return Some(time);
    }
    let d: i64 = ts[8..10].parse().ok()?;
    let mo: usize = ts[5..7].parse().ok()?;
    // (new Date('YYYY-MM-DDT12:00:00Z') of a day that does not exist is Invalid Date)
    if !(1..=12).contains(&mo) || d < 1 || d > 31 {
        return Some(format!("Invalid Date {}", time));
    }
    let t = tz::utc_ms(ts[..4].parse().ok()?, mo as i64, d, 12, 0, 0);
    let (_, m2, d2) = tz::civil_from_days(t.div_euclid(86_400_000));
    Some(format!("{} {} {}", d2, MONTHS[(m2 - 1) as usize], time))
}

/// describe(): the status in words, and its tone.
pub fn describe(s: &Status, now_ms: f64, zone: &str) -> (String, Option<String>, &'static str) {
    let now = interpret(Some(s), now_ms);
    let a = &s.archive;
    let v = s.verification.clone().unwrap_or_default();
    let t = s.transfer.clone();
    let mut tone = "ok";
    let summary;
    if now.overdue {
        tone = "waiting";
        let t = t.clone().unwrap_or_default();
        summary = format!(
            "Waiting for Sentry USB since {}: its transfer{} stopped part way (the car most likely drove off or lost Wi-Fi). Nothing is lost: the clips stay on the Sentry USB and the rest arrives at its next archive.",
            clock(t.started_unix, zone, now_ms).unwrap_or_else(|| "its last transfer".into()),
            t.files.filter(|f| *f != 0).map(|f| format!(" of {}", plural(f, "file"))).unwrap_or_default()
        );
    } else if now.transferring {
        tone = "info";
        let range = now.range.as_ref().map(|(f, l)| format!(" ({}–{})", clip_clock(f, zone, now_ms).unwrap_or_else(|| "null".into()), clip_clock(l, zone, now_ms).unwrap_or_else(|| "null".into()))).unwrap_or_default();
        let tt = t.clone().unwrap_or_default();
        summary = format!(
            "Sentry USB is copying {}{}{}{}. Those clips are not converted or reported missing until they are in.",
            tt.files.filter(|f| *f != 0).map(|f| plural(f, "file")).unwrap_or_else(|| "clips".into()),
            range,
            tt.started_unix.filter(|x| *x != 0).map(|x| format!(" since {}", clock(Some(x), zone, now_ms).unwrap_or_default())).unwrap_or_default(),
            tt.expected_finish_unix.filter(|x| *x != 0).map(|x| format!(", expected by {}", clock(Some(x), zone, now_ms).unwrap_or_default())).unwrap_or_default()
        );
    } else {
        let when = clock(a.finished_unix.filter(|x| *x != 0).or(s.written_unix), zone, now_ms);
        let w = when.map(|w| format!(" ({})", w)).unwrap_or_default();
        let mut parts = Vec::new();
        match a.result.as_deref() {
            Some("failed") => {
                tone = "amber";
                let nn = a.files_not_archived.unwrap_or(0);
                parts.push(format!(
                    "Sentry USB's last archive{} copied {}{}",
                    w,
                    plural(a.files_archived.unwrap_or(0), "file"),
                    if nn != 0 { format!("; {} did not make it and {} tried again at its next archive", plural(nn, "file"), if nn == 1 { "is" } else { "are" }) } else { String::new() }
                ));
            }
            Some("nothing_new") => parts.push(format!("Sentry USB's last archive{} had nothing new", w)),
            _ => parts.push(format!("Sentry USB's last archive{} copied {}", w, plural(a.files_archived.unwrap_or(0), "file"))),
        }
        if let Some(lc) = &a.last_clip {
            let nm = clip_name(&Some(lc.clone())).unwrap();
            parts.push(format!("newest clip {}", clip_clock(&nm, zone, now_ms).unwrap_or(nm)));
        }
        summary = format!("{}.", parts.join(", "));
    }
    let detail = if v.enabled && v.ran {
        let mut bits = vec![format!("{} matched", v.matched.unwrap_or(0))];
        if let Some(c) = v.converted.filter(|x| *x != 0) {
            bits.push(format!("{} converted here", c));
        }
        if let Some(c) = v.resending.filter(|x| *x != 0) {
            bits.push(format!("{} being sent again", c));
        }
        if let Some(c) = v.still_queued.filter(|x| *x != 0) {
            bits.push(format!("{} still to check", c));
        }
        Some(format!("Checksums: {}.", bits.join(", ")))
    } else if v.enabled {
        Some("Checksums: on, none checked in its last archive.".into())
    } else {
        None
    };
    (summary, detail, tone)
}

fn ms(unix: Option<i64>) -> Value {
    unix.map(|u| json!(u * 1000)).unwrap_or(Value::Null)
}

fn snapshots_view(s: &Status) -> Value {
    let Some(list) = &s.snapshots else { return Value::Null };
    let interval = s.snapshot_interval_s.unwrap_or(DEFAULT_INTERVAL_S);
    let gaps = snapshot_gaps(list, interval);
    json!({
        "interval": interval, "intervalReported": s.snapshot_interval_s.is_some(), "count": list.len(),
        "firstAt": list.first().map(|x| json!(x.started_unix * 1000)), "lastAt": list.last().map(|x| json!(x.started_unix * 1000)),
        "times": list.iter().map(|x| json!(x.started_unix * 1000)).collect::<Vec<_>>(),
        "missed": gaps.iter().map(|g| json!({ "from": g.from_unix * 1000, "to": g.to_unix * 1000, "minutes": n(json::round(g.seconds as f64 / 60.0)), "lostTo": g.lost_to_unix.map(|x| x * 1000) })).collect::<Vec<_>>()
    })
}

/// apiView: GET /api/vehicles/:id/sentry-usb (without its record part).
pub fn api_view(status: Option<&Status>, now_ms: f64, zone: &str, read_at: Option<f64>, error: Option<&str>) -> Value {
    let Some(s) = status else {
        return match error {
            Some(e) => json!({ "present": false, "error": e }),
            None => json!({ "present": false }),
        };
    };
    let now = interpret(Some(s), now_ms);
    let a = &s.archive;
    let written = s.written_unix.map(|u| (u * 1000) as f64);
    let (summary, detail, tone) = describe(s, now_ms, zone);
    let t = s.transfer.as_ref().filter(|t| t.started_unix.is_some() && t.first_clip.is_some());
    json!({
        "present": true, "readAt": read_at.map(n), "writtenAt": written.map(n), "device": s.device,
        "state": if now.overdue { "waiting" } else if now.transferring { "transferring" } else { "idle" },
        "archive": { "result": a.result, "startedAt": ms(a.started_unix), "finishedAt": ms(a.finished_unix), "filesArchived": opt_i(a.files_archived), "filesNotArchived": opt_i(a.files_not_archived), "lastClip": a.last_clip },
        "verification": s.verification.as_ref().map(|v| json!({ "enabled": v.enabled, "ran": v.ran, "matched": opt_i(v.matched), "converted": opt_i(v.converted), "resending": opt_i(v.resending), "noPiCopy": opt_i(v.no_pi_copy), "stillQueued": opt_i(v.still_queued), "stopped": v.stopped })),
        "autoDeleteEnabled": s.auto_delete,
        "transfer": t.map(|t| json!({ "startedAt": ms(t.started_unix), "files": opt_i(t.files), "bytes": opt_i(t.bytes), "firstClip": t.first_clip, "lastClip": t.last_clip.clone().or(t.first_clip.clone()), "expectedFinishAt": ms(t.expected_finish_unix), "giveUpAt": ms(t.give_up_unix) })),
        "stale": written.is_none_or(|w| now_ms - w > STALE_MS),
        "summary": summary, "detail": detail, "tone": tone,
        "snapshots": snapshots_view(s)
    })
}

/// archivedSince: when the Pi's newest archive that went through started (unix), or None.
pub fn archived_since(s: Option<&Status>) -> Option<i64> {
    let s = s?;
    if s.state == "transferring" {
        return s.transfer.as_ref().and_then(|t| t.started_unix);
    }
    let a = &s.archive;
    match a.result.as_deref() {
        Some("ok") | Some("nothing_new") => a.started_unix,
        Some("failed") if a.files_not_archived == Some(0) => a.started_unix,
        _ => None,
    }
}

// ---- the info file (sentryUsbDevice.js, sentryUsbCar.js)
pub const DEVICE_FILE: &str = "device-status.json";
pub const DEVICE_MAX: u64 = 16 * 1024;
const EARLIEST: i64 = 1_500_000_000;
const AHEAD: i64 = 86_400;

fn round1(x: f64) -> f64 {
    json::round(x * 10.0) / 10.0
}

/// A reading: only the known keys, each passing its check, the required ones there, `at` sane.
fn reading(v: Option<&Value>, checks: &[(&str, &dyn Fn(&Value) -> Option<Value>)], required: &[&str], now_s: i64) -> Option<Map<String, Value>> {
    let Some(Value::Object(m)) = v else { return None };
    let mut out = Map::new();
    for k in json::ordered_keys(m) {
        let x = &m[k];
        if k == "at" {
            let t = x.as_f64().filter(|t| t.fract() == 0.0)?;
            if t < EARLIEST as f64 || t > (now_s + AHEAD) as f64 {
                return None;
            }
            out.insert("at".into(), x.clone());
            continue;
        }
        let Some((_, check)) = checks.iter().find(|c| c.0 == k) else { continue };
        out.insert(k.clone(), check(x)?);
    }
    required.iter().all(|k| out.contains_key(*k)).then_some(out)
}

fn num_in(lo: f64, hi: f64) -> impl Fn(&Value) -> Option<Value> {
    move |x: &Value| x.as_f64().filter(|v| v.is_finite() && *v >= lo && *v <= hi).map(|v| n(round1(v)))
}
fn boolean(x: &Value) -> Option<Value> {
    x.as_bool().map(Value::Bool)
}
fn one_of(list: &'static [&'static str]) -> impl Fn(&Value) -> Option<Value> {
    move |x: &Value| x.as_str().filter(|s| list.contains(s)).map(|s| Value::String(s.into()))
}

/// cleanCar: the checked car object, or None (units dropped as parseDevice drops them).
pub fn clean_car(car: Option<&Value>, now_ms: f64) -> Option<Map<String, Value>> {
    let car = car.filter(|c| is_obj(Some(c)))?;
    let now_s = (now_ms / 1000.0).floor() as i64;
    let mut out = Map::new();
    let pct = num_in(0.0, 100.0);
    if let Some(b) = reading(car.get("battery"), &[("pct", &pct), ("charging", &boolean)], &["pct"], now_s) {
        out.insert("battery".into(), Value::Object(b));
    }
    let ic = num_in(-60.0, 100.0);
    if let Some(r) = reading(car.get("interior"), &[("c", &ic)], &["c"], now_s) {
        out.insert("interior".into(), Value::Object(r));
    }
    let ec = num_in(-70.0, 70.0);
    if let Some(r) = reading(car.get("exterior"), &[("c", &ec)], &["c"], now_s) {
        out.insert("exterior".into(), Value::Object(r));
    }
    if let Some(tires) = car.get("tires").filter(|t| is_obj(Some(t))) {
        let mut t = Map::new();
        let kpa = num_in(0.0, 1000.0);
        for p in ["fl", "fr", "rl", "rr"] {
            if let Some(r) = reading(tires.get(p), &[("kpa", &kpa)], &["kpa"], now_s) {
                t.insert(p.into(), Value::Object(r));
            }
        }
        if !t.is_empty() {
            if let Some(s) = tires.get("state").and_then(|s| s.as_str()).filter(|s| ["optimal", "check", "unsafe"].contains(s)) {
                t.insert("state".into(), json!(s));
            }
            out.insert("tires".into(), Value::Object(t));
        }
    }
    let state = one_of(&["parked", "driving"]);
    let since = move |x: &Value| x.as_f64().filter(|v| v.fract() == 0.0 && *v >= EARLIEST as f64 && *v <= (now_s + AHEAD) as f64).map(|_| x.clone());
    if let Some(r) = reading(car.get("drive"), &[("state", &state), ("since", &since)], &["state"], now_s) {
        out.insert("drive".into(), Value::Object(r));
    }
    (!out.is_empty()).then_some(out)
}

/// parseDevice: the checked info file, or None.
pub fn parse_device(text_in: &str, now_ms: f64) -> Option<Value> {
    let raw: Value = serde_json::from_str(text_in).ok()?;
    if !is_obj(Some(&raw)) || raw.get("schema").and_then(|s| s.as_f64()) != Some(1.0) {
        return None;
    }
    let now_s = (now_ms / 1000.0).floor() as i64;
    let written = raw.get("written_unix").and_then(|w| w.as_f64()).filter(|w| w.fract() == 0.0 && *w >= EARLIEST as f64 && *w <= (now_s + AHEAD) as f64)?;
    let ver = raw.get("version").and_then(|v| v.as_str()).map(|s| {
        let c: String = s.chars().map(|c| if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect();
        util::utf16_slice(c.trim(), 64)
    });
    let bytes = |v: Option<&Value>| v.and_then(json::safe_int).filter(|x| *x >= 0);
    let mut storage = Value::Null;
    if let Some(s) = raw.get("storage").filter(|s| is_obj(Some(s))) {
        let (mut total, used, free) = (bytes(s.get("total_bytes")), bytes(s.get("used_bytes")), bytes(s.get("free_bytes")));
        if let Some(t) = total {
            if used.unwrap_or(0) > t || free.unwrap_or(0) > t {
                total = None;
            }
        }
        if total.is_some() || used.is_some() || free.is_some() {
            storage = json!({ "totalBytes": total, "usedBytes": used, "freeBytes": free });
        }
    }
    let mut drives = Vec::new();
    if let Some(Value::Array(a)) = raw.get("drives") {
        let mut seen = HashSet::new();
        for d in a.iter().take(8) {
            let Some(name) = d.get("name").and_then(|x| x.as_str()).filter(|x| ["cam", "music", "lightshow", "boombox"].contains(x)) else { continue };
            if !is_obj(Some(d)) || seen.contains(name) {
                continue;
            }
            let Some(size) = bytes(d.get("size_bytes")) else { continue };
            seen.insert(name.to_string());
            drives.push(json!({ "name": name, "sizeBytes": size }));
        }
    }
    let cpu = raw.get("cpu_temp_c").and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v >= -40.0 && *v <= 125.0).map(|v| n(round1(v)));
    let car = clean_car(raw.get("car"), now_ms);
    Some(json!({ "writtenUnix": n(written), "version": ver.filter(|v| !v.is_empty()), "storage": storage, "drives": drives, "cpuTempC": cpu, "car": car }))
}

// ---- what the car wrote (carFiles.js)
pub const CAR_FILES: &str = "car-files.tsv";
pub const CAR_FILES_MAX: u64 = 32 * 1024 * 1024;
const MAX_CLIPS: usize = 400_000;

#[derive(Debug, Clone)]
pub struct CarClip {
    pub path: String,
    pub kind: &'static str,
    pub event: Option<String>,
    pub name: String,
    pub size: f64,
    pub mtime_unix: f64,
    pub first_seen_unix: f64,
    pub last_seen_unix: f64,
}

pub fn clip_path(p: &str) -> Option<(String, &'static str, Option<String>, String)> {
    if p.is_empty() || p.encode_utf16().count() > 512 || p.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) || p.contains('\\') || p.starts_with('/') {
        return None;
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return None;
    }
    let parts: Vec<&str> = p.split('/').collect();
    if parts.len() > 4 || parts.iter().any(|x| x.is_empty() || *x == "." || *x == "..") {
        return None;
    }
    let name = parts[parts.len() - 1];
    let nb = name.as_bytes();
    let ok = nb.len() > 24 && nb.is_ascii() && super::search::ts_from(&name[..19]).as_deref() == Some(&name[..19]) && nb[19] == b'-' && name.ends_with(".mp4") && name[20..name.len() - 4].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_');
    if !ok {
        return None;
    }
    let kind = match parts[0].to_lowercase().as_str() {
        "recentclips" => "RecentClips",
        "sentryclips" => "SentryClips",
        "savedclips" => "SavedClips",
        "teslatrackmode" => "TeslaTrackMode",
        _ => "Other",
    };
    let event = ((kind == "SentryClips" || kind == "SavedClips") && parts.len() >= 3).then(|| parts[parts.len() - 2].to_string());
    Some((p.to_string(), kind, event, name.to_string()))
}

#[derive(Debug, Clone, Default)]
pub struct CarFiles {
    pub clips: indexmap::IndexMap<String, CarClip>,
    pub lines: usize,
    pub bad: usize,
    pub first_seen_unix: Option<f64>,
    pub last_seen_unix: Option<f64>,
}

pub fn parse_car_files(s: &str) -> CarFiles {
    const COLUMNS: [&str; 4] = ["first_seen_unix", "path", "size", "mtime_unix"];
    let mut out = CarFiles::default();
    let mut order = [0usize, 1, 2, 3];
    let unix_of = |s: &str| -> Option<f64> {
        if s.is_empty() || s.len() > 12 || !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let v: f64 = s.parse().ok()?;
        (1262304000.0..=4102444800.0).contains(&v).then_some(v)
    };
    let digits = |s: &str, max: usize| -> Option<f64> { (!s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_digit())).then(|| s.parse().unwrap()) };
    for line in s.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() {
            continue;
        }
        if let Some(h) = line.strip_prefix('#') {
            let names: Vec<String> = h.trim().split('\t').map(|x| x.trim().to_lowercase()).collect();
            if names.len() == 4 && COLUMNS.iter().all(|c| names.iter().any(|x| x == c)) {
                for (i, c) in COLUMNS.iter().enumerate() {
                    order[i] = names.iter().position(|x| x == c).unwrap();
                }
            }
            continue;
        }
        out.lines += 1;
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 4 {
            out.bad += 1;
            continue;
        }
        let (seen, clip, size, mtime) = (unix_of(f[order[0]]), clip_path(f[order[1]]), digits(f[order[2]], 15), digits(f[order[3]], 12));
        let (Some(seen), Some(clip), Some(size), Some(mtime)) = (seen, clip, size, mtime) else {
            out.bad += 1;
            continue;
        };
        if let Some(had) = out.clips.get_mut(&clip.0) {
            had.size = had.size.max(size);
            had.mtime_unix = had.mtime_unix.max(mtime);
            had.first_seen_unix = had.first_seen_unix.min(seen);
            had.last_seen_unix = had.last_seen_unix.max(seen);
        } else {
            if out.clips.len() >= MAX_CLIPS {
                out.bad += 1;
                continue;
            }
            out.clips.insert(clip.0.clone(), CarClip { path: clip.0, kind: clip.1, event: clip.2, name: clip.3, size, mtime_unix: mtime, first_seen_unix: seen, last_seen_unix: seen });
        }
        out.first_seen_unix = Some(out.first_seen_unix.map_or(seen, |x| x.min(seen)));
        out.last_seen_unix = Some(out.last_seen_unix.map_or(seen, |x| x.max(seen)));
    }
    out
}

/// dailyCounts: the Pi's daily counts from the list.
pub fn daily_counts<'a>(entries: impl Iterator<Item = &'a CarClip>) -> Map<String, Value> {
    let mut out: indexmap::IndexMap<String, [usize; 4]> = indexmap::IndexMap::new();
    let mut minutes: HashMap<String, HashSet<String>> = HashMap::new();
    let mut events: HashMap<(String, &str), HashSet<String>> = HashMap::new();
    for c in entries {
        let day = c.name[..10].to_string();
        let d = out.entry(day.clone()).or_insert([0; 4]);
        if c.kind == "RecentClips" {
            d[0] += 1;
            minutes.entry(day.clone()).or_default().insert(c.name[..16].to_string());
        } else if let Some(e) = &c.event {
            if c.kind == "SentryClips" || c.kind == "SavedClips" {
                events.entry((day.clone(), c.kind)).or_default().insert(e.clone());
            }
        }
    }
    for (day, set) in minutes {
        out.get_mut(&day).unwrap()[1] = set.len();
    }
    for ((day, kind), set) in events {
        out.get_mut(&day).unwrap()[if kind == "SentryClips" { 2 } else { 3 }] = set.len();
    }
    out.into_iter().map(|(k, d)| (k, json!({ "recentFiles": d[0], "minutes": d[1], "sentryEvents": d[2], "savedEvents": d[3] }))).collect()
}

// ---- the service
#[derive(Clone)]
struct Read {
    file: Option<PathBuf>,
    size: Option<u64>,
    mtime: Option<f64>,
    status: Option<Status>,
    error: Option<String>,
    read_at: f64,
}

#[derive(Clone)]
pub struct Device {
    pub file: PathBuf,
    pub size: u64,
    pub mtime: f64,
    pub info: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct CarFilesRead {
    pub file: PathBuf,
    pub size: u64,
    pub mtime: f64,
    pub list: Option<Arc<CarFiles>>,
    pub error: Option<String>,
}

pub struct SentryUsb {
    ctx: Arc<dyn CanCtx>,
    pub now: Box<dyn Fn() -> f64 + Send + Sync>,
    cache: Mutex<HashMap<String, Read>>,
    devices: Mutex<HashMap<String, Option<Device>>>,
    car_files: Mutex<HashMap<String, Option<CarFilesRead>>>,
    arrived: Mutex<HashMap<String, (String, f64, Option<Value>, HashMap<PathBuf, u64>)>>,
    pub on_change: Box<dyn Fn(&str) + Send + Sync>,
}

impl SentryUsb {
    pub fn new(ctx: Arc<dyn CanCtx>) -> SentryUsb {
        SentryUsb { ctx, now: Box::new(util::now_ms), cache: Mutex::new(HashMap::new()), devices: Mutex::new(HashMap::new()), car_files: Mutex::new(HashMap::new()), arrived: Mutex::new(HashMap::new()), on_change: Box::new(|_| {}) }
    }

    fn files_of(v: &Car) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        if let Some(s) = &v.studio_root {
            out.push(s.join(DIR).join(FILE));
        }
        if let Some(r) = &v.root {
            let f = r.join(DIR).join(FILE);
            if !out.contains(&f) {
                out.push(f);
            }
        }
        out
    }

    fn read_device(&self, vid: &str, dirs: &[PathBuf]) -> Option<Device> {
        let before = self.devices.lock().unwrap().get(vid).cloned().flatten();
        for dir in dirs {
            let file = dir.join(DEVICE_FILE);
            let Ok(st) = std::fs::metadata(&file) else { continue };
            if !st.is_file() {
                continue;
            }
            if let Some(b) = &before {
                if b.file == file && b.size == st.len() && b.mtime == mtime_ms(&st) {
                    return Some(b.clone());
                }
            }
            let (mut info, mut error) = (None, None);
            if st.len() > DEVICE_MAX {
                error = Some("too large".into());
            } else {
                match std::fs::read_to_string(&file) {
                    Ok(t) => {
                        info = parse_device(&t, (self.now)());
                        if info.is_none() {
                            error = Some("not a schema 1 info file".into());
                        }
                    }
                    Err(_) => error = Some("unreadable".into()),
                }
            }
            return Some(Device { file, size: st.len(), mtime: mtime_ms(&st), info, error });
        }
        None
    }

    fn read_car_files(&self, dir: &Path, before: Option<&CarFilesRead>) -> Option<CarFilesRead> {
        let file = dir.join(CAR_FILES);
        let st = std::fs::metadata(&file).ok()?;
        if !st.is_file() {
            return None;
        }
        if let Some(b) = before.filter(|b| b.file == file && b.size == st.len() && b.mtime == mtime_ms(&st)) {
            return Some(b.clone());
        }
        let (mut list, mut error) = (None, None);
        if st.len() > CAR_FILES_MAX {
            error = Some("too large".into());
        } else {
            match std::fs::read(&file) {
                Ok(b) if b.len() as u64 > CAR_FILES_MAX => error = Some("too large".into()),
                Ok(b) => list = Some(Arc::new(parse_car_files(&String::from_utf8_lossy(&b)))),
                Err(_) => error = Some("unreadable".into()),
            }
        }
        Some(CarFilesRead { file, size: st.len(), mtime: mtime_ms(&st), list, error })
    }

    /// refresh(vid): the status file read again when it changed; the car files and the info file beside it.
    pub fn refresh(&self, vid: &str) -> Option<Status> {
        let Some(v) = self.ctx.vehicle(vid) else {
            self.cache.lock().unwrap().remove(vid);
            return None;
        };
        let before = self.cache.lock().unwrap().get(vid).cloned();
        let mut found: Option<(PathBuf, std::fs::Metadata)> = None;
        for f in Self::files_of(&v) {
            if let Ok(st) = std::fs::metadata(&f) {
                if st.is_file() {
                    found = Some((f, st));
                    break;
                }
            }
        }
        let now = (self.now)();
        let next = match &found {
            None => Read { file: None, size: None, mtime: None, status: None, error: None, read_at: now },
            Some((f, st)) => match before.as_ref().filter(|b| b.file.as_ref() == Some(f) && b.size == Some(st.len()) && b.mtime == Some(mtime_ms(st))) {
                Some(b) => Read { read_at: now, ..b.clone() },
                None => {
                    let (mut status, mut error) = (None, None);
                    if st.len() > MAX_BYTES {
                        error = Some("too large".into());
                    } else {
                        match std::fs::read_to_string(f) {
                            Ok(t) => {
                                status = parse_status(&t);
                                if status.is_none() {
                                    error = Some("not a schema 1 status file".into());
                                }
                            }
                            Err(_) => error = Some("unreadable".into()),
                        }
                    }
                    Read { file: Some(f.clone()), size: Some(st.len()), mtime: Some(mtime_ms(st)), status, error, read_at: now }
                }
            },
        };
        self.cache.lock().unwrap().insert(vid.to_string(), next.clone());
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some((f, _)) = &found {
            dirs.push(f.parent().unwrap().to_path_buf());
        }
        for f in Self::files_of(&v) {
            let d = f.parent().unwrap().to_path_buf();
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        let cf_before = self.car_files.lock().unwrap().get(vid).cloned().flatten();
        let mut cf = None;
        for d in &dirs {
            cf = self.read_car_files(d, cf_before.as_ref());
            if cf.is_some() {
                break;
            }
        }
        self.car_files.lock().unwrap().insert(vid.to_string(), cf.clone());
        let dev_before = self.devices.lock().unwrap().get(vid).cloned().flatten();
        let dev = self.read_device(vid, &dirs);
        self.devices.lock().unwrap().insert(vid.to_string(), dev.clone());
        let key3 = |f: Option<&PathBuf>, m: Option<f64>, s: Option<u64>| (f.cloned(), m.map(|x| x.to_bits()), s);
        let dev_changed = key3(dev_before.as_ref().map(|d| &d.file), dev_before.as_ref().map(|d| d.mtime), dev_before.as_ref().map(|d| d.size)) != key3(dev.as_ref().map(|d| &d.file), dev.as_ref().map(|d| d.mtime), dev.as_ref().map(|d| d.size));
        let cf_changed = key3(cf_before.as_ref().map(|d| &d.file), cf_before.as_ref().map(|d| d.mtime), cf_before.as_ref().map(|d| d.size)) != key3(cf.as_ref().map(|d| &d.file), cf.as_ref().map(|d| d.mtime), cf.as_ref().map(|d| d.size));
        let was = before.as_ref().and_then(|b| b.status.as_ref()).map(|s| json::stringify(&s.to_json()));
        let is = next.status.as_ref().map(|s| json::stringify(&s.to_json()));
        if was != is || cf_changed || dev_changed {
            (self.on_change)(vid);
        }
        next.status
    }

    /// fresh(vid): looked at again when the last look is older than a second (transferring) or 5 s.
    pub fn fresh(&self, vid: &str) {
        let c = self.cache.lock().unwrap().get(vid).cloned();
        let age = c.as_ref().map_or(f64::INFINITY, |c| (self.now)() - c.read_at);
        let wait = if c.as_ref().and_then(|c| c.status.as_ref()).is_some_and(|s| s.state == "transferring") { ARRIVED_MS } else { IDLE_LOOK_MS };
        if age >= wait {
            self.refresh(vid);
        }
    }

    pub fn get(&self, vid: &str) -> Option<Status> {
        self.cache.lock().unwrap().get(vid).and_then(|c| c.status.clone())
    }

    pub fn api(&self, vid: &str) -> Value {
        let c = self.cache.lock().unwrap().get(vid).cloned();
        let zone = self.ctx.vehicle(vid).map(|v| v.timezone).unwrap_or_default();
        api_view(c.as_ref().and_then(|c| c.status.as_ref()), (self.now)(), zone_or_utc(&zone), c.as_ref().map(|c| c.read_at), c.as_ref().and_then(|c| c.error.as_deref()))
    }

    /// device(vid): { present, error, info, readAt } or None.
    pub fn device(&self, vid: &str) -> Option<Value> {
        let d = self.devices.lock().unwrap().get(vid).cloned().flatten()?;
        let read_at = self.cache.lock().unwrap().get(vid).map(|c| c.read_at);
        Some(json!({ "present": true, "error": d.error, "info": d.info, "readAt": read_at.map(n) }))
    }

    pub fn car_files(&self, vid: &str) -> Option<CarFilesRead> {
        self.car_files.lock().unwrap().get(vid).cloned().flatten()
    }

    pub fn now(&self, vid: &str) -> Now {
        interpret(self.get(vid).as_ref(), (self.now)())
    }

    /// arrived(vid): while a transfer runs, the clips of its range on the share already.
    pub fn arrived(&self, vid: &str) -> Value {
        let c = self.cache.lock().unwrap().get(vid).cloned();
        let nw = interpret(c.as_ref().and_then(|c| c.status.as_ref()), (self.now)());
        let (Some(range), Some(file)) = (nw.range.clone().filter(|_| nw.transferring), c.as_ref().and_then(|c| c.file.clone())) else { return Value::Null };
        let root = file.parent().and_then(|p| p.parent()).unwrap().to_path_buf();
        let key = format!("{}|{}|{}", root.display(), range.0, range.1);
        let mut all = self.arrived.lock().unwrap();
        let a = all.entry(vid.to_string()).or_insert_with(|| (key.clone(), 0.0, None, HashMap::new()));
        if a.0 != key {
            *a = (key.clone(), 0.0, None, HashMap::new());
        }
        if a.2.is_some() && (self.now)() - a.1 < ARRIVED_MS {
            return a.2.clone().unwrap();
        }
        let stamp = |s: &str| s.chars().take(19).collect::<String>();
        let (first, last) = (stamp(&range.0), stamp(&range.1));
        let (fd, ld) = (first.chars().take(10).collect::<String>(), last.chars().take(10).collect::<String>());
        let mut dirs = Vec::new();
        for top in ["RecentClips", "SentryClips", "SavedClips", "TeslaTrackMode"] {
            let Ok(rd) = std::fs::read_dir(root.join(top)) else { continue };
            dirs.push(root.join(top));
            let mut ents: Vec<_> = rd.filter_map(|e| e.ok()).collect();
            ents.sort_by_key(|e| e.file_name());
            for d in ents {
                let nm = d.file_name().to_string_lossy().into_owned();
                if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) || nm.starts_with('.') {
                    continue;
                }
                let day: String = nm.chars().take(10).collect();
                if day >= fd && day <= ld {
                    dirs.push(root.join(top).join(&nm));
                }
            }
        }
        let (mut files, mut bytes) = (0u64, 0u64);
        let mut seen = HashSet::new();
        for dir in dirs {
            for name in util::names(&dir).unwrap_or_default() {
                if name.starts_with('.') || !name.ends_with(".mp4") {
                    continue;
                }
                let t = stamp(&name);
                if t < first || t > last {
                    continue;
                }
                let f = dir.join(&name);
                let size = match a.3.get(&f) {
                    Some(s) => *s,
                    None => match std::fs::metadata(&f) {
                        Ok(st) if st.is_file() => {
                            a.3.insert(f.clone(), st.len());
                            st.len()
                        }
                        _ => continue,
                    },
                };
                seen.insert(f);
                files += 1;
                bytes += size;
            }
        }
        a.3.retain(|k, _| seen.contains(k));
        let r = json!({ "files": files, "bytes": bytes, "countedAt": n((self.now)()) });
        a.1 = (self.now)();
        a.2 = Some(r.clone());
        r
    }

    /// poll(): every minute, the cars whose status says a transfer runs (and the ones not read yet).
    pub fn poll(&self) {
        for v in self.ctx.vehicles() {
            let c = self.cache.lock().unwrap().get(&v.id).cloned();
            if c.as_ref().is_some_and(|c| c.status.as_ref().is_none_or(|s| s.state != "transferring")) {
                continue;
            }
            self.refresh(&v.id);
        }
    }

    pub fn forget(&self, vid: &str) {
        self.cache.lock().unwrap().remove(vid);
        self.arrived.lock().unwrap().remove(vid);
        self.car_files.lock().unwrap().remove(vid);
        self.devices.lock().unwrap().remove(vid);
    }
}

//! Sentry USB's drive data (a port of server/driveData.js): the
//! drive-data.json the Pi writes to the archive share. It can be over a
//! gigabyte, so it is never read whole: a small streaming tokenizer walks it
//! a chunk at a time and parses one route at a time, each boiled down at once
//! to a few numbers per driving segment. That is what is kept, in memory and
//! under DATA_PATH/drive-data/<car>.json (the Node server's cache format), so
//! the file is read again only when it changes. Reads run one at a time in
//! the background; the API never waits for one. Nothing is written to the share.

use super::ctx::Ctx;
use super::js::{self, num, r1, r5};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const FILE: &str = "drive-data.json";
const CLIP_MS: f64 = 60_000.0;
const PARK_GAP_MS: f64 = 2000.0;
pub const DEFAULT_GAP_S: f64 = 300.0;
const SEG_POINTS: usize = 8;
const DRIVE_POINTS: usize = 96;
const MAX_ROUTE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TAG_BYTES: usize = 16 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;
const CACHE_VERSION: f64 = 1.0;

#[derive(Clone, Copy, PartialEq, Debug)]
enum St {
    Start,
    KeyOrEnd,
    Key,
    Colon,
    Value,
    After,
    Arr,
    ArrNext,
    Val,
    Done,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Route,
    Tags,
}

fn ws(c: u8) -> bool {
    matches!(c, 0x20 | 0x0a | 0x0d | 0x09)
}

/// The streaming tokenizer (StoreDataScanner): routes one at a time, driveTags whole, the rest stepped over.
pub struct Scanner<'a> {
    on_route: Box<dyn FnMut(Value) + 'a>,
    on_tags: Box<dyn FnMut(Value) + 'a>,
    st: St,
    pub at: usize,
    key: String,
    key_bytes: Vec<u8>,
    esc: bool,
    target: Option<Target>,
    parts: Vec<u8>,
    over: bool,
    depth: i64,
    in_str: bool,
    prim: bool,
    pub routes: usize,
    pub skipped: usize,
    pub keys: Vec<String>,
    bom: usize,
    max_route: usize,
    max_tags: usize,
}

impl<'a> Scanner<'a> {
    pub fn new(on_route: impl FnMut(Value) + 'a, on_tags: impl FnMut(Value) + 'a) -> Scanner<'a> {
        Scanner { on_route: Box::new(on_route), on_tags: Box::new(on_tags), st: St::Start, at: 0, key: String::new(), key_bytes: Vec::new(), esc: false, target: None, parts: Vec::new(), over: false, depth: 0, in_str: false, prim: false, routes: 0, skipped: 0, keys: Vec::new(), bom: 0, max_route: MAX_ROUTE_BYTES, max_tags: MAX_TAG_BYTES }
    }

    fn begin(&mut self, t: Option<Target>) {
        self.target = t;
        self.parts.clear();
        self.over = false;
        self.depth = 0;
        self.in_str = false;
        self.esc = false;
        self.prim = false;
        self.st = St::Val;
    }

    fn max(&self) -> usize {
        if self.target == Some(Target::Route) { self.max_route } else { self.max_tags }
    }

    fn finish(&mut self, buf: &[u8], from: usize, end: usize) -> Result<(), String> {
        let target = self.target;
        let after = if target == Some(Target::Route) { St::ArrNext } else { St::After };
        if target.is_some() && !self.over && self.parts.len() + (end - from) > self.max() {
            self.over = true;
        }
        if let (Some(t), false) = (target, self.over) {
            self.parts.extend_from_slice(&buf[from..end]);
            let text = String::from_utf8_lossy(&self.parts).into_owned();
            let obj: Value = serde_json::from_str(&text).map_err(|e| format!("not JSON at byte {}: {e}", self.at + end))?;
            if t == Target::Route {
                self.routes += 1;
                (self.on_route)(obj);
            } else {
                (self.on_tags)(obj);
            }
        } else if target == Some(Target::Route) {
            self.skipped += 1;
        }
        self.parts.clear();
        self.target = None;
        self.st = after;
        Ok(())
    }

    pub fn push(&mut self, buf: &[u8]) -> Result<(), String> {
        let n = buf.len();
        let mut from = 0usize;
        let mut i = 0usize;
        while i < n {
            let c = buf[i];
            match self.st {
                St::Val => {
                    if self.in_str {
                        if self.esc {
                            self.esc = false;
                        } else if c == b'\\' {
                            self.esc = true;
                        } else if c == b'"' {
                            self.in_str = false;
                            if self.depth == 0 {
                                self.finish(buf, from, i + 1)?;
                            }
                        }
                    } else if self.prim {
                        if c == b',' || c == b'}' || c == b']' || ws(c) {
                            self.finish(buf, from, i)?;
                            continue;
                        }
                    } else if c == b'"' {
                        self.in_str = true;
                    } else if c == b'{' || c == b'[' {
                        self.depth += 1;
                    } else if c == b'}' || c == b']' {
                        self.depth -= 1;
                        if self.depth == 0 {
                            self.finish(buf, from, i + 1)?;
                        } else if self.depth < 0 {
                            return Err(format!("unexpected {} at byte {}", c as char, self.at + i));
                        }
                    } else if self.depth == 0 && !ws(c) {
                        self.prim = true;
                    }
                }
                St::Start => {
                    if !ws(c) {
                        if self.at + i == self.bom && self.bom < 3 && c == [0xef, 0xbb, 0xbf][self.bom] {
                            self.bom += 1;
                        } else if c != b'{' {
                            return Err("not a JSON object".into());
                        } else {
                            self.st = St::KeyOrEnd;
                        }
                    }
                }
                St::KeyOrEnd => {
                    if !ws(c) {
                        if c == b'"' {
                            self.st = St::Key;
                            self.key_bytes.clear();
                            self.esc = false;
                        } else if c == b'}' {
                            self.st = St::Done;
                        } else {
                            return Err(format!("expected a key at byte {}", self.at + i));
                        }
                    }
                }
                St::Key => {
                    if self.esc {
                        self.esc = false;
                        self.key_bytes.push(c);
                    } else if c == b'\\' {
                        self.esc = true;
                        self.key_bytes.push(c);
                    } else if c == b'"' {
                        self.key = String::from_utf8_lossy(&self.key_bytes).into_owned();
                        if self.keys.len() < 32 {
                            self.keys.push(self.key.clone());
                        }
                        self.st = St::Colon;
                    } else {
                        self.key_bytes.push(c);
                        if self.key_bytes.len() > 256 {
                            return Err("a key too long".into());
                        }
                    }
                }
                St::Colon => {
                    if !ws(c) {
                        if c != b':' {
                            return Err(format!("expected : at byte {}", self.at + i));
                        }
                        self.st = St::Value;
                    }
                }
                St::Value => {
                    if !ws(c) {
                        if (self.key == "routes" || self.key == "Routes") && c == b'[' {
                            self.st = St::Arr;
                        } else {
                            let t = if self.key == "driveTags" || self.key == "DriveTags" { Some(Target::Tags) } else { None };
                            self.begin(t);
                            from = i;
                            continue;
                        }
                    }
                }
                St::Arr => {
                    if !ws(c) {
                        if c == b']' {
                            self.st = St::After;
                        } else {
                            self.begin(Some(Target::Route));
                            from = i;
                            continue;
                        }
                    }
                }
                St::ArrNext => {
                    if !ws(c) {
                        if c == b',' {
                            self.st = St::Arr;
                        } else if c == b']' {
                            self.st = St::After;
                        } else {
                            return Err(format!("expected , or ] at byte {}", self.at + i));
                        }
                    }
                }
                St::After => {
                    if !ws(c) {
                        if c == b',' {
                            self.st = St::KeyOrEnd;
                        } else if c == b'}' {
                            self.st = St::Done;
                        } else {
                            return Err(format!("expected , or }} at byte {}", self.at + i));
                        }
                    }
                }
                St::Done => {
                    if !ws(c) && c != 0 {
                        return Err(format!("text after the end at byte {}", self.at + i));
                    }
                }
            }
            i += 1;
        }
        if self.st == St::Val && self.target.is_some() && !self.over {
            if self.parts.len() + (n - from) > self.max() {
                self.over = true;
                self.parts.clear();
            } else {
                self.parts.extend_from_slice(&buf[from..]);
            }
        }
        self.at += n;
        Ok(())
    }

    pub fn end(&self) -> Result<(usize, usize), String> {
        if self.st != St::Done {
            return Err(format!("the file ends part way (at byte {})", self.at));
        }
        Ok((self.routes, self.skipped))
    }
}

// ---- one route, boiled down

fn pick<'v>(o: &'v Value, a: &str, b: &str) -> Option<&'v Value> {
    match o.get(a) {
        Some(v) if !v.is_null() => Some(v),
        _ => o.get(b),
    }
}

/// A Go []uint8 field: base64 text, or an array of numbers.
pub fn bytes_of(v: Option<&Value>) -> Vec<f64> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| js::or(js::number(Some(x)), 0.0)).collect(),
        Some(Value::String(s)) if !s.is_empty() => {
            let t = s.trim_end_matches('=');
            if s.len() - t.len() > 2 || !t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/') {
                return Vec::new();
            }
            unbase64(t).into_iter().map(|b| b as f64).collect()
        }
        _ => Vec::new(),
    }
}

fn unbase64(t: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in t.bytes() {
        acc = acc << 6 | val(c) as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

fn nums(v: Option<&Value>) -> Vec<f64> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| js::number(Some(x))).collect(),
        _ => Vec::new(),
    }
}

fn null_island(lat: f64, lng: f64) -> bool {
    lat.abs() < 1.0 && lng.abs() < 1.0
}

pub fn haversine(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let dl = (lat2 - lat1) * rad;
    let dn = (lon2 - lon1) * rad;
    let a = (dl / 2.0).sin().powi(2) + (lat1 * rad).cos() * (lat2 * rad).cos() * (dn / 2.0).sin().powi(2);
    6371008.8 * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

fn aligned(arr: Vec<f64>, n: usize) -> Option<Vec<f64>> {
    let r = arr.len() as f64 / n as f64;
    (!arr.is_empty() && n > 0 && (0.8..=1.2).contains(&r)).then_some(arr)
}

fn at(arr: &[f64], i: usize) -> f64 {
    arr[i.min(arr.len() - 1)]
}

/// gearRuns as (gear, frames)
fn runs_of(v: Option<&Value>) -> Vec<(f64, f64)> {
    let Some(Value::Array(a)) = v else { return Vec::new() };
    let mut out = Vec::new();
    for r in a {
        if !r.is_object() {
            continue;
        }
        let gear = js::or(js::number(pick(r, "gear", "Gear")), 0.0);
        let mut frames = js::number(pick(r, "frames", "Frames"));
        if !frames.is_finite() {
            frames = js::number(pick(r, "endFrame", "EndFrame")) - js::number(pick(r, "startFrame", "StartFrame"));
        }
        if frames.is_finite() && frames > 0.0 {
            out.push((gear, js::js_round(frames)));
        }
    }
    out
}

#[derive(Debug, Clone)]
struct PlanSeg {
    sf: f64,
    ef: f64,
    parked: bool,
}

fn park_plan(runs: &[(f64, f64)]) -> Option<(f64, Vec<PlanSeg>)> {
    let total: f64 = runs.iter().map(|r| r.1).sum();
    if total == 0.0 {
        return None;
    }
    let mut merged: Vec<PlanSeg> = Vec::new();
    let mut f = 0.0;
    for &(gear, frames) in runs {
        let parked = gear == 0.0 && frames * CLIP_MS >= PARK_GAP_MS * total;
        match merged.last_mut() {
            Some(last) if !last.parked && !parked => last.ef = f + frames,
            _ => merged.push(PlanSeg { sf: f, ef: f + frames, parked }),
        }
        f += frames;
    }
    merged.iter().any(|s| s.parked).then_some((total, merged))
}

struct ClipPts {
    pts: Vec<Option<(f64, f64)>>,
    speeds: Option<Vec<f64>>,
    ap: Option<Vec<f64>>,
    dt: f64,
    sei: bool,
}

fn seg_stats(c: &ClipPts, si: usize, ei: usize, sf: f64, ef: f64, tf: f64) -> Value {
    let (mut d, mut top, mut moving) = (0.0, 0.0, 0.0);
    let mut ap = [0f64; 7]; // fsdM, asM, taccM, assistM, fsdS, asS, taccS
    let (mut a, mut z) = (None, None);
    for i in si..ei {
        if let Some(p) = c.pts[i] {
            if null_island(p.0, p.1) {
                continue;
            }
            if a.is_none() {
                a = Some(p);
            }
            z = Some(p);
        }
    }
    for i in si + 1..ei {
        let (Some(p), Some(q)) = (c.pts[i - 1], c.pts[i]) else { continue };
        if null_island(p.0, p.1) || null_island(q.0, q.1) {
            continue;
        }
        let m = haversine(p.0, p.1, q.0, q.1);
        if !c.sei && c.dt > 0.0 && m / c.dt > 70.0 {
            continue;
        }
        d += m;
        let mut v = None;
        if c.sei {
            let s = at(c.speeds.as_ref().unwrap(), i);
            if (0.0..100.0).contains(&s) {
                v = Some(s);
            }
        } else if c.dt > 0.0 && m / c.dt < 70.0 {
            v = Some(m / c.dt);
        }
        if let Some(v) = v {
            if v > top {
                top = v;
            }
            if v > 0.5 {
                moving += c.dt;
            }
        }
        if let Some(apv) = &c.ap {
            let s = at(apv, i);
            if s != 0.0 {
                ap[3] += m;
                if s == 1.0 {
                    ap[0] += m;
                    ap[4] += c.dt;
                } else if s == 2.0 {
                    ap[1] += m;
                    ap[5] += c.dt;
                } else if s == 3.0 {
                    ap[2] += m;
                    ap[6] += c.dt;
                }
            }
        }
    }
    let span: Vec<(f64, f64)> = (si..ei).filter_map(|i| c.pts[i]).filter(|p| !null_island(p.0, p.1)).collect();
    let mut keep = Vec::new();
    if !span.is_empty() {
        let want = SEG_POINTS.min(span.len());
        for k in 0..want {
            let p = span[if want == 1 { 0 } else { js::js_round((k * (span.len() - 1)) as f64 / (want - 1) as f64) as usize }];
            keep.push(json!([num(r5(p.0)), num(r5(p.1))]));
        }
    }
    let pos = |p: Option<(f64, f64)>| p.map_or(Value::Null, |p| json!([num(r5(p.0)), num(r5(p.1))]));
    let mut out = json!({ "sf": num(sf), "ef": num(ef), "tf": num(tf), "d": num(js::js_round(d * 10.0) / 10.0), "v": num(r1(top)), "mv": num(r1(moving)), "a": pos(a), "z": pos(z), "p": keep });
    if let Some(apv) = &c.ap {
        out["ap"] = Value::Array(ap.iter().map(|x| num(r1(*x))).collect());
        out["ap0"] = num(at(apv, si));
    }
    out
}

fn left_out(file: &str) -> bool {
    let parts: Vec<&str> = file.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| p.starts_with('.')) {
        return true;
    }
    parts.iter().take(parts.len().saturating_sub(1)).any(|p| *p == "SavedClips" || *p == "SentryClips")
}

/// reduceRoute: { k, t, native, runs, lp, gs, segs } (a segment, or 0 for a Park gap), or None.
pub fn reduce_route(r: &Value) -> Option<Value> {
    if !r.is_object() {
        return None;
    }
    let file = match pick(r, "file", "File") {
        Some(Value::String(s)) => s.replace('\\', "/"),
        Some(Value::Null) | None => String::new(),
        Some(Value::Bool(false)) => String::new(),
        Some(v) => super::places::js_string(Some(v)).replace('\\', "/"),
    };
    if file.is_empty() || left_out(&file) {
        return None;
    }
    let name = file.rsplit('/').next().unwrap_or(&file);
    let (key, t) = js::stamp_in(name)?;
    let raw = match pick(r, "points", "Points") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let mut pts: Vec<Option<(f64, f64)>> = Vec::new();
    let mut obj_speeds: Option<Vec<f64>> = None;
    for p in &raw {
        match p {
            Value::Array(a) => pts.push(Some((js::number(a.first()), js::number(a.get(1))))),
            Value::Object(_) => {
                pts.push(Some((js::number(pick(p, "lat", "Lat")), js::number(pick(p, "lng", "Lng")))));
                if let Some(s) = pick(p, "speed", "Speed") {
                    obj_speeds.get_or_insert_with(Vec::new).push(js::number(Some(s)));
                }
            }
            _ => pts.push(None),
        }
    }
    for p in pts.iter_mut() {
        if p.is_some_and(|(a, b)| !(a.is_finite() && b.is_finite())) {
            *p = None;
        }
    }
    let n = pts.len();
    let speeds = aligned(obj_speeds.unwrap_or_else(|| nums(pick(r, "speeds", "Speeds"))), n);
    let ap = aligned(bytes_of(pick(r, "autopilotStates", "AutopilotStates")), n);
    let gears = bytes_of(pick(r, "gearStates", "GearStates"));
    let runs = runs_of(pick(r, "gearRuns", "GearRuns"));
    let raw_frames = js::or(js::number(pick(r, "rawFrameCount", "RawFrameCount")), 0.0);
    let raw_park = js::or(js::number(pick(r, "rawParkCount", "RawParkCount")), 0.0);
    let source = pick(r, "source", "Source");
    let sei = speeds.as_ref().is_some_and(|s| s.iter().any(|x| *x > 0.0));
    let c = ClipPts { pts, speeds, ap, dt: if n > 1 { CLIP_MS / 1000.0 / (n - 1) as f64 } else { 0.0 }, sei };
    let total: f64 = runs.iter().map(|r| r.1).sum();
    let plan = if runs.is_empty() { None } else { park_plan(&runs) };
    let mut segs = Vec::new();
    match plan {
        None => {
            let tf = if total > 0.0 { total } else { 1.0 };
            segs.push(seg_stats(&c, 0, n, 0.0, tf, tf));
        }
        Some((pt, list)) => {
            for s in list {
                if s.parked {
                    segs.push(json!(0));
                    continue;
                }
                let mut si = js::js_round(s.sf / pt * n as f64) as usize;
                let mut ei = js::js_round(s.ef / pt * n as f64) as usize;
                if si >= n {
                    si = n.saturating_sub(1);
                }
                if ei > n {
                    ei = n;
                }
                if ei <= si {
                    ei = si + 1;
                }
                if ei > n {
                    continue;
                }
                segs.push(seg_stats(&c, si, ei, s.sf, s.ef, pt));
            }
        }
    }
    let park_count = gears.iter().filter(|g| **g == 0.0).count();
    let native = matches!(source, None | Some(Value::Null)) || source == Some(&json!("sei"));
    Some(json!({
        "k": key, "t": num(t),
        "native": native && !file.contains("-front-bridge.mp4"),
        "runs": !runs.is_empty(), "gs": !gears.is_empty(),
        "lp": if raw_frames > 0.0 { raw_park / raw_frames > 0.5 } else { !gears.is_empty() && park_count as f64 > gears.len() as f64 / 2.0 },
        "segs": segs
    }))
}

/// finishClips: oldest first, one per clip time, each with its span (ms).
pub fn finish_clips(list: Vec<Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut clips: Vec<Value> = list.into_iter().filter(|c| seen.insert(c["k"].as_str().unwrap_or("").to_string())).collect();
    clips.sort_by(|a, b| a["t"].as_f64().partial_cmp(&b["t"].as_f64()).unwrap());
    let mut prev: Option<usize> = None;
    for i in 0..clips.len() {
        clips[i]["span"] = json!(CLIP_MS as u64);
        if clips[i]["native"] != json!(true) {
            continue;
        }
        if let Some(p) = prev {
            let gap = (clips[i]["t"].as_f64().unwrap() - clips[p]["t"].as_f64().unwrap()) * 1000.0;
            if gap > 0.0 && gap <= CLIP_MS {
                clips[p]["span"] = num(gap);
            }
        }
        prev = Some(i);
    }
    clips
}

fn frame_ms(frame: f64, total: f64, span: f64) -> f64 {
    if total != 0.0 { ((frame * span + (total / 2.0).floor()) / total).floor() } else { 0.0 }
}

/// A drive from the Pi's data
#[derive(Debug, Clone)]
pub struct UsbDrive {
    pub start_ms: f64,
    pub end_ms: f64,
    pub keys: Vec<String>,
    pub distance: f64,
    pub top: f64,
    pub moving: f64,
    pub from: Option<(f64, f64)>,
    pub to: Option<(f64, f64)>,
    pub autopilot: Value,
    pub route: Vec<Value>,
    pub tag_key: String,
}

fn split_at_park(group: &[&Value]) -> Vec<Vec<(usize, Value)>> {
    let mut out = Vec::new();
    let mut cur: Vec<(usize, Value)> = Vec::new();
    let truthy = |v: &Value| v == &json!(true);
    let segs = |c: &Value| c["segs"].as_array().cloned().unwrap_or_default();
    if group.iter().any(|c| truthy(&c["runs"])) {
        for (i, c) in group.iter().enumerate() {
            for s in segs(c) {
                if s == json!(0) {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                } else {
                    cur.push((i, s));
                }
            }
        }
    } else if group.iter().any(|c| truthy(&c["gs"]) || truthy(&c["lp"])) {
        for (i, c) in group.iter().enumerate() {
            if truthy(&c["lp"]) {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            } else {
                for s in segs(c) {
                    if s != json!(0) {
                        cur.push((i, s));
                    }
                }
            }
        }
    } else {
        for (i, c) in group.iter().enumerate() {
            for s in segs(c) {
                if s != json!(0) {
                    cur.push((i, s));
                }
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn downsample(arr: Vec<Value>, max: usize) -> Vec<Value> {
    if arr.len() <= max {
        return arr;
    }
    let step = (arr.len() - 1) as f64 / (max - 1) as f64;
    (0..max).map(|i| arr[js::js_round(i as f64 * step) as usize].clone()).collect()
}

fn pair(v: &Value) -> Option<(f64, f64)> {
    let a = v.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

fn build_drive(group: &[&Value], parts: &[(usize, Value)]) -> UsbDrive {
    let (fi, fseg) = &parts[0];
    let (li, lseg) = &parts[parts.len() - 1];
    let n = |v: &Value, k: &str| v[k].as_f64().unwrap_or(0.0);
    let start_ms = n(group[*fi], "t") * 1000.0 + frame_ms(n(fseg, "sf"), n(fseg, "tf"), n(group[*fi], "span"));
    let end_ms = n(group[*li], "t") * 1000.0 + frame_ms(n(lseg, "ef"), n(lseg, "tf"), n(group[*li], "span"));
    let (mut d, mut top, mut moving, mut has_ap) = (0.0, 0.0, 0.0, false);
    let mut ap = [0f64; 7];
    let mut prev_end: Option<(f64, f64)> = None;
    let (mut a, mut z) = (None, None);
    let mut pts = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for (ci, seg) in parts {
        let k = group[*ci]["k"].as_str().unwrap_or("").to_string();
        if keys.last() != Some(&k) {
            keys.push(k);
        }
        d += n(seg, "d");
        moving += n(seg, "mv");
        if n(seg, "v") > top {
            top = n(seg, "v");
        }
        if let Some(sap) = seg.get("ap").and_then(Value::as_array) {
            has_ap = true;
            for i in 0..7 {
                ap[i] += sap.get(i).and_then(Value::as_f64).unwrap_or(0.0);
            }
        }
        let sa = pair(&seg["a"]);
        let sz = pair(&seg["z"]);
        if let (Some(pe), Some(sa)) = (prev_end, sa) {
            let gap = haversine(pe.0, pe.1, sa.0, sa.1);
            d += gap;
            let ap0 = seg.get("ap0").and_then(Value::as_f64).unwrap_or(0.0);
            if ap0 == 1.0 {
                ap[0] += gap;
            } else if ap0 == 2.0 {
                ap[1] += gap;
            } else if ap0 == 3.0 {
                ap[2] += gap;
            }
            if ap0 != 0.0 && !ap0.is_nan() {
                ap[3] += gap;
            }
        }
        if sz.is_some() || sa.is_some() {
            prev_end = sz.or(sa);
        }
        if a.is_none() && sa.is_some() {
            a = sa;
        }
        if sz.is_some() {
            z = sz;
        }
        for p in seg["p"].as_array().cloned().unwrap_or_default() {
            pts.push(p);
        }
    }
    let pct = |m: f64| if d > 0.0 { num(r1(m / d * 100.0)) } else { json!(0) };
    let r = |x: f64| num(js::js_round(x));
    UsbDrive {
        start_ms,
        end_ms,
        keys,
        distance: js::js_round(d),
        top: r1(top),
        moving: js::js_round(moving),
        from: a,
        to: z,
        autopilot: if has_ap {
            json!({ "percent": pct(ap[3]), "fsd": pct(ap[0]), "autosteer": pct(ap[1]), "tacc": pct(ap[2]),
                "fsdSeconds": r(ap[4]), "autosteerSeconds": r(ap[5]), "taccSeconds": r(ap[6]), "fsdMetres": r(ap[0]), "assistedMetres": r(ap[3]) })
        } else {
            Value::Null
        },
        route: downsample(pts, DRIVE_POINTS),
        tag_key: js::iso(start_ms)[..23].to_string(),
    }
}

/// groupDrives: clips (oldest first) into drives, newest first.
pub fn group_drives(clips: &[Value], gap_s: f64) -> Vec<UsbDrive> {
    let mut out = Vec::new();
    let mut group: Vec<&Value> = Vec::new();
    let mut prev_t: Option<f64> = None;
    let flush = |group: &mut Vec<&Value>, out: &mut Vec<UsbDrive>| {
        for parts in split_at_park(group) {
            out.push(build_drive(group, &parts));
        }
        group.clear();
    };
    for c in clips {
        let t = c["t"].as_f64().unwrap_or(0.0);
        if prev_t.is_some_and(|p| t - p > gap_s) {
            flush(&mut group, &mut out);
        }
        group.push(c);
        prev_t = Some(t);
    }
    flush(&mut group, &mut out);
    out.reverse();
    out
}

/// driveTags as lookups: exact keys, and by the second
#[derive(Default, Clone)]
pub struct Tags {
    exact: HashMap<String, Value>,
    second: HashMap<String, Value>,
    /// the kept tags in their order, for the cache
    kept: Vec<(String, Value)>,
}

pub fn tag_index(obj: Option<&Value>) -> Tags {
    let mut t = Tags::default();
    let Some(Value::Object(o)) = obj else { return t };
    let mut count = 0;
    for (k, v) in o {
        if count >= 50000 {
            break;
        }
        let Some(arr) = v.as_array() else { continue };
        let mut list: Vec<String> = Vec::new();
        for x in arr {
            let Some(s) = x.as_str() else { continue };
            let s: String = s.chars().filter(|c| !((*c as u32) < 0x20 || *c as u32 == 0x7f)).collect();
            let s = js::slice_units(s.trim(), 60);
            if !s.is_empty() && !list.contains(&s) {
                list.push(s);
            }
        }
        list.truncate(20);
        if list.is_empty() {
            continue;
        }
        let key = js::slice_units(k, 64);
        let val = json!(list);
        if !t.exact.contains_key(&key) {
            t.kept.push((key.clone(), val.clone()));
        } else if let Some(e) = t.kept.iter_mut().find(|e| e.0 == key) {
            e.1 = val.clone();
        }
        t.exact.insert(key.clone(), val.clone());
        let b = key.as_bytes();
        if b.len() >= 19 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':' && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18].iter().all(|&i| b[i].is_ascii_digit()) {
            t.second.entry(key[..19].to_string()).or_insert(val);
        }
        count += 1;
    }
    t
}

fn tags_of(tags: Option<&Tags>, d: &UsbDrive) -> Value {
    let Some(t) = tags else { return json!([]) };
    let sec = &d.tag_key[..19];
    t.exact.get(&d.tag_key).or_else(|| t.second.get(sec)).or_else(|| t.exact.get(&d.keys[0])).or_else(|| t.exact.get(sec)).cloned().unwrap_or(json!([]))
}

fn wall_ms(ms: f64) -> String {
    js::iso((ms / 1000.0).floor() * 1000.0)[..19].replace('T', " ")
}

pub fn key_of_ms(ms: f64) -> String {
    wall_ms(ms).replace(' ', "_").replace(':', "-")
}

/// describeDrive: a drive of the Pi's data for the API
pub fn describe_drive<'c>(d: &UsbDrive, tags: Option<&Tags>, clip_of: &dyn Fn(&str) -> Option<super::drives::Clip<'c>>, stats_of: &dyn Fn(&super::drives::Clip) -> Option<super::speed_index::Stats>, label: &super::drives::Label) -> Value {
    let found: Vec<super::drives::Clip> = d.keys.iter().filter_map(|k| clip_of(k)).collect();
    let (mut brakes, mut swerves, mut read) = (0, 0, 0);
    for c in &found {
        if let Some(s) = stats_of(c) {
            read += 1;
            brakes += s.b;
            swerves += s.t;
        }
    }
    let open = match clip_of(&d.keys[0]) {
        Some(c) => {
            let second = js::js_round(d.start_ms / 1000.0 - c.t).clamp(0.0, 59.0);
            json!({ "recording": if c.rec_id.is_empty() { Value::Null } else { json!(c.rec_id) }, "day": if c.rec_day.is_empty() { json!(c.day) } else { json!(c.rec_day) }, "clip": c.key, "second": num(second) })
        }
        None => match found.first() {
            Some(c) => json!({ "recording": if c.rec_id.is_empty() { Value::Null } else { json!(c.rec_id) }, "day": if c.rec_day.is_empty() { json!(c.day) } else { json!(c.rec_day) }, "clip": c.key, "second": 0 }),
            None => Value::Null,
        },
    };
    let recs: std::collections::HashSet<&str> = found.iter().map(|c| c.rec_id).filter(|s| !s.is_empty()).collect();
    json!({
        "id": key_of_ms(d.start_ms), "date": wall_ms(d.start_ms)[..10], "start": wall_ms(d.start_ms), "end": wall_ms(d.end_ms),
        "seconds": num(js::js_round((d.end_ms - d.start_ms) / 1000.0).max(0.0)), "clips": d.keys.len(), "recordings": recs.len(), "footage": found.len(), "indexed": read,
        "distance": num(d.distance), "moving": num(d.moving), "top": num(d.top),
        "hardBrakes": if read > 0 { json!(brakes) } else { Value::Null }, "swerves": if read > 0 { json!(swerves) } else { Value::Null },
        "from": super::drives::end_of(d.from, label), "to": super::drives::end_of(d.to, label),
        "can": false, "autopilot": d.autopilot, "tags": tags_of(tags, d), "route": d.route, "open": open
    })
}

/// Read a drive-data.json a chunk at a time; pause between chunks.
pub fn read_store_data(file: &Path, on_route: &mut dyn FnMut(Value), on_tags: &mut dyn FnMut(Value), pause: &mut dyn FnMut(usize), stopped: &dyn Fn() -> bool, chunk: usize) -> Result<(usize, usize), String> {
    let mut f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(file).map_err(|e| e.to_string())?;
    let mut sc = Scanner::new(|v| on_route(v), |v| on_tags(v));
    let mut buf = vec![0u8; chunk];
    loop {
        if stopped() {
            return Err("stopped".into());
        }
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        sc.push(&buf[..n])?;
        pause(sc.at);
    }
    sc.end()
}

// ---- the reader: per car, in the background, cached on disk

#[derive(Clone)]
struct Found {
    file: PathBuf,
    size: u64,
    mtime: f64,
}

#[derive(Clone)]
struct Result_ {
    raw: Map<String, Value>,
    tags: Tags,
}

#[derive(Default)]
struct Car {
    result: Option<Result_>,
    loaded: bool,
    reading: bool,
    present: Option<Found>,
    failed: Option<(String, String)>,
    last_check: f64,
    drives: HashMap<u64, Arc<Vec<UsbDrive>>>,
    progress: Option<(usize, u64)>,
    queued: bool,
}

pub struct DriveData {
    dir: PathBuf,
    ctx: Arc<dyn Ctx>,
    cars: Mutex<HashMap<String, Car>>,
    reading: Mutex<()>,
    pub stable_ms: f64,
    pub check_ms: f64,
    pub chunk: usize,
}

/// What the drives route uses: (usable, reading, meta)
pub struct View {
    pub usable: bool,
    pub reading: bool,
    pub meta: Value,
}

impl DriveData {
    pub fn new(dir: PathBuf, ctx: Arc<dyn Ctx>) -> Arc<DriveData> {
        Arc::new(DriveData { dir, ctx, cars: Mutex::new(HashMap::new()), reading: Mutex::new(()), stable_ms: 15_000.0, check_ms: 30_000.0, chunk: CHUNK })
    }

    /// forget(vid): a removed vehicle's drives and its cache file go
    pub fn forget(&self, vid: &str) {
        self.cars.lock().unwrap().remove(vid);
        let _ = std::fs::remove_file(self.cache_file(vid));
    }

    fn cache_file(&self, vid: &str) -> PathBuf {
        self.dir.join(format!("{}.json", js::encode_component(vid)))
    }

    fn load_cache(&self, vid: &str) {
        let mut cars = self.cars.lock().unwrap();
        let s = cars.entry(vid.to_string()).or_default();
        if s.loaded {
            return;
        }
        if let Some(Value::Object(raw)) = std::fs::read_to_string(self.cache_file(vid)).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            if raw.get("v").and_then(Value::as_f64) == Some(CACHE_VERSION) && raw.get("clips").is_some_and(Value::is_array) && s.result.is_none() {
                let tags = tag_index(raw.get("tags"));
                s.result = Some(Result_ { raw, tags });
            }
        }
        s.loaded = true;
    }

    /// The car's drive-data.json: only a plain file inside the car's folder.
    fn locate(&self, vid: &str) -> Option<Found> {
        let v = self.ctx.vehicle(vid)?;
        let mut roots = Vec::new();
        if let Some(s) = self.ctx.studio_root(vid) {
            roots.push(s);
        }
        roots.push(v.root.clone());
        let real_root = std::fs::canonicalize(&v.root).ok()?;
        let mut seen = std::collections::HashSet::new();
        for r in roots {
            if !seen.insert(r.clone()) {
                continue;
            }
            let file = r.join(FILE);
            let Ok(st) = std::fs::symlink_metadata(&file) else { continue };
            if !st.is_file() {
                continue;
            }
            let Ok(real) = std::fs::canonicalize(&file) else { continue };
            if real == real_root || !real.starts_with(&real_root) {
                continue;
            }
            return Some(Found { file, size: st.size(), mtime: js::js_round(crate::scanner::ms_of(st.mtime(), st.mtime_nsec())) });
        }
        None
    }

    fn stamp(f: &Found) -> String {
        format!("{}/{}", f.size, num(f.mtime))
    }

    /// Look at the file now and then; read it in the background when it changed and settled.
    pub fn check(self: &Arc<Self>, vid: &str, force: bool) {
        if self.ctx.vehicle(vid).is_none() {
            self.cars.lock().unwrap().remove(vid);
            return;
        }
        let now = js::now_ms();
        {
            let mut cars = self.cars.lock().unwrap();
            let s = cars.entry(vid.to_string()).or_default();
            if !force && now - s.last_check < self.check_ms {
                return;
            }
            s.last_check = now;
        }
        self.load_cache(vid);
        let f = self.locate(vid);
        let mut cars = self.cars.lock().unwrap();
        let s = cars.get_mut(vid).unwrap();
        s.present = f.clone();
        let Some(f) = f else { return };
        let stamp = Self::stamp(&f);
        let done = s.result.as_ref().and_then(|r| r.raw.get("stamp")).and_then(Value::as_str) == Some(&stamp);
        if done || s.failed.as_ref().is_some_and(|x| x.0 == stamp) || s.reading || s.queued {
            return;
        }
        let age = now - f.mtime;
        let me = self.clone();
        let id = vid.to_string();
        if age < self.stable_ms {
            // still being written, perhaps: look again once it settled
            let wait = (self.stable_ms - age + 500.0).max(1000.0);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(wait as u64));
                me.check(&id, true);
            });
            return;
        }
        s.queued = true;
        drop(cars);
        std::thread::spawn(move || {
            let _one = me.reading.lock().unwrap();
            me.read(&id);
        });
    }

    fn read(&self, vid: &str) {
        let f = self.locate(vid);
        {
            let mut cars = self.cars.lock().unwrap();
            let s = cars.entry(vid.to_string()).or_default();
            s.queued = false;
            s.present = f.clone();
            let Some(f) = &f else { return };
            if s.result.as_ref().and_then(|r| r.raw.get("stamp")).and_then(Value::as_str) == Some(&Self::stamp(f)) {
                return;
            }
            s.reading = true;
            s.progress = Some((0, f.size));
        }
        let f = f.unwrap();
        let stamp = Self::stamp(&f);
        let started = js::now_ms();
        let mut list = Vec::new();
        let mut raw_tags: Option<Value> = None;
        let mut seen = 0usize;
        let out = read_store_data(
            &f.file,
            &mut |r| {
                seen += 1;
                if let Some(c) = reduce_route(&r) {
                    list.push(c);
                }
            },
            &mut |t| raw_tags = t.is_object().then_some(t),
            &mut |bytes| {
                if let Some(s) = self.cars.lock().unwrap().get_mut(vid) {
                    s.progress = Some((bytes, f.size));
                }
                std::thread::sleep(Duration::from_millis(if self.ctx.busy() { 150 } else { 2 }));
            },
            &|| false,
            self.chunk,
        );
        let mut cars = self.cars.lock().unwrap();
        let s = cars.entry(vid.to_string()).or_default();
        s.reading = false;
        s.progress = None;
        match out {
            Err(e) => {
                eprintln!("Sentry USB drive data for {vid} ({seen} routes in): {e}; keeping the last good read");
                s.failed = Some((stamp, e));
            }
            Ok((routes, _)) => {
                drop(cars);
                let after = self.locate(vid);
                let mut cars = self.cars.lock().unwrap();
                let s = cars.entry(vid.to_string()).or_default();
                if after.as_ref().map(Self::stamp) != Some(stamp.clone()) {
                    s.last_check = 0.0;
                    eprintln!("Sentry USB drive data for {vid} changed while it was read; reading it again later");
                    return;
                }
                let clips = finish_clips(list);
                let tags = tag_index(raw_tags.as_ref());
                let kept: Map<String, Value> = tags.kept.iter().cloned().collect();
                let root = self.ctx.vehicle(vid).map(|v| v.root).unwrap_or_default();
                let rel = f.file.strip_prefix(&root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                let used = clips.len();
                let mut raw = Map::new();
                raw.insert("v".into(), json!(1));
                raw.insert("stamp".into(), json!(stamp));
                raw.insert("file".into(), json!(if rel.is_empty() { FILE.to_string() } else { rel }));
                raw.insert("size".into(), json!(f.size));
                raw.insert("mtimeMs".into(), num(f.mtime));
                raw.insert("readAt".into(), num(js::now_ms()));
                raw.insert("routes".into(), json!(routes));
                raw.insert("used".into(), json!(used));
                raw.insert("clips".into(), Value::Array(clips));
                let mut saved = raw.clone();
                saved.insert("tags".into(), Value::Object(kept));
                s.result = Some(Result_ { raw, tags });
                s.failed = None;
                s.drives.clear();
                drop(cars);
                let _ = std::fs::create_dir_all(&self.dir);
                let tmp = PathBuf::from(format!("{}.tmp", self.cache_file(vid).display()));
                if std::fs::write(&tmp, Value::Object(saved).to_string()).is_ok() {
                    let _ = std::fs::rename(&tmp, self.cache_file(vid));
                }
                eprintln!("Sentry USB drive data for {vid}: {routes} routes, {used} used, read in {} s", js::js_round((js::now_ms() - started) / 1000.0));
            }
        }
    }

    pub fn view(&self, vid: &str) -> View {
        let cars = self.cars.lock().unwrap();
        let Some(s) = cars.get(vid) else { return View { usable: false, reading: false, meta: Value::Null } };
        let r = s.result.as_ref().map(|r| &r.raw);
        let usable = r.is_some_and(|r| r.get("used").and_then(Value::as_u64).unwrap_or(0) > 0) && s.present.is_some();
        if s.present.is_none() && r.is_none() {
            return View { usable, reading: false, meta: Value::Null };
        }
        let reading = s.reading || s.queued;
        let g = |k: &str| r.and_then(|r| r.get(k)).cloned().unwrap_or(Value::Null);
        let meta = json!({
            "file": r.and_then(|r| r.get("file")).cloned().unwrap_or(json!(FILE)),
            "updatedAt": match &s.present { Some(p) => num(p.mtime), None => g("mtimeMs") },
            "readOf": g("mtimeMs"), "readAt": g("readAt"), "routes": g("routes"), "reading": reading,
            "progress": s.progress.map_or(Value::Null, |(b, size)| num(js::js_round(b as f64 / size.max(1) as f64 * 100.0).min(99.0))),
            "error": s.failed.as_ref().map_or(Value::Null, |f| json!(f.1))
        });
        View { usable, reading, meta }
    }

    pub fn drives(&self, vid: &str, gap_s: f64) -> Arc<Vec<UsbDrive>> {
        let mut cars = self.cars.lock().unwrap();
        let Some(s) = cars.get_mut(vid) else { return Arc::new(Vec::new()) };
        let Some(r) = &s.result else { return Arc::new(Vec::new()) };
        let key = gap_s.to_bits();
        if let Some(d) = s.drives.get(&key) {
            return d.clone();
        }
        let list = Arc::new(group_drives(r.raw.get("clips").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), gap_s));
        if s.drives.len() > 6 {
            s.drives.clear();
        }
        s.drives.insert(key, list.clone());
        list
    }

    pub fn tags(&self, vid: &str) -> Option<Tags> {
        self.cars.lock().unwrap().get(vid).and_then(|s| s.result.as_ref().map(|r| r.tags.clone()))
    }

    /// For tests: wait until nothing is queued or reading.
    pub fn settled(&self) {
        loop {
            if !self.cars.lock().unwrap().values().any(|c| c.reading || c.queued) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(test)]
#[path = "drive_data_tests.rs"]
mod tests;

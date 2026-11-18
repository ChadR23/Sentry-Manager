//! CAN to footage sync (server/canSync.js): where on the CAN logs' clock a
//! clip's first frame is, from the front camera's per-frame record (speed,
//! pedals, blinkers, brake, steering) matched with the same things in the
//! CAN signals: speed correlation, then edges matched one to one, then one
//! offset and drift per drive. Cached per car key in sync.json.

use super::json::{self, n};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const SIG_SPEED: &str = "DI_vehicleSpeed";
pub const SIG_BRAKE: &str = "IBST_driverBrakeApply";
pub const SIG_LEFT: &str = "VCFRONT_turnSignalLeftStatus";
pub const SIG_RIGHT: &str = "VCFRONT_turnSignalRightStatus";
pub const SIG_ACCEL: &str = "DI_accelPedalPos";
pub const SIG_STEER: &str = "SteeringAngle129";
pub const NAMES: [&str; 6] = [SIG_SPEED, SIG_BRAKE, SIG_LEFT, SIG_RIGHT, SIG_ACCEL, SIG_STEER];
pub const SEARCH_MS: f64 = 10_000.0;
const GRID_MS: f64 = 5.0;
const TEL_STEP: f64 = 50.0;
const ACCEL_STEPS: [f64; 2] = [5.0, 20.0];
pub const SYNC_FORMAT: &str = "1/r2";
const MAX_FRAME_GAP: f64 = 200.0;
const MOVING_KPH: f64 = 18.0;
const GAP_NONE_MS: f64 = 60.0;

fn median(a: &[f64]) -> f64 {
    if a.is_empty() {
        return f64::NAN;
    }
    let mut s = a.to_vec();
    s.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() >> 1;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}
fn r1(x: f64) -> f64 {
    json::round(x * 10.0) / 10.0
}

#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub t: f64,
    pub v: f64,
    pub acc: f64,
    pub steer: f64,
    pub left: bool,
    pub right: bool,
    pub brake: bool,
}

/// decodeRecord: a frame's telemetry fields (protobuf), or None.
pub fn decode_record(buf: &[u8]) -> Option<(f64, f64, f64, bool, bool, bool)> {
    let (mut v, mut acc, mut steer, mut left, mut right, mut brake) = (0.0, 0.0, 0.0, false, false, false);
    let mut p = 0usize;
    let vint = |p: &mut usize| -> Result<f64, ()> {
        let mut n = 0f64;
        let mut mul = 1f64;
        loop {
            if *p >= buf.len() {
                return Err(());
            }
            let b = buf[*p];
            *p += 1;
            n += (b & 0x7f) as f64 * mul;
            if b & 0x80 == 0 {
                return Ok(n);
            }
            mul *= 128.0;
            if mul > 2f64.powi(63) {
                return Err(());
            }
        }
    };
    while p < buf.len() {
        let Ok(tag) = vint(&mut p) else { return None };
        let field = (tag / 8.0).floor();
        let typ = tag % 8.0;
        let value: f64 = if typ == 0.0 {
            match vint(&mut p) {
                Ok(x) => x,
                Err(()) => return None,
            }
        } else if typ == 5.0 {
            if p + 4 > buf.len() {
                return None;
            }
            let x = f32::from_le_bytes(buf[p..p + 4].try_into().unwrap()) as f64;
            p += 4;
            x
        } else if typ == 1.0 {
            if p + 8 > buf.len() {
                return None;
            }
            let x = f64::from_le_bytes(buf[p..p + 8].try_into().unwrap());
            p += 8;
            x
        } else if typ == 2.0 {
            match vint(&mut p) {
                Ok(len) => p += len as usize,
                Err(()) => return None,
            }
            continue;
        } else {
            return None;
        };
        match field as i64 {
            4 => v = value * 3.6,
            5 => acc = value,
            6 => steer = value,
            7 => left = value != 0.0 && !value.is_nan(),
            8 => right = value != 0.0 && !value.is_nan(),
            9 => brake = value != 0.0 && !value.is_nan(),
            _ => {}
        }
    }
    Some((v, acc, steer, left, right, brake))
}

/// telemetryFrames: a clip's frames from its telemetry JSON.
pub fn telemetry_frames(body: &Value) -> Vec<Frame> {
    let mut out = Vec::new();
    if let Some(Value::Array(frames)) = body.get("frames") {
        for item in frames {
            let Value::Array(item) = item else { continue };
            let b64 = item.get(1).map(|x| if x.is_null() || !json::truthy(Some(x)) { String::new() } else { super::logs::js_string(x) }).unwrap_or_default();
            let buf = super::trust::base64_loose(&b64);
            let t = json::js_number(item.first());
            if let Some((v, acc, steer, left, right, brake)) = decode_record(&buf) {
                if t.is_finite() {
                    out.push(Frame { t, v, acc, steer, left, right, brake });
                }
            }
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let max = out.iter().fold(0f64, |m, f| if f.acc > m { f.acc } else { m });
    if max <= 1.01 {
        for f in &mut out {
            f.acc *= 100.0;
        }
    }
    out
}

pub fn clip_duration(frames: &[Frame]) -> f64 {
    if frames.is_empty() {
        return 0.0;
    }
    let dts: Vec<f64> = frames.windows(2).map(|w| w[1].t - w[0].t).collect();
    frames[frames.len() - 1].t + if dts.is_empty() { 0.0 } else { median(&dts) }
}

pub type Series = IndexMap<String, Vec<(f64, f64)>>;

#[derive(Default, Clone)]
pub struct Channels {
    pub speed: Vec<(f64, f64)>,
    pub steer: Vec<(f64, f64)>,
    pub accel: Vec<(f64, f64)>,
    pub brake: Vec<(f64, bool)>,
    pub left: Vec<(f64, bool)>,
    pub right: Vec<(f64, bool)>,
}

pub fn can_channels(series: &Series) -> Channels {
    let num = |name: &str| series.get(name).map(|p| p.iter().filter(|x| x.1.is_finite()).cloned().collect()).unwrap_or_default();
    let boolean = |name: &str, on: f64, off: f64| series.get(name).map(|p| p.iter().filter(|x| x.1 == on || x.1 == off).map(|x| (x.0, x.1 == on)).collect()).unwrap_or_default();
    Channels { speed: num(SIG_SPEED), steer: num(SIG_STEER), accel: num(SIG_ACCEL), brake: boolean(SIG_BRAKE, 2.0, 1.0), left: boolean(SIG_LEFT, 1.0, 0.0), right: boolean(SIG_RIGHT, 1.0, 0.0) }
}

#[derive(Debug, Clone)]
pub struct Edge {
    pub kind: String,
    pub t: f64,
}

fn flag(f: &Frame, k: usize) -> bool {
    match k {
        0 => f.brake,
        1 => f.left,
        _ => f.right,
    }
}
const BOOLS: [&str; 3] = ["brake", "left", "right"];

pub fn tel_edges(frames: &[Frame]) -> Vec<Edge> {
    let mut out = Vec::new();
    for i in 1..frames.len() {
        let (a, b) = (&frames[i - 1], &frames[i]);
        if b.t - a.t > MAX_FRAME_GAP {
            continue;
        }
        for (k, name) in BOOLS.iter().enumerate() {
            if flag(a, k) != flag(b, k) {
                out.push(Edge { kind: format!("{}{}", name, if flag(b, k) { '+' } else { '-' }), t: (a.t + b.t) / 2.0 });
            }
        }
        for th in ACCEL_STEPS {
            if (a.acc < th) != (b.acc < th) {
                out.push(Edge { kind: format!("acc{}{}", th, if b.acc >= th { '+' } else { '-' }), t: a.t + ((th - a.acc) / (b.acc - a.acc)) * (b.t - a.t) });
            }
        }
    }
    out
}

pub fn can_edges(ch: &Channels) -> Vec<Edge> {
    let mut out = Vec::new();
    for (name, pts) in [("brake", &ch.brake), ("left", &ch.left), ("right", &ch.right)] {
        for i in 1..pts.len() {
            if pts[i].1 != pts[i - 1].1 {
                out.push(Edge { kind: format!("{}{}", name, if pts[i].1 { '+' } else { '-' }), t: pts[i].0 });
            }
        }
    }
    let acc = &ch.accel;
    for i in 1..acc.len() {
        let (ta, a) = acc[i - 1];
        let (tb, b) = acc[i];
        for th in ACCEL_STEPS {
            if (a < th) == (b < th) {
                continue;
            }
            let t = if tb - ta <= 100.0 { ta + ((th - a) / (b - a)) * (tb - ta) } else { tb };
            out.push(Edge { kind: format!("acc{}{}", th, if b >= th { '+' } else { '-' }), t });
        }
    }
    out
}

fn by_type(edges: &[Edge]) -> HashMap<String, Vec<f64>> {
    let mut m: HashMap<String, Vec<f64>> = HashMap::new();
    for e in edges {
        m.entry(e.kind.clone()).or_default().push(e.t);
    }
    for l in m.values_mut() {
        l.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }
    m
}

struct Mode {
    offset_ms: f64,
    count: usize,
    second: usize,
}

fn edge_mode(tel: &[Edge], can: &[Edge], start: f64, center: f64, range: f64) -> Option<Mode> {
    let cm = by_type(can);
    let mut d = Vec::new();
    for e in tel {
        let Some(list) = cm.get(&e.kind) else { continue };
        let lo = start + e.t + center - range;
        let hi = start + e.t + center + range;
        for &t in list {
            if t >= lo && t <= hi {
                d.push(t - start - e.t);
            }
        }
    }
    if d.is_empty() {
        return None;
    }
    d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    const W: f64 = 40.0;
    let mut wins = Vec::new();
    let mut j = 0;
    for i in 0..d.len() {
        while j < d.len() && d[j] <= d[i] + W {
            j += 1;
        }
        wins.push((j - i, (d[i] + d[j - 1]) / 2.0, i, j));
    }
    let mut best = wins[0];
    for w in &wins {
        if w.0 > best.0 || (w.0 == best.0 && (w.1 - center).abs() < (best.1 - center).abs()) {
            best = *w;
        }
    }
    let mut second = 0;
    for w in &wins {
        if (w.1 - best.1).abs() > 150.0 && w.0 > second {
            second = w.0;
        }
    }
    Some(Mode { offset_ms: median(&d[best.2..best.3]), count: best.0, second })
}

fn match_edges(tel: &[Edge], can: &[Edge], predict: &dyn Fn(f64) -> f64, win: f64) -> Vec<(f64, f64)> {
    let cm = by_type(can);
    let mut out = Vec::new();
    for e in tel {
        let Some(list) = cm.get(&e.kind) else { continue };
        let want = predict(e.t);
        let lo = list.partition_point(|&x| x < want);
        let mut best: Option<f64> = None;
        for k in [lo as i64 - 1, lo as i64] {
            if k >= 0 && (k as usize) < list.len() {
                let c = list[k as usize];
                if (c - want).abs() <= win && best.is_none_or(|b| (c - want).abs() < (b - want).abs()) {
                    best = Some(c);
                }
            }
        }
        if let Some(b) = best {
            out.push((e.t, b));
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct Fit {
    pub a: f64,
    pub b: f64,
    pub n: usize,
    pub spread_ms: Option<f64>,
    pub keep: Vec<P>,
}

#[derive(Debug, Clone, Copy)]
pub struct P {
    pub x: f64,
    pub z: f64,
    pub k: usize,
}

pub fn robust_fit(points: &[P], slope: bool, floor: f64) -> Option<Fit> {
    if points.is_empty() {
        return None;
    }
    let mut pts: Vec<P> = points.to_vec();
    let mut a = median(&pts.iter().map(|p| p.z).collect::<Vec<_>>());
    let mut b = 0f64;
    let span_of = |v: &[P]| v.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) - v.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let mut thr = if slope { 60f64.max(2e-4 * span_of(&pts)) } else { 60.0 };
    for _ in 0..8 {
        let keep: Vec<P> = pts.iter().filter(|p| (p.z - (a + b * p.x)).abs() <= thr).cloned().collect();
        if keep.is_empty() {
            return None;
        }
        let span = span_of(&keep);
        if slope && keep.len() >= 10 && span >= 120_000.0 {
            let mx = keep.iter().map(|p| p.x).sum::<f64>() / keep.len() as f64;
            let mz = keep.iter().map(|p| p.z).sum::<f64>() / keep.len() as f64;
            let (mut sxx, mut sxz) = (0f64, 0f64);
            for p in &keep {
                sxx += (p.x - mx).powi(2);
                sxz += (p.x - mx) * (p.z - mz);
            }
            b = (sxz / sxx).clamp(-1e-3, 1e-3);
            a = mz - b * mx;
        } else {
            b = 0.0;
            a = keep.iter().map(|p| p.z).sum::<f64>() / keep.len() as f64;
        }
        let res: Vec<f64> = keep.iter().map(|p| p.z - (a + b * p.x)).collect();
        let mr = median(&res);
        let sigma = 1.4826 * median(&res.iter().map(|r| (r - mr).abs()).collect::<Vec<_>>());
        let next = floor.max(3.0 * sigma);
        let same = keep.len() == pts.len() && (next - thr).abs() < 0.01;
        pts = keep;
        thr = next;
        if same {
            break;
        }
    }
    let keep: Vec<P> = pts.iter().filter(|p| (p.z - (a + b * p.x)).abs() <= thr).cloned().collect();
    let res: Vec<f64> = keep.iter().map(|p| p.z - (a + b * p.x)).collect();
    let mean = res.iter().sum::<f64>() / (if res.is_empty() { 1 } else { res.len() }) as f64;
    let spread = (res.len() > 1).then(|| (res.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (res.len() - 1) as f64).sqrt());
    Some(Fit { a, b, n: keep.len(), spread_ms: spread, keep })
}

fn can_grid(pts: &[(f64, f64)], from: f64, n_: usize, step: f64) -> Vec<f64> {
    let mut out = vec![f64::NAN; n_];
    if pts.is_empty() {
        return out;
    }
    let end = pts[pts.len() - 1].0 + 1500.0;
    let mut k = 0;
    for (i, o) in out.iter_mut().enumerate() {
        let t = from + i as f64 * step;
        while k + 1 < pts.len() && pts[k + 1].0 <= t {
            k += 1;
        }
        if t < pts[0].0 || t > end {
            continue;
        }
        *o = match pts.get(k + 1) {
            Some(b) if b.0 - pts[k].0 <= 120.0 => pts[k].1 + ((t - pts[k].0) / (b.0 - pts[k].0)) * (b.1 - pts[k].1),
            _ => pts[k].1,
        };
    }
    out
}

fn tel_grid(frames: &[Frame], key: fn(&Frame) -> f64) -> (Vec<f64>, Vec<f64>) {
    let t0 = frames[0].t;
    let n_ = ((frames[frames.len() - 1].t - t0) / TEL_STEP).floor() as usize + 1;
    let mut ts = vec![0f64; n_];
    let mut vs = vec![0f64; n_];
    let mut k = 0;
    for i in 0..n_ {
        let t = t0 + i as f64 * TEL_STEP;
        while k + 1 < frames.len() && frames[k + 1].t <= t {
            k += 1;
        }
        let a = &frames[k];
        let b = &frames[(k + 1).min(frames.len() - 1)];
        ts[i] = t;
        vs[i] = if b.t > a.t && b.t - a.t <= MAX_FRAME_GAP { key(a) + ((t - a.t) / (b.t - a.t)) * (key(b) - key(a)) } else { key(a) };
    }
    (ts, vs)
}

fn deriv(arr: &[f64], h: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; arr.len()];
    let mut i = h;
    while i + h < arr.len() {
        out[i] = arr[i + h] - arr[i - h];
        i += 1;
    }
    out
}

fn idx_of(ts: f64, lag: f64, base: f64) -> i64 {
    json::round((ts + lag - base) / GRID_MS) as i64
}

fn pearson(tv: &[f64], cv: &[f64], ts: &[f64], base: f64, lag: f64) -> Option<f64> {
    let (mut nn, mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    for i in 0..ts.len() {
        let x = tv[i];
        let j = idx_of(ts[i], lag, base);
        let y = if j >= 0 && (j as usize) < cv.len() { cv[j as usize] } else { f64::NAN };
        if x.is_nan() || y.is_nan() {
            continue;
        }
        nn += 1.0;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }
    if nn < 200.0 {
        return None;
    }
    let vx = sxx - (sx * sx) / nn;
    let vy = syy - (sy * sy) / nn;
    if vx <= 1e-9 || vy <= 1e-9 {
        return None;
    }
    Some((sxy - (sx * sy) / nn) / (vx * vy).sqrt())
}

fn mean_gap(tv: &[f64], cv: &[f64], ts: &[f64], base: f64, lag: f64) -> Option<(f64, f64)> {
    let (mut nn, mut sum, mut mean) = (0f64, 0f64, 0f64);
    for i in 0..tv.len() {
        let j = idx_of(ts[i], lag, base);
        let y = if j >= 0 && (j as usize) < cv.len() { cv[j as usize] } else { f64::NAN };
        if tv[i].is_nan() || y.is_nan() {
            continue;
        }
        nn += 1.0;
        sum += (tv[i] - y).abs();
        mean += tv[i];
    }
    (nn >= 200.0).then(|| (sum / nn, mean / nn))
}

/// speedOffset: the offset that lines up the footage's speed with the CAN speed, or None.
fn speed_offset(frames: &[Frame], ch: &Channels, start: f64, center: f64, range: f64) -> Option<(f64, f64)> {
    if frames.len() < 50 || ch.speed.len() < 10 {
        return None;
    }
    let sp = tel_grid(frames, |f| f.v);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for &v in &sp.1 {
        if v < lo {
            lo = v;
        }
        if v > hi {
            hi = v;
        }
    }
    if hi - lo < 3.0 {
        return None;
    }
    let st = tel_grid(frames, |f| f.steer);
    let base = start + sp.0[0] + center - range - 1000.0;
    let n_ = ((sp.0[sp.0.len() - 1] - sp.0[0] + 2.0 * range + 2000.0) / GRID_MS).ceil() as usize;
    let cs = can_grid(&ch.speed, base, n_, GRID_MS);
    let cst = (ch.steer.len() >= 10).then(|| can_grid(&ch.steer, base, n_, GRID_MS));
    let ts_abs: Vec<f64> = sp.0.iter().map(|t| t + start).collect();
    let tdv = deriv(&sp.1, 3);
    let cdv = deriv(&cs, ((3.0 * TEL_STEP) / GRID_MS) as usize);
    let score = |lag: f64, fine: bool| -> Option<(f64, f64)> {
        let rs = pearson(&sp.1, &cs, &ts_abs, base, lag)?;
        let mut parts = vec![rs];
        if fine {
            if let Some(rd) = pearson(&tdv, &cdv, &ts_abs, base, lag) {
                parts.push(rd);
            }
        }
        if let Some(c) = &cst {
            if let Some(rt) = pearson(&st.1, c, &ts_abs, base, lag) {
                parts.push(rt.abs());
            }
        }
        Some((rs, parts.iter().sum::<f64>() / parts.len() as f64))
    };
    let mut best: Option<(f64, f64, f64)> = None; // lag, rs, s
    let mut coarse = Vec::new();
    let mut lag = center - range;
    while lag <= center + range {
        if let Some((rs, s)) = score(lag, false) {
            coarse.push((lag, s));
            if best.is_none_or(|b| s > b.2) {
                best = Some((lag, rs, s));
            }
        }
        lag += 100.0;
    }
    let best = best?;
    let far: Vec<f64> = coarse.iter().filter(|x| (x.0 - best.0).abs() >= 2000.0).map(|x| x.1).collect();
    if !far.is_empty() && best.2 - far.iter().cloned().fold(f64::NEG_INFINITY, f64::max) < 0.03 {
        return None;
    }
    let mut fine = Vec::new();
    let mut lag = best.0 - 250.0;
    while lag <= best.0 + 250.0 {
        fine.push((lag, score(lag, true)));
        lag += GRID_MS;
    }
    let mut k: i64 = -1;
    for i in 0..fine.len() {
        if let Some(sc) = fine[i].1 {
            if k < 0 || sc.1 > fine[k as usize].1.unwrap().1 {
                k = i as i64;
            }
        }
    }
    if k < 0 || fine[k as usize].1.unwrap().0 < 0.85 {
        return None;
    }
    let ku = k as usize;
    let agree = mean_gap(&sp.1, &cs, &ts_abs, base, fine[ku].0)?;
    if agree.0 > 3f64.max(0.08 * agree.1) {
        return None;
    }
    let mut off = fine[ku].0;
    if ku > 0 && ku + 1 < fine.len() {
        if let (Some(a), Some(b), Some(c)) = (fine[ku - 1].1, fine[ku].1, fine[ku + 1].1) {
            let (y0, y1, y2) = (a.1, b.1, c.1);
            let den = y0 - 2.0 * y1 + y2;
            if den < 0.0 {
                off += (GRID_MS * (y0 - y2)) / (2.0 * den);
            }
        }
    }
    let mut best2: Option<(f64, f64)> = None;
    let mut lag = off - 150.0;
    while lag <= off + 150.0 {
        if let Some(g) = mean_gap(&sp.1, &cs, &ts_abs, base, lag) {
            if best2.is_none_or(|b| g.0 < b.1) {
                best2 = Some((lag, g.0));
            }
        }
        lag += GRID_MS;
    }
    if let Some(b2) = best2 {
        if (b2.0 - off).abs() < 150.0 {
            off = b2.0;
        }
    }
    Some((off, fine[ku].1.unwrap().1))
}

fn speed_at(pts: &[(f64, f64)], t: f64) -> Option<f64> {
    if pts.is_empty() || t < pts[0].0 || t > pts[pts.len() - 1].0 + 1500.0 {
        return None;
    }
    let (mut lo, mut hi) = (0usize, pts.len() - 1);
    while lo < hi {
        let m = (lo + hi + 1) >> 1;
        if pts[m].0 <= t {
            lo = m;
        } else {
            hi = m - 1;
        }
    }
    let a = pts[lo];
    Some(match pts.get(lo + 1) {
        Some(b) if b.0 - a.0 <= 1200.0 => a.1 + ((t - a.0) / (b.0 - a.0)) * (b.1 - a.1),
        _ => a.1,
    })
}

#[derive(Debug, Clone, Copy)]
pub struct CheckOut {
    pub speed_gap: Option<f64>,
    pub edges: usize,
    pub edge_res: Option<f64>,
}

/// clipCheck: how well an offset fits a clip.
pub struct Checker {
    moving: Vec<Frame>,
    speed: Vec<(f64, f64)>,
    tel: Vec<Edge>,
    cm: HashMap<String, Vec<f64>>,
    start: f64,
}

impl Checker {
    pub fn check(&self, off: f64) -> CheckOut {
        let mut speed_gap = None;
        if self.moving.len() >= 300 && self.speed.len() >= 10 {
            let (mut nn, mut sum) = (0usize, 0f64);
            for f in &self.moving {
                if let Some(c) = speed_at(&self.speed, self.start + off + f.t) {
                    nn += 1;
                    sum += (f.v - c).abs();
                }
            }
            if nn as f64 >= 0.8 * self.moving.len() as f64 {
                speed_gap = Some(sum / nn as f64);
            }
        }
        let mut res = Vec::new();
        for e in &self.tel {
            let Some(list) = self.cm.get(&e.kind) else { continue };
            let want = self.start + off + e.t;
            let lo = list.partition_point(|&x| x < want);
            let mut d = f64::INFINITY;
            for k in [lo as i64 - 1, lo as i64] {
                if k >= 0 && (k as usize) < list.len() {
                    d = d.min((list[k as usize] - want).abs());
                }
            }
            if d <= 40.0 {
                res.push(d);
            }
        }
        CheckOut { speed_gap, edges: res.len(), edge_res: (!res.is_empty()).then(|| median(&res)) }
    }
}

fn no_worse(check: Option<&Checker>, a: f64, b: f64) -> bool {
    let Some(c) = check else { return true };
    let x = c.check(a);
    let y = c.check(b);
    if (y.edges as i64) < x.edges as i64 - if (a - b).abs() <= 30.0 { 1 } else { 0 } {
        return false;
    }
    if let Some(xg) = x.speed_gap {
        if y.speed_gap.is_none_or(|yg| yg > xg * 1.1 + 0.02) {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyncResult {
    pub offset_ms: f64,
    pub method: &'static str,
    pub matches: usize,
    pub spread_ms: Option<f64>,
    pub rate: Option<f64>,
    pub drift_ppm: Option<f64>,
    pub clips: Option<usize>,
}

impl SyncResult {
    fn plain(offset_ms: f64, method: &'static str, matches: usize, spread_ms: Option<f64>) -> SyncResult {
        SyncResult { offset_ms, method, matches, spread_ms, rate: None, drift_ppm: None, clips: None }
    }
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("offsetMs".into(), n(self.offset_ms));
        o.insert("method".into(), json!(self.method));
        o.insert("matches".into(), json!(self.matches));
        o.insert("spreadMs".into(), self.spread_ms.map(n).unwrap_or(Value::Null));
        if let Some(r) = self.rate {
            o.insert("rate".into(), n(r));
        }
        if let Some(d) = self.drift_ppm {
            o.insert("driftPpm".into(), n(d));
        }
        if let Some(c) = self.clips {
            o.insert("clips".into(), json!(c));
        }
        Value::Object(o)
    }
    pub fn from_json(v: &Value) -> Option<SyncResult> {
        let method = match v.get("method")?.as_str()? {
            "clock" => "clock",
            "edges" => "edges",
            "speed" => "speed",
            "edges-drive" => "edges-drive",
            "speed-drive" => "speed-drive",
            "drive" => "drive",
            _ => return None,
        };
        Some(SyncResult {
            offset_ms: v.get("offsetMs")?.as_f64()?,
            method,
            matches: v.get("matches").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
            spread_ms: v.get("spreadMs").and_then(|x| x.as_f64()),
            rate: v.get("rate").and_then(|x| x.as_f64()),
            drift_ppm: v.get("driftPpm").and_then(|x| x.as_f64()),
            clips: v.get("clips").and_then(|x| x.as_u64()).map(|x| x as usize),
        })
    }
}

pub struct Estimate {
    pub result: SyncResult,
    pub dur: f64,
    pub tel: Vec<Edge>,
    pub can: Vec<Edge>,
    pub has_can: bool,
    pub check: Option<Checker>,
    pub failed: bool,
}

/// estimateClip: one clip on its own.
pub fn estimate_clip(frames: &[Frame], series: &Series, start: f64) -> Estimate {
    let ch = can_channels(series);
    let has_can = NAMES.iter().any(|nm| series.get(*nm).is_some_and(|p| !p.is_empty()));
    let dur = clip_duration(frames);
    let tel = if frames.is_empty() { Vec::new() } else { tel_edges(frames) };
    let can = can_edges(&ch);
    let clock = SyncResult::plain(0.0, "clock", 0, None);
    if frames.is_empty() || !has_can {
        return Estimate { result: clock, dur, tel, can, has_can, check: None, failed: false };
    }
    let checker = Checker { moving: frames.iter().filter(|f| f.v > MOVING_KPH).cloned().collect(), speed: ch.speed.clone(), tel: tel.clone(), cm: by_type(&can), start };
    let sp = speed_offset(frames, &ch, start, 0.0, SEARCH_MS);
    let mode = edge_mode(&tel, &can, start, sp.map_or(0.0, |s| s.0), if sp.is_some() { 600.0 } else { SEARCH_MS });
    let mut fit = None;
    if let Some(m) = &mode {
        if sp.is_some() || (m.count >= 3 && m.second as f64 <= 0.6 * m.count as f64) {
            let off = m.offset_ms;
            let pairs = match_edges(&tel, &can, &|t| start + t + off, 100.0);
            let pts: Vec<P> = pairs.iter().map(|p| P { x: p.0, z: p.1 - start - p.0, k: 0 }).collect();
            fit = robust_fit(&pts, false, 15.0);
        }
    }
    let mut result = clock;
    if let Some(f) = fit.as_ref().filter(|f| f.n >= 3) {
        result = SyncResult::plain(r1(f.a), "edges", f.n, f.spread_ms.map(r1));
    } else if let Some(s) = sp {
        result = SyncResult::plain(r1(s.0), "speed", 0, None);
    }
    if result.method == "edges" {
        if let Some(s) = sp {
            if (result.offset_ms - s.0).abs() > 100.0 {
                let e = checker.check(result.offset_ms);
                let sc = checker.check(s.0);
                if let (Some(eg), Some(sg)) = (e.speed_gap, sc.speed_gap) {
                    if eg > 1.5 * sg + 0.03 {
                        result = SyncResult::plain(r1(s.0), "speed", 0, None);
                    }
                }
            }
        }
    }
    Estimate { result, dur, tel, can, has_can, check: Some(checker), failed: false }
}

fn speed_refine(check: Option<&Checker>, center: f64, range: f64) -> Option<f64> {
    let c = check?;
    c.check(center).speed_gap?;
    let mut pts = Vec::new();
    let mut off = center - range;
    while off <= center + range {
        if let Some(g) = c.check(off).speed_gap {
            pts.push((off, g));
        }
        off += 10.0;
    }
    if pts.len() < 10 {
        return None;
    }
    let mut best = pts[0];
    for p in &pts {
        if p.1 < best.1 {
            best = *p;
        }
    }
    if best.0 <= center - range + 20.0 || best.0 >= center + range - 20.0 {
        return None;
    }
    let around = c.check(best.0 - 200.0).speed_gap.unwrap_or(f64::INFINITY).min(c.check(best.0 + 200.0).speed_gap.unwrap_or(f64::INFINITY));
    if !(around - best.1 >= 0.005) || best.1 > 0.7 * median(&pts.iter().map(|p| p.1).collect::<Vec<_>>()) {
        return None;
    }
    let (mut b2, mut g2) = (best.0, best.1);
    let mut off = best.0 - 10.0;
    while off <= best.0 + 10.0 {
        if let Some(g) = c.check(off).speed_gap {
            if g < g2 {
                g2 = g;
                b2 = off;
            }
        }
        off += 1.0;
    }
    Some(b2)
}

pub struct DriveClip {
    pub start: f64,
    pub est: Estimate,
}

fn solid(m: &str) -> bool {
    m == "edges" || m == "speed"
}

/// solveDrive: a drive's clips in order; each clip's result (with `rate` for the drift).
pub fn solve_drive(clips: &[DriveClip]) -> Vec<SyncResult> {
    let mut out: Vec<SyncResult> = clips.iter().map(|c| c.est.result.clone()).collect();
    let is_solid = |k: usize| solid(clips[k].est.result.method);
    let follows = |k: usize| k > 0 && clips[k - 1].est.dur > 0.0 && clips[k].est.dur > 0.0 && (clips[k].start - clips[k - 1].start - clips[k - 1].est.dur).abs() <= 1500.0;
    let mut gap_of: HashMap<usize, f64> = HashMap::new();
    let mut measured = Vec::new();
    for k in 1..clips.len() {
        if !follows(k) || !is_solid(k) || !is_solid(k - 1) {
            continue;
        }
        let g = (clips[k].start + clips[k].est.result.offset_ms) - (clips[k - 1].start + clips[k - 1].est.result.offset_ms) - clips[k - 1].est.dur;
        if g > -300.0 && g < 1500.0 {
            let v = if g.abs() < GAP_NONE_MS { 0.0 } else { g };
            gap_of.insert(k, v);
            measured.push((k, v));
        }
    }
    let measured: Vec<f64> = measured.into_iter().map(|x| x.1).collect();
    let named: Vec<f64> = (1..clips.len()).filter(|&k| follows(k)).map(|k| clips[k].start - clips[k - 1].start - clips[k - 1].est.dur).collect();
    let guess = if measured.len() >= 2 { median(&measured) } else if named.len() >= 3 { median(&named) } else { 0.0 };
    let typical = if guess.abs() >= GAP_NONE_MS { guess } else { 0.0 };
    // chains of clips that follow on: (k, C, guessed)
    let mut segs: Vec<Vec<(usize, f64, usize)>> = Vec::new();
    for k in 0..clips.len() {
        if let (Some(seg), true) = (segs.last_mut(), follows(k)) {
            let (_, c0, g0) = *seg.last().unwrap();
            let known = gap_of.contains_key(&k);
            seg.push((k, c0 + clips[k - 1].est.dur + if known { gap_of[&k] } else { typical }, g0 + usize::from(!known)));
        } else {
            segs.push(vec![(k, 0.0, 0)]);
        }
    }
    for s in &segs {
        let mut fitted_of: HashMap<usize, SyncResult> = HashMap::new();
        let fill = |out: &mut Vec<SyncResult>, fitted_of: &HashMap<usize, SyncResult>| {
            let mut anchor: IndexMap<usize, f64> = IndexMap::new();
            for (i, (k, _, _)) in s.iter().enumerate() {
                if is_solid(*k) {
                    anchor.insert(i, out[*k].offset_ms);
                }
            }
            let mut pending: Vec<usize> = (0..s.len()).filter(|&i| !is_solid(s[i].0)).collect();
            while !pending.is_empty() {
                let (mut pick, mut from): (i64, i64) = (-1, -1);
                for &i in &pending {
                    for &j in anchor.keys() {
                        if pick < 0 || (i as i64 - j as i64).abs() < (pick - from).abs() {
                            pick = i as i64;
                            from = j as i64;
                        }
                    }
                }
                if pick < 0 {
                    for &i in &pending {
                        if let Some(f) = fitted_of.get(&i) {
                            out[s[i].0] = f.clone();
                        }
                    }
                    break;
                }
                let (pick, from) = (pick as usize, from as usize);
                pending.retain(|&x| x != pick);
                let k = s[pick].0;
                let near = clips[s[from].0].start + anchor[&from] + (s[pick].1 - s[from].1) - clips[k].start;
                let mut guessed = 0;
                for x in pick.min(from) + 1..=pick.max(from) {
                    if !gap_of.contains_key(&s[x].0) {
                        guessed += 1;
                    }
                }
                let range = 1500f64.min(300.0 + 200.0 * guessed as f64);
                let fitted = fitted_of.get(&pick);
                if let Some(f) = fitted {
                    if typical == 0.0 && guessed == 0 {
                        out[k] = f.clone();
                        continue;
                    }
                }
                let mut refined = speed_refine(clips[k].est.check.as_ref(), near, range);
                if refined.is_none() {
                    if let Some(f) = fitted {
                        refined = speed_refine(clips[k].est.check.as_ref(), f.offset_ms, range);
                    }
                }
                match refined {
                    Some(r) => {
                        out[k] = SyncResult::plain(r1(r), "speed-drive", 0, None);
                        anchor.insert(pick, r);
                    }
                    None => out[k] = SyncResult::plain(r1(near), "drive", 0, None),
                }
            }
        };
        let live: Vec<(usize, f64)> = s.iter().filter(|(k, _, _)| clips[*k].est.has_can && !clips[*k].est.tel.is_empty()).map(|(k, c, _)| (*k, *c)).collect();
        if live.is_empty() {
            fill(&mut out, &fitted_of);
            continue;
        }
        let collect = |predict: &dyn Fn(usize, f64) -> Option<Box<dyn Fn(f64) -> f64>>, win: &dyn Fn(usize) -> f64, skip: &std::collections::HashSet<usize>| -> Vec<P> {
            let mut pts = Vec::new();
            for &(k, c) in &live {
                if skip.contains(&k) {
                    continue;
                }
                let Some(pr) = predict(k, c) else { continue };
                for p in match_edges(&clips[k].est.tel, &clips[k].est.can, &*pr, win(k)) {
                    pts.push(P { x: c + p.0, z: p.1 - (c + p.0), k });
                }
            }
            pts
        };
        let none = std::collections::HashSet::new();
        let pass1 = collect(
            &|k, _c| {
                let r = &clips[k].est.result;
                if r.method == "clock" {
                    return None;
                }
                let (st, off) = (clips[k].start, r.offset_ms);
                Some(Box::new(move |t| st + t + off))
            },
            &|k| if clips[k].est.result.method == "edges" { 60.0 } else { 250.0 },
            &none,
        );
        let mut fit = match robust_fit(&pass1, true, 15.0) {
            Some(f) if f.n >= 6 => f,
            _ => {
                fill(&mut out, &fitted_of);
                continue;
            }
        };
        let mut outside: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for _ in 0..2 {
            let (fa, fb) = (fit.a, fit.b);
            let pts = collect(&|_k, c| Some(Box::new(move |t| fa + (1.0 + fb) * (c + t))), &|_| 80.0, &outside);
            let next = match robust_fit(&pts, true, 15.0) {
                Some(f) if f.n >= 6 => f,
                _ => break,
            };
            fit = next;
            let mut moved = false;
            for &(k, _) in &live {
                if outside.contains(&k) {
                    continue;
                }
                let mine: Vec<&P> = pts.iter().filter(|p| p.k == k).collect();
                if mine.len() < 3 {
                    continue;
                }
                let res = median(&mine.iter().map(|p| p.z - (fit.a + fit.b * p.x)).collect::<Vec<_>>());
                if res.abs() > 25f64.max(3.0 * fit.spread_ms.unwrap_or(0.0)) {
                    outside.insert(k);
                    moved = true;
                }
            }
            if !moved {
                break;
            }
        }
        let used: std::collections::HashSet<usize> = fit.keep.iter().map(|p| p.k).collect();
        for (i, (k, c, _)) in s.iter().enumerate() {
            if outside.contains(k) {
                continue;
            }
            let cand = fit.a + (1.0 + fit.b) * c - clips[*k].start;
            let fitted = SyncResult { offset_ms: r1(cand), method: "edges-drive", matches: fit.n, spread_ms: fit.spread_ms.map(r1), rate: Some(1.0 + fit.b), drift_ppm: Some(r1(fit.b * 1e6)), clips: Some(used.len()) };
            if is_solid(*k) {
                if no_worse(clips[*k].est.check.as_ref(), clips[*k].est.result.offset_ms, fitted.offset_ms) {
                    out[*k] = fitted;
                }
            } else {
                fitted_of.insert(i, fitted);
            }
        }
        fill(&mut out, &fitted_of);
    }
    out
}

//! The speed index (server/speedIndex.js): every front-camera clip's speed,
//! one value a second, plus the summary Find moments and the place search
//! read, kept in the catalog so a day's speed graph is one small query. A
//! clip is read again only when its size or time changes.

use crate::catalog::{Catalog, Front};
use crate::inventory::num;
use crate::sei::{self, js_round, r2, Sample};
use crate::telemetry;
use serde_json::{json, Value};
use std::path::Path;

const GPS_EVERY: usize = 5;
const SUMMARY_VERSION: u32 = 2;

fn r5(x: f64) -> f64 {
    js_round(x * 1e5) / 1e5
}

/// A clip's summary from its seconds (speedIndex.js summarize).
pub fn summarize(samples: &[Option<Sample>]) -> Value {
    let mut b: Option<(usize, f64)> = None;
    let mut t: Option<(usize, f64)> = None;
    let mut v: Option<(usize, f64)> = None;
    let mut g = Vec::new();
    for s in 0..samples.len() {
        let Some(x) = samples[s] else { continue };
        if let Some(xv) = x.v {
            if v.map_or(true, |v| xv > v.1) {
                v = Some((s, r2(xv)));
            }
        }
        let n = samples.get(s + 1).copied().flatten();
        let p = if s > 0 { samples[s - 1] } else { None };
        let lost_next = match (x.v, n.and_then(|n| n.v)) {
            (Some(a), Some(c)) => a - c,
            _ => 0.0,
        };
        let lost_prev = match (x.v, p.and_then(|p| p.v)) {
            (Some(a), Some(c)) => c - a,
            _ => 0.0,
        };
        if x.v.is_some() && n.and_then(|n| n.v).is_some() && lost_next > 0.0 && b.map_or(true, |b| lost_next > b.1) {
            b = Some((s, r2(lost_next)));
        }
        let dec = match x.ax {
            Some(ax) if ax.is_finite() && ax < 0.0 => -ax,
            _ => 0.0,
        };
        if dec > 0.0 && (lost_next > 0.3 || lost_prev > 0.3) && lost_next.max(lost_prev) >= 0.4 * dec && b.map_or(true, |b| dec > b.1) {
            b = Some((s, r2(dec)));
        }
        if let Some(ay) = x.ay {
            if t.map_or(true, |t| ay.abs() > t.1) {
                t = Some((s, r2(ay.abs())));
            }
        }
        if let (Some(lat), Some(lon)) = (x.lat, x.lon) {
            if s % GPS_EVERY == 0 && (lat != 0.0 || lon != 0.0) && lat.abs() <= 90.0 && lon.abs() <= 180.0 {
                g.push(json!([s, num(r5(lat)), num(r5(lon))]));
            }
        }
    }
    let pair = |p: Option<(usize, f64)>| p.map(|(s, x)| json!([s, num(x)]));
    json!({ "b": pair(b), "t": pair(t), "v": pair(v), "g": g, "k": SUMMARY_VERSION })
}

fn speeds_json(speeds: &[Option<f64>]) -> String {
    Value::Array(speeds.iter().map(|v| v.map_or(Value::Null, num)).collect()).to_string()
}

/// Speeds and summary of one clip (speedIndex.js speedsFor): the quick read, else the
/// dashboard's full read (telemetry.rs), which gives speeds only; (None, None) when it has
/// none or cannot be read. `size`: the size the scan found.
pub fn speeds_for(path: &Path, size: u64) -> (Option<Vec<Option<f64>>>, Option<Value>) {
    match sei::read_samples(path) {
        Ok(Some(samples)) => {
            let speeds: Vec<Option<f64>> = samples.iter().map(|x| x.and_then(|x| x.v).map(r2)).collect();
            (Some(speeds), Some(summarize(&samples)))
        }
        Ok(None) => (None, None),
        Err(_) => match telemetry::read_records(path, size) {
            Ok(frames) => match telemetry::speeds_of(&frames) {
                Some(speeds) => {
                    let samples: Vec<Option<Sample>> = speeds.iter().map(|&v| Some(Sample { v, ..Sample::default() })).collect();
                    let sum = summarize(&samples);
                    (Some(speeds), Some(sum))
                }
                None => (None, None),
            },
            Err(_) => (None, None),
        },
    }
}

/// speeds_for as the catalog keeps it: (speeds JSON, summary JSON).
pub fn read_clip(path: &Path, size: u64) -> (Option<String>, Option<String>) {
    let (sp, sum) = speeds_for(path, size);
    (sp.as_deref().map(speeds_json), sum.map(|s| s.to_string()))
}

/// Index what is new or changed: returns how many clips were read.
pub fn pass(catalog: &Catalog, vehicle: &str, root: &Path, progress: &dyn Fn(usize, usize, &str)) -> rusqlite::Result<usize> {
    let todo: Vec<Front> = catalog.fronts(vehicle)?.into_iter().filter(|(_, had)| !had).map(|(f, _)| f).collect();
    let total = todo.len();
    for (i, f) in todo.iter().enumerate() {
        let (sp, sum) = read_clip(&root.join(&f.rel), f.size);
        catalog.put_speeds(vehicle, f, sp.as_deref(), sum.as_deref())?;
        progress(i + 1, total, &f.day);
    }
    Ok(total)
}

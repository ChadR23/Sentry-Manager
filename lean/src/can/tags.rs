//! Which recordings have CAN Bridge data, the green "CAN" tag on the Footage
//! page (server/canFootage.js): an indexed minute of one of the car's CAN keys
//! overlaps the recording's clips, from its first clip's start to its last
//! clip's end. The minutes are kept per car until the index changes.

use super::ctx::{Car, Rec};
use std::collections::HashMap;
use std::sync::Mutex;

pub const CLIP_MS: f64 = 62_000.0;
const MINUTE_MS: f64 = 60_000.0;

/// Whether an indexed minute (sorted starts) overlaps [from, to).
pub fn minute_in(minutes: &[f64], from: f64, to: f64) -> bool {
    let i = minutes.partition_point(|&m| m < from - MINUTE_MS + 1.0);
    i < minutes.len() && minutes[i] < to
}

/// A recording's first and last clip name stamps, or None.
pub fn clip_range(rec: &Rec) -> Option<(String, String)> {
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    for rel in &rec.clip_rels {
        let Some(m) = super::search::ts_from(rel.rsplit('/').next().unwrap_or(rel)) else { continue };
        if first.as_ref().is_none_or(|f| m < *f) {
            first = Some(m.clone());
        }
        if last.as_ref().is_none_or(|l| m > *l) {
            last = Some(m);
        }
    }
    if first.is_none() {
        if let Some(k) = rec.start_key.as_deref().and_then(super::search::ts_from) {
            first = Some(k.clone());
            last = Some(k);
        }
    }
    Some((first?, last?))
}

struct CarMinutes {
    sig: Option<String>,
    minutes: Vec<f64>,
    zone: String,
    #[allow(dead_code)]
    stamps: HashMap<String, Option<f64>>,
}

#[derive(Default)]
pub struct CanTags {
    cars: Mutex<HashMap<String, CarMinutes>>,
}

impl CanTags {
    /// A test rec -> CAN data covers it, for car `v` (its minutes read once).
    pub fn for_vehicle(&self, v: &Car, keys: &[String], generation: u64, minute_times: &dyn Fn(&str) -> Vec<f64>) -> impl Fn(&Rec) -> bool {
        let mut keys = keys.to_vec();
        keys.sort();
        let zone = if v.timezone.is_empty() { "UTC".to_string() } else { v.timezone.clone() };
        let sig = format!("{}|{}", generation, keys.join(","));
        let mut cars = self.cars.lock().unwrap();
        let c = cars.entry(v.id.clone()).or_insert_with(|| CarMinutes { sig: None, minutes: Vec::new(), zone: zone.clone(), stamps: HashMap::new() });
        if c.zone != zone {
            *c = CarMinutes { sig: None, minutes: Vec::new(), zone: zone.clone(), stamps: HashMap::new() };
        }
        if c.sig.as_deref() != Some(sig.as_str()) {
            let mut all: Vec<f64> = keys.iter().flat_map(|k| minute_times(k)).collect();
            all.sort_by(|a, b| a.partial_cmp(b).unwrap());
            all.dedup();
            c.minutes = all;
            c.sig = Some(sig);
        }
        let minutes = c.minutes.clone();
        drop(cars);
        let car = v.clone();
        move |rec: &Rec| {
            if minutes.is_empty() {
                return false;
            }
            let Some((first, last)) = clip_range(rec) else { return false };
            let (Some(from), Some(to)) = (super::prune::start_of(&car, &first), super::prune::start_of(&car, &last)) else { return false };
            minute_in(&minutes, from, from.max(to) + CLIP_MS)
        }
    }

    pub fn forget(&self, vid: &str) {
        self.cars.lock().unwrap().remove(vid);
    }
}

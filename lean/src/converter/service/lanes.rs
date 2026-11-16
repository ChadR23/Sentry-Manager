//! jobService.js lanes: several GPUs, each set by hand, a lane per GPU with
//! its own number of conversions at once. Every worker belongs to one lane
//! (None is the default lane, the only one of a job without lanes) and takes
//! the next queued clip whenever it is free. Also the decode tiers of an
//! encode (zero-copy, GPU, CPU), kept per GPU and encoder.

use super::*;
use super::super::planner::{Device, Selected};
use indexmap::IndexMap;

/// Clips each helper server is sent beyond its conversions at once
pub const NODE_SEND_AHEAD: usize = 15;
/// the most a helper server converts at once
pub const NODE_MAX_AT_ONCE: i64 = 8;

/// resolveLanes' answer: { fallback, limits, base, devices }
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LanePlan {
    pub fallback: bool,
    pub limits: IndexMap<String, usize>,
    pub base: IndexMap<String, usize>,
    pub devices: IndexMap<String, Value>,
}

/// A worker's lane: its device id and the device found for it.
#[derive(Debug, Clone)]
pub struct Lane {
    pub id: String,
    pub device: Value,
}

/// lanesOf(manifest)
pub fn lanes_of(m: &Manifest) -> Option<Value> {
    m.config().get("lanes").filter(|l| l.as_array().is_some_and(|a| !a.is_empty())).cloned()
}

/// shareAhead(owns): NODE_SEND_AHEAD shared in proportion
pub fn share_ahead(owns: &[usize]) -> Vec<usize> {
    let total: usize = owns.iter().sum();
    if total == 0 {
        return owns.iter().map(|_| 0).collect();
    }
    let exact: Vec<f64> = owns.iter().map(|n| (NODE_SEND_AHEAD * n) as f64 / total as f64).collect();
    let mut shares: Vec<usize> = exact.iter().map(|x| x.floor() as usize).collect();
    let mut left = NODE_SEND_AHEAD as i64 - shares.iter().sum::<usize>() as i64;
    let mut order: Vec<(f64, usize)> = exact.iter().enumerate().map(|(i, v)| (v - v.floor(), i)).collect();
    // (Array.prototype.sort is stable)
    order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    for (_, i) in order {
        if left <= 0 {
            break;
        }
        shares[i] += 1;
        left -= 1;
    }
    shares
}

impl RtState {
    pub fn lane_counter(&mut self, lane: &Option<String>) -> &mut (usize, usize) {
        self.lane_counters.entry(lane.clone()).or_insert((0, 0))
    }
    /// laneLimit(runtime, laneId)
    pub fn lane_limit(&self, lane: &Option<String>) -> usize {
        match &self.lane_plan {
            Some(p) if !p.fallback => lane.as_ref().map(|id| p.limits.get(id).copied().unwrap_or(0)).unwrap_or(0),
            _ => {
                if lane.is_none() {
                    self.concurrency()
                } else {
                    0
                }
            }
        }
    }
    /// laneActive(runtime, laneId)
    pub fn lane_active(&self, lane: &Option<String>) -> usize {
        self.lane_counters.get(lane).map(|(l, r)| l.saturating_sub(*r)).unwrap_or(0)
    }
    /// deviceActive(runtime, laneId): the default lane and the lane of the
    /// device a job without lanes uses count together
    pub fn device_active(&self, lane: &Option<String>) -> usize {
        let shared = self.default_lane.clone().flatten();
        match lane {
            None => self.lane_active(&None) + shared.map(|s| self.lane_active(&Some(s))).unwrap_or(0),
            Some(id) => self.lane_active(lane) + if shared.as_deref() == Some(id.as_str()) { self.lane_active(&None) } else { 0 },
        }
    }
    /// ownLanesOff: every one of this server's devices set to Off (only helper servers convert)
    pub fn own_lanes_off(&self) -> bool {
        let Some(p) = self.lane_plan.as_ref().filter(|p| !p.fallback) else { return false };
        !p.limits.iter().any(|(id, n)| *n > 0 && !id.starts_with("node:"))
    }
}

impl Service {
    /// resolveLanes(lanes): finds each lane's GPU among the devices this container has now
    pub fn resolve_lanes(&self, lanes: &Value) -> LanePlan {
        struct Found {
            lane_device: String,
            concurrency: i64,
            device: Value,
            own: i64,
            ahead: usize,
        }
        let list = lanes.as_array().cloned().unwrap_or_default();
        let named: std::collections::HashSet<String> = list.iter().filter_map(|l| l["device"].as_str().map(str::to_string)).collect();
        let mut found: Vec<Found> = vec![];
        for lane in &list {
            let id = lane["device"].as_str().unwrap_or("").to_string();
            let conc = lane["concurrency"].as_i64().unwrap_or(0);
            let device = self.0.o.resolve_device.as_ref().and_then(|f| f(&id));
            let did = device.as_ref().and_then(|d| d["id"].as_str()).map(str::to_string);
            let alias = device.is_some() && did.as_deref() != Some(id.as_str()) && device.as_ref().unwrap()["kind"] == "node" && did.as_deref().and_then(contracts::node_key_of) == Some(id.as_str());
            if alias && did.as_ref().is_some_and(|d| named.contains(d)) {
                continue;
            }
            match device {
                Some(d) if did.as_deref() == Some(id.as_str()) || alias => found.push(Found { lane_device: id, concurrency: conc, device: d, own: conc, ahead: 0 }),
                _ => eprintln!("[CONVERTER] Encoding device {id} is not in the container; its {conc} conversions at once are not started."),
            }
        }
        // a helper server converts as many at once on each device as its rows say
        let mut by_node: IndexMap<String, Vec<usize>> = IndexMap::new();
        for (i, f) in found.iter().enumerate() {
            if f.device["kind"] != "node" {
                continue;
            }
            let did = f.device["id"].as_str().unwrap_or("").to_string();
            let key = contracts::node_key_of(&did).map(str::to_string).unwrap_or(did);
            by_node.entry(key).or_default().push(i);
        }
        for (key, idx) in &by_node {
            let slots = |f: &Found| f.device["slots"].as_i64().filter(|s| *s > 0);
            if let Some(set) = &self.0.o.set_node_slots {
                for &i in idx {
                    found[i].own = found[i].concurrency.min(NODE_MAX_AT_ONCE);
                }
                if idx.iter().any(|&i| found[i].device["slots"].as_i64() != Some(found[i].own)) {
                    let per_device = idx.iter().all(|&i| found[i].device["id"].as_str() != Some(key.as_str()));
                    let r = if per_device {
                        let m: Map<String, Value> = idx.iter().map(|&i| (found[i].device["id"].as_str().unwrap_or("").to_string(), json!(found[i].own))).collect();
                        set(key, &Value::Object(m))
                    } else {
                        set(found[idx[0]].device["id"].as_str().unwrap_or(""), &json!(found[idx[0]].own))
                    };
                    if r.is_err() {
                        for &i in idx {
                            if let Some(s) = slots(&found[i]) {
                                found[i].own = found[i].own.min(s);
                            }
                        }
                    }
                }
            } else {
                for &i in idx {
                    if let Some(s) = slots(&found[i]) {
                        found[i].own = found[i].concurrency.min(s);
                    }
                }
            }
            let ahead = share_ahead(&idx.iter().map(|&i| found[i].own.max(0) as usize).collect::<Vec<_>>());
            for (n, &i) in idx.iter().enumerate() {
                found[i].ahead = ahead[n];
            }
        }
        let mut plan = LanePlan::default();
        for f in found {
            plan.limits.insert(f.lane_device.clone(), f.own.max(0) as usize + f.ahead);
            plan.base.insert(f.lane_device.clone(), f.own.max(0) as usize);
            plan.devices.insert(f.lane_device, f.device);
        }
        plan.fallback = plan.devices.is_empty();
        plan
    }

    /// noteDefaultLane(runtime, toLanes): before switching between no lanes and lanes
    pub fn note_default_lane(&self, rt: &Runtime, to_lanes: bool) {
        let (from_lanes, known, codec) = {
            let s = rt.lock();
            (s.lane_plan.as_ref().is_some_and(|p| !p.fallback), s.default_lane.is_some(), s.manifest.config()["codec"].as_str().unwrap_or("h265").to_string())
        };
        if from_lanes == to_lanes || known {
            return;
        }
        let id = self.0.o.default_device.as_ref().and_then(|f| f(&codec)).filter(|s| !s.is_empty());
        let mut s = rt.lock();
        if s.default_lane.is_none() {
            s.default_lane = Some(id);
        }
    }

    /// dropLanes(runtime, value): a lanes job becomes a job without lanes
    pub fn drop_lanes(&self, rt: &Arc<Runtime>, value: i64) -> SResult<Value> {
        let running = || {
            let s = rt.lock();
            s.consuming && !s.cancel_requested && !s.stop_requested
        };
        if running() {
            self.note_default_lane(rt, false);
        }
        self.update(rt, |s| {
            let mut c = s.manifest.config().clone();
            if let Some(m) = c.as_object_mut() {
                m.shift_remove("lanes");
            }
            c["concurrency"] = json!(value);
            Some(Patch::new().set("config", c))
        })?;
        if running() {
            rt.lock().lane_plan = None;
            self.start_missing_workers(rt);
        }
        Ok(public_snapshot(&rt.manifest()))
    }

    /// setLanes after its checks: the GPUs are looked up first, so the new lanes start as saved
    pub fn set_lanes_now(&self, rt: &Arc<Runtime>, lanes: &Value) -> SResult<Value> {
        if lanes_of(&rt.manifest()).as_ref() == Some(lanes) {
            return Ok(public_snapshot(&rt.manifest()));
        }
        let running = || {
            let s = rt.lock();
            s.consuming && !s.cancel_requested && !s.stop_requested
        };
        let found = if running() { Some(self.resolve_lanes(lanes)) } else { None };
        let total = contracts::lanes_total(lanes);
        let l2 = lanes.clone();
        self.update(rt, move |s| {
            let mut c = s.manifest.config().clone();
            c["lanes"] = l2;
            c["concurrency"] = json!(total);
            Some(Patch::new().set("config", c))
        })?;
        if running() {
            let plan = found.unwrap_or_else(|| self.resolve_lanes(lanes));
            if running() {
                self.note_default_lane(rt, !plan.fallback);
            }
            if running() {
                rt.lock().lane_plan = Some(plan);
                self.start_missing_workers(rt);
            }
        }
        Ok(public_snapshot(&rt.manifest()))
    }

    // ---- decode tiers

    fn lane_device(e: &Selected) -> Option<&Device> {
        e.device.as_ref().filter(|d| d.kind != "cpu")
    }

    /// decodeKey(encoder): `<device id>|<encoder>` or the encoder alone
    pub fn decode_key(e: &Selected) -> String {
        match Self::lane_device(e) {
            Some(d) => format!("{}|{}", d.id, e.codec),
            None => e.codec.clone(),
        }
    }

    fn accel_args(&self, e: &Selected, zero_copy: bool) -> Option<Vec<String>> {
        let f = self.0.o.decode_accel.as_ref()?;
        f(&e.codec, zero_copy, Self::lane_device(e)).filter(|a| !a.is_empty())
    }

    /// decodeAccelFor(encoder, 'verify')
    pub fn verify_decode_accel(&self, e: &Selected) -> Option<Vec<String>> {
        if !e.hardware || e.remote || self.0.o.decode_accel.is_none() {
            return None;
        }
        if self.0.verify_fallbacks.lock().unwrap().get(&Self::decode_key(e)).copied().unwrap_or(0) >= 3 {
            return None;
        }
        self.accel_args(e, false)
    }

    pub fn note_verify_fallback(&self, key: &str) {
        *self.0.verify_fallbacks.lock().unwrap().entry(key.to_string()).or_insert(0) += 1;
    }

    /// encodeDecodeTiers(encoder, { zeroCopy }): fastest first; CPU decode after the list
    pub fn encode_decode_tiers(&self, e: &Selected, zero_copy: bool) -> Vec<(String, Vec<String>)> {
        if !e.hardware || e.remote || self.0.o.decode_accel.is_none() {
            return vec![];
        }
        let key = Self::decode_key(e);
        let broken = self.0.decode_broken.lock().unwrap().clone();
        let mut tiers = vec![];
        if zero_copy {
            tiers.push((format!("{key}:zero-copy"), self.accel_args(e, true)));
        }
        tiers.push((format!("{key}:gpu"), self.accel_args(e, false)));
        tiers.into_iter().filter_map(|(k, a)| a.filter(|_| !broken.contains(&k)).map(|a| (k, a))).collect()
    }

    /// a slower decode tier fixed what a faster one broke: stop offering those
    pub fn mark_broken_tiers(&self, e: &Selected, failed: &mut Vec<String>) {
        let prefix = format!("{}:", Self::decode_key(e));
        let mut b = self.0.decode_broken.lock().unwrap();
        for k in failed.drain(..) {
            if k.starts_with(&prefix) {
                b.insert(k);
            }
        }
    }
}

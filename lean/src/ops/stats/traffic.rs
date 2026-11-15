//! traffic.js: data used, in bytes received and sent, per day (local time,
//! the same days as energy.rs), from the cumulative byte counters of the
//! interfaces the Network tile counts. A gap between readings loses nothing:
//! its bytes are split over the days it spans in proportion to time. A
//! counter that went down only starts a new count, and a jump faster than
//! any link is dropped. The days are kept per scope (container or host), and
//! the last readings are saved so an app restart alone counts on.

use super::energy::{day_key, local_date, local_ms, week_keys};
use super::network::Where;
use super::util::js_round;
use crate::ops::js::num as jnum;
use serde_json::{json, Map, Value};

pub const DAYS_KEPT: usize = 62;
pub const MAX_BPS: f64 = 50e9;
const SLACK: f64 = 1.1;
const SLACK_B: f64 = 1_048_576.0;
const MAX_IFACES: usize = 256;

fn finite(n: &Value) -> Option<f64> {
    n.as_f64().filter(|x| x.is_finite() && *x >= 0.0)
}

fn text(s: Option<&str>) -> Option<String> {
    s.filter(|s| !s.is_empty() && s.encode_utf16().count() <= 128).map(str::to_string)
}

fn scope_of(s: Option<&str>) -> &'static str {
    if s == Some("host") {
        "host"
    } else {
        "container"
    }
}

#[derive(Clone, Debug, PartialEq)]
struct W {
    scope: Option<String>,
    boot: Option<String>,
    netns: Option<String>,
}

fn same_where(a: Option<&W>, b: &W) -> bool {
    a.is_some_and(|a| a == b)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Reading {
    rx: f64,
    tx: f64,
    t: f64,
    ifindex: Option<i64>,
}

type Days = Vec<(String, (f64, f64))>;

pub struct Traffic {
    container: Days,
    host: Days,
    scope: &'static str,
    last: Vec<(String, Reading)>,
    where_: Option<W>,
    saved: Option<(W, Vec<(String, Reading)>)>,
}

impl Default for Traffic {
    fn default() -> Self {
        Traffic::new()
    }
}

impl Traffic {
    pub fn new() -> Traffic {
        Traffic { container: Vec::new(), host: Vec::new(), scope: "container", last: Vec::new(), where_: None, saved: None }
    }

    fn days(&mut self) -> &mut Days {
        if self.scope == "host" {
            &mut self.host
        } else {
            &mut self.container
        }
    }

    fn days_ref(&self) -> &Days {
        if self.scope == "host" {
            &self.host
        } else {
            &self.container
        }
    }

    /// One reading at t: the counted interfaces' counters (None: nothing could be read).
    pub fn add(&mut self, t: Option<i64>, counters: Option<&[(String, f64, f64)]>, where_: &Where, ifindex_of: &dyn Fn(&str) -> Option<i64>) {
        let (Some(t), Some(counters)) = (t, counters) else { return };
        let here = W { scope: text(Some(where_.scope)), boot: text(where_.boot.as_deref()), netns: text(where_.netns.as_deref()) };
        if !same_where(self.where_.as_ref(), &here) {
            self.last.clear();
        }
        self.where_ = Some(here.clone());
        self.scope = scope_of(here.scope.as_deref());
        let saved = match (&self.saved, &here.boot, &here.netns) {
            (Some((w, ifaces)), Some(_), Some(_)) if *w == here => Some(ifaces.clone()),
            _ => None,
        };
        self.saved = None;
        let idx = |name: &str| ifindex_of(name).filter(|v| *v > 0);
        let mut next: Vec<(String, Reading)> = Vec::new();
        for (name, rx, tx) in counters {
            if next.len() >= MAX_IFACES || !(rx.is_finite() && *rx >= 0.0 && tx.is_finite() && *tx >= 0.0) {
                continue;
            }
            let mut prev = self.last.iter().find(|e| &e.0 == name).map(|e| e.1);
            let ifindex = match prev {
                Some(p) => p.ifindex,
                None => idx(name),
            };
            if prev.is_none() {
                if let (Some(saved), Some(i)) = (&saved, ifindex) {
                    if let Some(s) = saved.iter().find(|e| &e.0 == name).map(|e| e.1).filter(|s| s.ifindex == Some(i)) {
                        prev = Some(s);
                    }
                }
            }
            let mut cur = Reading { rx: *rx, tx: *tx, t: t as f64, ifindex };
            if let Some(p) = prev {
                if !self.count(&p, &cur) {
                    cur.ifindex = idx(name);
                }
            }
            if let Some(e) = next.iter_mut().find(|e| &e.0 == name) {
                e.1 = cur;
            } else {
                next.push((name.clone(), cur));
            }
        }
        self.last = next;
    }

    fn count(&mut self, prev: &Reading, cur: &Reading) -> bool {
        let ms = cur.t - prev.t;
        let (rx, tx) = (cur.rx - prev.rx, cur.tx - prev.tx);
        if !(ms > 0.0) || !(rx >= 0.0) || !(tx >= 0.0) {
            return false;
        }
        let most = MAX_BPS * (ms / 1000.0) * SLACK + SLACK_B;
        if rx > most || tx > most {
            return false;
        }
        self.spread(prev.t as i64, cur.t as i64, rx, tx);
        true
    }

    fn spread(&mut self, from: i64, to: i64, rx: f64, tx: f64) {
        let ms = (to - from) as f64;
        let end = local_date(to);
        let mut at = from.max(local_ms(end - chrono::Duration::days(DAYS_KEPT as i64 - 1), 0));
        let mut done_rx = js_round(rx * ((at - from) as f64 / ms));
        let mut done_tx = js_round(tx * ((at - from) as f64 / ms));
        while at < to {
            let d = local_date(at);
            let until = to.min(local_ms(d + chrono::Duration::days(1), 0));
            let up_rx = if until == to { rx } else { js_round(rx * ((until - from) as f64 / ms)) };
            let up_tx = if until == to { tx } else { js_round(tx * ((until - from) as f64 / ms)) };
            let key = day_key(at);
            let days = self.days();
            match days.iter_mut().find(|e| e.0 == key) {
                Some(e) => {
                    e.1 .0 += up_rx - done_rx;
                    e.1 .1 += up_tx - done_tx;
                }
                None => days.push((key, (up_rx - done_rx, up_tx - done_tx))),
            }
            done_rx = up_rx;
            done_tx = up_tx;
            at = until;
        }
    }

    /// { today, week, month } of the scope read last.
    pub fn summary(&self, t: i64) -> (Value, Value, Value) {
        let today = day_key(t);
        let week = week_keys(t);
        let month: Vec<String> = self.days_ref().iter().map(|e| e.0.clone()).filter(|k| k[..7] == today[..7] && *k <= today).collect();
        (self.total(&[today]), self.total(&week), self.total(&month))
    }

    fn total(&self, keys: &[String]) -> Value {
        let (mut rx, mut tx, mut measured) = (0.0, 0.0, false);
        for k in keys {
            if let Some(v) = self.days_ref().iter().find(|e| &e.0 == k) {
                measured = true;
                rx += v.1 .0;
                tx += v.1 .1;
            }
        }
        if measured {
            json!({ "rxB": jnum(js_round(rx)), "txB": jnum(js_round(tx)) })
        } else {
            Value::Null
        }
    }

    fn trim(&mut self) {
        for days in [&mut self.container, &mut self.host] {
            let mut keys: Vec<String> = days.iter().map(|e| e.0.clone()).collect();
            keys.sort();
            let n = keys.len().saturating_sub(DAYS_KEPT);
            for k in &keys[..n] {
                days.retain(|e| &e.0 != k);
            }
        }
    }

    pub fn to_json(&mut self) -> Value {
        self.trim();
        let (w, ifaces) = match &self.saved {
            Some((w, i)) => (Some(w.clone()), i.clone()),
            None => (self.where_.clone(), self.last.clone()),
        };
        let ifaces: Vec<(String, Reading)> = ifaces.into_iter().filter(|e| e.1.ifindex.is_some()).collect();
        let last = match w {
            Some(w) if w.boot.is_some() && w.netns.is_some() && !ifaces.is_empty() => {
                let m: Map<String, Value> = ifaces.iter().map(|(n, c)| (n.clone(), json!({ "rx": jnum(c.rx), "tx": jnum(c.tx), "t": jnum(c.t), "ifindex": c.ifindex }))).collect();
                json!({ "scope": w.scope, "boot": w.boot, "netns": w.netns, "ifaces": m })
            }
            _ => Value::Null,
        };
        let days = |d: &Days| Value::Object(d.iter().map(|(k, (rx, tx))| (k.clone(), json!({ "rx": jnum(*rx), "tx": jnum(*tx) }))).collect());
        json!({ "scope": self.scope, "days": { "container": days(&self.container), "host": days(&self.host) }, "last": last })
    }

    pub fn load(&mut self, data: &Value) {
        let Some(d) = data.as_object() else { return };
        let src = d.get("days").filter(|v| v.is_object());
        let read = |scope: &str| -> Days {
            src.and_then(|s| s.get(scope)).and_then(Value::as_object).map(|o| {
                o.iter()
                    .filter(|(k, _)| super::util::re!(r"^\d{4}-\d{2}-\d{2}$").is(k))
                    .filter_map(|(k, v)| Some((k.clone(), (finite(v.get("rx")?)?, finite(v.get("tx")?)?))))
                    .collect()
            }).unwrap_or_default()
        };
        self.container = read("container");
        self.host = read("host");
        self.scope = scope_of(d.get("scope").and_then(Value::as_str));
        self.trim();
        self.saved = None;
        let l = &d.get("last").cloned().unwrap_or(Value::Null);
        let (Some(boot), Some(netns)) = (text(l["boot"].as_str()), text(l["netns"].as_str())) else { return };
        let Some(o) = l["ifaces"].as_object() else { return };
        let mut ifaces = Vec::new();
        for (name, c) in o {
            if ifaces.len() >= MAX_IFACES {
                break;
            }
            if !super::util::re!(r"^[^\s/:]{1,15}$").is(name) {
                continue;
            }
            let (Some(rx), Some(tx)) = (finite(&c["rx"]), finite(&c["tx"])) else { continue };
            let Some(t) = c["t"].as_f64().filter(|x| x.is_finite()) else { continue };
            let Some(i) = c["ifindex"].as_f64().filter(|i| i.fract() == 0.0 && *i > 0.0) else { continue };
            ifaces.push((name.clone(), Reading { rx, tx, t, ifindex: Some(i as i64) }));
        }
        self.saved = Some((W { scope: text(l["scope"].as_str()), boot: Some(boot), netns: Some(netns) }, ifaces));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, NaiveDate, TimeZone};

    fn at(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        Local.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap()).earliest().unwrap().timestamp_millis()
    }

    fn w(scope: &'static str) -> Where {
        Where { scope, boot: Some("b1".into()), netns: Some("net:[1]".into()) }
    }

    fn read(t: &mut Traffic, ms: i64, list: &[(&str, f64, f64)], scope: &'static str) {
        let c: Vec<(String, f64, f64)> = list.iter().map(|(n, r, x)| (n.to_string(), *r, *x)).collect();
        t.add(Some(ms), Some(&c), &w(scope), &|_| Some(2));
    }

    // test/statsTraffic.test.js: deltas, a span over midnight, a counter that went down, scopes, save and load
    #[test]
    fn data_used_per_day() {
        let mut t = Traffic::new();
        let t0 = at(2026, 10, 23, 23, 0);
        read(&mut t, t0, &[("eth0", 1000.0, 100.0)], "container");
        assert_eq!(t.summary(t0).0, Value::Null, "the first reading only starts the count");
        read(&mut t, t0 + 3_600_000 * 2, &[("eth0", 1000.0 + 7200.0, 100.0)], "container");
        // 23:00 -> 01:00: half each side of midnight
        assert_eq!(t.summary(t0).0, json!({ "rxB": 3600, "txB": 0 }));
        assert_eq!(t.summary(t0 + 7_200_000).0, json!({ "rxB": 3600, "txB": 0 }));
        assert_eq!(t.summary(t0 + 7_200_000).1, json!({ "rxB": 7200, "txB": 0 }));
        // a counter that went down only starts a new count
        read(&mut t, t0 + 7_300_000, &[("eth0", 5.0, 5.0)], "container");
        assert_eq!(t.summary(t0 + 7_300_000).1, json!({ "rxB": 7200, "txB": 0 }));
        // faster than any link: dropped
        read(&mut t, t0 + 7_301_000, &[("eth0", 5.0 + 1e12, 5.0)], "container");
        assert_eq!(t.summary(t0 + 7_301_000).1, json!({ "rxB": 7200, "txB": 0 }));
        // the host's days are its own
        read(&mut t, t0 + 7_302_000, &[("eth0", 1.0, 1.0)], "host");
        assert_eq!(t.summary(t0 + 7_302_000).1, Value::Null);
        let saved = t.to_json();
        let mut again = Traffic::new();
        again.load(&saved);
        assert_eq!(again.to_json(), saved);
        // an app restart counts on from the saved readings (same boot, namespace and index)
        read(&mut again, t0 + 7_304_000, &[("eth0", 101.0, 1.0)], "host");
        assert_eq!(again.summary(t0 + 7_304_000).0, json!({ "rxB": 100, "txB": 0 }));
    }
}

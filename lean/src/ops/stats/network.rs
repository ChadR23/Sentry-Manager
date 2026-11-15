//! network.js: traffic from /proc/net/dev: the container's own interfaces,
//! or the whole server's when the container runs with `pid: host`. The same
//! counters feed the data used per day (traffic.rs).

use super::util::*;
use crate::ops::js::num as jnum;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn skip(n: &str) -> bool {
    re!(r"^(lo|veth|docker\d|br-[0-9a-f]{6,}|podman|virbr|lxcbr|lxdbr|incusbr|cni|flannel|cali|cilium|weave|vnet|tap\d|fwbr|fwpr|fwln|ifb|dummy|kube|vxlan|genev|tunl|sit\d|ip6tnl|gre)").is(n)
}

fn tunnel_name(n: &str) -> bool {
    re!(r"^(tun|wg|tailscale|zt|ppp|nordlynx|nordtun|wt\d)").is(n)
}

fn layer(n: &str) -> i32 {
    if re!(r"^(br|vmbr)\d").is(n) {
        3
    } else if re!(r"^(bond|team)\d").is(n) {
        2
    } else if re!(r"^(eth|en|em|wl)").is(n) {
        1
    } else {
        0
    }
}

/// name -> (rx, tx), in the file's order.
pub fn parse_net_dev(text: Option<&str>) -> Vec<(String, f64, f64)> {
    let mut out: Vec<(String, f64, f64)> = Vec::new();
    for line in text.unwrap_or("").split('\n') {
        let Some(i) = line.find(':') else { continue };
        let name = line[..i].trim().to_string();
        let f: Vec<f64> = line[i + 1..].trim().split_whitespace().map(crate::ops::js::number_str).collect();
        if name.is_empty() || f.len() < 9 || !f[0].is_finite() || !f[8].is_finite() {
            continue;
        }
        if let Some(e) = out.iter_mut().find(|e| e.0 == name) {
            *e = (name, f[0], f[8]);
        } else {
            out.push((name, f[0], f[8]));
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct Where {
    pub scope: &'static str,
    pub boot: Option<String>,
    pub netns: Option<String>,
}

pub struct NetworkProvider {
    proc_root: PathBuf,
    sys_root: PathBuf,
    now: Clock,
    pub scope: &'static str,
    prev: Option<Vec<(String, f64, f64)>>,
    prev_at: Option<i64>,
    speeds: HashMap<String, (Option<f64>, i64)>,
    tunnels: HashMap<String, (bool, i64)>,
    file: PathBuf,
    /// the last reading's counted interfaces: name -> (rx, tx), in order
    pub counters: Option<Vec<(String, f64, f64)>>,
    pub read_at: Option<i64>,
    own_netns: bool,
    boot: Option<String>,
    netns: Option<String>,
}

impl NetworkProvider {
    pub fn new(proc_root: &Path, sys_root: &Path, now: Clock) -> NetworkProvider {
        NetworkProvider {
            proc_root: proc_root.into(),
            sys_root: sys_root.into(),
            now,
            scope: "container",
            prev: None,
            prev_at: None,
            speeds: HashMap::new(),
            tunnels: HashMap::new(),
            file: proc_root.join("net/dev"),
            counters: None,
            read_at: None,
            own_netns: true,
            boot: None,
            netns: None,
        }
    }

    pub fn probe(&mut self) {
        let own = parse_net_dev(read_text(self.proc_root.join("net/dev")).as_deref());
        let init = parse_net_dev(read_text(self.proc_root.join("1/net/dev")).as_deref());
        let names = |m: &[(String, f64, f64)]| {
            let mut v: Vec<&str> = m.iter().map(|e| e.0.as_str()).collect();
            v.sort();
            v.join(",")
        };
        self.scope = if !init.is_empty() && names(&init) != names(&own) { "host" } else { "container" };
        self.own_netns = self.scope == "container";
        // with network_mode: host the container already sees the host's links
        if self.scope == "container" && own.iter().any(|e| re!(r"^(docker0|veth)").is(&e.0)) {
            self.scope = "host";
        }
        self.file = if self.scope == "host" && !init.is_empty() { self.proc_root.join("1/net/dev") } else { self.proc_root.join("net/dev") };
        self.prev = None;
        self.tunnels.clear();
        self.boot = read_line(self.proc_root.join("sys/kernel/random/boot_id"));
        self.netns = if self.own_netns { read_link(self.proc_root.join("self/ns/net")) } else { None };
    }

    /// What the counters belong to.
    pub fn where_(&self) -> Where {
        Where { scope: self.scope, boot: self.boot.clone(), netns: self.netns.clone() }
    }

    /// An interface's index (sysfs shows only our own namespace's links), or None.
    pub fn ifindex(&self, name: &str) -> Option<i64> {
        if !self.own_netns {
            return None;
        }
        let v = read_num(self.sys_root.join("class/net").join(name).join("ifindex"))?;
        (v.fract() == 0.0 && v > 0.0).then_some(v as i64)
    }

    /// Link speed in Mbit/s; virtual links (a container's veth) report a made-up 10000.
    fn speed(&self, name: &str) -> Option<f64> {
        let dir = self.sys_root.join("class/net").join(name);
        if !exists(dir.join("device")) {
            return None;
        }
        read_num(dir.join("speed")).filter(|v| *v > 0.0 && *v < 10_000_000.0)
    }

    fn top_level(&self, names: Vec<String>) -> Vec<String> {
        let dir = self.sys_root.join("class/net");
        if names.iter().all(|n| exists(dir.join(n))) {
            return names.into_iter().filter(|n| !exists(dir.join(n).join("master"))).collect();
        }
        let top = names.iter().map(|n| layer(n)).max().unwrap_or(0).max(0);
        names.into_iter().filter(|n| layer(n) == 0 || layer(n) == top).collect()
    }

    fn tunnel(&self, name: &str) -> bool {
        if tunnel_name(name) {
            return true;
        }
        if !self.own_netns {
            return false;
        }
        let dir = self.sys_root.join("class/net").join(name);
        exists(dir.join("tun_flags")) || matches!(read_num(dir.join("type")), Some(t) if t == 65534.0 || t == 512.0)
    }

    fn tunnel_cached(&mut self, name: &str) -> bool {
        let t = (self.now)();
        if let Some((v, at)) = self.tunnels.get(name) {
            if t - at < 60000 {
                return *v;
            }
        }
        let v = self.tunnel(name);
        if self.tunnels.len() > 256 {
            self.tunnels.clear();
        }
        self.tunnels.insert(name.to_string(), (v, t));
        v
    }

    fn speed_cached(&mut self, name: &str) -> Option<f64> {
        let t = (self.now)();
        if let Some((v, at)) = self.speeds.get(name) {
            if t - at < 60000 {
                return *v;
            }
        }
        let v = self.speed(name);
        if self.speeds.len() > 256 {
            self.speeds.clear();
        }
        self.speeds.insert(name.to_string(), (v, t));
        v
    }

    /// The links that count, in the file's order.
    fn counted(&mut self, cur: &[(String, f64, f64)]) -> Vec<String> {
        let names = self.top_level(cur.iter().map(|e| e.0.clone()).filter(|n| !skip(n)).collect());
        let carriers: Vec<String> = names.iter().filter(|n| !self.tunnel_cached(n)).cloned().collect();
        let keep = if carriers.is_empty() { names } else { carriers };
        cur.iter().map(|e| e.0.clone()).filter(|n| keep.contains(n)).collect()
    }

    pub fn sample(&mut self) -> (&'static str, Vec<Value>, Option<f64>, Option<f64>) {
        let t = (self.now)();
        self.counters = None;
        let cur = parse_net_dev(read_text(&self.file).as_deref());
        let dt = self.prev_at.map_or(0.0, |p| (t - p) as f64 / 1000.0);
        let mut interfaces = Vec::new();
        let mut counters = Vec::new();
        let (mut rx_sum, mut tx_sum): (Option<f64>, Option<f64>) = (None, None);
        for name in self.counted(&cur) {
            let c = cur.iter().find(|e| e.0 == name).unwrap().clone();
            let before = self.prev.as_ref().and_then(|p| p.iter().find(|e| e.0 == name)).cloned();
            let ok = before.as_ref().is_some_and(|b| dt > 0.0 && c.1 >= b.1 && c.2 >= b.2);
            let speed = self.speed_cached(&name);
            let (rx, tx) = if ok {
                let b = before.unwrap();
                (Some(js_round((c.1 - b.1) / dt)), Some(js_round((c.2 - b.2) / dt)))
            } else {
                (None, None)
            };
            rx_sum = sum_of([rx_sum, rx]);
            tx_sum = sum_of([tx_sum, tx]);
            let n = |x: Option<f64>| x.map_or(Value::Null, jnum);
            interfaces.push(json!({ "name": name, "speedMbps": n(speed), "rxBps": n(rx), "txBps": n(tx) }));
            counters.push(c);
        }
        if !cur.is_empty() {
            self.prev = Some(cur);
            self.prev_at = Some(t);
            self.counters = Some(counters);
            self.read_at = Some(t);
        }
        (self.scope, interfaces, rx_sum, tx_sum)
    }

    /// Only the counters, for the data used (the app's daily reading).
    pub fn read(&mut self) {
        let t = (self.now)();
        self.counters = None;
        let cur = parse_net_dev(read_text(&self.file).as_deref());
        if cur.is_empty() {
            return;
        }
        let names = self.counted(&cur);
        self.counters = Some(names.iter().map(|n| cur.iter().find(|e| &e.0 == n).unwrap().clone()).collect());
        self.read_at = Some(t);
    }
}

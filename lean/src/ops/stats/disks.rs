//! disks.js: whole disks: read/write bytes per second and how busy they are
//! from /proc/diskstats deltas, model and kind from /sys/block, temperature
//! from the disk's own sensor.

use super::sensors::SensorsProvider;
use super::util::*;
use crate::ops::js::num as jnum;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SECTOR: f64 = 512.0;

#[derive(Clone, Copy, Debug)]
pub struct DiskStat {
    pub read: f64,
    pub write: f64,
    pub io_ms: f64,
}

pub fn parse_diskstats(text: Option<&str>) -> HashMap<String, DiskStat> {
    let mut out = HashMap::new();
    for line in text.unwrap_or("").split('\n') {
        let f: Vec<&str> = line.trim().split_whitespace().collect();
        if f.len() < 14 {
            continue;
        }
        let v: Vec<f64> = f[3..].iter().map(|x| crate::ops::js::number_str(x)).collect();
        if v[..10].iter().any(|n| !n.is_finite()) {
            continue;
        }
        out.insert(f[2].to_string(), DiskStat { read: v[2] * SECTOR, write: v[6] * SECTOR, io_ms: v[9] });
    }
    out
}

pub fn kind_of(name: &str, rotational: Option<f64>) -> &'static str {
    if name.starts_with("nvme") {
        return "nvme";
    }
    if re!(r"^(vd|xvd|mmcblk|mtdblock)").is(name) {
        return "other";
    }
    match rotational {
        Some(r) if r == 1.0 => "hdd",
        Some(r) if r == 0.0 => "ssd",
        _ => "other",
    }
}

struct Disk {
    name: String,
    model: Option<String>,
    kind: &'static str,
}

pub struct DisksProvider {
    proc_root: PathBuf,
    sys_root: PathBuf,
    now: Clock,
    disks: Vec<Disk>,
    prev: Option<HashMap<String, DiskStat>>,
    prev_at: Option<i64>,
}

impl DisksProvider {
    pub fn new(proc_root: &Path, sys_root: &Path, now: Clock) -> DisksProvider {
        DisksProvider { proc_root: proc_root.into(), sys_root: sys_root.into(), now, disks: Vec::new(), prev: None, prev_at: None }
    }

    /// Sampling stopped and starts again later: the next sample has nothing to diff against.
    pub fn reset_baseline(&mut self) {
        self.prev = None;
        self.prev_at = None;
    }

    pub fn probe(&mut self) {
        self.disks.clear();
        for name in list_dir(self.sys_root.join("block"), 4096) {
            if re!(r"^(loop|ram|zram|dm-|md|nbd|sr|fd|zd|rbd|drbd|bcache)").is(&name) {
                continue;
            }
            let dir = self.sys_root.join("block").join(&name);
            // empty card readers and drives without a medium report size 0
            if read_num(dir.join("size")) == Some(0.0) {
                continue;
            }
            let model = read_line(dir.join("device/model")).or_else(|| read_line(dir.join("device/name")));
            let kind = kind_of(&name, read_num(dir.join("queue/rotational")));
            if let Some(d) = self.disks.iter_mut().find(|d| d.name == name) {
                *d = Disk { name, model, kind };
            } else {
                self.disks.push(Disk { name, model, kind });
            }
        }
    }

    pub fn sample(&mut self, sensors: &SensorsProvider) -> Vec<Value> {
        let t = (self.now)();
        let stats = parse_diskstats(read_text(self.proc_root.join("diskstats")).as_deref());
        let dt = self.prev_at.map_or(0.0, |p| (t - p) as f64 / 1000.0);
        let mut out = Vec::new();
        for d in &self.disks {
            let cur = stats.get(&d.name);
            let before = self.prev.as_ref().and_then(|p| p.get(&d.name));
            let (mut r, mut w, mut busy) = (None, None, None);
            if let (Some(c), Some(b)) = (cur, before) {
                if dt > 0.0 && c.read >= b.read && c.write >= b.write {
                    r = Some(js_round((c.read - b.read) / dt));
                    w = Some(js_round((c.write - b.write) / dt));
                    if c.io_ms >= b.io_ms {
                        busy = round(clamp_pct(Some((c.io_ms - b.io_ms) / (dt * 10.0))), 0);
                    }
                }
            }
            let n = |x: Option<f64>| x.map_or(Value::Null, jnum);
            out.push(json!({ "name": d.name, "model": d.model, "readBps": n(r), "writeBps": n(w), "tempC": n(sensors.disk_temp(&d.name)), "kind": d.kind, "busy": n(busy) }));
        }
        if !stats.is_empty() {
            self.prev = Some(stats);
            self.prev_at = Some(t);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_lines() {
        assert_eq!(kind_of("nvme0n1", None), "nvme");
        assert_eq!(kind_of("mmcblk0", Some(0.0)), "other");
        assert_eq!(kind_of("sda", Some(1.0)), "hdd");
        assert_eq!(kind_of("sdb", Some(0.0)), "ssd");
        let s = parse_diskstats(Some("   8       0 sda 100 0 2048 50 200 0 4096 80 0 1000 130 0 0 0 0 0 0\nshort line"));
        assert_eq!(s["sda"].read, 2048.0 * 512.0);
        assert_eq!(s["sda"].write, 4096.0 * 512.0);
        assert_eq!(s["sda"].io_ms, 1000.0);
    }
}

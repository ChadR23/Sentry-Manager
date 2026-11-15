//! CPU power for Overview > Server: the RAPL energy counters are readable by
//! root only, so the supervisor reads them (fixed paths, read only) while the
//! app asks, and hands the counters over. Docker hides them by default; the
//! owner can bind the host's /sys/devices/virtual/powercap read-only to
//! /host/powercap (docker-compose.yml shows the line).
//!
//! Each `{ type: 'rapl', on: true }` from the app keeps the readings coming
//! for 30 s; without another one they stop by themselves. Never more than one
//! reading every 2 s; none at all once there is nothing to read.

use super::js::{number_json, string_to_number};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RAPL_ROOTS: [&str; 3] = ["/host/powercap/intel-rapl", "/host/powercap", "/sys/class/powercap"];

fn zone_name(n: &str) -> bool {
    n.strip_prefix("intel-rapl:").is_some_and(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit()))
}

/// The packages of the first root that has any (`readRapl`).
pub fn read_rapl(roots: &[PathBuf]) -> Vec<Value> {
    for root in roots {
        let Ok(rd) = std::fs::read_dir(root) else { continue };
        let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| zone_name(n)).collect();
        names.sort();
        let mut packages = Vec::new();
        for n in &names {
            let read = |f: &str| std::fs::read_to_string(Path::new(root).join(n).join(f)).map(|s| super::js::js_trim(&s).to_string());
            // a package without counters (or masked) is left out
            let Ok(energy) = read("energy_uj") else { continue };
            let Ok(max) = read("max_energy_range_uj") else { continue };
            let energy_uj = string_to_number(&energy);
            let max_uj = string_to_number(&max);
            if energy_uj.is_finite() {
                let Ok(name) = read("name") else { continue };
                let name = if name.is_empty() { n.clone() } else { name };
                packages.push(json!({ "name": name, "energyUj": number_json(energy_uj), "maxEnergyUj": if max_uj.is_finite() { number_json(max_uj) } else { Value::Null } }));
            }
        }
        if !packages.is_empty() {
            return packages;
        }
    }
    Vec::new()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

struct State {
    until: Option<Instant>,
    read_at: Option<Instant>,
    running: bool,
    generation: u64,
}

/// The reading loop. `send` returns false when the app is not connected.
#[derive(Clone)]
pub struct RaplPump {
    state: Arc<Mutex<State>>,
    roots: Arc<Vec<PathBuf>>,
    pub every: Duration,
    pub keep: Duration,
}

impl RaplPump {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        RaplPump {
            state: Arc::new(Mutex::new(State { until: None, read_at: None, running: false, generation: 0 })),
            roots: Arc::new(roots),
            every: Duration::from_secs(2),
            keep: Duration::from_secs(30),
        }
    }

    pub fn off(&self) {
        let mut s = self.state.lock().unwrap();
        s.until = None;
        s.running = false;
        s.generation += 1;
    }

    /// `rapl(true)`; `send(Some(message))` sends, `send(None)` only asks
    /// whether the app is connected; both return that.
    pub fn on<F: Fn(Option<&Value>) -> bool + Send + Sync + 'static>(&self, send: F) {
        let gen = {
            let mut s = self.state.lock().unwrap();
            s.until = Some(Instant::now() + self.keep);
            if s.running {
                return;
            }
            s.running = true;
            s.generation
        };
        let me = self.clone();
        tokio::spawn(async move {
            let mut first = true;
            loop {
                if !first {
                    tokio::time::sleep(me.every).await;
                }
                first = false;
                {
                    let s = me.state.lock().unwrap();
                    if s.generation != gen || !s.running {
                        return;
                    }
                }
                if !me.tick(&send) {
                    return;
                }
            }
        });
    }

    /// One `send()` of supervisor.js; false once stopped.
    fn tick<F: Fn(Option<&Value>) -> bool>(&self, send: &F) -> bool {
        {
            let mut s = self.state.lock().unwrap();
            if !send(None) || s.until.is_none_or(|u| Instant::now() > u) {
                drop(s);
                self.off();
                return false;
            }
            if s.read_at.is_some_and(|r| r.elapsed() < Duration::from_millis(1900)) {
                return true; // never more than every 2 s
            }
            s.read_at = Some(Instant::now());
        }
        let packages = read_rapl(&self.roots);
        let empty = packages.is_empty();
        if !send(Some(&json!({ "type": "rapl-reading", "at": now_ms(), "packages": packages }))) {
            self.off();
            return false;
        }
        if empty {
            self.off(); // nothing to read: stop asking the kernel
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_top_level_zones_in_order() {
        let dir = std::env::temp_dir().join(format!("sup-rapl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let zone = |n: &str, files: &[(&str, &str)]| {
            std::fs::create_dir_all(dir.join("b").join(n)).unwrap();
            for (f, v) in files {
                std::fs::write(dir.join("b").join(n).join(f), v).unwrap();
            }
        };
        zone("intel-rapl:1", &[("energy_uj", "200\n"), ("max_energy_range_uj", "x"), ("name", "package-1\n")]);
        zone("intel-rapl:0", &[("energy_uj", "100\n"), ("max_energy_range_uj", "262143328850\n"), ("name", "\n")]);
        zone("intel-rapl:0:0", &[("energy_uj", "5"), ("max_energy_range_uj", "5"), ("name", "core")]);
        zone("intel-rapl:2", &[("energy_uj", "1")]); // no max: left out
        zone("intel-rapl:3", &[("energy_uj", "nope"), ("max_energy_range_uj", "1"), ("name", "x")]);
        let p = read_rapl(&[dir.join("a"), dir.join("b")]);
        assert_eq!(
            Value::Array(p),
            json!([
                { "name": "intel-rapl:0", "energyUj": 100, "maxEnergyUj": 262143328850i64 },
                { "name": "package-1", "energyUj": 200, "maxEnergyUj": null }
            ])
        );
        assert!(read_rapl(&[dir.join("a")]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn readings_stop_without_a_keepalive_and_when_nothing_to_read() {
        let mut pump = RaplPump::new(vec![PathBuf::from("/nonexistent-rapl")]);
        pump.every = Duration::from_millis(10);
        let sent = Arc::new(Mutex::new(0));
        let s = sent.clone();
        pump.on(move |m| {
            if m.is_some() {
                *s.lock().unwrap() += 1;
            }
            true
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(*sent.lock().unwrap(), 1, "one empty reading, then it stops asking");
    }
}

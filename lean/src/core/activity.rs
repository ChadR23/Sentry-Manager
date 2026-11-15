//! Jobs (what the manager did) and notifications (what needs attention),
//! as server/activity.js: kept in manager.db, announced as the `jobs` and
//! `notifications` live-update topics.

use super::db::{now_ms, Db, Job, JobUpdate, NewJob, NewNotification};
use super::events::Hub;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct Jobs {
    db: Arc<Db>,
    hub: Arc<Hub>,
}

impl Jobs {
    pub fn new(db: Arc<Db>, hub: Arc<Hub>) -> Jobs {
        Jobs { db, hub }
    }

    pub fn start(&self, j: NewJob) -> i64 {
        let id = self.db.start_job(&j);
        self.hub.announce("jobs");
        id
    }

    pub fn update(&self, id: i64, u: JobUpdate) {
        self.db.update_job(id, &u);
        self.hub.announce("jobs");
    }

    /// finish(id, { status = 'done', detail, result })
    pub fn finish(&self, id: i64, status: Option<&str>, detail: Option<String>, result: Option<Value>) {
        self.db.update_job(id, &JobUpdate { status: Some(status.unwrap_or("done").to_string()), detail, result, finished: true });
        self.db.trim_jobs(2000);
        self.hub.announce("jobs");
    }

    pub fn list(&self, limit: i64, vehicle_id: Option<&str>) -> Vec<Job> {
        self.db.jobs(limit, vehicle_id)
    }

    /// How many finished jobs Clear jobs would take off the list.
    pub fn finished(&self, vehicle_id: Option<&str>, keep_external: &[String]) -> usize {
        self.db.finished_jobs(vehicle_id, keep_external).len()
    }

    pub fn clear(&self, vehicle_id: Option<&str>, keep_external: &[String]) -> usize {
        let n = self.db.clear_jobs(vehicle_id, keep_external);
        if n > 0 {
            self.hub.announce("jobs");
        }
        n
    }

    /// At start: jobs a restart stopped are interrupted, not running.
    pub fn interrupt_leftovers(&self) -> usize {
        let n = self.db.interrupt_jobs();
        if n > 0 {
            self.hub.announce("jobs");
        }
        n
    }
}

/// A share's status as Notifications.syncShare reads it (vehicles.js share status).
#[derive(Debug, Clone, Default)]
pub struct ShareStatus {
    pub healthy: bool,
    pub read_only: bool,
    pub writable: Option<bool>,
    pub last_error: Option<String>,
    pub hint: Option<String>,
    pub total_bytes: Option<f64>,
    pub free_bytes: Option<f64>,
}

struct Down {
    since: i64,
    timer: bool,
    name: String,
    status: ShareStatus,
}

pub struct Notifications {
    db: Arc<Db>,
    hub: Arc<Hub>,
    pub share_grace_ms: i64,
    share_down: Mutex<HashMap<String, Down>>,
}

impl Notifications {
    pub fn new(db: Arc<Db>, hub: Arc<Hub>) -> Arc<Notifications> {
        Arc::new(Notifications { db, hub, share_grace_ms: 10 * 60 * 1000, share_down: Mutex::new(HashMap::new()) })
    }

    /// Raise (or refresh) one; a kind the owner muted is not raised. None when muted.
    pub fn raise(&self, n: NewNotification) -> Option<i64> {
        if let Some(Value::Array(muted)) = self.db.get("notify-muted") {
            if muted.iter().any(|m| m.as_str() == Some(n.kind.as_str())) {
                return None;
            }
        }
        let id = self.db.notify(&n);
        if self.db.last_notify_changed() {
            self.hub.announce("notifications");
        }
        Some(id)
    }

    pub fn resolve(&self, dedupe_key: &str) {
        self.db.resolve(dedupe_key);
        self.hub.announce("notifications");
    }

    pub fn dismiss(&self, id: i64) {
        self.db.resolve_id(id);
        self.hub.announce("notifications");
    }

    pub fn mark_read(&self, ids: &[i64]) {
        self.db.mark_read(ids);
        self.hub.announce("notifications");
    }

    pub fn list(&self, open: bool, limit: i64, vehicle_id: Option<&str>) -> Vec<Value> {
        self.db.notifications(open, limit, vehicle_id)
    }

    fn raise_down(&self, vehicle_id: &str) {
        let (name, status, since) = {
            let d = self.share_down.lock().unwrap();
            let Some(d) = d.get(vehicle_id) else { return };
            (d.name.clone(), d.status.clone(), d.since)
        };
        let mins = ((now_ms() - since) as f64 / 60000.0).round() as i64;
        let msg = [Some(format!("Not reachable for {mins} minute{}; still retrying.", if mins == 1 { "" } else { "s" })), status.last_error.clone(), status.hint.clone()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        self.raise(NewNotification {
            kind: "share".into(),
            level: Some("critical".into()),
            vehicle_id: Some(vehicle_id.into()),
            dedupe_key: Some(format!("share:{vehicle_id}")),
            title: format!("{name}: footage share is offline"),
            message: Some(msg),
        });
    }

    /// Keep share / disk alerts in step with a vehicle's share status (a share down for under 10 minutes is retried quietly).
    pub fn sync_share(self: &Arc<Self>, vehicle_id: &str, vehicle_name: &str, status: &ShareStatus) {
        let key = format!("share:{vehicle_id}");
        if !status.healthy {
            let (due, start_timer, wait) = {
                let mut map = self.share_down.lock().unwrap();
                let d = map.entry(vehicle_id.to_string()).or_insert(Down { since: now_ms(), timer: false, name: vehicle_name.into(), status: status.clone() });
                d.name = vehicle_name.into();
                d.status = status.clone();
                let elapsed = now_ms() - d.since;
                let due = elapsed >= self.share_grace_ms;
                let start = !due && !d.timer;
                if start {
                    d.timer = true;
                }
                (due, start, self.share_grace_ms - elapsed)
            };
            if due {
                self.raise_down(vehicle_id);
            } else if start_timer {
                let me = self.clone();
                let id = vehicle_id.to_string();
                let run = move || me.raise_down(&id);
                match tokio::runtime::Handle::try_current() {
                    Ok(h) => {
                        h.spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(wait.max(0) as u64)).await;
                            run();
                        });
                    }
                    Err(_) => {
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(wait.max(0) as u64));
                            run();
                        });
                    }
                }
            }
        } else {
            self.share_down.lock().unwrap().remove(vehicle_id);
            self.resolve(&key);
        }

        let ro_key = format!("readonly:{vehicle_id}");
        if status.healthy && status.read_only {
            self.raise(NewNotification {
                kind: "share".into(),
                level: Some("info".into()),
                vehicle_id: Some(vehicle_id.into()),
                dedupe_key: Some(ro_key),
                title: format!("{vehicle_name}: footage is mounted read-only"),
                message: Some("It is only read: conversions, the Recycle Bin, cleanup and restore are off until it is mounted read-write.".into()),
            });
        } else if status.healthy && status.writable == Some(false) {
            self.raise(NewNotification {
                kind: "share".into(),
                level: Some("warning".into()),
                vehicle_id: Some(vehicle_id.into()),
                dedupe_key: Some(ro_key),
                title: format!("{vehicle_name}: share is read-only"),
                message: Some(status.last_error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| "Conversions, trash and restore need write access.".into())),
            });
        } else if status.writable == Some(true) {
            self.resolve(&ro_key);
        }

        let space_key = format!("space:{vehicle_id}");
        if let (Some(total), Some(free)) = (status.total_bytes.filter(|t| *t != 0.0), status.free_bytes) {
            let ratio = free / total;
            let pct = format!("{:.1}", ratio * 100.0);
            if ratio < 0.05 {
                self.raise(NewNotification {
                    kind: "storage".into(),
                    level: Some("critical".into()),
                    vehicle_id: Some(vehicle_id.into()),
                    dedupe_key: Some(space_key),
                    title: format!("{vehicle_name}: share almost full"),
                    message: Some(format!("{pct}% free.")),
                });
            } else if ratio < 0.1 {
                self.raise(NewNotification {
                    kind: "storage".into(),
                    level: Some("warning".into()),
                    vehicle_id: Some(vehicle_id.into()),
                    dedupe_key: Some(space_key),
                    title: format!("{vehicle_name}: share running low on space"),
                    message: Some(format!("{pct}% free.")),
                });
            } else {
                self.resolve(&space_key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn muted_kinds_and_space() {
        let db = Arc::new(Db::memory().unwrap());
        let hub = Hub::new();
        let n = Notifications::new(db.clone(), hub);
        db.set("notify-muted", &json!(["storage"]));
        assert!(n.raise(NewNotification { kind: "storage".into(), title: "x".into(), ..Default::default() }).is_none());
        db.del("notify-muted");
        n.sync_share("car", "Car", &ShareStatus { healthy: true, writable: Some(true), total_bytes: Some(100.0), free_bytes: Some(4.0), ..Default::default() });
        let open = n.list(true, 200, None);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["title"], "Car: share almost full");
        assert_eq!(open[0]["message"], "4.0% free.");
        n.sync_share("car", "Car", &ShareStatus { healthy: true, writable: Some(true), total_bytes: Some(100.0), free_bytes: Some(50.0), ..Default::default() });
        assert!(n.list(true, 200, None).is_empty());
    }

    #[test]
    fn share_down_waits_for_the_grace() {
        let db = Arc::new(Db::memory().unwrap());
        let n = Notifications::new(db.clone(), Hub::new());
        n.sync_share("car", "Car", &ShareStatus { healthy: false, ..Default::default() });
        assert!(n.list(true, 200, None).is_empty());
        // pretend it has been down for 11 minutes
        n.share_down.lock().unwrap().get_mut("car").unwrap().since -= 11 * 60 * 1000;
        n.sync_share("car", "Car", &ShareStatus { healthy: false, last_error: Some("Host is down".into()), ..Default::default() });
        let open = n.list(true, 200, None);
        assert_eq!(open[0]["message"], "Not reachable for 11 minutes; still retrying. Host is down");
    }

    #[test]
    fn jobs_finish() {
        let db = Arc::new(Db::memory().unwrap());
        let j = Jobs::new(db, Hub::new());
        let id = j.start(NewJob { kind: "scan".into(), title: "Scan".into(), ..Default::default() });
        j.finish(id, None, Some("12 files".into()), None);
        let l = j.list(200, None);
        assert_eq!(l[0].status, "done");
        assert_eq!(l[0].detail.as_deref(), Some("12 files"));
        assert_eq!(j.clear(None, &[]), 1);
    }
}

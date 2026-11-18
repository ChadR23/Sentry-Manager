//! Notifications (server/activity.js `Notifications`): raise, resolve,
//! dismiss, mark read, list, the notification rules (muted kinds), and the
//! share / disk alerts kept in step with a vehicle's share status. Every
//! change is announced on the live-update hub as `notifications`, except a
//! warning raised again unchanged.

use super::ctx::{OpsCtx, ShareStatus, VehicleInfo};
use super::store::{self, Note};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// index.js NOTIFY_KINDS: the kinds the rules list, in this order.
pub const NOTIFY_KINDS: [&str; 7] = ["share", "storage", "server", "health", "conversion", "update", "archive"];

/// A share that drops for a moment is retried quietly; only one still down
/// after this long raises an alert.
pub const SHARE_GRACE_MS: i64 = 10 * 60 * 1000;

struct Down {
    since: i64,
    timer: bool,
    vehicle: VehicleInfo,
    status: ShareStatus,
    generation: u64,
}

pub struct Notes {
    ctx: Arc<dyn OpsCtx>,
    share_grace_ms: i64,
    share_down: Mutex<HashMap<String, Down>>,
    generation: Mutex<u64>,
}

fn muted(ctx: &dyn OpsCtx) -> Vec<String> {
    let v = store::get_or(&ctx.db(), "notify-muted", json!([]));
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

impl Notes {
    pub fn new(ctx: Arc<dyn OpsCtx>) -> Arc<Notes> {
        Notes::with_grace(ctx, SHARE_GRACE_MS)
    }

    pub fn with_grace(ctx: Arc<dyn OpsCtx>, share_grace_ms: i64) -> Arc<Notes> {
        Arc::new(Notes { ctx, share_grace_ms, share_down: Mutex::new(HashMap::new()), generation: Mutex::new(0) })
    }

    /// A notification, unless its kind is muted (then None; it is still logged by the caller).
    pub fn raise(&self, n: &Note) -> Option<i64> {
        if muted(&*self.ctx).iter().any(|k| *k == n.kind) {
            return None;
        }
        let (id, changed) = store::notify(&self.ctx.db(), n);
        if changed {
            self.ctx.announce("notifications");
        }
        Some(id)
    }

    pub fn resolve(&self, key: &str) {
        store::resolve(&self.ctx.db(), key);
        self.ctx.announce("notifications");
    }

    pub fn dismiss(&self, id: f64) {
        store::resolve_id(&self.ctx.db(), id);
        self.ctx.announce("notifications");
    }

    pub fn mark_read(&self, ids: &[f64]) {
        store::mark_read(&self.ctx.db(), ids);
        self.ctx.announce("notifications");
    }

    pub fn list(&self, open: bool, vehicle: Option<&str>) -> Vec<Value> {
        store::list(&self.ctx.db(), open, 200, vehicle)
    }

    /// GET and PUT /api/notification-rules
    pub fn rules(&self) -> Value {
        let m = muted(&*self.ctx);
        json!({ "rules": NOTIFY_KINDS.iter().map(|k| json!({ "kind": k, "on": !m.iter().any(|x| x == k) })).collect::<Vec<_>>() })
    }

    /// The kinds turned off are those sent as `false`; returns the muted list.
    pub fn set_rules(&self, body: &Value) -> Vec<String> {
        let muted: Vec<String> = NOTIFY_KINDS.iter().filter(|k| body["rules"][**k] == Value::Bool(false)).map(|k| k.to_string()).collect();
        store::set(&self.ctx.db(), "notify-muted", &json!(muted));
        muted
    }

    fn raise_share_down(self: &Arc<Self>, id: &str) {
        let (vehicle, status, since) = {
            let map = self.share_down.lock().unwrap();
            let Some(d) = map.get(id) else { return };
            (d.vehicle.clone(), d.status.clone(), d.since)
        };
        let mins = ((store::now_ms() - since) as f64 / 60000.0).round() as i64;
        let mut parts = vec![format!("Not reachable for {mins} minute{}; still retrying.", if mins == 1 { "" } else { "s" })];
        parts.extend(status.last_error.clone().filter(|s| !s.is_empty()));
        parts.extend(status.hint.clone().filter(|s| !s.is_empty()));
        self.raise(
            &Note::new("share", "critical", format!("{}: footage share is offline", vehicle.name))
                .vehicle(&vehicle.id)
                .key(format!("share:{}", vehicle.id))
                .message(parts.join(" ")),
        );
    }

    /// Keeps the share and disk alerts in step with a vehicle's share status.
    pub fn sync_share(self: &Arc<Self>, vehicle: &VehicleInfo, status: Option<&ShareStatus>) {
        let Some(status) = status else { return };
        let key = format!("share:{}", vehicle.id);
        if !status.healthy {
            let now = store::now_ms();
            let (since, has_timer, generation) = {
                let mut map = self.share_down.lock().unwrap();
                let gen = {
                    let mut g = self.generation.lock().unwrap();
                    *g += 1;
                    *g
                };
                let d = map.entry(vehicle.id.clone()).or_insert_with(|| Down { since: now, timer: false, vehicle: vehicle.clone(), status: status.clone(), generation: gen });
                d.vehicle = vehicle.clone();
                d.status = status.clone();
                (d.since, d.timer, d.generation)
            };
            if now - since >= self.share_grace_ms {
                self.raise_share_down(&vehicle.id);
            } else if !has_timer {
                if let Some(d) = self.share_down.lock().unwrap().get_mut(&vehicle.id) {
                    d.timer = true;
                }
                let me = Arc::clone(self);
                let id = vehicle.id.clone();
                let wait = (self.share_grace_ms - (now - since)).max(0) as u64;
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(wait));
                    // still the same outage (not cleared and down again in between)
                    let same = me.share_down.lock().unwrap().get(&id).map(|d| d.generation) == Some(generation);
                    if same {
                        me.raise_share_down(&id);
                    }
                });
            }
        } else {
            self.share_down.lock().unwrap().remove(&vehicle.id);
            self.resolve(&key);
        }

        let ro_key = format!("readonly:{}", vehicle.id);
        if status.healthy && status.read_only {
            self.raise(&Note::new("share", "info", format!("{}: footage is mounted read-only", vehicle.name)).vehicle(&vehicle.id).key(&ro_key).message(
                "It is only read: conversions, the Recycle Bin, cleanup and restore are off until it is mounted read-write.",
            ));
        } else if status.healthy && status.writable == Some(false) {
            self.raise(
                &Note::new("share", "warning", format!("{}: share is read-only", vehicle.name))
                    .vehicle(&vehicle.id)
                    .key(&ro_key)
                    .message(status.last_error.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "Conversions, trash and restore need write access.".into())),
            );
        } else if status.writable == Some(true) {
            self.resolve(&ro_key);
        }

        let space_key = format!("space:{}", vehicle.id);
        if let (Some(total), Some(free)) = (status.total_bytes.filter(|t| *t != 0.0), status.free_bytes) {
            let ratio = free / total;
            let pct = super::js::to_fixed(ratio * 100.0, 1);
            if ratio < 0.05 {
                self.raise(&Note::new("storage", "critical", format!("{}: share almost full", vehicle.name)).vehicle(&vehicle.id).key(&space_key).message(format!("{pct}% free.")));
            } else if ratio < 0.1 {
                self.raise(&Note::new("storage", "warning", format!("{}: share running low on space", vehicle.name)).vehicle(&vehicle.id).key(&space_key).message(format!("{pct}% free.")));
            } else {
                self.resolve(&space_key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::testing::FakeCtx;

    #[test]
    fn muted_kinds_are_not_raised_and_rules_answer_in_order() {
        let ctx = FakeCtx::new();
        let notes = Notes::new(ctx.clone());
        assert_eq!(notes.rules()["rules"].as_array().unwrap().len(), 7);
        assert_eq!(notes.set_rules(&json!({ "rules": { "update": false, "share": true, "bogus": false } })), vec!["update".to_string()]);
        assert_eq!(notes.rules()["rules"][5], json!({ "kind": "update", "on": false }));
        assert_eq!(notes.raise(&Note::new("update", "info", "x").key("image-update")), None);
        assert!(notes.raise(&Note::new("share", "info", "x")).is_some());
        assert_eq!(notes.list(false, None).len(), 1);
        assert!(ctx.announced().contains(&"notifications".to_string()));
    }

    #[test]
    fn share_alerts_follow_the_status() {
        let ctx = FakeCtx::new();
        let notes = Notes::with_grace(ctx.clone(), 0);
        let v = VehicleInfo { id: "car".into(), name: "Car".into(), ..Default::default() };
        let down = ShareStatus { healthy: false, last_error: Some("Host is down".into()), ..Default::default() };
        notes.sync_share(&v, Some(&down));
        let open = notes.list(true, None);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["title"], "Car: footage share is offline");
        assert_eq!(open[0]["message"], "Not reachable for 0 minutes; still retrying. Host is down");
        let up = ShareStatus { healthy: true, writable: Some(true), free_bytes: Some(4.0), total_bytes: Some(100.0), ..Default::default() };
        notes.sync_share(&v, Some(&up));
        let open = notes.list(true, None);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["title"], "Car: share almost full");
        assert_eq!(open[0]["message"], "4.0% free.");
        let ro = ShareStatus { healthy: true, read_only: true, writable: Some(false), free_bytes: Some(8.0), total_bytes: Some(100.0), ..Default::default() };
        notes.sync_share(&v, Some(&ro));
        let titles: Vec<String> = notes.list(true, None).iter().map(|n| n["title"].as_str().unwrap().to_string()).collect();
        assert!(titles.contains(&"Car: footage is mounted read-only".to_string()));
        assert!(titles.contains(&"Car: share running low on space".to_string()));
    }

    #[test]
    fn a_short_drop_waits_for_the_grace_time() {
        let ctx = FakeCtx::new();
        let notes = Notes::with_grace(ctx.clone(), 60_000);
        let v = VehicleInfo { id: "car".into(), name: "Car".into(), ..Default::default() };
        notes.sync_share(&v, Some(&ShareStatus { healthy: false, ..Default::default() }));
        assert!(notes.list(true, None).is_empty(), "nothing yet");
        notes.sync_share(&v, Some(&ShareStatus { healthy: true, ..Default::default() }));
        assert!(notes.list(true, None).is_empty());
    }
}

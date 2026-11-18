//! The route logic of index.js that belongs to this area, as plain
//! functions (the integrator mounts them; README.md here):
//!
//!   GET  /api/vehicles/:id/sentry-usb         its `record` field: record_view
//!   POST /api/vehicles/:id/sentry-usb/record  { older }: post_record (admin)
//!   DELETE /api/vehicles/:id                  vehicle_removed

use super::ctx::ArrivalCtx;
use super::engine::Arrival;
use serde_json::{Map, Value};

/// An error the router answers with `{ "error": message }` and the status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

/// `record: { ...arrivalRef.view(v.id), canBackfill: adminHere(req, user) }`
pub fn record_view(a: &Arrival, vid: &str, can_backfill: bool) -> Value {
    let mut m: Map<String, Value> = match a.view(vid) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    m.insert("canBackfill".into(), Value::Bool(can_backfill));
    Value::Object(m)
}

pub const OLDER_REQUIRED: &str = "Send { \"older\": true } or { \"older\": false }: every clip is recorded, newest first, unless older clips are turned off.";

/// POST /api/vehicles/:id/sentry-usb/record (after vehicleOr404): stores
/// the setting, kicks a pass and writes the audit line. `by` is index.js
/// `by(req, user)`. The answer is the GET's view (sentryUsbView), which the
/// integrator builds as for the GET.
pub fn post_record(a: &Arrival, ctx: &dyn ArrivalCtx, vid: &str, vehicle_name: &str, body: &Value, by: &str) -> Result<(), ApiError> {
    let Some(older) = body.get("older").and_then(Value::as_bool) else {
        return Err(ApiError { status: 400, message: OLDER_REQUIRED.into() });
    };
    ctx.set_older(vid, older);
    a.kick();
    ctx.audit(&format!("Checksum record of \"{vehicle_name}\": older clips {}: {by}", if older { "on" } else { "off" }));
    Ok(())
}

/// DELETE /api/vehicles/:id: `arrivalRef?.forget(id)` and the vehicle's
/// entry of the `sentry-usb-record` setting removed.
pub fn vehicle_removed(a: &Arrival, ctx: &dyn ArrivalCtx, vid: &str) {
    a.forget(vid);
    ctx.forget_setting(vid);
}

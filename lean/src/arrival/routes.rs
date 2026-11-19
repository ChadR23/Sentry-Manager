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

/// `record: { ...arrivalRef.view(v.id), canBackfill: adminHere(req, user) }` (an error when
/// the setting cannot be read)
pub fn record_view(a: &Arrival, vid: &str, can_backfill: bool) -> Result<Value, String> {
    let mut m: Map<String, Value> = match a.view(vid)? {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    m.insert("canBackfill".into(), Value::Bool(can_backfill));
    Ok(Value::Object(m))
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
    if let Err(e) = ctx.set_older(vid, older) {
        ctx.log_warn(&format!("The checksum record setting of \"{vehicle_name}\" was not kept: {e}"));
        return Err(ApiError { status: 500, message: "Internal error".into() });
    }
    a.kick();
    ctx.audit(&format!("Checksum record of \"{vehicle_name}\": older clips {}: {by}", if older { "on" } else { "off" }));
    Ok(())
}

/// DELETE /api/vehicles/:id: `arrivalRef?.forget(id)` and the vehicle's
/// entry of the `sentry-usb-record` setting removed.
pub fn vehicle_removed(a: &Arrival, ctx: &dyn ArrivalCtx, vid: &str) {
    a.forget(vid);
    // (the vehicle is gone either way; its leftover entry is only tidied)
    if let Err(e) = ctx.forget_setting(vid) {
        ctx.log_warn(&format!("The checksum record setting of removed vehicle {vid} was not tidied: {e}"));
    }
}

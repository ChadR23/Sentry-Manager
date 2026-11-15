//! The ops area (lean/PORT_PLAN.md): notifications and their rules, health
//! checks with the startup self-check and the banner, database snapshots,
//! power price and savings, image updates, metrics, the opt-in feedback and
//! diagnostics reports, system info, stats with history and CSV, and the
//! support bundle.
//!
//! Handlers are plain functions over `ctx::OpsCtx`; `routes` maps a request
//! to them and answers with a `Reply`, which `api.rs` turns into HTTP.

pub mod build;
pub mod ctx;
pub mod js;
pub mod net;
pub mod notes;
pub mod power;
pub mod snapshots;
pub mod store;
pub mod updates;

#[cfg(test)]
pub mod testing;

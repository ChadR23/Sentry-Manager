//! The footage area (PORT_PLAN.md): vehicles and shares, the scan, the
//! catalog and inventory, the Recycle Bin, cleanup policies, protect, stars
//! and the footage check. What it needs from the rest of the server is the
//! small `ctx::Ctx` trait.

mod names;
pub use names::*;

pub mod catalog;
pub mod inventory;
pub mod scanner;

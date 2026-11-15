//! The footage area (PORT_PLAN.md): vehicles and shares, the scan, the
//! catalog and inventory, the Recycle Bin, cleanup policies, protect, stars
//! and the footage check. What it needs from the rest of the server is the
//! small `ctx::Ctx` trait.

mod names;
pub use names::*;

pub mod catalog;
pub mod inventory;
pub mod scanner;

pub mod cars;
pub mod ctx;
pub mod js;
pub mod mdb;
pub mod safe_fs;
pub mod share;
pub mod smb;
pub mod tz;
pub mod vehicles;

//! The viewer area: media ranges' companions (telemetry, speeds, the speed
//! index, scrub previews, thumbnails), moments, places and the map, drives
//! and driving, the event map, archive gaps and the Studio viewer's routes.
//! Handlers take the small `Ctx` trait (ctx.rs) for what they need of the
//! rest of the server.

pub mod ctx;
pub mod glue;
pub mod js;
pub mod pace;
pub mod speed_reader;
pub mod work_limits;
pub mod speed_index;
pub mod telemetry_api;
#[cfg(test)]
pub mod testkit;

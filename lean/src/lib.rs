//! Sentry Six Manager's lean backend: the Node server's API from one small
//! binary. See lean/README.md for what is done and what is still to come.

pub mod api;
pub mod app;
pub mod arrival;
pub mod converter;
pub mod core;
pub mod footage;
pub mod jobs;
pub mod media;
pub mod mp4;
pub mod nodes;
pub mod ops;
pub mod sei;
pub mod speeds;
pub mod telemetry;
pub mod thumbnails;
pub mod supervisor;
pub mod ui;
pub mod viewer;

// (moved into footage/; the old paths still work)
pub use footage::{catalog, inventory, scanner};

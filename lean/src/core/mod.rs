//! core: what every area needs (see core/README.md for how an area plugs in).
//!
//! config (env), manager.db (db.js's schema and queries), accounts, sessions
//! and cookies, sign-in throttle and bans, access levels and the CSRF header,
//! the client address, HTTPS (own CA, own certificate, Let's Encrypt), the
//! live-update hub, jobs and notifications, the app and audit logs, the
//! router, and core's own routes.

pub mod access;
pub mod accounts;
pub mod acme;
pub mod activity;
pub mod auth;
pub mod client_addr;
pub mod config;
pub mod db;
pub mod events;
pub mod http;
pub mod log;
pub mod routes;
pub mod server;
pub mod state;
pub mod tls;

pub use config::Config;
pub use http::{Access, Ctx, HttpError, RawReq, Reply, Router, WebReq};
pub use state::AppState;

/// A router with core's routes in it; areas add theirs, then `server::install` and `server::serve`.
pub fn router() -> Router {
    let mut r = Router::new();
    routes::register(&mut r);
    r
}

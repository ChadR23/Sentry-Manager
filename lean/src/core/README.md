# core: what every area plugs into

The port of `server/db.js`, `catalog.js` (its tables), `auth.js`,
`accounts.js`, `access.js`, `clientAddress.js`, `tls.js`, `acme.js`,
`http.js`, `log.js`, `activity.js` and the request handler, listeners,
live updates and core routes of `server/index.js`. The Node code is the
specification.

| File | Port of | What |
| --- | --- | --- |
| `config.rs` | `process.env` reads | `Config`: every variable Node reads, its default, the DATA layout (`db_file`, `log_file`, `tls_dir`, `setup_file`, ...) and `var()` for the rest |
| `db.rs` | db.js, catalog.js schema | `Db`: the same `manager.db` (WAL, same schema, the same `ALTER TABLE sessions` columns, catalog tables): settings `get/get_or/get_as/set/del`, users, sessions, protected, bin items, jobs, notifications; `conn()` and `tx()` for an area's own queries. Every read and write returns `DbResult`: a `DbError` is the database failing (busy, read-only, full, damaged), never a missing row or a write that was kept |
| `auth.rs` | auth.js | scrypt hashes (N 16384, r 8, p 1, 64 bytes, hex salt as text: Node's hashes verify), cookies (`__Host-sm_session` over HTTPS, `sm_session` on plain HTTP), setup code, sign-in throttle, the two-at-once check limiter, the 10-minute password window |
| `accounts.rs` | accounts.js | roles (admin, viewer), TOTP and recovery codes, pending sign-ins, `viewer_may` |
| `access.rs` | access.js | bans, two-step rules, admin only at home, the home network |
| `client_addr.rs` | clientAddress.js | the client address (TRUST_PROXY, TRUSTED_PROXIES), ban keys, home matcher |
| `tls.rs` | tls.js | the app's CA and server certificate in DATA/tls (same openssl commands and files), own certificate, status, `export_for_app`, `TlsSource::{Local, Supervised}`, the rustls configuration |
| `acme.rs` | acme.js | Let's Encrypt: JWS, CSR, the order, files, state, backoff, renewal |
| `body.rs` | index.js `setTimeout(120_000)`, `requestTimeout` | reading a request body: `collect` (a limit, 408 after 2 minutes without a byte or 10 minutes in all), `idle_bounded` for a body read as it comes |
| `log.rs` | log.js | `Logger` and `Scope`: the same line format and file, rotation at 5 MB, archive, search, redaction |
| `events.rs` | index.js `announce` | the `/api/events` hub: `hello`, `changed { topics }` batched for 400 ms, `: ping` every 20 s, at most 200 streams |
| `activity.rs` | activity.js | `Jobs`, `Notifications` (with `sync_share`) |
| `http.rs` | http.js | `Router` (Node's matching), `Ctx`, `Reply`, `HttpError`, `send_json` (gzip over 1 KB), security headers |
| `server.rs` | index.js handler, listen | `dispatch` (the checks, in Node's order), the HTTPS + plain-HTTP port, the device port, `shutdown` |
| `routes.rs` | index.js | core's routes (below) |
| `state.rs` | index.js main() | `AppState`, `Hooks` |
| `supervised.rs` | supervisor.js, index.js | `supervisor::ctx::Tls` for the TLS manager (`tls_factory`), and the app side of the fd-3 link (`attach`) |

## How an area plugs in

`main.rs` does, in order:

```rust
let state = core::AppState::open(config)?;     // db, logs, accounts, access, TLS source, jobs
let mut router = core::router();               // core's routes
footage::routes(&mut router, footage_state);   // each area adds its own
core::server::install(&state, router);         // once, before listening
core::supervised::attach(&state, link);        // when the supervisor started us
core::server::serve(state).await;
```

### Routes

```rust
use sentry_lean::core::{Access, Ctx, HttpError, Reply, Router};
use axum::http::Method;

pub fn routes(r: &mut Router, me: Arc<MyArea>) {
    let m = me.clone();
    // GET, signed in; runs on a blocking thread (db, files)
    r.get("/api/things/:id", move |c: &mut Ctx| {
        let id = &c.params["id"];                          // decoded, as Node's params
        let limit = c.query.get("limit");                  // last of a repeated key wins
        let v = m.thing(id).ok_or_else(|| HttpError::new(404, "No such thing."))?;
        Ok(Reply::json(v))                                 // gzip over 1 KB, no-store
    });
    // POST, signed in: X-Requested-With and same-origin are already checked
    r.post("/api/things/:id/do", |c| {
        c.require_confirmed()?;                            // 403 CONFIRM_PASSWORD outside the window
        let body = c.body.as_ref();                        // None: no body (Node's undefined)
        c.state.audit.warn(format!("Did it: {}", c.by(c.user.as_deref())));
        c.state.announce("inventory");
        Ok(Reply::json(json!({ "ok": true })))
    });
    r.add(Method::PUT, "/api/x", Access::SignedIn, handler);   // any method
    r.add(Method::GET, "/api/open", Access::Public, handler);   // { public: true }
    r.add_async(Method::GET, "/api/stream", Access::SignedIn, |c| Box::pin(async move { ... }));
    r.raw("/node/v1/", |raw| Box::pin(async move { ... }));     // own tokens (nodes, CAN uploads, /metrics)
    r.web(|w| Box::pin(async move { ... }));                    // pages and files (the ui area)
}
```

- **Access levels.** `Access::Public` or `Access::SignedIn`. "admin" in the
  contract is not a flag: as in Node, every signed-in request is checked
  against `accounts::viewer_may(method, path)`; a viewer gets 403, an admin
  outside home with "admin pages at home" gets 403 `HOME_NETWORK_ONLY`. The
  token levels (node-token, can-token, metrics-token) are `r.raw(...)`
  handlers: they run before the host and session checks and do their own
  token check. Unclaimed, `/metrics`, `/node/v1/…` and `/api/can/logs…`
  answer 404 (the CAN paths with `code: "off"`), as Node does with those
  features off.
- **Errors.** `HttpError::new(status, msg)` answers `{ "error": msg }`;
  `.code("X")` adds `code` (Node's `expose && code`); `HttpError::internal`
  answers 500 "Internal error" and logs `METHOD path: message`.
  `auth::Refusal` (status + message) converts with `?`, and so does
  `db::DbError` (500 "Internal error", logged).
- **Answers.** `Reply::json(v)`, `.cookie(set_cookie)`, `.header(name, v)`,
  `Reply::Raw(response)` for files and streams, `Reply::text_download`.
  Use `http::num(f64)` for numbers so 3.0 is written `3` as JSON.stringify does.
- Patterns are Node's: `:name` is one segment, the rest is a regular
  expression as in http.js (a `.` matches any character, as there). Matching
  is on the raw path; HEAD does not match a GET route (Node answers 404).

### What a handler gets (`Ctx`)

`c.state: Arc<AppState>` with `config`, `db`, `logger`, `log` (scope
server), `audit`, `auth`, `accounts`, `access`, `hub`, `jobs`, `notes`,
`tls`, `hooks`, `supervisor` (the link, when supervised); helpers
`announce(topic)`, `setting(key)`, `set_setting(key, v)` (both `DbResult`), `from_home(ip)`,
`role_for(ip, user)`, `admin_here(ip, user)`, `two_factor_state(user, home)`.
On the request: `method`, `raw_path`, `path` (decoded), `params`, `query`,
`raw_query`, `headers`, `body`, `user`, `client` (clientAddress), `secure`,
`conn`, `view()` (for auth calls), `field(k)`, `field_str(k)` (`String(body?.k || '')`),
`by(user)` (the audit tail), `require_confirmed()`.

A logger scope of your own: `c.state.logger.scope("vehicles")`.

### Hooks (`state.hooks`): what core needs back from areas

| Hook | Set by | Used for |
| --- | --- | --- |
| `vehicle_exists` | footage | `POST /api/jobs/clear` (vehicleOr404) |
| `can_token_valid` | can | the device port: a connection past an address's first 6 is served only with a valid CAN Bridge token |
| `conversions_active`, `settle_conversions` | converter | Clear jobs keeps conversions still going |
| `reports_configured`, `reports_setup` | ops | `/api/auth/me` on the first-run page; the setup opt-in |
| `note_start_call` | ui | web/prefetch.js learning |
| `rapl_reading` | ops | the supervisor's `rapl-reading` |
| `on_shutdown` | any | work before exit |

The coordinator implements each area's `ctx.rs` trait on `AppState` (or on
an area struct holding `Arc<AppState>`) with these.

## Core's routes

Accounts, sessions and access (18), HTTPS certificates (6), `/api/events`,
Activity (`/api/jobs`, `/api/jobs/clear`) and the logs routes
(`/api/logs`, `/clear`, `/archive`, `/archive/:name`, `/download`,
`/search`), plus `/healthz`, the ACME challenge, `/original` and the
sign-in redirects of pages.

## Tests

`cargo test --lib core`: Node's tests ported (clientAddress, access,
accounts/TOTP, auth throttle and cookies, log, the ACME pieces and a whole
order against test/fixtures/fakeAcme.js when node is there), scrypt checked
against a hash made by auth.js.

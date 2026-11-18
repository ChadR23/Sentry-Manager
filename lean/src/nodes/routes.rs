//! The Helper servers routes of server/index.js (`/api/nodes*`, 12 routes)
//! and the node-token routes (`/node/v1/*`, 7), answer for answer. Core
//! checks `access` before calling `NodesApi::handle` (admin, signed in); the
//! 🔑 routes also need the password confirmed lately, which `handle` checks
//! from `Caller::confirmed`, as Node's requireConfirmed does in the handler.

use super::benchmark::NodeBenchmark;
use super::ctx::{Level, NodesCtx};
use super::main_side::Nodes;
use super::worker::{NodeWorker, WorkerOptions, WorkerReply, WorkerRequest};
use crate::ops::ctx::Caller;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// a paired main's token (checked by the worker itself), HTTPS only
    NodeToken,
    /// pairing with the one-time code, HTTPS only
    Public,
    Admin,
    AdminConfirmed,
}

pub const ROUTES: [(&str, &str, Access); 19] = [
    ("GET", "/api/nodes", Access::Admin),
    ("POST", "/api/nodes", Access::AdminConfirmed),
    ("DELETE", "/api/nodes/:id", Access::Admin),
    ("PUT", "/api/nodes/:id", Access::AdminConfirmed),
    ("DELETE", "/api/nodes/:id/benchmark", Access::Admin),
    ("GET", "/api/nodes/:id/benchmark", Access::Admin),
    ("POST", "/api/nodes/:id/benchmark", Access::Admin),
    ("POST", "/api/nodes/:id/slots", Access::Admin),
    ("POST", "/api/nodes/worker", Access::Admin),
    ("DELETE", "/api/nodes/worker/mains/:id", Access::Admin),
    ("DELETE", "/api/nodes/worker/pair", Access::Admin),
    ("POST", "/api/nodes/worker/pair", Access::AdminConfirmed),
    ("GET", "/node/v1/info", Access::NodeToken),
    ("POST", "/node/v1/jobs", Access::NodeToken),
    ("DELETE", "/node/v1/jobs/:id", Access::NodeToken),
    ("GET", "/node/v1/jobs/:id", Access::NodeToken),
    ("GET", "/node/v1/jobs/:id/output", Access::NodeToken),
    ("POST", "/node/v1/pair", Access::Public),
    ("POST", "/node/v1/slots", Access::NodeToken),
];

// (Node's router matches routes in the order they were added: /api/nodes/worker
// is a route of its own before /api/nodes/:id would take it)
fn matches(pattern: &str, path: &str) -> Option<HashMap<String, String>> {
    let (p, q): (Vec<&str>, Vec<&str>) = (pattern.split('/').collect(), path.split('/').collect());
    if p.len() != q.len() {
        return None;
    }
    let mut params = HashMap::new();
    for (a, b) in p.iter().zip(q.iter()) {
        if let Some(k) = a.strip_prefix(':') {
            if b.is_empty() {
                return None;
            }
            params.insert(k.to_string(), crate::api::decode(b, false)?);
        } else if a != b {
            return None;
        }
    }
    Some(params)
}

/// Who may call a route of this area (None: not one of its routes).
/// `/node/v1/...` paths are all this area's (the worker answers each).
pub fn access(method: &str, path: &str) -> Option<Access> {
    if path.starts_with("/node/v1/") {
        return Some(if path == "/node/v1/pair" { Access::Public } else { Access::NodeToken });
    }
    if path.starts_with("/api/nodes/worker") {
        return ROUTES.iter().filter(|r| r.1.starts_with("/api/nodes/worker")).find(|(m, p, _)| *m == method && matches(p, path).is_some()).map(|r| r.2);
    }
    ROUTES.iter().find(|(m, p, _)| *m == method && matches(p, path).is_some()).map(|r| r.2)
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    fn ok(v: Value) -> Reply {
        Reply { status: 200, body: v }
    }
    fn error(status: u16, msg: &str) -> Reply {
        Reply { status, body: json!({ "error": msg }) }
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.body.to_string().into_bytes()
    }
}

pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    /// the JSON body (Null when there was none)
    pub body: &'a Value,
    pub caller: &'a Caller,
}

const CONFIRM_TEXT: &str = "Enter your password to confirm this change.";
const NO_TLS: &str = "This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node.";

fn confirm(c: &Caller) -> Option<Reply> {
    (!c.confirmed).then(|| Reply { status: 403, body: json!({ "error": CONFIRM_TEXT, "code": "CONFIRM_PASSWORD" }) })
}

pub struct ApiOptions {
    /// `<data>/node-work` unless given
    pub work_dir: Option<std::path::PathBuf>,
    /// `<data>/converter-temp/node-benchmark` unless given
    pub bench_dir: Option<std::path::PathBuf>,
    pub poll_ms: Option<u64>,
    pub spawn: Option<super::worker::Spawn>,
}

/// The whole area: the main side, the worker, the benchmark and the routes.
pub struct NodesApi {
    pub ctx: Arc<dyn NodesCtx>,
    pub nodes: Nodes,
    pub worker: NodeWorker,
    pub bench: NodeBenchmark,
}

impl NodesApi {
    pub fn new(ctx: Arc<dyn NodesCtx>, o: ApiOptions) -> NodesApi {
        let data = ctx.data_path();
        let nodes = Nodes::new(ctx.clone(), None, o.poll_ms);
        let worker = NodeWorker::new(ctx.clone(), WorkerOptions { work_dir: o.work_dir.unwrap_or_else(|| data.join("node-work")), name: None, spawn: o.spawn });
        let bench = NodeBenchmark::new(nodes.clone(), ctx.clone(), o.bench_dir.unwrap_or_else(|| data.join("converter-temp").join("node-benchmark")), None, None);
        NodesApi { ctx, nodes, worker, bench }
    }

    /// DELETE /api/vehicles/:id calls this: the vehicle leaves every node's Vehicles first list.
    pub fn forget_vehicle(&self, id: &str) {
        self.nodes.forget_car(id);
    }

    /// On exit (index.js nodeWorker.close()).
    pub fn close(&self) {
        self.worker.close();
    }

    /// `/node/v1/*` (index.js): the worker's answer over HTTPS; 404 Not found
    /// without this server's own HTTPS or over plain HTTP. None: not a node path.
    pub fn node_v1(&self, https: bool, r: &mut WorkerRequest) -> Option<WorkerReply> {
        if !r.path.starts_with("/node/v1/") {
            return None;
        }
        if https && self.ctx.tls_available() {
            if let Some(reply) = self.worker.handle(r) {
                return Some(reply);
            }
        }
        Some(WorkerReply::json(404, &json!({ "error": "Not found" })))
    }

    /// One `/api/nodes*` request, or None when it is not one of its routes.
    /// Blocking (it talks to the nodes): core calls it from spawn_blocking.
    pub fn handle(&self, r: &Request) -> Option<Reply> {
        let (m, p) = (r.method, r.path);
        let by = r.caller.by();
        let ctx = &*self.ctx;
        let route = |method: &str, pattern: &str| if m == method { matches(pattern, p) } else { None };
        let fail = |e: super::NodeError| Reply::error(if e.status < 500 { e.status } else { 502 }, &e.message);

        if route("GET", "/api/nodes").is_some() {
            let mut worker = match self.worker.status() {
                Value::Object(o) => o,
                _ => Map::new(),
            };
            worker.insert("available".into(), json!(ctx.tls_available()));
            worker.insert("name".into(), json!(ctx.hostname()));
            return Some(Reply::ok(json!({ "nodes": self.nodes.overview(), "worker": worker })));
        }
        if route("POST", "/api/nodes").is_some() {
            if let Some(no) = confirm(r.caller) {
                return Some(no);
            }
            return Some(match self.nodes.add(&r.body["address"], &r.body["code"]) {
                Ok(node) => {
                    ctx.audit(Level::Info, &format!("Node \"{}\" paired at {}:{}: {by}", crate::ops::js::to_string(&node["name"]), crate::ops::js::to_string(&node["host"]), crate::ops::js::to_string(&node["port"])));
                    Reply::ok(json!({ "ok": true, "id": node["id"] }))
                }
                Err(e) => fail(e),
            });
        }
        if route("POST", "/api/nodes/worker").is_some() {
            if !ctx.tls_available() {
                return Some(Reply::error(409, NO_TLS));
            }
            let slots = r.body.get("slots").filter(|_| r.body.is_object());
            let use_ = r.body.get("use").filter(|_| r.body.is_object());
            return Some(match self.worker.set_enabled(r.body["enabled"] == json!(true), slots, use_) {
                Ok(status) => {
                    ctx.audit(Level::Info, &format!("Node mode {}: {by}", if status["enabled"] == json!(true) { "on" } else { "off" }));
                    Reply::ok(status)
                }
                Err(e) => Reply::error(e.status.unwrap_or(500), &e.message),
            });
        }
        if route("POST", "/api/nodes/worker/pair").is_some() {
            if !ctx.tls_available() {
                return Some(Reply::error(409, NO_TLS));
            }
            if let Some(no) = confirm(r.caller) {
                return Some(no);
            }
            ctx.audit(Level::Info, &format!("Node pairing code shown: {by}"));
            return Some(Reply::ok(self.worker.start_pairing()));
        }
        if route("DELETE", "/api/nodes/worker/pair").is_some() {
            return Some(Reply::ok(self.worker.cancel_pairing()));
        }
        if let Some(params) = route("DELETE", "/api/nodes/worker/mains/:id") {
            let Some(main) = self.worker.revoke(&params["id"]) else { return Some(Reply::error(404, "No such main server.")) };
            ctx.audit(Level::Info, &format!("Main server \"{}\" can no longer use this node: {by}", crate::ops::js::to_string(&main["name"])));
            return Some(Reply::ok(self.worker.status()));
        }
        if let Some(params) = route("GET", "/api/nodes/:id/benchmark") {
            return Some(Reply::ok(json!({ "benchmark": self.bench.view(&params["id"]) })));
        }
        if let Some(params) = route("POST", "/api/nodes/:id/benchmark") {
            let id = &params["id"];
            if !self.nodes.has(id) {
                return Some(Reply::error(404, "No such node."));
            }
            let codec = if r.body["codec"] == json!("av1") { "av1" } else { "h265" };
            return Some(match self.bench.start(id, codec) {
                Ok(started) => {
                    ctx.audit(Level::Info, &format!("Node benchmark started for {id}: {by}"));
                    Reply::ok(json!({ "benchmark": started }))
                }
                Err((status, message)) => Reply::error(status, &message),
            });
        }
        if let Some(params) = route("DELETE", "/api/nodes/:id/benchmark") {
            return Some(Reply::ok(json!({ "benchmark": self.bench.cancel(&params["id"]) })));
        }
        if let Some(params) = route("POST", "/api/nodes/:id/slots") {
            let id = &params["id"];
            let n = r.body.get("slots").map(crate::ops::js::number).unwrap_or(f64::NAN);
            if let Err(e) = self.nodes.set_slots(id, &super::jnum(n)) {
                return Some(fail(e));
            }
            ctx.audit(Level::Info, &format!("Node {id} set to {} clips at once: {by}", crate::ops::js::num_text(n)));
            return Some(Reply::ok(json!({ "ok": true })));
        }
        if let Some(params) = route("PUT", "/api/nodes/:id") {
            return Some(self.put(&params["id"], r, &by));
        }
        if let Some(params) = route("DELETE", "/api/nodes/:id") {
            let Some(node) = self.nodes.remove(&params["id"]) else { return Some(Reply::error(404, "No such node.")) };
            ctx.audit(Level::Info, &format!("Node \"{}\" removed: {by}", crate::ops::js::to_string(&node["name"])));
            return Some(Reply::ok(json!({ "ok": true })));
        }
        None
    }

    /// PUT /api/nodes/:id: everything is checked (and the password asked for)
    /// before anything is saved.
    fn put(&self, id: &str, r: &Request, by: &str) -> Reply {
        let ctx = &*self.ctx;
        if !self.nodes.has(id) {
            return Reply::error(404, "No such node.");
        }
        let b = r.body;
        let given = |k: &str| b.get(k).is_some();
        if given("name") && !b["name"].as_str().is_some_and(|n| !super::js_trim(n).is_empty()) {
            return Reply::error(400, "Enter a name.");
        }
        if given("trusted") && !b["trusted"].is_boolean() {
            return Reply::error(400, "Trusted is on or off.");
        }
        if b["trusted"] == json!(true) {
            if let Some(no) = confirm(r.caller) {
                return no;
            }
        }
        let mut cars = None;
        if given("cars") {
            let Some(a) = b["cars"].as_array().filter(|a| a.iter().all(Value::is_string)) else { return Reply::error(400, "A list of vehicles.") };
            // a vehicle removed meanwhile is left out instead of refusing the list
            let known: Vec<String> = ctx.vehicles().into_iter().map(|v| v.id).collect();
            cars = Some(Value::Array(a.iter().filter(|c| known.iter().any(|k| Some(k.as_str()) == c.as_str())).cloned().collect()));
        }
        let mut out = Map::new();
        out.insert("ok".into(), json!(true));
        if given("name") {
            match self.nodes.rename(id, &b["name"]) {
                Ok(Some((previous, name))) => {
                    ctx.audit(Level::Info, &format!("Node \"{}\" renamed \"{name}\": {by}", crate::ops::js::to_string(&previous)));
                    out.insert("name".into(), json!(name));
                }
                Ok(None) => {}
                Err(e) => return Reply::error(e.status, &e.message),
            }
        }
        if given("trusted") {
            let t = self.nodes.set_trusted(id, &b["trusted"]);
            let on = t == Some(true);
            let line = format!("Node {id} {}: {by}", if on { "trusted: its encodes skip the picture check" } else { "no longer trusted: its encodes get the picture check" });
            ctx.audit(if on { Level::Warn } else { Level::Info }, &line);
            out.insert("trusted".into(), json!(t));
        }
        if let Some(c) = cars {
            match self.nodes.set_cars(id, &c) {
                Ok(list) => {
                    let list = list.unwrap_or_default();
                    ctx.audit(Level::Info, &format!("Node {id} converts first for: {}: {by}", if list.is_empty() { "no vehicle in particular".to_string() } else { list.join(", ") }));
                    out.insert("cars".into(), json!(list));
                }
                Err(e) => return Reply::error(e.status, &e.message),
            }
        }
        Reply::ok(Value::Object(out))
    }
}

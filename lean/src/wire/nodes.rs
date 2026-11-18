//! The helper servers on core: `NodesCtx` on core's state (manager.db's
//! `nodes` and `nodeWorker` settings, audit and logs, core's TLS and its
//! certificate authority, ops' node power, this server's own power and GPUs,
//! the footage area's vehicles, the converter's planner as the worker's
//! runtime); `/api/nodes*` through core's router, `/node/v1/*` as core's raw
//! path on its HTTPS port with the certificate this connection was served with.

use super::Server;
use crate::converter::planner::Planner;
use crate::converter::process::BoundedRunner;
use crate::core::http::{RawReq, Res};
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use crate::nodes::ctx::{Level, NodesCtx, Vehicle, WorkerRuntime};
use crate::nodes::routes::NodesApi;
use crate::nodes::worker::{ReplyBody, WorkerRequest};
use axum::body::Body;
use futures_util::StreamExt;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

pub struct CoreNodes {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
    gpus: Mutex<Option<(std::time::Instant, (Option<String>, Value))>>,
}

impl NodesCtx for CoreNodes {
    fn setting(&self, key: &str) -> Option<Value> {
        self.state.setting(key)
    }
    fn set_setting(&self, key: &str, value: &Value) {
        self.state.set_setting(key, value);
    }
    fn audit(&self, level: Level, line: &str) {
        match level {
            Level::Info => self.state.audit.info(line),
            Level::Warn => self.state.audit.warn(line),
            Level::Error => self.state.audit.error(line),
        }
    }
    fn log(&self, level: Level, line: &str) {
        let s = self.state.logger.scope("nodes");
        match level {
            Level::Info => s.info(line),
            Level::Warn => s.warn(line),
            Level::Error => s.error(line),
        }
    }
    fn tls_available(&self) -> bool {
        self.state.tls.is_some()
    }
    fn authority_pem(&self) -> Option<String> {
        self.state.tls.as_ref()?.ca_pem().map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    fn node_power(&self, node: &str, at: i64, w: Option<f64>, encoding: bool) {
        if let Some(ops) = self.srv.upgrade().and_then(|s| s.ops().cloned()) {
            ops.node_power(node, at, w, encoding);
        }
    }
    fn own_power(&self) -> Option<Value> {
        // (the main asks about every 30 s: sampling holds 45 s and the numbers stay live)
        let ops = self.srv.upgrade()?.ops()?.clone();
        Some(ops.power_for_main())
    }
    fn own_gpus(&self) -> Option<(Option<String>, Value)> {
        // index.js ownHardware: kept 10 minutes (detectGpus runs vainfo)
        let mut g = self.gpus.lock().unwrap();
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(600) {
                return Some(v.clone());
            }
        }
        let v = (crate::ops::diag::cpu_model(), crate::ops::gpu::detect_gpus(&crate::ops::gpu::DetectOptions::default(), &crate::ops::gpu::run));
        *g = Some((std::time::Instant::now(), v.clone()));
        Some(v)
    }
    fn vehicles(&self) -> Vec<Vehicle> {
        let Some(s) = self.srv.upgrade() else { return Vec::new() };
        let app = s.app();
        app.vehicles.list().iter().map(|v| Vehicle { id: v.id.clone(), studio_root: Some(app.studio_root(v)) }).collect()
    }
    fn data_path(&self) -> PathBuf {
        self.state.config.data.clone()
    }
    fn ffmpeg_path(&self) -> String {
        self.state.config.ffmpeg.clone()
    }
    fn ffprobe_path(&self) -> String {
        self.state.config.ffprobe.clone()
    }
    fn runtime(&self) -> Option<Arc<dyn WorkerRuntime>> {
        // the converter itself (None while it starts: the worker answers "The converter is starting.")
        let rt: Arc<dyn WorkerRuntime> = self.srv.upgrade()?.converter()?.runtime.clone();
        Some(rt)
    }
}

pub fn make(srv: &Arc<Server>) -> Arc<NodesApi> {
    let ctx: Arc<dyn NodesCtx> = Arc::new(CoreNodes { srv: Arc::downgrade(srv), state: srv.state.clone(), gpus: Mutex::new(None) });
    Arc::new(NodesApi::new(ctx, crate::nodes::routes::ApiOptions { work_dir: None, bench_dir: None, poll_ms: None, spawn: None }))
}

/// The planner of the health check's encoder test.
pub fn planner(ffmpeg: &str) -> Planner<BoundedRunner> {
    Planner::new(BoundedRunner::default(), "linux", ffmpeg)
}

/// An `/api/nodes*` route for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let Some(api) = srv.nodes() else { return Err(HttpError::not_found()) };
    let body = c.body.clone().unwrap_or(Value::Null);
    let caller = crate::ops::ctx::Caller { user: c.user.clone(), client: c.client.clone(), confirmed: c.state.auth.recently_confirmed(&c.view()), https: c.secure };
    let r = crate::nodes::routes::Request { method: c.method.as_str(), path: &c.raw_path, body: &body, caller: &caller };
    match api.handle(&r) {
        Some(reply) => Ok(Reply::Raw(crate::core::http::send_json(reply.status, &reply.body, c.accept_encoding()))),
        None => Err(HttpError::not_found()),
    }
}

/// `/node/v1/*`: a main's calls, before core's host and origin checks (its own token).
pub async fn node_v1(srv: Arc<Server>, q: RawReq) -> Res {
    let not_found = || crate::core::http::error_json(404, "Not found", None, "");
    let Some(api) = srv.nodes().cloned() else { return not_found() };
    // the DER of the certificate this connection was served with (what the main pinned)
    let served: Option<Vec<u8>> = if q.conn.encrypted { srv.state.tls.as_ref().and_then(|t| t.load().ok()).and_then(|m| crate::core::tls::pem_ders(&m.cert).into_iter().next()) } else { None };
    let (parts, body) = q.req.into_parts();
    let method = parts.method.as_str().to_string();
    let path = parts.uri.path().to_string();
    let headers: Vec<(String, String)> = parts.headers.iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
    let address = q.client.clone();
    let https = q.conn.encrypted;
    let stream = http_body_util::BodyStream::new(body).filter_map(|f| async move {
        match f {
            Ok(frame) => frame.into_data().ok().map(Ok::<_, std::io::Error>),
            Err(e) => Some(Err(std::io::Error::other(e))),
        }
    });
    let reader = tokio_util::io::StreamReader::new(Box::pin(stream));
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let mut body = tokio_util::io::SyncIoBridge::new(reader);
        let reply = {
            let mut req = WorkerRequest { method: &method, path: &path, headers: &headers, address: &address, served_cert: served.as_deref(), body: &mut body };
            api.node_v1(https, &mut req)
        };
        // what the worker left of a refused upload is read before the answer (a reset otherwise)
        let began = std::time::Instant::now();
        let mut sink = vec![0u8; 64 * 1024];
        while began.elapsed() < std::time::Duration::from_secs(5) {
            match body.read(&mut sink) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = tx.send(reply);
    });
    let Ok(Some(mut reply)) = rx.await else { return not_found() };
    let mut b = axum::http::Response::builder().status(reply.status);
    for (k, v) in &reply.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let content = std::mem::replace(&mut reply.body, ReplyBody::Close);
    // delivered() once the whole answer was taken (dropped unsent, the job it names stops)
    let done = Arc::new(Mutex::new(Some(reply)));
    let finish = move || {
        if let Some(r) = done.lock().unwrap().take() {
            r.delivered();
        }
    };
    let body = match content {
        ReplyBody::Bytes(bytes) => {
            let parts = futures_util::stream::iter([Ok::<_, std::io::Error>(bytes::Bytes::from(bytes))]).chain(futures_util::stream::once(async move {
                finish();
                Ok(bytes::Bytes::new())
            }));
            Body::from_stream(parts)
        }
        ReplyBody::File(file, len) => {
            let r = crate::media::file_stream(tokio::io::AsyncReadExt::take(tokio::fs::File::from_std(file), len));
            Body::from_stream(r.chain(futures_util::stream::once(async move {
                finish();
                Ok(bytes::Bytes::new())
            })))
        }
        // (Node leaves such a request unanswered: the connection is ended without an answer body)
        ReplyBody::Close => Body::from_stream(futures_util::stream::once(async { Err::<bytes::Bytes, std::io::Error>(std::io::Error::other("closed")) })),
    };
    b.body(body).unwrap_or_else(|_| not_found())
}

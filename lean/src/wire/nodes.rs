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
    fn setting(&self, key: &str) -> Result<Option<Value>, String> {
        self.state.setting(key).map_err(|e| e.to_string())
    }
    fn set_setting(&self, key: &str, value: &Value) -> Result<(), String> {
        self.state.set_setting(key, value).map_err(|e| e.to_string())
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
    let (parts, body) = q.req.into_parts();
    let method = parts.method.as_str().to_string();
    let path = parts.uri.path().to_string();
    let headers: Vec<(String, String)> = parts.headers.iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
    let address = q.client.clone();
    let https = q.conn.encrypted;
    // (a main that stops sending for 2 minutes is given up: the reader sees an error)
    let stream = crate::core::body::idle_bounded(body);
    let reader = tokio_util::io::StreamReader::new(Box::pin(stream));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tls = srv.clone();
    tokio::task::spawn_blocking(move || {
        // the DER of the certificate this connection was served with (what the main pinned): read here, it is a file
        let served: Option<Vec<u8>> = if https { tls.state.tls.as_ref().and_then(|t| t.load().ok()).and_then(|m| crate::core::tls::pem_ders(&m.cert).into_iter().next()) } else { None };
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
    let body = reply_body(content, finish);
    b.body(body).unwrap_or_else(|_| not_found())
}

/// The answer body for a /node/v1 reply; `finish` (the reply's delivered()) runs when its
/// last byte is handed to hyper.
fn reply_body(content: ReplyBody, finish: impl FnOnce() + Send + 'static) -> Body {
    // delivered() when the answer's last byte is handed to hyper: these answers carry a
    // Content-Length, and hyper stops polling the body once it has that many bytes, so a
    // marker chunk after the body is never reached (the answer then counted as unsent and
    // its job was stopped: the main's next GET /node/v1/jobs/<id> found "No such job.").
    // A connection gone before the last byte still drops the body unsent, as before.
    match content {
        ReplyBody::Bytes(bytes) => {
            let mut finish = Some(finish);
            let once = futures_util::stream::once(async move { Ok::<_, std::io::Error>(bytes::Bytes::from(bytes)) });
            Body::from_stream(once.inspect(move |_| {
                if let Some(f) = finish.take() {
                    f();
                }
            }))
        }
        ReplyBody::File(file, len) => {
            let r = crate::media::file_stream(tokio::io::AsyncReadExt::take(tokio::fs::File::from_std(file), len));
            let mut finish = Some(finish);
            let mut sent: u64 = 0;
            let mark = move |part: &std::io::Result<bytes::Bytes>| {
                if let Ok(b) = part {
                    sent += b.len() as u64;
                    if sent >= len {
                        if let Some(f) = finish.take() {
                            f();
                        }
                    }
                }
            };
            // (an empty file has no chunk to hand over: delivered once the stream ends)
            let mut mark = mark;
            if len == 0 {
                mark(&Ok(bytes::Bytes::new()));
            }
            Body::from_stream(r.inspect(move |p| mark(p)))
        }
        // (Node leaves such a request unanswered: the connection is ended without an answer body)
        ReplyBody::Close => Body::from_stream(futures_util::stream::once(async { Err::<bytes::Bytes, std::io::Error>(std::io::Error::other("closed")) })),
    }
}

#[cfg(test)]
mod tests {
    // The /node/v1 answers through a real hyper connection, as in production: each carries
    // a Content-Length, and the reply must count as delivered once its last byte is out
    // (it counted as unsent before, so every remote encode was stopped right after it began).
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serves one answer with this body and Content-Length; `read` bytes of it are read by the client.
    async fn serve_one(content: ReplyBody, len: u64, read: Option<usize>) -> bool {
        let delivered = Arc::new(AtomicBool::new(false));
        let flag = delivered.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let slot = Arc::new(Mutex::new(Some(content)));
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let svc = hyper::service::service_fn(move |_req: hyper::Request<hyper::body::Incoming>| {
                let content = slot.lock().unwrap().take().unwrap();
                let flag = flag.clone();
                async move {
                    let body = reply_body(content, move || flag.store(true, Ordering::SeqCst));
                    Ok::<_, std::convert::Infallible>(axum::http::Response::builder().status(200).header("Content-Length", len.to_string()).body(body).unwrap())
                }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(sock), svc).await;
        });
        let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
        // keep-alive, as the main's client: the server must not wait for the connection to end
        c.write_all(b"POST /node/v1/jobs HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        let mut got = Vec::new();
        let mut buf = [0u8; 8192];
        let head_and = |got: &Vec<u8>| got.windows(4).position(|w| w == b"\r\n\r\n").map(|i| got.len() - i - 4);
        loop {
            let want = read.map_or(len as usize, |r| r);
            if head_and(&got).is_some_and(|n| n >= want) {
                break;
            }
            let n = c.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
        }
        if read.is_some() {
            drop(c); // gone before the end of the answer
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let out = delivered.load(Ordering::SeqCst);
        server.abort();
        out
    }

    #[tokio::test]
    async fn a_json_answer_is_delivered_once_its_bytes_are_out() {
        let text = br#"{"id":"abc123"}"#.to_vec();
        let len = text.len() as u64;
        assert!(serve_one(ReplyBody::Bytes(text), len, None).await);
    }

    #[tokio::test]
    async fn an_encoded_file_is_delivered_once_its_last_byte_is_out() {
        let path = std::env::temp_dir().join(format!("node-reply-{}.bin", std::process::id()));
        std::fs::write(&path, vec![7u8; 300_000]).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        assert!(serve_one(ReplyBody::File(file, 300_000), 300_000, None).await);
        let empty = std::env::temp_dir().join(format!("node-reply-empty-{}.bin", std::process::id()));
        std::fs::write(&empty, b"").unwrap();
        assert!(serve_one(ReplyBody::File(std::fs::File::open(&empty).unwrap(), 0), 0, None).await);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(empty);
    }

    #[tokio::test]
    async fn a_file_the_main_stopped_reading_stays_unsent() {
        let path = std::env::temp_dir().join(format!("node-reply-cut-{}.bin", std::process::id()));
        // larger than the socket buffers, so the answer cannot all be handed over
        std::fs::write(&path, vec![7u8; 32 * 1024 * 1024]).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        assert!(!serve_one(ReplyBody::File(file, 32 * 1024 * 1024), 32 * 1024 * 1024, Some(64 * 1024)).await);
        let _ = std::fs::remove_file(path);
    }
}

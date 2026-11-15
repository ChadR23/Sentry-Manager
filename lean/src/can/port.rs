//! The device port (CAN_PORT, 10000; server/canPort.js): only the CAN Bridge
//! upload API (/api/can/logs...), every other address 404. It listens while
//! CAN uploads are on and is closed otherwise; calls are run one at a time,
//! so the port ends as the last call said.
//!
//! Not yet as in Node: TLS on this port (it comes with core's HTTPS; without
//! it the uploads answer 403 https_only unless a reverse proxy on the local
//! network forwards https), and the per-address (6) and total (256)
//! connection limits and the 15 s first-request timeout.

use super::routes::{json_res, Can, Req};
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::Request;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

struct Port {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

async fn only(State(can): State<Arc<Can>>, ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request<Body>) -> axum::response::Response {
    let path = req.uri().path().to_string();
    if path != "/api/can/logs" && !path.starts_with("/api/can/logs/") {
        return json_res(404, &serde_json::json!({ "error": "Not found" }));
    }
    let method = req.method().clone();
    let headers = req.headers().clone();
    let port = can.ctx.can_port();
    let body = match axum::body::to_bytes(req.into_body(), (super::logs::MAX_CHUNK + 1024 * 1024) as usize).await {
        Ok(b) => b,
        Err(_) => return json_res(413, &serde_json::json!({ "error": "That file is too large.", "code": "error" })),
    };
    let r = Req {
        method,
        path: path.clone(),
        query: Default::default(),
        headers,
        body,
        remote: addr.ip().to_string(),
        local_port: port,
        encrypted: false,
        who: Default::default(),
        confirmed: false,
        closed: Arc::new(AtomicBool::new(false)),
    };
    tokio::task::spawn_blocking(move || can.upload(&r, &path)).await.unwrap_or_else(|_| json_res(500, &serde_json::json!({ "error": "Internal error" })))
}

/// Hooks the device port to the area: opened or closed whenever the uploads are turned on or off.
pub fn attach(can: &Arc<Can>, rt: tokio::runtime::Handle, host: std::net::IpAddr) {
    let state = Arc::new(Mutex::new(Port { stop: None }));
    let weak = Arc::downgrade(can);
    let queue = Arc::new(tokio::sync::Mutex::new(()));
    *can.on_port.lock().unwrap() = Some(Box::new(move |on: bool| {
        let (state, weak, queue) = (state.clone(), weak.clone(), queue.clone());
        rt.spawn(async move {
            let _one = queue.lock().await;
            let Some(can) = weak.upgrade() else { return };
            let port = can.ctx.can_port();
            if !on {
                if let Some(stop) = state.lock().unwrap().stop.take() {
                    let _ = stop.send(());
                    can.ctx.log("info", &format!("Device port {} closed", port));
                }
                *can.port_state.lock().unwrap() = super::routes::PortState { listening: false, error: None, port };
                return;
            }
            if state.lock().unwrap().stop.is_some() {
                return;
            }
            match tokio::net::TcpListener::bind(SocketAddr::new(host, port)).await {
                Err(e) => {
                    let msg = if e.kind() == std::io::ErrorKind::AddrInUse { format!("Port {} is used by something else.", port) } else { e.to_string() };
                    can.ctx.log("warn", &format!("Device port {}: {}", port, e));
                    *can.port_state.lock().unwrap() = super::routes::PortState { listening: false, error: Some(msg), port };
                }
                Ok(listener) => {
                    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
                    state.lock().unwrap().stop = Some(tx);
                    *can.port_state.lock().unwrap() = super::routes::PortState { listening: true, error: None, port };
                    can.ctx.log("info", &format!("Device port open: http://{}:{} (CAN Bridge uploads at /api/can/logs)", host, port));
                    let app = axum::Router::new().fallback(only).with_state(can.clone()).into_make_service_with_connect_info::<SocketAddr>();
                    tokio::spawn(async move {
                        let _ = axum::serve(listener, app).with_graceful_shutdown(async move {
                            let _ = rx.await;
                        }).await;
                    });
                }
            }
        });
    }));
}

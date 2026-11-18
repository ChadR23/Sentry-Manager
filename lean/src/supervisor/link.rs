//! The app's side of the channel to the root supervisor: what `process.send`,
//! `process.on('message')` and `process.on('disconnect')` were in
//! `server/index.js`, plus the IPC mounter (`createIpcMounter`) and the TLS
//! name change request (`supervisorTlsSource().setHostnames`).
//!
//! See README.md in this folder for the messages.

use super::ipc;
use super::mounter::{check_id_str, BoxFuture, MountError, Mounter};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// How long the IPC mounter waits for an answer (90 s, as in Node).
pub const MOUNT_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a TLS host name change waits (120 s, as in Node).
pub const TLS_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct Link {
    sender: ipc::Sender,
    bus: broadcast::Sender<Value>,
    closed: watch::Receiver<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestError {
    /// No answer in time.
    Timeout,
    /// Could not send: the supervisor is gone (Node's "Channel closed").
    Send(String),
}

/// A v4 UUID like `crypto.randomUUID()`.
pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    // SAFETY: b is a valid 16-byte buffer
    let n = unsafe { libc::getrandom(b.as_mut_ptr().cast(), b.len(), 0) };
    if n != 16 {
        // getrandom cannot fail for 16 bytes after boot; fall back to the clock
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        b.copy_from_slice(&t.to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

impl Link {
    /// In the app, at start: connected when the supervisor ran it separately
    /// (`SENTRY_SUPERVISED=1`, Node's `SUPERVISED`) and handed over the channel.
    /// Needs a Tokio runtime. Call `ipc::take_from_env()` before starting
    /// threads and pass its result here.
    pub fn from_fd(fd: Option<std::os::fd::OwnedFd>) -> Option<Link> {
        if std::env::var("SENTRY_SUPERVISED").ok().as_deref() != Some("1") {
            return None;
        }
        Link::open(fd?).ok()
    }

    pub fn open(fd: std::os::fd::OwnedFd) -> std::io::Result<Link> {
        let (sender, mut incoming) = ipc::open(fd)?;
        let (bus, _) = broadcast::channel(256);
        let (closed_tx, closed) = watch::channel(false);
        let b = bus.clone();
        tokio::spawn(async move {
            while let Some(m) = incoming.recv().await {
                let _ = b.send(m);
            }
            let _ = closed_tx.send(true);
        });
        Ok(Link { sender, bus, closed })
    }

    pub fn connected(&self) -> bool {
        self.sender.connected()
    }

    pub fn send(&self, msg: &Value) -> Result<(), String> {
        self.sender.send(msg)
    }

    /// Every message from the supervisor (`process.on('message')`).
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.bus.subscribe()
    }

    /// Resolves when the supervisor is gone (`process.on('disconnect')`):
    /// the app shuts down then ('supervisor gone').
    pub async fn disconnected(&self) {
        let mut c = self.closed.clone();
        let _ = c.wait_for(|v| *v).await;
    }

    /// Send `msg` with a fresh `requestId` and wait for the message of type
    /// `reply_type` with the same id.
    pub async fn request(&self, mut msg: Value, reply_type: &str, timeout: Duration) -> Result<Value, RequestError> {
        let id = random_uuid();
        // { type, requestId, ...payload }: requestId second, as Node writes it
        if let Value::Object(m) = &mut msg {
            let mut out = serde_json::Map::new();
            if let Some(t) = m.shift_remove("type") {
                out.insert("type".into(), t);
            }
            out.insert("requestId".into(), Value::String(id.clone()));
            out.extend(std::mem::take(m));
            *m = out;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let mut rx = self.subscribe();
        self.send(&msg).map_err(RequestError::Send)?;
        let wait = async {
            loop {
                match rx.recv().await {
                    Ok(m) if m.get("type").and_then(Value::as_str) == Some(reply_type) && m.get("requestId").and_then(Value::as_str) == Some(id.as_str()) => return Some(m),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        };
        match tokio::time::timeout_at(deadline, wait).await {
            Ok(Some(m)) => Ok(m),
            // the channel closed: Node waits for its timer all the same
            Ok(None) => {
                tokio::time::sleep_until(deadline).await;
                Err(RequestError::Timeout)
            }
            Err(_) => Err(RequestError::Timeout),
        }
    }

    /// Keep the CPU energy readings coming for 30 s (`{ type: 'rapl', on: true }`).
    pub fn rapl_on(&self) {
        if self.connected() {
            let _ = self.send(&json!({ "type": "rapl", "on": true }));
        }
    }

    /// Ask the supervisor for a certificate with these names
    /// (`supervisorTlsSource().setHostnames`). Ok(caReplaced); Err((status, message)):
    /// status 400 for the supervisor's refusal. The caller then reads the new
    /// files from SENTRY_TLS_DIR.
    pub async fn tls_hostnames(&self, names: &[String]) -> Result<bool, (Option<u16>, String)> {
        let list: Vec<&String> = names.iter().take(20).collect();
        let msg = json!({ "type": "tls-hostnames", "hostnames": list });
        match self.request(msg, "tls-result", TLS_TIMEOUT).await {
            Ok(m) => match m.get("error") {
                Some(e) if super::js::truthy(Some(e)) => Err((Some(400), super::js::js_string(Some(e)))),
                _ => Ok(super::js::truthy(m.get("caReplaced"))),
            },
            Err(RequestError::Timeout) => Err((None, "The supervisor did not answer.".into())),
            Err(RequestError::Send(e)) => Err((None, e)),
        }
    }
}

/// The mounter for the unprivileged app (`createIpcMounter`): asks the
/// supervisor, which answers with the local mounter's result.
#[derive(Clone)]
pub struct IpcMounter {
    pub link: Arc<Link>,
    pub footage_root: PathBuf,
    pub timeout: Duration,
}

impl IpcMounter {
    pub fn new(link: Arc<Link>, footage_root: impl Into<PathBuf>) -> Self {
        IpcMounter { link, footage_root: footage_root.into(), timeout: MOUNT_TIMEOUT }
    }

    async fn ask(&self, op: &str, payload: Value) -> Value {
        let mut msg = json!({ "type": "mount-request", "op": op });
        if let (Value::Object(m), Value::Object(p)) = (&mut msg, payload) {
            m.extend(p);
        }
        match self.link.request(msg, "mount-result", self.timeout).await {
            Ok(m) => m.get("result").cloned().unwrap_or(Value::Null),
            Err(RequestError::Timeout) => json!({ "code": -1, "timedOut": true, "output": "The supervisor did not answer." }),
            Err(RequestError::Send(e)) => json!({ "code": -1, "output": format!("No connection to the supervisor: {e}") }),
        }
    }
}

impl Mounter for IpcMounter {
    fn mount<'a>(&'a self, id: &'a str, smb: &'a Value) -> BoxFuture<'a, Result<Value, MountError>> {
        Box::pin(async move {
            let id = check_id_str(id)?;
            Ok(self.ask("mount", json!({ "id": id, "smb": smb })).await)
        })
    }
    fn unmount<'a>(&'a self, id: &'a str, lazy: bool) -> BoxFuture<'a, Result<Value, MountError>> {
        Box::pin(async move {
            let id = check_id_str(id)?;
            Ok(self.ask("unmount", json!({ "id": id, "lazy": lazy })).await)
        })
    }
    fn forget<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Value, MountError>> {
        Box::pin(async move {
            let id = check_id_str(id)?;
            Ok(self.ask("forget", json!({ "id": id })).await)
        })
    }
    fn target(&self, id: &str) -> Result<PathBuf, MountError> {
        Ok(self.footage_root.join(check_id_str(id)?))
    }
}

/// `delete process.env.MALLOC_ARENA_MAX` at the top of server/index.js: the
/// image sets it for the server processes (glibc reads it at start); ffmpeg
/// started from the app keeps glibc's default, which encodes a little faster.
/// Call first thing in the app's main, before threads.
pub fn drop_malloc_arena_max() {
    std::env::remove_var("MALLOC_ARENA_MAX");
}

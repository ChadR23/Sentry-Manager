//! A port of `server/mounter.js`: mounting and unmounting SMB shares.
//!
//!   `LocalMounter`  runs mount.cifs itself; used by the root supervisor (and
//!                   by the app when it runs as root, e.g. in tests)
//!   `IpcMounter`    (in `link.rs`) used by the unprivileged app: asks the
//!                   supervisor over the IPC channel
//!   `serve_mount_request` the supervisor side of that channel
//!
//! The mount point is always <footageRoot>/<vehicle id> and is derived here,
//! never taken from the caller, so a request cannot mount over /etc or /data.

use super::js::{js_string, utf16_len};
use super::proc::{self, RunResult};
use super::spec::{credentials_text, mount_args, SmbError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How commands are run: `proc::run` by default, a fake in tests.
pub type Runner = Arc<dyn Fn(String, Vec<String>, Duration) -> BoxFuture<'static, RunResult> + Send + Sync>;

pub fn default_runner() -> Runner {
    Arc::new(|cmd, args, timeout| Box::pin(async move { proc::run(&cmd, &args, timeout, proc::MAX_OUTPUT).await }))
}

/// A refused or failed request (Node's thrown errors and their `code`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountError {
    /// 'Invalid vehicle id.' (INVALID_ID)
    InvalidId,
    /// Bad SMB settings (INVALID_SMB, status 400): the message is for the user.
    Smb(SmbError),
    /// The mount point is not a plain directory (BAD_MOUNTPOINT).
    BadMountpoint(String),
    /// Anything else (a file system error); only logged.
    Io(String),
}

impl MountError {
    pub fn code(&self) -> Option<&'static str> {
        match self {
            MountError::InvalidId => Some("INVALID_ID"),
            MountError::Smb(_) => Some(SmbError::CODE),
            MountError::BadMountpoint(_) => Some("BAD_MOUNTPOINT"),
            MountError::Io(_) => None,
        }
    }
    pub fn message(&self) -> String {
        match self {
            MountError::InvalidId => "Invalid vehicle id.".into(),
            MountError::Smb(e) => e.0.clone(),
            MountError::BadMountpoint(dir) => format!("{dir} is not a plain directory."),
            MountError::Io(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for MountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

fn io<'a>(what: &str, p: &'a Path) -> impl FnOnce(std::io::Error) -> MountError + 'a {
    let what = what.to_string();
    move |e| MountError::Io(format!("{what} '{}': {e}", p.display()))
}

/// ID_RE: `^[a-z0-9][a-z0-9-]{0,39}$` on `String(id)`.
pub fn id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 40 && matches!(b[0], b'a'..=b'z' | b'0'..=b'9') && b.iter().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `checkId(id)`: `None` is `undefined` (whose String() is a valid id, as in Node).
pub fn check_id(id: Option<&Value>) -> Result<String, MountError> {
    let s = js_string(id);
    if id_ok(&s) {
        Ok(s)
    } else {
        Err(MountError::InvalidId)
    }
}

pub fn check_id_str(id: &str) -> Result<String, MountError> {
    check_id(Some(&Value::String(id.to_string())))
}

/// `path.resolve`, lexically (the paths here are absolute).
pub fn resolve(p: &Path) -> PathBuf {
    let base = if p.is_absolute() { PathBuf::new() } else { std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")) };
    let mut out = PathBuf::from("/");
    for c in base.join(p).components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out
}

/// The same interface for both mounters. Results are the objects Node's
/// mounters resolve with (`{ code, timedOut, notFound, output }` for mount,
/// `{ code, output }` for unmount, `{ code: 0 }` for forget).
pub trait Mounter: Send + Sync {
    fn mount<'a>(&'a self, id: &'a str, smb: &'a Value) -> BoxFuture<'a, Result<Value, MountError>>;
    fn unmount<'a>(&'a self, id: &'a str, lazy: bool) -> BoxFuture<'a, Result<Value, MountError>>;
    fn forget<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Value, MountError>>;
    fn target(&self, id: &str) -> Result<PathBuf, MountError>;
}

#[derive(Clone)]
pub struct LocalMounter {
    pub footage_root: PathBuf,
    pub cred_dir: PathBuf,
    pub uid: u32,
    pub gid: u32,
    pub runner: Runner,
    /// "mount" and "umount" (found on PATH, as in Node); tests point them at fakes
    pub mount_cmd: String,
    pub umount_cmd: String,
}

impl LocalMounter {
    pub fn new(footage_root: impl Into<PathBuf>, cred_dir: impl Into<PathBuf>, uid: u32, gid: u32) -> Self {
        LocalMounter {
            footage_root: footage_root.into(),
            cred_dir: cred_dir.into(),
            uid,
            gid,
            runner: default_runner(),
            mount_cmd: "mount".into(),
            umount_cmd: "umount".into(),
        }
    }

    fn cred_file(&self, id: &str) -> Result<PathBuf, MountError> {
        Ok(self.cred_dir.join(format!("{}.cred", check_id_str(id)?)))
    }

    pub async fn mount_local(&self, id: &str, smb: &Value) -> Result<Value, MountError> {
        let dir = self.target(id)?;
        let file = self.cred_file(id)?;
        let (_, args) = mount_args(smb, &dir.to_string_lossy(), &file.to_string_lossy(), i64::from(self.uid), i64::from(self.gid)).map_err(MountError::Smb)?;
        std::fs::DirBuilder::new().recursive(true).mode(0o755).create(&dir).map_err(io("mkdir", &dir))?;
        // mount(2) follows symlinks: the mount point must be a plain directory where we expect it
        let st = std::fs::symlink_metadata(&dir).map_err(io("lstat", &dir))?;
        let real = std::fs::canonicalize(&dir).map_err(io("realpath", &dir))?;
        if !st.is_dir() || real != resolve(&dir) {
            return Err(MountError::BadMountpoint(dir.display().to_string()));
        }
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.cred_dir).map_err(io("mkdir", &self.cred_dir))?;
        std::fs::set_permissions(&self.cred_dir, std::fs::Permissions::from_mode(0o700)).map_err(io("chmod", &self.cred_dir))?;
        let text = credentials_text(smb).map_err(MountError::Smb)?;
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file).map_err(io("open", &file))?;
            f.write_all(text.as_bytes()).map_err(io("write", &file))?;
        }
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).map_err(io("chmod", &file))?;
        let res = (self.runner)(self.mount_cmd.clone(), args, Duration::from_secs(60)).await;
        let output = format!("{}\n{}", res.stderr, res.stdout)
            .split('\n')
            .filter(|l| !l.starts_with("Refer to the mount.cifs"))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(json!({
            "code": res.code,
            "timedOut": res.timed_out,
            "notFound": res.error == Some(std::io::ErrorKind::NotFound),
            "output": super::js::js_trim(&output),
        }))
    }

    pub async fn unmount_local(&self, id: &str, lazy: bool) -> Result<Value, MountError> {
        let dir = self.target(id)?.to_string_lossy().into_owned();
        let args = if lazy { vec!["-l".to_string(), dir] } else { vec![dir] };
        let res = (self.runner)(self.umount_cmd.clone(), args, Duration::from_secs(30)).await;
        Ok(json!({ "code": res.code, "output": proc::tail(&res.stderr, 2) }))
    }

    pub async fn forget_local(&self, id: &str) -> Result<Value, MountError> {
        let file = self.cred_file(id)?;
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io("rm", &file)(e)),
        }
        // and its mount point, once nothing is mounted there (an empty folder;
        // rmdir refuses anything else)
        let _ = std::fs::remove_dir(self.target(id)?);
        Ok(json!({ "code": 0 }))
    }
}

impl Mounter for LocalMounter {
    fn mount<'a>(&'a self, id: &'a str, smb: &'a Value) -> BoxFuture<'a, Result<Value, MountError>> {
        Box::pin(self.mount_local(id, smb))
    }
    fn unmount<'a>(&'a self, id: &'a str, lazy: bool) -> BoxFuture<'a, Result<Value, MountError>> {
        Box::pin(self.unmount_local(id, lazy))
    }
    fn forget<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Value, MountError>> {
        Box::pin(self.forget_local(id))
    }
    fn target(&self, id: &str) -> Result<PathBuf, MountError> {
        Ok(self.footage_root.join(check_id_str(id)?))
    }
}

/// Supervisor side: one queue per vehicle id, so one vehicle is never
/// mounted twice at once (`busy` in serveMountRequests).
/// (turn number, "the last request in line is done")
type Turn = (u64, tokio::sync::oneshot::Receiver<()>);

#[derive(Default, Clone)]
pub struct MountQueues {
    /// id -> (turn number, "the last request in line is done")
    busy: Arc<Mutex<HashMap<String, Turn>>>,
    turns: Arc<std::sync::atomic::AtomicU64>,
}

/// Answer one `mount-request` from the app with a local mounter
/// (`serveMountRequests`). Requests are rebuilt from known fields only;
/// mountSpec validates them again. `reply` gets the `mount-result` message;
/// `error_log` gets what Node logs with log.error (without the prefix).
/// Messages that are not mount requests (or have a bad requestId) are ignored.
pub fn serve_mount_request<M, R, L>(msg: &Value, mounter: Arc<M>, queues: &MountQueues, reply: R, error_log: L)
where
    M: Mounter + 'static,
    R: Fn(Value) + Send + Sync + 'static,
    L: Fn(String) + Send + Sync + 'static,
{
    if msg.get("type").and_then(Value::as_str) != Some("mount-request") {
        return;
    }
    let Some(request_id) = msg.get("requestId").and_then(Value::as_str) else { return };
    if utf16_len(request_id) > 64 {
        return;
    }
    let request_id = request_id.to_string();
    let send = move |result: Value| reply(json!({ "type": "mount-result", "requestId": request_id, "result": result }));
    let id = match check_id(msg.get("id")) {
        Ok(id) => id,
        Err(e) => return send(json!({ "code": -1, "output": e.message() })),
    };
    enum Op {
        Mount(Value),
        Unmount(bool),
        Forget,
    }
    let op_name = msg.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let op = match msg.get("op").and_then(Value::as_str) {
        Some("mount") => {
            let s = msg.get("smb").filter(|v| super::js::truthy(Some(v))).cloned().unwrap_or_else(|| json!({}));
            let mut smb = serde_json::Map::new();
            for k in ["share", "username", "password", "domain", "version", "encrypt", "port"] {
                if let Some(v) = s.as_object().and_then(|o| o.get(k)) {
                    smb.insert(k.to_string(), v.clone());
                }
            }
            Op::Mount(Value::Object(smb))
        }
        Some("unmount") => Op::Unmount(msg.get("lazy") == Some(&Value::Bool(true))),
        Some("forget") => Op::Forget,
        _ => return send(json!({ "code": -1, "output": "Unknown request." })),
    };
    // take a place in this vehicle's line now, in arrival order (Node's promise chain)
    let turn = queues.turns.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (done, done_rx) = tokio::sync::oneshot::channel::<()>();
    let prev = queues.busy.lock().unwrap().insert(id.clone(), (turn, done_rx)).map(|(_, rx)| rx);
    let busy = queues.busy.clone();
    let fut = async move {
        if let Some(prev) = prev {
            let _ = prev.await;
        }
        let out = match &op {
            Op::Mount(smb) => mounter.mount(&id, smb).await,
            Op::Unmount(lazy) => mounter.unmount(&id, *lazy).await,
            Op::Forget => mounter.forget(&id).await.map(|_| json!({ "code": 0 })),
        };
        match out {
            Ok(r) => send(r),
            Err(err) => {
                error_log(format!("{op_name} {id}: {}", err.message()));
                let output = match &err {
                    MountError::Smb(e) => e.0.clone(),
                    _ => "The mount request was refused.".to_string(),
                };
                send(json!({ "code": -1, "output": output }));
            }
        }
        let mut b = busy.lock().unwrap();
        if b.get(&id).is_some_and(|(t, _)| *t == turn) {
            b.remove(&id);
        }
        drop(b);
        let _ = done.send(());
    };
    tokio::spawn(fut);
}

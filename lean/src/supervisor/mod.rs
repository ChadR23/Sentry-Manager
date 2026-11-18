//! The container's entrypoint, and the only part that runs as root: a port of
//! `server/supervisor.js`, `server/mounter.js` and `server/mountSpec.js`.
//! The binary is `sentry-lean-supervisor` (`bin.rs`); README.md in this
//! folder has the design, the IPC messages and what is left.
//!
//! It runs the app built into the image as an unprivileged user (PUID/PGID,
//! default 1000): no capabilities, no_new_privs, no way back to root.
//!
//! What stays root, and why:
//!   - mounting SMB shares (mount.cifs needs CAP_SYS_ADMIN). The app asks over
//!     the IPC channel; requests are rebuilt from known fields and validated
//!     again (`spec.rs`), the mount point is always /footage/<id>, and every
//!     mount is nosuid,nodev,noexec.
//!   - the HTTPS certificate authority. Its key stays in /data/tls (root only);
//!     the app gets the server certificate and key, read-only.
//!   - the RAPL energy counters (root-only files), read while the app asks.
//!
//! Nothing is ever loaded from /data, so whoever can write /data cannot change
//! what runs, as root or as the app.

pub mod ctx;
pub mod dirs;
pub mod ipc;
pub mod js;
pub mod launch;
pub mod link;
pub mod mounter;
pub mod proc;
pub mod rapl;
pub mod spec;

#[cfg(test)]
mod tests;

use ctx::{AcmeHooks, Log, Tls, TlsFactory, TlsSetup};
use mounter::{serve_mount_request, LocalMounter, MountQueues};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// Everything supervisor.js reads from its environment and the machine.
#[derive(Clone, Debug)]
pub struct Config {
    /// DATA_PATH (/data)
    pub data: PathBuf,
    /// where the image's files are (APP_ROOT, /app); handed to the app as APP_ROOT
    pub image_root: PathBuf,
    /// FOOTAGE_ROOT (/footage): mount points are <footage_root>/<vehicle id>
    pub footage_root: PathBuf,
    /// RUN_DIR (/run/sentry-six-manager): root only, the SMB credentials
    pub root_run: PathBuf,
    /// SENTRY_APP_TLS_DIR (/run/sentry-app/tls): root-owned, readable by the app group
    pub app_tls: PathBuf,
    /// TLS_MODE (auto | off)
    pub tls_mode: String,
    pub tls_hostnames: String,
    pub tls_cert_file: Option<String>,
    pub tls_key_file: Option<String>,
    pub host: Option<String>,
    pub is_root: bool,
    /// PUID / PGID (1000); 0 when not a positive integer
    pub puid: u32,
    pub pgid: u32,
    /// the app's program and arguments: the `sentry-lean` beside this binary
    pub app_cmd: Vec<String>,
    pub setpriv: String,
    pub dev: PathBuf,
    pub rapl_roots: Vec<PathBuf>,
    pub restart_delay: Duration,
    pub mount_cmd: String,
    pub umount_cmd: String,
    /// the environment the app inherits (before the changes in launch.rs)
    pub env: Vec<(String, String)>,
}

fn id_env(v: Option<String>) -> u32 {
    // Number(process.env.PUID ?? 1000), then Number.isInteger and > 0
    let n = v.map(|s| js::string_to_number(&s)).unwrap_or(1000.0);
    if js::is_integer(n) && n > 0.0 && n <= f64::from(u32::MAX) {
        n as u32
    } else {
        0
    }
}

impl Config {
    pub fn from_env() -> Config {
        let get = |k: &str| std::env::var(k).ok();
        // `process.env.X || default`
        let or = |k: &str, d: &str| get(k).filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string());
        let res = |k: &str, d: &str| mounter::resolve(Path::new(&or(k, d)));
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("/usr/local/bin/sentry-lean-supervisor"));
        let app = exe.parent().unwrap_or(Path::new("/")).join("sentry-lean");
        Config {
            data: res("DATA_PATH", "/data"),
            image_root: res("APP_ROOT", "/app"),
            footage_root: res("FOOTAGE_ROOT", "/footage"),
            root_run: res("RUN_DIR", "/run/sentry-six-manager"),
            app_tls: res("SENTRY_APP_TLS_DIR", "/run/sentry-app/tls"),
            tls_mode: or("TLS_MODE", "auto").to_lowercase(),
            tls_hostnames: or("TLS_HOSTNAMES", ""),
            tls_cert_file: get("TLS_CERT_FILE").filter(|v| !v.is_empty()),
            tls_key_file: get("TLS_KEY_FILE").filter(|v| !v.is_empty()),
            host: get("HOST").filter(|v| !v.is_empty()),
            // SAFETY: getuid cannot fail
            is_root: unsafe { libc::getuid() } == 0,
            puid: id_env(get("PUID")),
            pgid: id_env(get("PGID")),
            app_cmd: vec![app.to_string_lossy().into_owned()],
            setpriv: "setpriv".into(),
            dev: PathBuf::from("/dev"),
            rapl_roots: rapl::RAPL_ROOTS.iter().map(PathBuf::from).collect(),
            restart_delay: Duration::from_secs(5),
            mount_cmd: "mount".into(),
            umount_cmd: "umount".into(),
            env: std::env::vars().collect(),
        }
    }

    /// The app runs as its own user (`separate`).
    pub fn separate(&self) -> bool {
        self.separate_as(self.is_root)
    }

    pub fn separate_as(&self, is_root: bool) -> bool {
        is_root && self.puid > 0 && self.pgid > 0
    }

    /// DATA/.supervisor: root only, who owns /data
    pub fn root_state(&self) -> PathBuf {
        self.data.join(".supervisor")
    }
}

#[derive(Default)]
struct State {
    link: Option<ipc::Sender>,
    pid: Option<i32>,
    stopping: bool,
    /// lines from before the app started wait for it (at most 100)
    early: Vec<Value>,
}

pub struct Supervisor {
    pub cfg: Config,
    state: Mutex<State>,
    tls: Mutex<Option<Arc<dyn Tls>>>,
    tls_factory: Option<TlsFactory>,
    rapl: rapl::RaplPump,
    queues: MountQueues,
    mounter: Arc<LocalMounter>,
}

/// Messages are cut to 4000 characters (UTF-16 units, as `slice(0, 4000)`).
const MAX_LOG: usize = 4000;

impl Supervisor {
    pub fn new(cfg: Config, tls_factory: Option<TlsFactory>) -> Arc<Supervisor> {
        let (uid, gid) = if cfg.separate() { (cfg.puid, cfg.pgid) } else { (0, 0) };
        let mut m = LocalMounter::new(cfg.footage_root.clone(), cfg.root_run.clone(), uid, gid);
        m.mount_cmd = cfg.mount_cmd.clone();
        m.umount_cmd = cfg.umount_cmd.clone();
        Arc::new(Supervisor {
            rapl: rapl::RaplPump::new(cfg.rapl_roots.clone()),
            cfg,
            state: Mutex::new(State::default()),
            tls: Mutex::new(None),
            tls_factory,
            queues: MountQueues::default(),
            mounter: Arc::new(m),
        })
    }

    /// Also handed to the app, so mount and certificate problems show in
    /// the Overview's Logs (lines from before the app started wait for it).
    fn forward(&self, level: &str, msg: &str) {
        let line = json!({ "type": "supervisor-log", "level": level, "message": js::utf16_slice(msg, MAX_LOG) });
        let mut s = self.state.lock().unwrap();
        match &s.link {
            Some(l) if l.connected() => {
                let _ = l.send(&line);
            }
            _ => {
                if s.early.len() < 100 {
                    s.early.push(line);
                }
            }
        }
    }

    pub fn log(&self, msg: &str) {
        println!("[supervisor] {msg}");
        self.forward("info", msg);
    }

    pub fn warn(&self, msg: &str) {
        eprintln!("[supervisor] {msg}");
        self.forward("warn", msg);
    }

    fn log_handle(self: &Arc<Self>) -> Log {
        let (a, b) = (self.clone(), self.clone());
        Log { info: Arc::new(move |m| a.log(&m)), warn: Arc::new(move |m| b.warn(&m)) }
    }

    /// Send to the app if it is connected (`child?.connected && child.send(m)`).
    pub fn tell(&self, msg: &Value) -> bool {
        let s = self.state.lock().unwrap();
        match &s.link {
            Some(l) if l.connected() => l.send(msg).is_ok(),
            _ => false,
        }
    }

    fn connected(&self) -> bool {
        self.state.lock().unwrap().link.as_ref().is_some_and(ipc::Sender::connected)
    }

    fn tls(&self) -> Option<Arc<dyn Tls>> {
        self.tls.lock().unwrap().clone()
    }

    /// Write the app's copy of the TLS files: root-owned, group-readable (0640 for the key). (`exportTls`)
    pub async fn export_tls(&self) -> Result<(), String> {
        let Some(tls) = self.tls() else { return Ok(()) };
        if !self.cfg.separate() {
            return Ok(()); // the app manages TLS itself
        }
        tls.export_for_app(self.cfg.app_tls.clone()).await?;
        dirs::own_app_tls_files(&self.cfg.app_tls, self.cfg.pgid).map_err(|e| e.to_string())
    }

    async fn setup_tls(self: &Arc<Self>) {
        if self.cfg.tls_mode == "off" || !self.cfg.separate() {
            return;
        }
        let Some(factory) = self.tls_factory.clone() else {
            self.warn("HTTPS setup failed: the certificate authority is not part of this build yet");
            return;
        };
        let setup = TlsSetup {
            dir: self.cfg.data.join("tls"),
            hostnames: self.cfg.tls_hostnames.clone(),
            cert_file: self.cfg.tls_cert_file.clone(),
            key_file: self.cfg.tls_key_file.clone(),
            host: self.cfg.host.clone(),
        };
        match factory(&setup, self.log_handle()) {
            Ok(t) => *self.tls.lock().unwrap() = Some(t),
            Err(e) => return self.warn(&format!("HTTPS setup failed: {e}")),
        }
        if let Err(e) = self.export_tls().await {
            self.warn(&format!("HTTPS setup failed: {e}"));
            *self.tls.lock().unwrap() = None;
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let day = Duration::from_secs(24 * 3600);
            loop {
                tokio::time::sleep(day).await;
                match me.export_tls().await {
                    Ok(()) => {
                        me.tell(&json!({ "type": "tls-updated" }));
                    }
                    Err(e) => me.warn(&format!("certificate renewal failed: {e}")),
                }
            }
        });
    }

    /// Let's Encrypt runs here, next to the TLS directory; the app only answers
    /// the check with the tokens it is sent, and reloads on tls-updated.
    fn start_acme(self: &Arc<Self>) {
        let Some(tls) = self.tls() else { return };
        if !tls.has_acme() {
            return;
        }
        let (a, b, c) = (self.clone(), self.clone(), self.clone());
        tls.start_acme(AcmeHooks {
            delay: Duration::from_secs(3),
            publish: Arc::new(move |token, key| {
                a.tell(&json!({ "type": "acme-challenge", "token": token, "keyAuthorization": key }));
            }),
            unpublish: Arc::new(move |token| {
                b.tell(&json!({ "type": "acme-challenge-done", "token": token }));
            }),
            on_change: Arc::new(move |cert_changed| {
                let me = c.clone();
                tokio::spawn(async move {
                    match me.export_tls().await {
                        Ok(()) => {
                            if cert_changed {
                                me.tell(&json!({ "type": "tls-updated" }));
                            }
                        }
                        Err(e) => me.warn(&format!("exporting the certificate failed: {e}")),
                    }
                });
            }),
        });
    }

    /// A message from the app (only served when the supervisor is root).
    fn handle(self: &Arc<Self>, msg: Value, link: ipc::Sender) {
        let reply_link = link.clone();
        let me = self.clone();
        serve_mount_request(
            &msg,
            self.mounter.clone(),
            &self.queues,
            move |m| {
                if reply_link.connected() {
                    let _ = reply_link.send(&m);
                }
            },
            move |m| me.warn(&m),
        );
        let ty = msg.get("type").and_then(Value::as_str);
        // the app can only ask for readings (they stop by themselves)
        if ty == Some("rapl") {
            if msg.get("on") == Some(&Value::Bool(true)) {
                let me = self.clone();
                self.rapl.on(move |m| match m {
                    None => me.connected(),
                    Some(m) => me.tell(m),
                });
            }
            return;
        }
        if ty != Some("tls-hostnames") {
            return;
        }
        let Some(request_id) = msg.get("requestId").and_then(Value::as_str).map(str::to_string) else { return };
        let Some(tls) = self.tls() else { return };
        let me = self.clone();
        tokio::spawn(async move {
            let list: Vec<String> = match msg.get("hostnames") {
                Some(Value::Array(a)) => a.iter().take(20).map(|v| js::js_string(Some(v))).collect(),
                _ => Vec::new(),
            };
            let names = tls.parse_hostnames(&list.join(","));
            let out = match tls.set_hostnames(names).await {
                Ok(ca_replaced) => me.export_tls().await.map(|()| ca_replaced),
                Err(e) => Err(e),
            };
            let reply = match out {
                Ok(ca) => json!({ "type": "tls-result", "requestId": request_id, "caReplaced": ca }),
                Err(e) => json!({ "type": "tls-result", "requestId": request_id, "error": e }),
            };
            if me.connected() {
                me.tell(&reply);
            }
        });
    }

    /// Start the app (`launch`).
    fn launch(self: &Arc<Self>) -> std::io::Result<tokio::process::Child> {
        let cfg = &self.cfg;
        let separate = cfg.separate();
        self.log(&format!("starting the app{}", if separate { format!(" as {}:{}", cfg.puid, cfg.pgid) } else { String::new() }));
        let setpriv = separate && launch::has_setpriv(&cfg.setpriv);
        let facts = launch::Facts {
            is_root: cfg.is_root,
            tls: self.tls().is_some(),
            setpriv,
            groups: if setpriv { launch::device_groups(&cfg.dev, cfg.pgid) } else { Vec::new() },
            drop_bounding_set: setpriv && launch::can_drop_bounding_set(),
        };
        let plan = launch::plan(cfg, cfg.env.clone(), &facts);
        if let Some(w) = &plan.warning {
            self.warn(w);
        }
        // only what the image holds runs: never a program from /data
        let app = cfg.app_cmd.first().map(|a| mounter::resolve(Path::new(a)));
        if app.as_ref().is_none_or(|a| a.starts_with(&cfg.data)) {
            return Err(std::io::Error::other("the app program must come from the image, not from the data folder"));
        }
        let (mine, theirs) = ipc::socketpair()?;
        let mut cmd = tokio::process::Command::new(&plan.program);
        cmd.args(&plan.args)
            .env_clear()
            .envs(&plan.env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .current_dir("/");
        if let Some((uid, gid)) = plan.uid_gid {
            cmd.uid(uid).gid(gid);
        }
        let fd = ipc::raw(&theirs);
        // SAFETY: install_child_fd only calls dup2/fcntl, which are async-signal-safe
        unsafe {
            cmd.pre_exec(move || ipc::install_child_fd(fd));
        }
        let child = cmd.spawn()?;
        drop(theirs);
        let (sender, mut incoming) = ipc::open(mine)?;
        {
            let mut s = self.state.lock().unwrap();
            s.pid = child.id().map(|p| p as i32);
            s.link = Some(sender.clone());
            for line in s.early.drain(..) {
                let _ = sender.send(&line);
            }
        }
        // a restarted app gets the Let's Encrypt tokens still waiting for their check
        if let Some(tls) = self.tls() {
            for (token, key) in tls.acme_pending() {
                let _ = sender.send(&json!({ "type": "acme-challenge", "token": token, "keyAuthorization": key }));
            }
        }
        let me = self.clone();
        let is_root = cfg.is_root;
        tokio::spawn(async move {
            while let Some(msg) = incoming.recv().await {
                if is_root {
                    me.handle(msg, sender.clone());
                }
            }
        });
        Ok(child)
    }

    /// SIGTERM / SIGINT: stop the app with the same signal (or ask it over the
    /// channel when that is not allowed), then exit with its code. Returns
    /// true when there is no app to wait for.
    fn on_signal(&self, sig: i32) -> bool {
        let mut s = self.state.lock().unwrap();
        s.stopping = true;
        let Some(pid) = s.pid else { return true };
        // SAFETY: kill with a pid we started
        if unsafe { libc::kill(pid, sig) } != 0 {
            // no CAP_KILL for a different uid: ask over IPC instead
            if let Some(l) = s.link.as_ref().filter(|l| l.connected()) {
                let _ = l.send(&json!({ "type": "shutdown" }));
            }
        }
        false
    }

    /// The whole life of the supervisor; returns the exit code.
    /// `signals` carries SIGTERM and SIGINT (bin.rs), or what a test sends.
    pub async fn run(self: Arc<Self>, mut signals: mpsc::UnboundedReceiver<i32>) -> i32 {
        {
            let log = |m: String| self.log(&m);
            let warn = |m: String| self.warn(&m);
            if let Err(e) = dirs::prepare_dirs(&self.cfg, &log, &warn) {
                self.warn(&format!("could not prepare folders: {e}"));
            }
        }
        self.setup_tls().await;
        let mut signals_open = true;
        let mut first = true;
        loop {
            let child = match self.launch() {
                Ok(c) => Some(c),
                Err(e) => {
                    self.warn(&format!("could not start the app: {e}"));
                    None
                }
            };
            if first {
                first = false;
                self.start_acme();
            }
            let mut exit: Option<std::process::ExitStatus> = None;
            if let Some(mut child) = child {
                exit = loop {
                    tokio::select! {
                        st = child.wait() => break st.ok(),
                        sig = signals.recv(), if signals_open => match sig {
                            Some(sig) => { self.on_signal(sig); }
                            None => signals_open = false,
                        },
                    }
                };
            }
            let stopping = {
                let mut s = self.state.lock().unwrap();
                s.pid = None;
                if let Some(l) = s.link.take() {
                    l.disconnect();
                }
                s.stopping
            };
            self.rapl.off();
            use std::os::unix::process::ExitStatusExt;
            let code = exit.and_then(|e| e.code());
            if stopping {
                return code.unwrap_or(0);
            }
            let why = match (code, exit.and_then(|e| e.signal())) {
                (Some(c), _) => c.to_string(),
                (None, Some(sig)) => launch::signal_name(sig),
                (None, None) => "not started".to_string(),
            };
            self.warn(&format!("server exited ({why}); restarting in {} s", self.cfg.restart_delay.as_secs()));
            let wait = tokio::time::sleep(self.cfg.restart_delay);
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    _ = &mut wait => break,
                    sig = signals.recv(), if signals_open => match sig {
                        // no app right now: exit at once
                        Some(sig) => if self.on_signal(sig) { return 0 },
                        None => signals_open = false,
                    },
                }
            }
        }
    }
}

/// Docker's HEALTHCHECK without Node: GET http://127.0.0.1:PORT/healthz,
/// healthy on a 2xx answer (`r.ok`).
pub fn healthcheck(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(5)));
    if s.write_all(format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    if s.read_exact(&mut head).is_err() {
        return false;
    }
    head.starts_with(b"HTTP/1.") && head[8] == b' ' && head[9] == b'2'
}

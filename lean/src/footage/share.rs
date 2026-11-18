//! Keeps a vehicle's footage share available (a port of server/share.js).
//! An SMB vehicle is mounted through the supervisor's mounter
//! (ctx::Mounter), watched every 30 s and remounted when the NAS drops; a
//! folder vehicle is only health-checked. The write check proves the share
//! takes every step a save needs, on two files of its own; a share mounted
//! read-only (the mount table says so, or EROFS) is not written at all.

use super::ctx::{Ctx, Level, MountResult, Mounter};
use super::js::now;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHECK_INTERVAL_MS: f64 = 30.0 * 1000.0;
const WRITE_CHECK_INTERVAL_MS: f64 = 10.0 * 60.0 * 1000.0;
pub const FS_TIMEOUT: Duration = Duration::from_secs(15);
const NETWORK_FS: [&str; 6] = ["cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs"];

/// Run `f` on a thread of its own, giving up after `ms` (share.js withTimeout): the
/// answer, or the time-out error ("<what> timed out after 15s (share not responding)").
pub fn with_timeout<T: Send + 'static>(limit: Duration, what: &str, f: impl FnOnce() -> std::io::Result<T> + Send + 'static) -> std::io::Result<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(limit) {
        Ok(r) => r,
        Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("{what} timed out after {}s (share not responding)", limit.as_secs()))),
    }
}

fn unescape_mount_path(p: &str) -> String {
    let b = p.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() + 0 && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            out.push(((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0')) as u8);
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mount {
    pub mount_point: String,
    pub fs_type: String,
    pub source: String,
    pub options: String,
    pub mount_options: String,
}

fn fields(line: &str) -> Option<(Vec<&str>, Vec<&str>)> {
    let sep = line.find(" - ")?;
    Some((line[..sep].split(' ').collect(), line[sep + 3..].split(' ').collect()))
}

/// findMount: the topmost mount at exactly `mount_point`, from /proc/self/mountinfo text.
pub fn find_mount(mountinfo: &str, mount_point: &str) -> Option<Mount> {
    let mut found = None;
    for line in mountinfo.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Some((left, right)) = fields(line) else { continue };
        if unescape_mount_path(left.get(4).unwrap_or(&"")) != mount_point {
            continue;
        }
        found = Some(Mount {
            mount_point: mount_point.to_string(),
            fs_type: right.first().unwrap_or(&"").to_string(),
            source: unescape_mount_path(right.get(1).unwrap_or(&"")),
            options: right.get(2).unwrap_or(&"").to_string(),
            mount_options: left.get(5).unwrap_or(&"").to_string(),
        });
    }
    found
}

/// onReadOnlyMount: whether `p` lies on a read-only mount (the topmost mount holding it,
/// read-only in its own options or its file system's).
pub fn on_read_only_mount(mountinfo: &str, p: &str) -> bool {
    let mut best: Option<(String, String, String)> = None;
    for line in mountinfo.split('\n') {
        let Some((left, right)) = fields(line) else { continue };
        let point = unescape_mount_path(left.get(4).unwrap_or(&""));
        let prefix = if point.ends_with('/') { point.clone() } else { format!("{point}/") };
        if point.is_empty() || !(p == point || p.starts_with(&prefix)) {
            continue;
        }
        if best.as_ref().map_or(true, |b| point.len() >= b.0.len()) {
            best = Some((point, left.get(5).unwrap_or(&"").to_string(), right.get(2).unwrap_or(&"").to_string()));
        }
    }
    let ro = |o: &str| o.split(',').any(|x| x == "ro");
    best.is_some_and(|(_, own, sup)| ro(&own) || ro(&sup))
}

fn mount_code(s: &str) -> Option<i64> {
    let at = s.find("mount error(")? + "mount error(".len();
    let end = s[at..].find(')')?;
    let d = &s[at..at + end];
    (!d.is_empty() && d.bytes().all(|c| c.is_ascii_digit())).then(|| d.parse().ok()).flatten()
}

fn has_ci(s: &str, words: &[&str]) -> bool {
    let l = s.to_lowercase();
    words.iter().any(|w| l.contains(&w.to_lowercase()))
}

/// explainMountError: mount.cifs output in words a person can act on.
pub fn explain_mount_error(output: &str) -> Option<&'static str> {
    let code = mount_code(output);
    let c = |n: i64| code == Some(n);
    if has_ci(output, &["unknown filesystem type", "No such device", "cifs filesystem not supported"]) || c(19) {
        return Some("The Docker host kernel has no CIFS support. On the host run: sudo modprobe cifs (and install cifs-utils).");
    }
    if c(1) || has_ci(output, &["Operation not permitted", "only root", "Unable to apply new capability set"]) {
        return Some("The container is not allowed to mount. Add cap_add: [SYS_ADMIN, DAC_READ_SEARCH] (see docker-compose.yml).");
    }
    if c(13) || has_ci(output, &["Permission denied"]) {
        return Some("Permission denied: the server rejected the user name or password (check them and the Domain field), or on AppArmor hosts (Ubuntu) the container needs security_opt: apparmor:unconfined.");
    }
    if c(2) {
        return Some("The share was not found on the server. It must look like //server/share (optionally //server/share/folder).");
    }
    if c(112) {
        return Some("Server unreachable, or it does not speak SMB 3. Check the address; on the NAS, set the minimum SMB version to SMB 3 (SMB 1/2 are not allowed here).");
    }
    if c(95) || c(5) {
        return Some("The server refused an encrypted SMB 3 session. On the NAS turn on SMB 3 encryption (Synology: Control Panel > File Services > SMB > Advanced; Samba: server smb encrypt = desired), or pick SMB 3.0 if it does not offer 3.1.1. Turning encryption off for this vehicle keeps signing, but lets others on the network see the footage.");
    }
    if c(22) {
        return Some("The server rejected a mount option. If the NAS does not support SMB 3.1.1, choose SMB 3.0 for this vehicle.");
    }
    if c(113) || c(111) || c(110) || has_ci(output, &["timed out", "No route", "refused"]) {
        return Some("Could not reach the SMB server. Check the IP/hostname and that port 445 is open from the Docker host.");
    }
    if has_ci(output, &["resolve", "bad UNC", "could not resolve"]) {
        return Some("Could not resolve the server name. Use the NAS IP address in SMB_SHARE (//192.168.1.10/share).");
    }
    if c(16) {
        return Some("Mount point is busy (something is already mounted there).");
    }
    None
}

/// proc.js tail: the last meaningful lines, joined with " | ".
pub fn tail(text: &str, lines: usize) -> String {
    let clean: Vec<String> = text
        .split('\n')
        .map(|l| {
            // drop "[name @ 0x55bc...]" prefixes
            let mut s = l.to_string();
            while let (Some(a), Some(z)) = (s.find('['), s.find(']')) {
                if z > a && s[a..z].contains(" @ 0x") {
                    s = format!("{}{}", &s[..a], s[z + 1..].trim_start());
                } else {
                    break;
                }
            }
            s.trim().to_string()
        })
        .filter(|l| !l.is_empty())
        .collect();
    clean[clean.len().saturating_sub(lines)..].join(" | ")
}

const WRITE_STEPS: [(&str, &str); 6] = [
    ("write", "writing a file"),
    ("sync", "saving a file to disk"),
    ("rename", "replacing a file by renaming another over it"),
    ("utime", "setting a file's date"),
    ("read", "reading a file back"),
    ("remove", "deleting a file"),
];

fn write_hint(step: &str) -> Option<&'static str> {
    match step {
        "write" => Some("The NAS account has read-only access to this share: give it write access (and check PUID/PGID)."),
        "rename" => Some("The NAS refuses to rename a file over another. On a Mac sharing the folder, or with Samba's \"vfs objects\" such as fruit or recycle, renames over a file can be refused."),
        "utime" => Some("The NAS does not let this account change file dates, which keeps an original's date when it is replaced. Give the account full control of the share (on Windows/NTFS: Modify, or \"Write attributes\")."),
        "remove" => Some("The NAS account can create files but not delete them: give it delete rights on the share."),
        _ => None,
    }
}

fn step_words(step: &str) -> &'static str {
    WRITE_STEPS.iter().find(|(k, _)| *k == step).map_or("", |(_, w)| w)
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteCheck {
    pub ok: bool,
    /// the words of the step that failed
    pub step: Option<String>,
    pub error: Option<String>,
    pub hint: Option<String>,
    pub rename_overwrite: Option<bool>,
}

/// Node's error message for a failed file call: "<CODE>: <text>, <call> '<path>'".
fn node_message(e: &std::io::Error, call: &str, path: &Path) -> String {
    match e.raw_os_error() {
        Some(n) => {
            let code = errno_name(n);
            let text = std::io::Error::from_raw_os_error(n).to_string();
            let text = text.split(" (os error").next().unwrap_or(&text).to_lowercase();
            format!("{code}: {text}, {call} '{}'", path.display())
        }
        None => e.to_string(),
    }
}

pub fn errno_name(n: i32) -> &'static str {
    match n {
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EROFS => "EROFS",
        libc::ENOENT => "ENOENT",
        libc::ENOTDIR => "ENOTDIR",
        libc::EEXIST => "EEXIST",
        libc::ENOSPC => "ENOSPC",
        libc::EIO => "EIO",
        libc::EBUSY => "EBUSY",
        libc::EXDEV => "EXDEV",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::EINVAL => "EINVAL",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::EHOSTDOWN => "EHOSTDOWN",
        _ => "EIO",
    }
}

/// checkWritable: every step of a real save in `root`, on two files that are removed again.
pub fn check_writable(root: &Path) -> WriteCheck {
    let root = root.to_path_buf();
    let state = Arc::new(Mutex::new(("write", None::<bool>)));
    let s2 = state.clone();
    let r2 = root.clone();
    let res = with_timeout(FS_TIMEOUT, "Write test", move || {
        use std::io::Write;
        let a = r2.join(".sentry-six-manager-check-a");
        let b = r2.join(".sentry-six-manager-check-b");
        let set = |step: &'static str| s2.lock().unwrap().0 = step;
        let fail = |e: std::io::Error, call: &str, p: &Path| std::io::Error::new(e.kind(), node_message(&e, call, p));
        std::fs::write(&a, "old").map_err(|e| fail(e, "open", &a))?;
        let mut fh = std::fs::File::create(&b).map_err(|e| fail(e, "open", &b))?;
        fh.write_all(b"new")?;
        set("sync");
        fh.sync_all()?;
        drop(fh);
        set("rename");
        if std::fs::rename(&b, &a).is_ok() {
            s2.lock().unwrap().1 = Some(true);
        } else {
            s2.lock().unwrap().1 = Some(false);
            set("remove");
            std::fs::remove_file(&a).map_err(|e| fail(e, "unlink", &a))?;
            set("rename");
            std::fs::rename(&b, &a).map_err(|e| fail(e, "rename", &b))?;
        }
        set("utime");
        let when = std::time::UNIX_EPOCH + Duration::from_secs(1_577_836_800);
        std::fs::File::options().write(true).open(&a).and_then(|f| f.set_times(std::fs::FileTimes::new().set_accessed(when).set_modified(when))).map_err(|e| fail(e, "utime", &a))?;
        set("read");
        if std::fs::read_to_string(&a).map_err(|e| fail(e, "open", &a))? != "new" {
            return Err(std::io::Error::other("what was read back differs from what was written"));
        }
        set("remove");
        std::fs::remove_file(&a).map_err(|e| fail(e, "unlink", &a))?;
        Ok(())
    });
    let (step, rename_overwrite) = *state.lock().unwrap();
    match res {
        Ok(()) => WriteCheck { ok: true, step: None, error: None, hint: None, rename_overwrite },
        Err(e) => {
            let _ = std::fs::remove_file(root.join(".sentry-six-manager-check-a"));
            let _ = std::fs::remove_file(root.join(".sentry-six-manager-check-b"));
            let msg = e.to_string();
            let denied = msg.starts_with("EACCES") || msg.starts_with("EPERM") || msg.starts_with("EROFS");
            WriteCheck {
                ok: false,
                step: Some(step_words(step).to_string()),
                error: Some(msg),
                hint: if denied || step != "write" { write_hint(step).map(String::from) } else { None },
                rename_overwrite,
            }
        }
    }
}

/// (free, total) bytes of the file system holding p (fsSpace.js diskSpace).
pub fn disk_space(p: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((s.f_bavail as u64 * s.f_frsize as u64, s.f_blocks as u64 * s.f_frsize as u64))
}

#[derive(Debug, Clone, Default)]
pub struct ShareState {
    pub healthy: bool,
    pub mounted: bool,
    pub fs_type: Option<String>,
    pub source: Option<String>,
    pub readable: bool,
    pub writable: Option<bool>,
    pub read_only: bool,
    pub rename_overwrite: Option<bool>,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub last_error: Option<String>,
    pub hint: Option<String>,
    pub warning: Option<String>,
    pub checked_at: Option<f64>,
    pub write_checked_at: Option<f64>,
    pub mounted_at: Option<f64>,
}

struct Inner {
    st: ShareState,
    mounted_by_us: bool,
    failures: u32,
    next_mount_at: f64,
    backoff_ms: f64,
    read_only_now: bool,
}

pub enum ShareEvent {
    Status,
    Health(bool),
}

pub type Events = Box<dyn Fn(&str, ShareEvent) + Send + Sync>;

pub struct Share {
    pub id: String,
    pub root: PathBuf,
    /// the normalized SMB source; None for a folder vehicle
    pub smb: Option<Value>,
    mountinfo: PathBuf,
    mounter: Option<Arc<dyn Mounter>>,
    ctx: Arc<dyn Ctx>,
    inner: Mutex<Inner>,
    /// one mount or check at a time (share.js queue)
    work: Mutex<()>,
    stopped: AtomicBool,
    events: Events,
}

fn ms_or_null(x: Option<f64>) -> Value {
    x.map_or(Value::Null, |t| json!(t as i64))
}

impl Share {
    pub fn new(id: &str, root: PathBuf, smb: Option<Value>, ctx: Arc<dyn Ctx>, mountinfo: PathBuf, events: Events) -> Arc<Share> {
        let mounter = ctx.mounter();
        Arc::new(Share {
            id: id.to_string(),
            root,
            smb,
            mountinfo,
            mounter,
            ctx,
            inner: Mutex::new(Inner { st: ShareState::default(), mounted_by_us: false, failures: 0, next_mount_at: 0.0, backoff_ms: CHECK_INTERVAL_MS, read_only_now: false }),
            work: Mutex::new(()),
            stopped: AtomicBool::new(false),
            events,
        })
    }

    fn smb_mode(&self) -> bool {
        self.smb.is_some()
    }

    fn log(&self, level: Level, line: &str) {
        self.ctx.log(&format!("share:{}", self.id), level, line);
    }

    /// The first check (with a write check), then one every 30 s on a thread of its own.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || {
            me.ensure(true);
            loop {
                for _ in 0..(CHECK_INTERVAL_MS as u64 / 250) {
                    if me.stopped.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                me.ensure(false);
            }
        });
    }

    fn current_mount(&self) -> Option<Mount> {
        match std::fs::read_to_string(&self.mountinfo) {
            Ok(info) => {
                let root = self.root.to_string_lossy();
                self.inner.lock().unwrap().read_only_now = on_read_only_mount(&info, &root);
                find_mount(&info, &root)
            }
            Err(_) => {
                self.inner.lock().unwrap().read_only_now = false;
                None
            }
        }
    }

    pub fn ensure(&self, force_write_check: bool) -> Value {
        let _w = self.work.lock().unwrap();
        let mut force = force_write_check;
        let mount = self.current_mount();
        if self.smb_mode() {
            let is_smb = mount.as_ref().is_some_and(|m| m.fs_type == "cifs" || m.fs_type == "smb3");
            if !is_smb && now() >= self.inner.lock().unwrap().next_mount_at {
                let ok = self.mount();
                force = force || ok;
            }
        }
        self.check_health(force);
        if self.smb_mode() {
            let (mounted, readable) = {
                let i = self.inner.lock().unwrap();
                (i.st.mounted, i.st.readable)
            };
            if mounted && !readable {
                let again = {
                    let mut i = self.inner.lock().unwrap();
                    i.failures += 1;
                    i.failures >= 2 && now() >= i.next_mount_at
                };
                if again {
                    self.log(Level::Warn, "Share stopped responding; remounting.");
                    self.unmount(true);
                    if self.mount() {
                        self.check_health(true);
                    }
                }
                return self.status();
            }
        }
        if self.inner.lock().unwrap().st.readable {
            self.inner.lock().unwrap().failures = 0;
        }
        self.status()
    }

    pub fn reconnect(&self) -> Value {
        let _w = self.work.lock().unwrap();
        {
            let mut i = self.inner.lock().unwrap();
            i.next_mount_at = 0.0;
            i.backoff_ms = CHECK_INTERVAL_MS;
        }
        if self.smb_mode() {
            self.unmount(true);
            self.mount();
        }
        self.check_health(true);
        self.status()
    }

    fn mount(&self) -> bool {
        let smb = self.smb.clone().unwrap_or(Value::Null);
        let s = |k: &str| smb.get(k).map(super::js::string).unwrap_or_else(|| "undefined".into());
        self.log(Level::Info, &format!("Mounting {} at {} (SMB {}, {}, user {})", s("share"), self.root.display(), s("version"),
            if smb.get("encrypt") == Some(&Value::Bool(false)) { "signed" } else { "encrypted" }, s("username")));
        let res = match &self.mounter {
            Some(m) => m.mount(&self.id, &smb),
            None => MountResult { code: -1, output: "An SMB vehicle needs a mounter.".into(), ..Default::default() },
        };
        if res.code == 0 {
            let mut i = self.inner.lock().unwrap();
            i.mounted_by_us = true;
            i.backoff_ms = CHECK_INTERVAL_MS;
            i.next_mount_at = 0.0;
            i.st.mounted_at = Some(now());
            i.st.last_error = None;
            i.st.hint = None;
            drop(i);
            self.log(Level::Info, &format!("Mounted {}", s("share")));
            return true;
        }
        let message = if res.not_found {
            "mount command not found (cifs-utils is missing from the image).".to_string()
        } else if res.timed_out {
            "mount timed out (server not answering on port 445?)".to_string()
        } else {
            let t = tail(&res.output, 3);
            if t.is_empty() { format!("mount exited with {}", res.code) } else { t }
        };
        self.fail(&format!("Mount failed: {message}"), explain_mount_error(&res.output).map(String::from));
        let mut i = self.inner.lock().unwrap();
        i.next_mount_at = now() + i.backoff_ms;
        i.backoff_ms = (i.backoff_ms * 2.0).min(10.0 * 60.0 * 1000.0);
        false
    }

    fn unmount(&self, lazy: bool) {
        if !self.smb_mode() || self.current_mount().is_none() {
            return;
        }
        if let Some(m) = &self.mounter {
            let res = m.unmount(&self.id, lazy);
            if res.code != 0 {
                self.log(Level::Warn, &format!("umount failed: {}", if res.output.is_empty() { res.code.to_string() } else { res.output }));
            }
        }
        self.inner.lock().unwrap().mounted_by_us = false;
    }

    fn fail(&self, message: &str, hint: Option<String>) {
        let mut i = self.inner.lock().unwrap();
        if i.st.last_error.as_deref() != Some(message) {
            self.log(Level::Error, &format!("{message}{}", hint.as_ref().map_or(String::new(), |h| format!(" Hint: {h}"))));
        }
        i.st.last_error = Some(message.to_string());
        i.st.hint = hint;
    }

    fn check_health(&self, force_write_check: bool) {
        let mount = self.current_mount();
        {
            let mut i = self.inner.lock().unwrap();
            i.st.mounted = mount.is_some();
            i.st.fs_type = mount.as_ref().map(|m| m.fs_type.clone()).filter(|t| !t.is_empty());
            i.st.source = mount.as_ref().map(|m| m.source.clone()).filter(|t| !t.is_empty());
            i.st.checked_at = Some(now());
            i.st.warning = None;
        }
        let root = self.root.clone();
        let listed = with_timeout(FS_TIMEOUT, "Listing the share", move || std::fs::read_dir(&root).map(drop));
        let local = !self.smb_mode();
        if let Err(e) = listed {
            let mounted = {
                let mut i = self.inner.lock().unwrap();
                i.st.readable = false;
                i.st.writable = None;
                i.st.mounted
            };
            if local && e.kind() == std::io::ErrorKind::NotFound {
                self.fail(&format!("{} does not exist.", self.root.display()), Some(format!("Mount your footage at this path (volumes: - /path/to/TeslaCam:/footage) or set SMB_SHARE.")));
            } else if local || mounted {
                let msg = if e.kind() == std::io::ErrorKind::TimedOut { e.to_string() } else { node_message(&e, "scandir", &self.root) };
                self.fail(&format!("Cannot read {}: {msg}", self.root.display()), None);
            }
            self.update_healthy();
            return;
        }
        let mounted = {
            let mut i = self.inner.lock().unwrap();
            i.st.readable = true;
            if local && !i.st.mounted {
                i.st.warning = Some(format!("Nothing is mounted at {0}, so the manager is looking at the container's own disk. Set SMB_SHARE or add a volume for {0}.", self.root.display()));
            }
            i.st.mounted
        };
        if !local && !mounted {
            // readable but our mount is gone: the container's empty folder is not the share
            self.inner.lock().unwrap().st.readable = false;
            self.update_healthy();
            return;
        }
        let root = self.root.clone();
        let space = with_timeout(FS_TIMEOUT, "Reading free space", move || disk_space(&root));
        let due = {
            let mut i = self.inner.lock().unwrap();
            match space {
                Ok((free, total)) => {
                    i.st.total_bytes = Some(total);
                    i.st.free_bytes = Some(free);
                }
                Err(_) => {
                    i.st.total_bytes = None;
                    i.st.free_bytes = None;
                }
            }
            force_write_check || i.st.writable.is_none() || now() - i.st.write_checked_at.unwrap_or(0.0) > WRITE_CHECK_INTERVAL_MS
        };
        if due {
            self.write_check();
        }
        {
            let mut i = self.inner.lock().unwrap();
            if i.st.writable != Some(false) || i.st.read_only {
                i.st.last_error = None;
                i.st.hint = None;
            }
        }
        self.update_healthy();
    }

    fn write_check(&self) {
        let ro_now = {
            let mut i = self.inner.lock().unwrap();
            i.st.write_checked_at = Some(now());
            i.read_only_now
        };
        if ro_now {
            self.read_only(&format!("{} is mounted read-only", self.root.display()));
            return;
        }
        let r = check_writable(&self.root);
        if r.ok {
            let was = {
                let mut i = self.inner.lock().unwrap();
                if r.rename_overwrite.is_some() {
                    i.st.rename_overwrite = r.rename_overwrite;
                }
                let was = i.st.writable;
                i.st.writable = Some(true);
                i.st.read_only = false;
                was
            };
            if was == Some(false) {
                self.log(Level::Info, "Share is writable again.");
            }
            return;
        }
        if r.rename_overwrite.is_some() {
            self.inner.lock().unwrap().st.rename_overwrite = r.rename_overwrite;
        }
        // a read-only file system the mount table did not show (an NFS export, say): the same
        if r.step.as_deref() == Some(step_words("write")) && r.error.as_deref().unwrap_or("").contains("EROFS") {
            self.read_only(&format!("{} is on a read-only file system", self.root.display()));
            return;
        }
        {
            let mut i = self.inner.lock().unwrap();
            i.st.writable = Some(false);
            i.st.read_only = false;
        }
        self.fail(&format!("Share is not writable: {} failed ({})", r.step.unwrap_or_default(), r.error.unwrap_or_default()), r.hint);
    }

    fn read_only(&self, why: &str) {
        let was = {
            let mut i = self.inner.lock().unwrap();
            let was = i.st.read_only;
            i.st.read_only = true;
            i.st.writable = Some(false);
            i.st.last_error = None;
            i.st.hint = None;
            was
        };
        if !was {
            self.log(Level::Info, &format!("{why}: footage is only read (the Recycle Bin, Protect, cleanup and replacing originals are off)."));
        }
    }

    fn update_healthy(&self) {
        let changed = {
            let mut i = self.inner.lock().unwrap();
            let prev = i.st.healthy;
            i.st.healthy = i.st.readable && (!self.smb.is_some() || i.st.mounted);
            (prev != i.st.healthy).then_some(i.st.healthy)
        };
        if let Some(h) = changed {
            (self.events)(&self.id, ShareEvent::Health(h));
        }
        (self.events)(&self.id, ShareEvent::Status);
    }

    pub fn state(&self) -> ShareState {
        self.inner.lock().unwrap().st.clone()
    }

    pub fn is_healthy(&self) -> bool {
        self.inner.lock().unwrap().st.healthy
    }

    pub fn is_writable(&self) -> bool {
        let i = self.inner.lock().unwrap();
        i.st.healthy && i.st.writable == Some(true)
    }

    /// share.status(): the state with `network`.
    pub fn status(&self) -> Value {
        let st = self.state();
        json!({
            "mode": if self.smb_mode() { "smb" } else { "local" },
            "share": self.smb.as_ref().and_then(|s| s.get("share")).filter(|s| s.as_str().is_some_and(|x| !x.is_empty())),
            "path": self.root.to_string_lossy(), "healthy": st.healthy, "mounted": st.mounted, "fsType": st.fs_type, "source": st.source,
            "readable": st.readable, "writable": st.writable, "readOnly": st.read_only, "renameOverwrite": st.rename_overwrite,
            "totalBytes": st.total_bytes, "freeBytes": st.free_bytes, "lastError": st.last_error, "hint": st.hint, "warning": st.warning,
            "checkedAt": ms_or_null(st.checked_at), "writeCheckedAt": ms_or_null(st.write_checked_at), "mountedAt": ms_or_null(st.mounted_at),
            "network": st.fs_type.as_deref().is_some_and(|t| NETWORK_FS.contains(&t))
        })
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        if self.inner.lock().unwrap().mounted_by_us {
            self.unmount(false);
        }
        if self.smb_mode() {
            if let Some(m) = &self.mounter {
                m.forget(&self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INFO: &str = "22 1 0:21 / / rw,relatime - overlay overlay rw\n\
        30 22 8:1 /footage /footage ro,relatime - ext4 /dev/sda1 rw\n\
        31 22 0:50 / /mnt/nas\\040share rw - cifs //nas/cam rw,vers=3.1.1\n";

    #[test]
    fn mount_table() {
        let m = find_mount(INFO, "/mnt/nas share").unwrap();
        assert_eq!((m.fs_type.as_str(), m.source.as_str()), ("cifs", "//nas/cam"));
        assert!(find_mount(INFO, "/mnt").is_none());
        assert!(on_read_only_mount(INFO, "/footage/car"));
        assert!(!on_read_only_mount(INFO, "/footagex"));
        assert!(!on_read_only_mount(INFO, "/mnt/nas share/x"));
    }

    #[test]
    fn mount_errors_and_tail() {
        assert_eq!(explain_mount_error("mount error(13): Permission denied").unwrap().split(':').next(), Some("Permission denied"));
        assert!(explain_mount_error("mount error(112): Host is down").unwrap().starts_with("Server unreachable"));
        assert!(explain_mount_error("whatever").is_none());
        assert_eq!(tail("a\n\n[h264 @ 0x55aa] b\n c \n", 2), "b | c");
    }

    #[test]
    fn write_check_on_a_folder() {
        let d = std::env::temp_dir().join(format!("lean-share-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let r = check_writable(&d);
        assert!(r.ok, "{r:?}");
        assert_eq!(r.rename_overwrite, Some(true));
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        let r = check_writable(&d.join("missing"));
        assert!(!r.ok);
        assert_eq!(r.step.as_deref(), Some("writing a file"));
        assert!(r.error.unwrap().starts_with("ENOENT: no such file or directory, open"));
        assert_eq!(r.hint, None);
    }
}

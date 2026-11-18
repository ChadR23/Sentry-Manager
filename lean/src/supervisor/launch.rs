//! How the app is started (`launch` in supervisor.js): as PUID:PGID through
//! setpriv with no capabilities, no_new_privs and the GPU device groups, or
//! with a plain setuid when setpriv is missing.

use super::Config;
use std::collections::BTreeMap;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;

/// Group ids that own the GPU device nodes, so the app can use VA-API / NVENC. (`deviceGroups`)
pub fn device_groups(dev: &Path, pgid: u32) -> Vec<u32> {
    let mut gids: Vec<u32> = Vec::new();
    for (dir, nvidia_only) in [(dev.join("dri"), false), (dev.to_path_buf(), true)] {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for n in names {
            if nvidia_only && !n.starts_with("nvidia") {
                continue;
            }
            let Ok(st) = std::fs::metadata(dir.join(&n)) else { continue }; // gone
            let group_rw = st.mode() & 0o060 == 0o060;
            let other_rw = st.mode() & 0o006 == 0o006;
            if st.file_type().is_char_device() && st.gid() != 0 && group_rw && !other_rw && !gids.contains(&st.gid()) {
                gids.push(st.gid());
            }
        }
    }
    gids.retain(|g| *g != pgid);
    gids
}

/// `setpriv --version` runs? (`hasSetpriv`)
pub fn has_setpriv(setpriv: &str) -> bool {
    std::process::Command::new(setpriv)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Dropping the bounding set needs CAP_SETPCAP (bit 8) in our effective set. (`canDropBoundingSet`)
pub fn can_drop_bounding_set() -> bool {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else { return false };
    status
        .lines()
        .find_map(|l| l.strip_prefix("CapEff:"))
        .and_then(|v| u64::from_str_radix(v.trim(), 16).ok())
        .is_some_and(|eff| eff & (1 << 8) != 0)
}

/// What to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    /// the whole environment of the app
    pub env: BTreeMap<String, String>,
    /// plain setuid/setgid (no setpriv)
    pub uid_gid: Option<(u32, u32)>,
    pub warning: Option<String>,
}

pub struct Facts {
    pub is_root: bool,
    pub tls: bool,
    pub setpriv: bool,
    pub groups: Vec<u32>,
    pub drop_bounding_set: bool,
}

/// The command line and environment for the app.
pub fn plan(cfg: &Config, env: impl IntoIterator<Item = (String, String)>, f: &Facts) -> LaunchPlan {
    let mut env: BTreeMap<String, String> = env.into_iter().collect();
    env.insert("APP_ROOT".into(), cfg.image_root.to_string_lossy().into_owned());
    env.remove("UI_PASSWORD_FILE");
    for k in ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"] {
        env.remove(k);
    }
    // the channel to the supervisor (Node: NODE_CHANNEL_FD)
    env.insert(super::ipc::FD_ENV.into(), super::ipc::CHILD_FD.to_string());
    let (app, app_args) = cfg.app_cmd.split_first().map(|(a, r)| (a.clone(), r.to_vec())).unwrap_or_default();
    let mut out = LaunchPlan { program: app.clone(), args: app_args.clone(), env, uid_gid: None, warning: None };
    if cfg.separate_as(f.is_root) {
        out.env.insert("SENTRY_SUPERVISED".into(), "1".into());
        out.env.insert("HOME".into(), cfg.data.to_string_lossy().into_owned());
        if f.tls {
            out.env.insert("SENTRY_TLS_DIR".into(), cfg.app_tls.to_string_lossy().into_owned());
        }
        // the app never needs these, and the CA key is not its business
        out.env.remove("TLS_KEY_FILE");
        out.env.remove("TLS_CERT_FILE");
        if f.setpriv {
            let mut args = vec![
                format!("--reuid={}", cfg.puid),
                format!("--regid={}", cfg.pgid),
                if f.groups.is_empty() { "--clear-groups".to_string() } else { format!("--groups={}", f.groups.iter().map(u32::to_string).collect::<Vec<_>>().join(",")) },
                "--inh-caps=-all".into(),
                "--ambient-caps=-all".into(),
            ];
            if f.drop_bounding_set {
                args.push("--bounding-set=-all".into());
            }
            args.push("--no-new-privs".into());
            args.push("--".into());
            args.push(app);
            args.extend(app_args);
            out.program = cfg.setpriv.clone();
            out.args = args;
        } else {
            out.warning = Some("setpriv is missing; dropping privileges with plain setuid (no supplementary groups, no no_new_privs).".into());
            out.uid_gid = Some((cfg.puid, cfg.pgid));
        }
    } else if f.is_root {
        out.warning = Some("PUID is 0: the app runs as root. Set PUID/PGID to a normal user id so a bug in the web app cannot become root.".into());
    }
    out
}

/// A signal's name, for "server exited (SIGKILL)".
pub fn signal_name(sig: i32) -> String {
    let n = match sig {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGSYS => "SIGSYS",
        _ => return format!("signal {sig}"),
    };
    n.to_string()
}

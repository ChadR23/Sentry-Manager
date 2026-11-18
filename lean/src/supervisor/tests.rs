//! Ports of the supervisor, mounter and mount spec tests in test/
//! (security.test.js, share.test.js, server.test.js), plus the Rust side's
//! own: the IPC channel, the launch plan, restarts and signals. Nothing real
//! is ever mounted: mount and umount are fakes (a runner, or a script).

use super::ctx::{AcmeHooks, Log, Tls, TlsSetup};
use super::link::{IpcMounter, Link};
use super::mounter::{serve_mount_request, BoxFuture, LocalMounter, MountQueues, Mounter, Runner};
use super::proc::RunResult;
use super::*;
use serde_json::{json, Value};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static N: AtomicUsize = AtomicUsize::new(0);

/// A fresh folder, 0755 so the app user can reach what is in it.
fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sup-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
    d
}

fn is_root() -> bool {
    // SAFETY: getuid cannot fail
    unsafe { libc::getuid() == 0 }
}

fn script(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

type Calls = Arc<Mutex<Vec<Vec<String>>>>;

/// A runner that records each call and answers `code`, checking the
/// credentials file while "mount" runs (as share.test.js does).
fn fake_runner(calls: Calls, code: i32, stderr: &'static str) -> Runner {
    Arc::new(move |cmd: String, args: Vec<String>, _t: Duration| {
        let calls = calls.clone();
        Box::pin(async move {
            let mut c = vec![cmd.clone()];
            c.extend(args.iter().cloned());
            if cmd == "mount" {
                let opts: Vec<String> = args[args.iter().position(|a| a == "-o").unwrap() + 1].split(',').map(String::from).collect();
                let cred = opts.iter().find_map(|o| o.strip_prefix("credentials=")).unwrap().to_string();
                let st = std::fs::metadata(&cred).unwrap();
                assert_eq!(st.mode() & 0o777, 0o600);
                c.push(format!("CRED={}", std::fs::read_to_string(&cred).unwrap()));
            }
            calls.lock().unwrap().push(c);
            RunResult { code, stderr: stderr.to_string(), ..Default::default() }
        }) as BoxFuture<'static, RunResult>
    })
}

fn mounter_in(dir: &Path, runner: Runner) -> LocalMounter {
    let mut m = LocalMounter::new(dir.join("footage"), dir.join("run"), 1000, 1000);
    m.runner = runner;
    m
}

// share.test.js: 'SMB mode mounts the share, writes a 0600 credentials file ...' (the mounter's part)
#[tokio::test]
async fn mounts_with_fixed_options_and_a_0600_credentials_file() {
    let dir = tmp("mount");
    let calls: Calls = Default::default();
    let m = mounter_in(&dir, fake_runner(calls.clone(), 0, "mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs)\n"));
    let smb = json!({ "share": "//nas/TeslaCam", "username": "tesla", "password": "secret!", "domain": "", "version": "3.1.1", "encrypt": true });
    let r = m.mount("car", &smb).await.unwrap();
    assert_eq!(r, json!({ "code": 0, "timedOut": false, "notFound": false, "output": "mount error(13): Permission denied" }));
    let c = calls.lock().unwrap()[0].clone();
    let root = dir.join("footage/car");
    assert_eq!(&c[1..5], ["-t", "cifs", "//nas/TeslaCam", root.to_str().unwrap()]);
    let opts: Vec<&str> = c[6].split(',').collect();
    for o in ["vers=3.1.1", "sec=ntlmssp", "seal", "nosuid", "nodev", "noexec", "uid=1000", "gid=1000", "forceuid", "forcegid"] {
        assert!(opts.contains(&o), "mount option {o}");
    }
    assert!(!opts.iter().any(|o| matches!(*o, "guest" | "exec" | "suid" | "dev")));
    assert_eq!(c[7], "CRED=username=tesla\npassword=secret!\n");
    assert!(!c[..7].join(" ").contains("secret!"), "password never on the command line");
    assert!(dir.join("footage/car").is_dir());
    assert_eq!(std::fs::metadata(dir.join("run")).unwrap().mode() & 0o777, 0o700);

    let u = m.unmount("car", true).await.unwrap();
    assert_eq!(u, json!({ "code": 0, "output": "mount error(13): Permission denied | Refer to the mount.cifs(8) manual page (e.g. man mount.cifs)" }));
    assert_eq!(calls.lock().unwrap()[1], ["umount", "-l", root.to_str().unwrap()]);
    m.unmount("car", false).await.unwrap();
    assert_eq!(calls.lock().unwrap()[2], ["umount", root.to_str().unwrap()]);
    m.forget("car").await.unwrap();
    assert!(!dir.join("run/car.cred").exists() && !root.exists(), "credentials and the empty mount point are gone");
    m.forget("car").await.unwrap(); // twice is fine
    assert!(m.mount("../etc", &smb).await.is_err());
    assert!(m.target("Car").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

// security.test.js: the mount command line, through a fake mount program
#[tokio::test]
async fn the_mount_program_gets_exactly_this_command_line() {
    let dir = tmp("fakebin");
    script(&dir.join("mount"), &format!("#!/bin/sh\necho \"uid=$(id -u) $*\" >> {}/mount.log\necho 'Refer to the mount.cifs(8) manual page' >&2\necho 'mount error(112): Host is down' >&2\nexit 32\n", dir.display()));
    let mut m = LocalMounter::new(dir.join("mnt"), dir.join("run-root"), 1000, 1000);
    m.mount_cmd = dir.join("mount").to_string_lossy().into_owned();
    let r = m.mount("weekend", &json!({ "share": "//192.0.2.10/TeslaCam", "username": "tesla", "password": "pa,ss", "port": 445 })).await.unwrap();
    assert_eq!(r, json!({ "code": 32, "timedOut": false, "notFound": false, "output": "mount error(112): Host is down" }));
    let log = std::fs::read_to_string(dir.join("mount.log")).unwrap();
    let d = dir.display();
    assert_eq!(
        log,
        format!("uid={} -t cifs //192.0.2.10/TeslaCam {d}/mnt/weekend -o credentials={d}/run-root/weekend.cred,vers=3.1.1,sec=ntlmssp,seal,nosuid,nodev,noexec,uid=1000,gid=1000,forceuid,forcegid,file_mode=0660,dir_mode=0770,serverino,port=445\n", unsafe { libc::getuid() })
    );
    assert!(!log.contains("pa,ss"));
    assert_eq!(std::fs::read_to_string(dir.join("run-root/weekend.cred")).unwrap(), "username=tesla\npassword=pa,ss\n");
    // no mount.cifs at all
    m.mount_cmd = dir.join("missing").to_string_lossy().into_owned();
    let r = m.mount("weekend", &json!({ "share": "//h/s", "username": "u", "password": "p" })).await.unwrap();
    assert_eq!((r["code"].clone(), r["notFound"].clone()), (json!(-1), json!(true)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_mount_point_that_is_a_symlink_is_refused() {
    let dir = tmp("symlink");
    let calls: Calls = Default::default();
    let m = Arc::new(mounter_in(&dir, fake_runner(calls.clone(), 0, "")));
    std::fs::create_dir_all(dir.join("footage")).unwrap();
    std::fs::create_dir_all(dir.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("footage/car")).unwrap();
    let smb = json!({ "share": "//h/s", "username": "u", "password": "p" });
    let e = m.mount("car", &smb).await.unwrap_err();
    assert_eq!(e.code(), Some("BAD_MOUNTPOINT"));
    assert!(calls.lock().unwrap().is_empty());
    // the supervisor answers with the generic refusal, and logs the reason
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let logs = Arc::new(Mutex::new(Vec::new()));
    let l = logs.clone();
    serve_mount_request(&json!({ "type": "mount-request", "requestId": "a", "op": "mount", "id": "car", "smb": smb }), m.clone(), &MountQueues::default(), move |v| tx.send(v).unwrap(), move |s| l.lock().unwrap().push(s));
    assert_eq!(rx.recv().await.unwrap(), json!({ "type": "mount-result", "requestId": "a", "result": { "code": -1, "output": "The mount request was refused." } }));
    assert_eq!(logs.lock().unwrap()[0], format!("mount car: {} is not a plain directory.", dir.join("footage/car").display()));
    let _ = std::fs::remove_dir_all(&dir);
}

async fn serve(m: Arc<LocalMounter>, q: &MountQueues, msg: Value) -> Option<Value> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    serve_mount_request(&msg, m, q, move |v| tx.send(v).unwrap(), |_| {});
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.ok().flatten()
}

// serveMountRequests: requests rebuilt from known fields, validated again
#[tokio::test]
async fn the_supervisor_answers_only_well_formed_requests() {
    let dir = tmp("serve");
    let calls: Calls = Default::default();
    let m = Arc::new(mounter_in(&dir, fake_runner(calls.clone(), 0, "")));
    let q = MountQueues::default();
    let r = |v: Value| json!({ "type": "mount-result", "requestId": "x", "result": v });
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x", "op": "mount", "id": "../etc" })).await, Some(r(json!({ "code": -1, "output": "Invalid vehicle id." }))));
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x", "op": "chmod", "id": "car" })).await, Some(r(json!({ "code": -1, "output": "Unknown request." }))));
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x", "op": "mount", "id": "car", "smb": { "share": "//h/s,exec", "username": "u", "password": "p" } })).await, Some(r(json!({ "code": -1, "output": "The share or folder name has characters a share cannot use (commas, quotes, \\ or control characters)." }))));
    // ignored: not a request, no id, a long id
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount", "requestId": "x", "op": "mount", "id": "car" })).await, None);
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": 5, "op": "forget", "id": "car" })).await, None);
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x".repeat(65), "op": "forget", "id": "car" })).await, None);
    // a number is an id too (String(5)), as in Node
    assert_eq!(serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x", "op": "forget", "id": 5 })).await, Some(r(json!({ "code": 0 }))));
    // extra fields never reach mount: options, a credentials path, lazy as a string
    let ok = serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x", "op": "mount", "id": "car", "smb": { "share": "//h/s", "username": "u", "password": "p", "options": "exec,suid", "credentials": "/etc/shadow" } })).await.unwrap();
    assert_eq!(ok["result"]["code"], 0);
    let c = calls.lock().unwrap().last().unwrap().clone();
    assert!(!c.join(" ").contains("exec,suid") && !c.join(" ").contains("shadow"));
    serve(m.clone(), &q, json!({ "type": "mount-request", "requestId": "x", "op": "unmount", "id": "car", "lazy": "yes" })).await.unwrap();
    assert_eq!(calls.lock().unwrap().last().unwrap().len(), 2, "lazy only when true");
    let _ = std::fs::remove_dir_all(&dir);
}

// one vehicle is never mounted twice at once; others go ahead
#[tokio::test]
async fn requests_for_one_vehicle_run_one_after_another_in_order() {
    let dir = tmp("queue");
    let active = Arc::new(AtomicUsize::new(0));
    let order = Arc::new(Mutex::new(Vec::new()));
    let (a, o) = (active.clone(), order.clone());
    let runner: Runner = Arc::new(move |_cmd, args: Vec<String>, _t| {
        let (a, o) = (a.clone(), o.clone());
        Box::pin(async move {
            assert_eq!(a.fetch_add(1, Ordering::SeqCst), 0, "never two at once");
            tokio::time::sleep(Duration::from_millis(30)).await;
            o.lock().unwrap().push(args.len());
            a.fetch_sub(1, Ordering::SeqCst);
            RunResult::default()
        }) as BoxFuture<'static, RunResult>
    });
    let m = Arc::new(mounter_in(&dir, runner));
    let q = MountQueues::default();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    for (i, lazy) in [true, false, true, false].iter().enumerate() {
        let tx = tx.clone();
        serve_mount_request(&json!({ "type": "mount-request", "requestId": i.to_string(), "op": "unmount", "id": "car", "lazy": lazy }), m.clone(), &q, move |v| tx.send(v).unwrap(), |_| {});
    }
    let mut ids = Vec::new();
    for _ in 0..4 {
        ids.push(rx.recv().await.unwrap()["requestId"].as_str().unwrap().to_string());
    }
    assert_eq!(ids, ["0", "1", "2", "3"]);
    assert_eq!(*order.lock().unwrap(), [2, 1, 2, 1]);
    let _ = std::fs::remove_dir_all(&dir);
}

// createIpcMounter <-> serveMountRequests over the channel
#[tokio::test]
async fn the_app_mounts_through_the_supervisor() {
    let dir = tmp("ipc");
    let calls: Calls = Default::default();
    let m = Arc::new(mounter_in(&dir, fake_runner(calls.clone(), 0, "")));
    let (app_end, sup_end) = ipc::socketpair().unwrap();
    let link = Arc::new(Link::open(app_end).unwrap());
    let (sup_tx, mut sup_rx) = ipc::open(sup_end).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let server = tokio::spawn(async move {
        let q = MountQueues::default();
        while let Some(msg) = sup_rx.recv().await {
            s2.lock().unwrap().push(msg.clone());
            let tx = sup_tx.clone();
            serve_mount_request(&msg, m.clone(), &q, move |v| tx.send(&v).unwrap(), |_| {});
        }
    });
    let im = IpcMounter::new(link.clone(), dir.join("footage"));
    let smb = json!({ "share": "//nas/TeslaCam", "username": "tesla", "password": "pw" });
    assert_eq!(im.mount("car", &smb).await.unwrap(), json!({ "code": 0, "timedOut": false, "notFound": false, "output": "" }));
    assert_eq!(im.unmount("car", true).await.unwrap(), json!({ "code": 0, "output": "" }));
    assert_eq!(im.forget("car").await.unwrap(), json!({ "code": 0 }));
    assert!(im.mount("Bad Id", &smb).await.is_err(), "checked before asking");
    assert_eq!(im.target("car").unwrap(), dir.join("footage/car"));
    let msgs = seen.lock().unwrap().clone();
    let keys: Vec<Vec<&str>> = msgs.iter().map(|m| m.as_object().unwrap().keys().map(String::as_str).collect()).collect();
    assert_eq!(keys, [vec!["type", "requestId", "op", "id", "smb"], vec!["type", "requestId", "op", "id", "lazy"], vec!["type", "requestId", "op", "id"]]);
    let id = msgs[0]["requestId"].as_str().unwrap();
    assert_eq!((id.len(), &id[14..15]), (36, "4"), "a v4 uuid");
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_silent_or_missing_supervisor_is_an_answer_too() {
    let (app_end, sup_end) = ipc::socketpair().unwrap();
    let link = Arc::new(Link::open(app_end).unwrap());
    let mut im = IpcMounter::new(link.clone(), "/footage");
    im.timeout = Duration::from_millis(100);
    let smb = json!({ "share": "//h/s", "username": "u", "password": "p" });
    assert_eq!(im.mount("car", &smb).await.unwrap(), json!({ "code": -1, "timedOut": true, "output": "The supervisor did not answer." }));
    drop(sup_end);
    tokio::time::timeout(Duration::from_secs(5), link.disconnected()).await.expect("disconnect seen");
    assert_eq!(im.forget("car").await.unwrap(), json!({ "code": -1, "output": "No connection to the supervisor: Channel closed" }));
}

fn base_cfg(dir: &Path) -> Config {
    let mut c = Config::from_env();
    c.data = dir.join("data");
    c.image_root = PathBuf::from("/app");
    c.footage_root = dir.join("mnt");
    c.root_run = dir.join("run-root");
    c.app_tls = dir.join("run-app/tls");
    c.tls_mode = "auto".into();
    c.puid = 1000;
    c.pgid = 1000;
    c.dev = dir.join("dev");
    c.rapl_roots = vec![dir.join("powercap")];
    c.restart_delay = Duration::from_millis(200);
    c.env = vec![("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into())];
    c
}

#[test]
fn the_launch_plan_drops_privileges_and_cleans_the_environment() {
    let dir = tmp("plan");
    let mut cfg = base_cfg(&dir);
    cfg.app_cmd = vec!["/usr/local/bin/sentry-lean".into()];
    let env: Vec<(String, String)> = ["PATH=/bin", "LD_PRELOAD=/x.so", "LD_LIBRARY_PATH=/x", "LD_AUDIT=/x", "UI_PASSWORD_FILE=/run/secrets/p", "TLS_KEY_FILE=/k", "TLS_CERT_FILE=/c", "MALLOC_ARENA_MAX=2", "APP_ROOT=/data/evil", "HOME=/root"]
        .iter()
        .map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).unwrap())
        .collect();
    let f = |setpriv, groups: Vec<u32>, drop| launch::Facts { is_root: true, tls: true, setpriv, groups, drop_bounding_set: drop };
    let p = launch::plan(&cfg, env.clone(), &f(true, vec![44, 109], true));
    assert_eq!(p.program, "setpriv");
    assert_eq!(p.args, ["--reuid=1000", "--regid=1000", "--groups=44,109", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", "/usr/local/bin/sentry-lean"]);
    let keys: Vec<&str> = p.env.keys().map(String::as_str).collect();
    assert_eq!(keys, ["APP_ROOT", "HOME", "MALLOC_ARENA_MAX", "PATH", "SENTRY_SUPERVISED", "SENTRY_SUPERVISOR_FD", "SENTRY_TLS_DIR"]);
    assert_eq!(p.env["APP_ROOT"], "/app");
    assert_eq!(p.env["HOME"], cfg.data.to_str().unwrap());
    assert_eq!(p.env["SENTRY_SUPERVISOR_FD"], "3");
    assert_eq!(p.env["SENTRY_TLS_DIR"], cfg.app_tls.to_str().unwrap());
    assert_eq!((p.uid_gid, p.warning.clone()), (None, None));
    let p = launch::plan(&cfg, env.clone(), &f(true, vec![], false));
    assert_eq!(&p.args[..6], ["--reuid=1000", "--regid=1000", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"]);
    let p = launch::plan(&cfg, env.clone(), &f(false, vec![], false));
    assert_eq!((p.program.as_str(), p.uid_gid), ("/usr/local/bin/sentry-lean", Some((1000, 1000))));
    assert!(p.warning.unwrap().starts_with("setpriv is missing"));
    // PUID 0: as root, with a warning; not "supervised", TLS files kept
    cfg.puid = 0;
    let p = launch::plan(&cfg, env.clone(), &f(true, vec![], true));
    assert_eq!(p.program, "/usr/local/bin/sentry-lean");
    assert!(p.warning.unwrap().starts_with("PUID is 0: the app runs as root."));
    assert!(!p.env.contains_key("SENTRY_SUPERVISED") && p.env.contains_key("TLS_KEY_FILE") && !p.env.contains_key("LD_PRELOAD"));
    // not root at all: no warning
    let p = launch::plan(&cfg, env, &launch::Facts { is_root: false, tls: false, setpriv: false, groups: vec![], drop_bounding_set: false });
    assert_eq!(p.warning, None);
    assert_eq!(launch::signal_name(9), "SIGKILL");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn ids_like_node() {
    assert_eq!(id_env(None), 1000);
    assert_eq!(id_env(Some("568".into())), 568);
    assert_eq!(id_env(Some("".into())), 0, "Number('') is 0: not separate");
    assert_eq!(id_env(Some("1e3".into())), 1000);
    assert_eq!(id_env(Some("-1".into())), 0);
    assert_eq!(id_env(Some("1.5".into())), 0);
}

#[test]
fn gpu_device_groups() {
    if !is_root() {
        return eprintln!("skipped: needs root to make device nodes");
    }
    let dir = tmp("dev");
    std::fs::create_dir_all(dir.join("dri")).unwrap();
    let mk = |p: PathBuf, mode: u32, gid: u32| {
        let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
        // SAFETY: a character device node in a test folder
        assert_eq!(unsafe { libc::mknod(c.as_ptr(), libc::S_IFCHR | mode, libc::makedev(1, 3)) }, 0);
        std::os::unix::fs::chown(&p, Some(0), Some(gid)).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    mk(dir.join("dri/renderD128"), 0o660, 109);
    mk(dir.join("dri/card0"), 0o660, 44);
    mk(dir.join("dri/card1"), 0o666, 45); // world-usable: no group needed
    mk(dir.join("dri/card2"), 0o660, 0);
    mk(dir.join("nvidia0"), 0o660, 1000); // the app's own group
    mk(dir.join("nvidiactl"), 0o660, 46);
    mk(dir.join("null2"), 0o660, 47); // not a GPU
    assert_eq!(launch::device_groups(&dir, 1000), [44, 109, 46]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn data_is_root_pgid_sticky_and_root_folders_stay_roots() {
    if !is_root() {
        return eprintln!("skipped: needs root");
    }
    let dir = tmp("dirs");
    let cfg = base_cfg(&dir);
    std::fs::create_dir_all(cfg.data.join("thumbs/a")).unwrap();
    std::fs::write(cfg.data.join("thumbs/a/x.jpg"), "x").unwrap();
    let victim = dir.join("victim");
    std::fs::write(&victim, "root's").unwrap();
    std::os::unix::fs::symlink(&victim, cfg.data.join("evil-link")).unwrap();
    // a swapped tls folder: a link to somewhere the app chose
    std::fs::create_dir_all(dir.join("planted")).unwrap();
    std::os::unix::fs::symlink(dir.join("planted"), cfg.data.join("tls")).unwrap();
    let lines = Mutex::new(Vec::new());
    let log = |m: String| lines.lock().unwrap().push(m);
    dirs::prepare_dirs(&cfg, &log, &log).unwrap();
    let st = |p: &Path| std::fs::symlink_metadata(p).unwrap();
    let data = st(&cfg.data);
    assert_eq!((data.uid(), data.gid(), data.mode() & 0o7777), (0, 1000, 0o1770));
    for d in [cfg.data.join("tls"), cfg.root_state(), cfg.root_run.clone()] {
        let s = st(&d);
        assert!(s.is_dir(), "{d:?}");
        assert_eq!((s.uid(), s.mode() & 0o777), (0, 0o700), "{d:?}");
    }
    let aside: Vec<String> = std::fs::read_dir(&cfg.data).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("tls.untrusted-")).collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(st(&cfg.data.join("thumbs/a/x.jpg")).uid(), 1000);
    assert!(st(&cfg.data.join("evil-link")).file_type().is_symlink());
    assert_eq!(std::fs::metadata(&victim).unwrap().uid(), 0, "a planted link is never followed");
    assert_eq!(std::fs::read_to_string(cfg.root_state().join("owner")).unwrap(), "1000:1000\n");
    assert_eq!(st(&cfg.root_state().join("owner")).mode() & 0o777, 0o600);
    assert_eq!(st(&cfg.footage_root).uid(), 0);
    for d in [cfg.app_tls.clone(), cfg.app_tls.parent().unwrap().to_path_buf()] {
        let s = st(&d);
        assert_eq!((s.uid(), s.gid(), s.mode() & 0o777), (0, 1000, 0o750));
    }
    let l = lines.lock().unwrap().clone();
    assert!(l.iter().any(|m| m.contains("was not a root-owned folder; moved it to")), "{l:?}");
    assert!(l.iter().any(|m| m.contains("(one time)")));
    // a second start: nothing to give away again
    lines.lock().unwrap().clear();
    dirs::prepare_dirs(&cfg, &log, &log).unwrap();
    assert!(lines.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn signals_stop_the_app_and_its_code_is_the_supervisors() {
    let dir = tmp("signal");
    let mut cfg = base_cfg(&dir);
    cfg.is_root = false;
    script(&dir.join("app"), &format!("#!/bin/sh\ntrap 'exit 5' TERM\ntouch {}/up\nwhile :; do sleep 0.05; done\n", dir.display()));
    cfg.app_cmd = vec![dir.join("app").to_string_lossy().into_owned()];
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let run = tokio::spawn(Supervisor::new(cfg, None).run(rx));
    for _ in 0..200 {
        if dir.join("up").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    tx.send(libc::SIGTERM).unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), run).await.unwrap().unwrap(), 5);
    let _ = std::fs::remove_dir_all(&dir);
}

// server.test.js: 'the supervisor only runs the app from the image, never code left in /data'
#[tokio::test]
async fn never_runs_a_program_from_data_and_a_signal_while_waiting_exits_at_once() {
    let dir = tmp("planted");
    let mut cfg = base_cfg(&dir);
    cfg.is_root = false;
    cfg.restart_delay = Duration::from_secs(30);
    std::fs::create_dir_all(&cfg.data).unwrap();
    script(&cfg.data.join("app"), &format!("#!/bin/sh\ntouch {}/PLANTED\n", dir.display()));
    cfg.app_cmd = vec![cfg.data.join("app").to_string_lossy().into_owned()];
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let run = tokio::spawn(Supervisor::new(cfg, None).run(rx));
    tokio::time::sleep(Duration::from_millis(300)).await;
    tx.send(libc::SIGINT).unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), run).await.unwrap().unwrap(), 0);
    assert!(!dir.join("PLANTED").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

struct FakeTls {
    exports: AtomicUsize,
    names: Mutex<Vec<String>>,
}

impl Tls for FakeTls {
    fn export_for_app(&self, dir: PathBuf) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.exports.fetch_add(1, Ordering::SeqCst);
            for f in ["server.crt", "server.key", "ca.crt"] {
                std::fs::write(dir.join(f), f).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
    fn parse_hostnames(&self, joined: &str) -> Vec<String> {
        joined.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect()
    }
    fn set_hostnames(&self, names: Vec<String>) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            *self.names.lock().unwrap() = names;
            Ok(true)
        })
    }
    fn has_acme(&self) -> bool {
        false
    }
    fn acme_pending(&self) -> Vec<(String, String)> {
        vec![("tok_1".into(), "tok_1.thumb".into())]
    }
    fn start_acme(&self, _hooks: AcmeHooks) {}
}

// security.test.js: 'the supervisor runs the app unprivileged and keeps mounts and the CA to itself'
#[tokio::test]
async fn runs_the_app_unprivileged_serves_its_requests_and_restarts_it() {
    let reachable = is_root()
        && std::process::Command::new("setpriv")
            .args(["--reuid", "1000", "--regid", "1000", "--clear-groups", "sh", "-c", "test -x \"$1\"", "sh", std::env::temp_dir().to_str().unwrap()])
            .status()
            .is_ok_and(|s| s.success());
    if !reachable {
        return eprintln!("skipped: needs root, setpriv, and a temp folder uid 1000 can reach");
    }
    let dir = tmp("full");
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::os::unix::fs::chown(&out, Some(1000), Some(1000)).unwrap();
    std::fs::create_dir_all(dir.join("powercap/intel-rapl:0")).unwrap();
    for (f, v) in [("energy_uj", "123456\n"), ("max_energy_range_uj", "262143328850\n"), ("name", "package-0\n")] {
        std::fs::write(dir.join("powercap/intel-rapl:0").join(f), v).unwrap();
    }
    script(&dir.join("mount"), &format!("#!/bin/sh\necho \"uid=$(id -u) $*\" >> {}/mount.log\nexit 32\n", dir.display()));
    script(
        &dir.join("app"),
        r#"#!/bin/sh
OUT="$SUP_TEST_OUT"
n=$(cat "$OUT/runs" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$OUT/runs"
cat /proc/$$/status > "$OUT/status.$n"
env | sort > "$OUT/env.$n"
wait_for() { while IFS= read -r line <&3; do case "$line" in *"$1"*) printf '%s\n' "$line"; return 0;; esac; done; return 1; }
if [ "$n" = 1 ]; then
  wait_for '"acme-challenge"' > "$OUT/acme"
  echo '{"type":"mount-request","requestId":"r1","op":"mount","id":"weekend","smb":{"share":"//192.0.2.10/TeslaCam","username":"tesla","password":"pa,ss"}}' >&3
  wait_for '"mount-result"' > "$OUT/mount"
  echo '{"type":"rapl","on":true}' >&3
  wait_for '"rapl-reading"' > "$OUT/rapl"
  echo '{"type":"tls-hostnames","requestId":"t1","hostnames":["a.example","b.example"]}' >&3
  wait_for '"tls-result"' > "$OUT/tls"
  cat "$SUP_TEST_RUN/weekend.cred" "$SUP_TEST_DATA/tls/owner" > "$OUT/peek" 2>/dev/null; echo "exit=$?" >> "$OUT/peek"
  exit 3
fi
wait_for 'server exited (3)' > "$OUT/exitlog"
trap 'exit 7' TERM
echo ready > "$OUT/ready"
while :; do sleep 0.05; done
"#,
    );
    let mut cfg = base_cfg(&dir);
    cfg.is_root = true;
    cfg.app_cmd = vec![dir.join("app").to_string_lossy().into_owned()];
    cfg.mount_cmd = dir.join("mount").to_string_lossy().into_owned();
    cfg.env.extend([
        ("SUP_TEST_OUT".to_string(), out.to_string_lossy().into_owned()),
        ("SUP_TEST_RUN".to_string(), cfg.root_run.to_string_lossy().into_owned()),
        ("SUP_TEST_DATA".to_string(), cfg.data.to_string_lossy().into_owned()),
        ("LD_PRELOAD".to_string(), "/nonexistent.so".to_string()),
        ("UI_PASSWORD_FILE".to_string(), "/run/secrets/x".to_string()),
        ("MALLOC_ARENA_MAX".to_string(), "2".to_string()),
    ]);
    let tls = Arc::new(FakeTls { exports: AtomicUsize::new(0), names: Mutex::new(Vec::new()) });
    let t2 = tls.clone();
    let factory: ctx::TlsFactory = Arc::new(move |setup: &TlsSetup, _log: Log| {
        assert!(setup.dir.ends_with("data/tls"));
        Ok(t2.clone() as Arc<dyn Tls>)
    });
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let run = tokio::spawn(Supervisor::new(cfg.clone(), Some(factory)).run(rx));
    for _ in 0..600 {
        if out.join("ready").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let read = |f: &str| std::fs::read_to_string(out.join(f)).unwrap_or_else(|_| panic!("{f} missing"));
    assert_eq!(read("ready"), "ready\n");
    tx.send(libc::SIGTERM).unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), run).await.unwrap().unwrap(), 7, "the app's exit code");

    // the app: uid 1000, no capabilities, no_new_privs (both runs)
    for n in ["1", "2"] {
        let status = read(&format!("status.{n}"));
        let field = |k: &str| status.lines().find_map(|l| l.strip_prefix(&format!("{k}:"))).unwrap().split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(field("Uid"), "1000 1000 1000 1000");
        assert_eq!(field("Gid"), "1000 1000 1000 1000");
        for k in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] {
            assert_eq!(field(k), "0000000000000000", "{k}");
        }
        assert_eq!(field("NoNewPrivs"), "1");
    }
    let env = read("env.1");
    for want in ["SENTRY_SUPERVISED=1", "SENTRY_SUPERVISOR_FD=3", "APP_ROOT=/app", "MALLOC_ARENA_MAX=2", &format!("HOME={}", cfg.data.display()), &format!("SENTRY_TLS_DIR={}", cfg.app_tls.display())] {
        assert!(env.lines().any(|l| l == want), "{want} in {env}");
    }
    assert!(!env.contains("LD_PRELOAD") && !env.contains("UI_PASSWORD_FILE"));
    // a restarted app gets the pending Let's Encrypt tokens (here: the first run)
    assert_eq!(read("acme"), "{\"type\":\"acme-challenge\",\"token\":\"tok_1\",\"keyAuthorization\":\"tok_1.thumb\"}\n");
    // the app asks, root mounts with the fixed options
    assert_eq!(read("mount"), "{\"type\":\"mount-result\",\"requestId\":\"r1\",\"result\":{\"code\":32,\"timedOut\":false,\"notFound\":false,\"output\":\"\"}}\n");
    let d = dir.display();
    assert_eq!(
        std::fs::read_to_string(dir.join("mount.log")).unwrap(),
        format!("uid=0 -t cifs //192.0.2.10/TeslaCam {d}/mnt/weekend -o credentials={d}/run-root/weekend.cred,vers=3.1.1,sec=ntlmssp,seal,nosuid,nodev,noexec,uid=1000,gid=1000,forceuid,forcegid,file_mode=0660,dir_mode=0770,serverino\n")
    );
    let cred = std::fs::metadata(cfg.root_run.join("weekend.cred")).unwrap();
    assert_eq!((cred.uid(), cred.mode() & 0o777), (0, 0o600));
    // the app cannot read root's secrets
    let peek = read("peek");
    assert!(!peek.contains("password=") && !peek.contains("exit=0"), "{peek}");
    let rapl: Value = serde_json::from_str(&read("rapl")).unwrap();
    assert_eq!(rapl["packages"], json!([{ "name": "package-0", "energyUj": 123456, "maxEnergyUj": 262143328850i64 }]));
    assert!(rapl["at"].as_i64().unwrap() > 1_700_000_000_000);
    assert_eq!(read("tls"), "{\"type\":\"tls-result\",\"requestId\":\"t1\",\"caReplaced\":true}\n");
    assert_eq!(*tls.names.lock().unwrap(), ["a.example", "b.example"]);
    assert!(tls.exports.load(Ordering::SeqCst) >= 2, "exported at start and after the name change");
    let key = std::fs::metadata(cfg.app_tls.join("server.key")).unwrap();
    let crt = std::fs::metadata(cfg.app_tls.join("server.crt")).unwrap();
    assert_eq!((key.uid(), key.gid(), key.mode() & 0o777), (0, 1000, 0o640));
    assert_eq!((crt.uid(), crt.gid(), crt.mode() & 0o777), (0, 1000, 0o644));
    // the crash was logged to the restarted app's Logs
    let exitlog: Value = serde_json::from_str(&read("exitlog")).unwrap();
    assert_eq!(exitlog, json!({ "type": "supervisor-log", "level": "warn", "message": "server exited (3); restarting in 0 s" }));
    assert_eq!(read("runs"), "2\n");
    let _ = std::fs::remove_dir_all(&dir);
}

//! The job service end to end on Tesla-like clips (needs ffmpeg with
//! libx265):
//! - conversions in place (direct and through local staging) and to a
//!   separate folder, compared with how the Node converter ran the same job
//!   (frozen in tests/fixtures/node-reference/converter-jobs.json: the job's
//!   shape, its events, each output's codec and digest, the ffmpeg runs it
//!   asked for; both sides run libx265 on one frame thread through
//!   FFMPEG_ONE_FRAME_THREAD, so the bytes are the same however busy the
//!   machine is);
//! - the crash suites (test/converterCrashReplace, converterCrashSeparate,
//!   fixtures/crashPoints.js): the converter killed with SIGKILL at each
//!   point of a conversion, started again, and the job finishes by itself
//!   with every clip converted and nothing left behind; the original is never
//!   lost.
//!
//! The clip (node-reference/job-clip.mp4: 2 s, 12 fps, 320x240 H.264 with
//! Tesla telemetry) was made by lean/parity/converterJobs.js clip.

use super::super::jobstore::{Manifest, Patch, StoreHooks};
use super::super::runtime::{Converter, RuntimeOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

fn ok(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd).args(args).output().is_ok_and(|o| o.status.success())
}

fn available() -> bool {
    ok("ffmpeg", &["-version"]) && Command::new("ffmpeg").args(["-hide_banner", "-encoders"]).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("libx265"))
}

struct Fixtures {
    dir: PathBuf,
    clip: PathBuf,
    /// the ffmpeg the converter runs: FFMPEG_ONE_FRAME_THREAD
    ffmpeg: PathBuf,
}

/// ffmpeg with libx265 on one frame thread (added to -x265-params, or given as
/// its own -x265-params before the output when the encode has none), and a
/// pool of 4 threads (the converter's pools=<usable CPUs>, run as pools=4: the
/// pool Node's frozen outputs were encoded with; its size changes the bytes,
/// so they are the same on a machine with other CPUs). It first appends the
/// arguments it was given, as they came, to "$0.args": the count, then each
/// argument, each one NUL-terminated.
const FFMPEG_ONE_FRAME_THREAD: &str = r##"#!/bin/sh
printf '%s\0' "$#" "$@" >> "$0.args"
n=$# i=0 p= codec= params=
for a do
  shift
  i=$((i + 1))
  case $p in
    -c:v) codec=$a ;;
    -x265-params) params=1; a="$(printf '%s' "$a" | sed 's/\(^\|:\)pools=[0-9]*/\1pools=4/'):frame-threads=1" ;;
  esac
  if [ "$i" = "$n" ] && [ "$codec" = libx265 ] && [ -z "$params" ]; then
    set -- "$@" -x265-params frame-threads=1
  fi
  set -- "$@" "$a"
  p=$a
done
exec ffmpeg "$@"
"##;

/// The ffmpeg runs a FFMPEG_ONE_FRAME_THREAD copy recorded, as the converter
/// asked for them, with the base folder and the random ids made alike (as
/// Node's were when they were recorded: converter-jobs.json "ffmpegCalls").
fn ffmpeg_calls(wrapper: &Path, base: &Path) -> Vec<Vec<String>> {
    let recorded = fs::read(format!("{}.args", wrapper.display())).unwrap_or_default();
    let mut parts = recorded.split(|b| *b == 0).map(|p| String::from_utf8_lossy(p).into_owned());
    let bases = [fs::canonicalize(base).unwrap(), base.to_path_buf()].map(|b| b.to_string_lossy().into_owned());
    let id = regex::Regex::new("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap();
    let mut calls = vec![];
    while let Some(n) = parts.next().filter(|n| !n.is_empty()) {
        let n: usize = n.parse().unwrap();
        calls.push(parts.by_ref().take(n).map(|a| id.replace_all(&bases.iter().fold(a, |a, b| a.replace(b.as_str(), "<base>")), "<id>").into_owned()).collect());
    }
    calls
}

fn fixtures() -> &'static Fixtures {
    static F: OnceLock<Fixtures> = OnceLock::new();
    F.get_or_init(|| {
        let dir = std::env::var("LEAN_CONVERTER_JOB_FIXTURES").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join(format!("lean-jobs-fixtures-{}", std::process::id())));
        fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        if !clip.exists() {
            fs::copy(crate::reference::dir().join("job-clip.mp4"), &clip).unwrap();
        }
        // libx265 encodes a few frames at once (frame threads), and the size it
        // gives a frame can depend on whether the frames before it are done, so
        // on a busy machine a clip now and then comes out with other bytes
        // (frames 0 and 1 the same, every frame from 2 on another size). One
        // frame thread gives the same bytes every time; Node's frozen outputs
        // and ffmpeg runs were recorded through this same script.
        // (written every time, so a folder kept with LEAN_CONVERTER_JOB_FIXTURES runs this script)
        let ffmpeg = dir.join("ffmpeg-one-frame-thread");
        fs::write(&ffmpeg, FFMPEG_ONE_FRAME_THREAD).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ffmpeg, fs::Permissions::from_mode(0o755)).unwrap();
        Fixtures { dir, clip, ffmpeg }
    })
}

const EVENT: &str = "TeslaCam/SentryClips/2026-10-20_07-44-14";

fn clip_name(i: usize) -> String {
    format!("2026-10-20_07-{:02}-00-front.mp4", 40 + i)
}

fn make_base(tag: &str, clips: usize) -> PathBuf {
    let base = fixtures().dir.join(format!("{tag}-{}", super::super::jobstore::random_uuid().unwrap()));
    let folder = base.join("footage").join(EVENT);
    fs::create_dir_all(&folder).unwrap();
    for i in 0..clips {
        fs::copy(&fixtures().clip, folder.join(clip_name(i))).unwrap();
    }
    for d in ["data", "temp", "out"] {
        fs::create_dir_all(base.join(d)).unwrap();
    }
    base
}

/// The first line of `ffmpeg -version`.
fn ffmpeg_version() -> String {
    let o = Command::new("ffmpeg").arg("-version").output().unwrap();
    String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").split(" Copyright").next().unwrap_or("").to_string()
}

fn sha(p: &Path) -> String {
    super::super::tesla_sei::hex(&Sha256::digest(fs::read(p).unwrap()))
}

fn codec_of(p: &Path) -> String {
    let o = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"]).arg(p).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn config(base: &Path, mode: &str, network: &str, concurrency: i64) -> Value {
    let root = fs::canonicalize(base.join("footage/TeslaCam")).unwrap();
    let out = fs::canonicalize(base.join("out")).unwrap();
    json!({
        "sourceRoot": root, "destinationRoot": if mode == "replace" { Value::Null } else { json!(out) },
        "codec": "h265", "profileId": "custom", "bitrateKbps": 250, "networkMode": network, "outputMode": mode,
        "includedGroups": ["RecentClips", "SavedClips", "SentryClips"], "groupOrder": ["SavedClips", "SentryClips", "RecentClips"],
        "replacementConfirmed": mode == "replace", "concurrency": concurrency, "verifyMode": "quick"
    })
}

fn open(base: &Path, ffmpeg: &str, ffprobe: &str, hooks: Option<Arc<dyn StoreHooks>>) -> Converter {
    Converter::open(RuntimeOptions {
        tune: Some(Box::new(|o| {
            o.backoff_initial_ms = 50;
            o.backoff_max_ms = 200;
        })),
        hooks,
        ..RuntimeOptions::new(fs::canonicalize(base.join("data")).unwrap(), fs::canonicalize(base.join("temp")).unwrap(), ffmpeg, ffprobe)
    })
    .unwrap()
}

/// Everything the converter may leave behind that it should not.
fn leftovers(base: &Path) -> Vec<String> {
    let mut found = vec![];
    for e in fs::read_dir(base.join("footage").join(EVENT)).unwrap() {
        let n = e.unwrap().file_name().to_string_lossy().to_string();
        if n.starts_with("TEMP-") || n.starts_with("BACKUP-") || n.starts_with(".sentry-owned-remove-") || n.starts_with(".sentry-tidy-") || n.ends_with(".partial") {
            found.push(n);
        }
    }
    fn walk(dir: &Path, base: &Path, found: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd {
            let e = e.unwrap();
            let n = e.file_name().to_string_lossy().to_string();
            if e.file_type().unwrap().is_dir() {
                walk(&e.path(), base, found);
            } else if n.ends_with(".partial") || n.starts_with(".sentry-owned-remove-") {
                found.push(e.path().strip_prefix(base).unwrap().to_string_lossy().to_string());
            }
        }
    }
    walk(&base.join("out"), base, &mut found);
    for e in fs::read_dir(base.join("temp")).unwrap() {
        let n = e.unwrap().file_name().to_string_lossy().to_string();
        if n == "sentry-six-converter" {
            for i in fs::read_dir(base.join("temp").join(&n)).unwrap() {
                found.push(format!("temp/{n}/{}", i.unwrap().file_name().to_string_lossy()));
            }
        } else if n.starts_with("sentry-six-verification-") {
            found.push(format!("temp/{n}"));
        }
    }
    found
}

fn output_of(base: &Path, mode: &str, name: &str) -> PathBuf {
    if mode == "replace" {
        base.join("footage").join(EVENT).join(name)
    } else {
        base.join("out/SentryClips/2026-10-20_07-44-14").join(name)
    }
}

fn assert_recovered(base: &Path, job: &Value, mode: &str, names: &[String], before: &[String]) {
    assert_eq!(job["state"], "completed", "finished by itself: {}", job.get("recovery").unwrap_or(&Value::Null));
    assert!(job.get("recovery").map_or(true, Value::is_null));
    for item in job["items"].as_array().unwrap() {
        assert_eq!(item["state"], "completed", "{}: {} {}", item["relativePath"], item["state"], item["resultCode"]);
        assert_eq!(item["resultCode"], "converted");
    }
    for (n, name) in names.iter().enumerate() {
        assert_eq!(codec_of(&output_of(base, mode, name)), "hevc", "{name} holds its conversion");
        if mode == "separate" {
            assert_eq!(sha(&base.join("footage").join(EVENT).join(name)), before[n], "{name}: the original is untouched");
        }
    }
    let mut now: Vec<String> = fs::read_dir(base.join("footage").join(EVENT)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    now.sort();
    assert_eq!(now, names, "only the clips are in the folder");
    assert_eq!(leftovers(base), Vec::<String>::new(), "nothing left behind");
}

fn names_and_hashes(base: &Path) -> (Vec<String>, Vec<String>) {
    let folder = base.join("footage").join(EVENT);
    let mut names: Vec<String> = fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    let hashes = names.iter().map(|n| sha(&folder.join(n))).collect();
    (names, hashes)
}


/// What two runs of the same job must share.
fn shape(job: &Value) -> Value {
    let items: Vec<Value> = job["items"].as_array().unwrap().iter().map(|i| json!({
        "id": i["id"], "state": i["state"], "kind": i["kind"], "relativePath": i["relativePath"], "resultCode": i["resultCode"],
        "eligibleVideo": i["eligibleVideo"], "attempts": i["attempts"], "encoder": i["encoder"], "group": i["group"], "eventId": i["eventId"],
    })).collect();
    json!({ "state": job["state"], "items": items, "files": job["counters"]["files"], "summaryFiles": job["summary"]["files"], "discoveryComplete": job["discoveryComplete"], "revisionAtLeast": job["revision"].as_i64().unwrap() > 5 })
}

#[test]
fn conversions_as_node_runs_them() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    for (mode, network) in [("replace", "direct"), ("replace", "staging"), ("separate", "direct")] {
        let rust_base = make_base(&format!("rust-{mode}-{network}"), 2);
        let node_base = make_base(&format!("node-{mode}-{network}"), 2);
        let (names, before) = names_and_hashes(&rust_base);
        let ffmpeg = &fixtures().ffmpeg;
        fs::write(format!("{}.args", ffmpeg.display()), "").unwrap();
        let c = open(&rust_base, ffmpeg.to_str().unwrap(), "ffprobe", None);
        let events: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let e2 = events.clone();
        c.service.subscribe(Arc::new(move |e: &Value| e2.lock().unwrap().push(e["type"].as_str().unwrap_or("").to_string())));
        c.start().unwrap();
        // (libx265 on both sides: a hardware encoder's output differs from run to run)
        let mut cfg = config(&rust_base, mode, network, 1);
        cfg["lanes"] = json!([{ "device": "cpu", "concurrency": 1 }]);
        let id = c.service.start(&cfg).unwrap();
        let job = c.service.when_idle(&id).unwrap();
        c.shutdown();
        assert_recovered(&rust_base, &job, mode, &names, &before);
        let key = |list: Vec<String>| list.into_iter().filter(|t| t != "snapshot" && t != "progress").collect::<Vec<_>>();
        let theirs = crate::reference::answer("converter-jobs", &[], &json!({ "mode": mode, "network": network }));
        assert_eq!(shape(&job), theirs["shape"], "{mode} {network}");
        // the same events, apart from how many live updates went out
        assert_eq!(json!(key(events.lock().unwrap().clone())), theirs["events"], "{mode} {network}");
        // (libx265 at a set bitrate on one frame thread, the same telemetry
        // writer: byte for byte with the same ffmpeg; another ffmpeg encodes
        // other bytes, and may be asked other things)
        let same_ffmpeg = theirs["ffmpeg"] == json!(ffmpeg_version());
        if !same_ffmpeg {
            eprintln!("note: {} is not the ffmpeg Node's outputs were made with ({}): their digests and ffmpeg runs are not compared", ffmpeg_version(), theirs["ffmpeg"]);
        }
        // the same ffmpeg runs, as each converter asked for them (before the one frame thread)
        let ran = ffmpeg_calls(&fixtures().ffmpeg, &rust_base);
        let encodes = ran.iter().filter(|c| c.windows(2).any(|w| w[0] == "-i" && w[1].starts_with("<base>/")) && c.iter().any(|a| a == "libx265")).count();
        assert_eq!(encodes, names.len(), "{mode} {network}: every clip's encode recorded: {ran:?}");
        if same_ffmpeg {
            // (libx265's pool: one thread per usable CPU, on Node's machine then and on this one now)
            let read = |p: &str| fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default();
            let pools = super::super::planner::default_x265_pools(std::env::consts::OS, super::super::planner::usable_cpus(&read));
            let node_ran = crate::reference::subst(&theirs["ffmpegCalls"], &[("pools=<cpus>".into(), format!("pools={pools}"))]);
            assert_eq!(json!(ran), node_ran, "{mode} {network}: ffmpeg as Rust and as Node ran it");
        }
        for (n, name) in names.iter().enumerate() {
            let a = output_of(&rust_base, mode, name);
            let b = &theirs["outputs"][n];
            assert_eq!(b["name"], json!(name));
            assert_eq!(json!(codec_of(&a)), b["codec"]);
            if same_ffmpeg {
                assert_eq!(json!(sha(&a)), b["sha256"], "{mode} {network} {name}: the same output as Node's");
            }
        }
        fs::remove_dir_all(&rust_base).unwrap();
        fs::remove_dir_all(&node_base).unwrap();
    }
}

// ---- the crash suites ----------------------------------------------------------

fn copy_field(item: &Value) -> &'static str {
    if item.get("ownedPaths").and_then(|o| o.get("destinationPartial")).is_some() {
        "destinationPartial"
    } else {
        "replacementCandidate"
    }
}

fn die() -> ! {
    // SAFETY: the whole process group, ffmpeg included (docker kill)
    unsafe {
        libc::kill(0, libc::SIGKILL);
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    unreachable!()
}

struct Point(String);

fn items(v: &Value) -> Vec<Value> {
    v.get("items").and_then(Value::as_array).cloned().unwrap_or_default()
}

impl StoreHooks for Point {
    fn before_write(&self, patch: &Patch, current: &Manifest) {
        let p = patch.to_value();
        let cur = current.to_value();
        let find = |id: &Value| items(&cur).into_iter().find(|e| e["id"] == *id);
        let hit = match self.0.as_str() {
            "snapshot-unrecorded" => items(&p).iter().any(|i| i["ownedArtifacts"][copy_field(i)]["state"] == "intent" && find(&i["id"]).map_or(true, |c| c["ownedArtifacts"].get(copy_field(i)).is_none())),
            "before-result" => items(&p).iter().any(|i| i["state"] == "completed" && find(&i["id"]).map_or(true, |c| c["state"] != "completed")),
            "cleanup-unrecorded" => items(&p).iter().any(|i| i["state"] == "completed" && find(&i["id"]).is_some_and(|c| c["state"] == "completed" && c["ownedPaths"].as_object().is_some_and(|o| !o.is_empty())) && i["ownedPaths"].as_object().map_or(true, |o| o.is_empty())),
            _ => false,
        };
        if hit {
            die();
        }
    }
    fn after_write(&self, next: &Manifest, previous: Option<&Manifest>) {
        let m = next.to_value();
        let prev = previous.map(|p| p.to_value()).unwrap_or(json!({ "items": [] }));
        let hit = match self.0.as_str() {
            "slot-entered" => m["replacementPhase"] == "candidate-written" || m["state"] == "copying",
            "backup-recorded" => m["replacementPhase"] == "original-backed-up",
            "final-recorded" => m["replacementPhase"] == "candidate-promoted",
            "save-recorded" => items(&m).iter().any(|i| i["ownedArtifacts"][copy_field(i)]["state"] == "intent" && i.get("replacementPhase").is_none()),
            "copy-recorded" => items(&m).iter().any(|i| {
                let s = i["ownedArtifacts"]["replacementCandidate"]["state"].as_str().or(i["ownedArtifacts"]["destinationPartial"]["state"].as_str());
                matches!(s, Some("owned") | Some("cleanup-pending")) && i.get("replacementPhase").is_none() && m["state"] != "copying"
            }),
            "after-result" => items(&m).iter().any(|i| i["state"] == "completed" && !items(&prev).iter().any(|e| e["id"] == i["id"] && e["state"] == "completed")),
            "rolled-back" => m["replacementPhase"] == "backup-restored",
            _ => false,
        };
        if hit {
            die();
        }
    }
}

fn wrapper(base: &Path, name: &str, body: &str) -> String {
    let p = base.join(format!("{name}-crash.sh"));
    fs::write(&p, format!("#!/bin/sh\n{body}\nexec {name} \"$@\"\n")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p.to_string_lossy().to_string()
}

/// The child: runs a job on LEAN_CRASH_BASE and dies at LEAN_CRASH_POINT.
#[test]
fn crash_child_entry() {
    let (Ok(base), Ok(point)) = (std::env::var("LEAN_CRASH_BASE"), std::env::var("LEAN_CRASH_POINT")) else { return };
    // SAFETY: a process group of its own, so the kill takes its ffmpeg too
    unsafe {
        libc::setpgid(0, 0);
    }
    let base = PathBuf::from(base);
    let mode = std::env::var("LEAN_CRASH_MODE").unwrap_or_else(|_| "replace".into());
    let network = std::env::var("LEAN_CRASH_NET").unwrap_or_else(|_| "direct".into());
    let concurrency: i64 = std::env::var("LEAN_CRASH_CONCURRENCY").ok().and_then(|c| c.parse().ok()).unwrap_or(1);
    let ffmpeg = if point == "encode" {
        wrapper(&base, "ffmpeg", "case \"$*\" in *-progress*) kill -9 -$(ps -o pgid= $PPID | tr -d ' ') 2>/dev/null; kill -9 $PPID; exit 1;; esac")
    } else if point == "lowered" {
        // every encode waits (the converter dies before any is let go)
        wrapper(&base, "ffmpeg", &format!("case \"$*\" in *-progress*) while [ ! -f \"{}/release\" ]; do kill -0 $PPID 2>/dev/null || exit 1; sleep 0.05; done;; esac", base.display()))
    } else {
        "ffmpeg".into()
    };
    let ffprobe = if point == "verify" { wrapper(&base, "ffprobe", "case \"$*\" in *sentry-six-verification-*) kill -9 $PPID; exit 1;; esac") } else { "ffprobe".into() };
    let no_links = std::env::var("LEAN_CRASH_NOLINKS").is_ok_and(|v| v == "1");
    let p2 = point.clone();
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    *super::super::owned::TEST_HOOK.write().unwrap() = Some(Arc::new(move |event: &str, from: &Path, to: &Path| {
        let (f, t) = (name(from), name(to));
        let to_backup = t.starts_with("BACKUP-");
        let final_move = !to_backup && t.ends_with("front.mp4");
        if event == "link-before" && no_links {
            return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no links"));
        }
        match (p2.as_str(), event) {
            ("backup-renamed", "promote-after" | "link-after") if to_backup => die(),
            ("before-final", "promote-before" | "replace-before") if final_move => die(),
            ("after-final", "promote-after" | "replace-after") if final_move => die(),
            ("quarantined", "quarantined") if f.starts_with("BACKUP-") && t.starts_with(".sentry-owned-remove-") => die(),
            ("rolled-back", "promote-before" | "replace-before") if f.starts_with("TEMP-") && t.ends_with("front.mp4") => Err(std::io::Error::from_raw_os_error(libc::EPERM)),
            _ => Ok(()),
        }
    }));
    // the points inside a file copy (crashPoints.js fsOpen)
    let p3 = point.clone();
    *super::super::fs_hook::HOOK.write().unwrap() = Some(Arc::new(move |event: &str, path: &Path| -> Option<usize> {
        let n = name(path);
        let copy = n.starts_with("TEMP-H265-") || n.ends_with(".partial");
        let staged = n.ends_with("-source.mp4");
        match (p3.as_str(), event) {
            ("temp-created", "open-new") if copy => die(),
            ("temp-torn", "write") if copy => Some(0),
            ("temp-torn", "written-part") if copy => die(),
            ("temp-complete", "copied") if copy => die(),
            ("temp-readback", "read-open") if copy => die(),
            ("staging-copy", "write") if staged => Some(0),
            ("staging-copy", "written-part") if staged => die(),
            ("writer", "truncated") if n.ends_with("-encoded.mp4") => die(),
            _ => None,
        }
    }));
    let c = open(&base, &ffmpeg, &ffprobe, Some(Arc::new(Point(point.clone()))));
    c.start().unwrap();
    let id = c.service.start(&config(&base, &mode, &network, concurrency)).unwrap();
    if point == "lowered" {
        // several encoding at once, then fewer at once (one), then the stop
        while c.service.active_encodes().len() < concurrency as usize {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        c.service.set_concurrency(&id, &json!(1)).unwrap();
        die();
    }
    c.service.when_idle(&id).unwrap();
    eprintln!("kill point not reached");
    std::process::exit(3);
}

fn crash(base: &Path, point: &str, mode: &str, network: &str, concurrency: usize, no_links: bool) -> std::process::Output {
    let exe = std::env::current_exe().unwrap();
    Command::new(exe)
        .args(["--exact", "converter::service::tests::crash_child_entry", "--nocapture", "--test-threads=1"])
        .env("LEAN_CRASH_BASE", base)
        .env("LEAN_CRASH_POINT", point)
        .env("LEAN_CRASH_MODE", mode)
        .env("LEAN_CRASH_NET", network)
        .env("LEAN_CRASH_CONCURRENCY", concurrency.to_string())
        .env("LEAN_CRASH_NOLINKS", if no_links { "1" } else { "" })
        .output()
        .unwrap()
}

fn crash_and_recover(point: &str, mode: &str, network: &str, concurrency: usize) {
    crash_and_recover_on(point, mode, network, concurrency, false)
}

fn crash_and_recover_on(point: &str, mode: &str, network: &str, concurrency: usize, no_links: bool) {
    eprintln!("kill point {point} ({mode}, {network}, {concurrency} at once)");
    let base = make_base(&format!("crash-{point}"), concurrency.max(1));
    let (names, before) = names_and_hashes(&base);
    let died = crash(&base, point, mode, network, concurrency, no_links);
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(died.status.signal(), Some(libc::SIGKILL), "the converter died at {point}: {}", String::from_utf8_lossy(&died.stderr).chars().take(600).collect::<String>());
    // nothing of the original was lost at the moment of the crash: it is at
    // its name or kept as its backup
    if mode == "replace" {
        let folder = base.join("footage").join(EVENT);
        for name in &names {
            let at_name = folder.join(name).exists();
            let backup = fs::read_dir(&folder).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("BACKUP-"));
            assert!(at_name || backup, "{point}: {name} is at its name or kept as its backup");
        }
    }
    let job = {
        let c = open(&base, "ffmpeg", "ffprobe", None);
        c.start().unwrap();
        let id = c.store.list().unwrap()[0].id().to_string();
        // (the recovery runs on its own thread; wait for it and the job)
        std::thread::sleep(std::time::Duration::from_millis(200));
        let job = c.service.when_idle(&id).unwrap();
        c.shutdown();
        job
    };
    assert_recovered(&base, &job, mode, &names, &before);
    fs::remove_dir_all(&base).unwrap();
}

/// test/converterCrashReplace, converterCrashSeparate, converterCrashParallel:
/// the points inside a file copy (and the telemetry writer)
#[test]
fn crash_inside_a_file_copy_finishes_by_itself() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    for point in ["writer", "temp-created", "temp-torn", "temp-complete", "temp-readback"] {
        crash_and_recover(point, "replace", "direct", 1);
        crash_and_recover(point, "separate", "direct", 1);
    }
    crash_and_recover("writer", "separate", "staging", 1);
    crash_and_recover("staging-copy", "replace", "staging", 1);
    crash_and_recover("writer", "replace", "staging", 1);
    // several at once through staging, one copy half written or being read back
    crash_and_recover("temp-torn", "replace", "staging", 3);
    crash_and_recover("temp-readback", "separate", "staging", 3);
    // and one at a time, in place
    crash_and_recover("temp-torn", "replace", "direct", 1);
}

/// three clips under way, lowered to one at once, then killed: all three are
/// cleaned up and converted
#[test]
fn crash_after_fewer_at_once_finishes_every_clip() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    crash_and_recover("lowered", "replace", "staging", 3);
}

const REPLACE_POINTS: [&str; 12] = ["encode", "verify", "snapshot-unrecorded", "save-recorded", "copy-recorded", "slot-entered", "backup-recorded", "final-recorded", "before-result", "after-result", "cleanup-unrecorded", "verify"];

#[test]
fn crash_replacing_originals_finishes_by_itself() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    for point in &REPLACE_POINTS[..11] {
        crash_and_recover(point, "replace", "direct", 1);
    }
}

#[test]
fn crash_in_the_moves_of_a_replacement() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    for point in ["backup-renamed", "before-final", "after-final", "quarantined", "rolled-back"] {
        crash_and_recover(point, "replace", "direct", 1);
    }
    // a share without hard links: the original moved aside, the copy moved in
    for point in ["backup-renamed", "before-final", "rolled-back"] {
        crash_and_recover_on(point, "replace", "direct", 1, true);
    }
    crash_and_recover("after-final", "replace", "staging", 1);
    crash_and_recover("before-final", "replace", "direct", 1);
}

#[test]
fn crash_through_local_staging_and_separately() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    for point in ["encode", "copy-recorded", "final-recorded"] {
        crash_and_recover(point, "replace", "staging", 1);
    }
    for point in ["encode", "verify", "save-recorded", "copy-recorded", "slot-entered", "after-result"] {
        crash_and_recover(point, "separate", "direct", 1);
    }
}

#[test]
fn crash_with_several_at_once() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    for point in ["encode", "backup-recorded", "after-result"] {
        crash_and_recover(point, "replace", "direct", 3);
    }
}

/// (These points were restarted by the Node converter while it was still
/// in the repository, each reading the other's interrupted jobs; now the
/// Rust converter restarts them. That both write the same job files is
/// checked by jobstore's parity with the frozen Node store.)
#[test]
fn crash_at_each_point_of_one_clip_finishes_by_itself() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265");
        return;
    }
    for point in ["encode", "copy-recorded", "backup-recorded", "final-recorded", "after-result"] {
        crash_and_recover(point, "replace", "direct", 1);
    }
}

// ---- test/restartResume.test.js and a cancel ------------------------------------

fn holding_probe(base: &Path) -> String {
    let b = base.to_string_lossy();
    wrapper(base, "ffprobe", &format!("case \"$*\" in *07-42-00-front*) [ -f \"{b}/released\" ] || {{ touch \"{b}/reached\"; while [ ! -f \"{b}/released\" ]; do sleep 0.05; done; }} ;; esac"))
}

fn until(mut f: impl FnMut() -> bool, ms: u64) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    while std::time::Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    false
}

#[test]
fn stopped_between_two_clips_the_job_carries_on_after_the_restart() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    let base = make_base("restart", 4);
    let probe = holding_probe(&base);
    let c = open(&base, "ffmpeg", &probe, None);
    c.start().unwrap();
    let id = c.service.start(&config(&base, "replace", "direct", 1)).unwrap();
    assert!(until(|| base.join("reached").exists(), 60_000), "the third clip is reached");
    c.shutdown();
    let stopped = c.service.get(&id).unwrap();
    assert_eq!(stopped["state"], "paused");
    assert!(stopped.get("activeItemId").map_or(true, Value::is_null), "no clip was half done");
    assert_eq!(stopped["recovery"], json!({ "fromState": "waiting", "action": "resume-queue" }));
    fs::write(base.join("released"), b"").unwrap();
    let c = open(&base, "ffmpeg", "ffprobe", None);
    c.start().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let job = c.service.when_idle(&id).unwrap();
    assert_eq!(job["state"], "completed", "no Resume or Cancel needed");
    assert_eq!(job["items"].as_array().unwrap().iter().filter(|i| i["state"] == "completed").count(), 4);
    c.shutdown();
    fs::remove_dir_all(&base).unwrap();
}

#[test]
fn a_paused_job_stays_paused_through_a_restart_and_resume_finishes_it() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    let base = make_base("paused", 4);
    let probe = holding_probe(&base);
    let c = open(&base, "ffmpeg", &probe, None);
    c.start().unwrap();
    let id = c.service.start(&config(&base, "replace", "direct", 1)).unwrap();
    assert!(until(|| base.join("reached").exists(), 60_000));
    c.service.pause(&id).unwrap();
    fs::write(base.join("released"), b"").unwrap();
    assert!(until(|| c.service.get(&id).unwrap()["state"] == "paused", 60_000), "paused");
    c.shutdown();
    let c = open(&base, "ffmpeg", "ffprobe", None);
    c.start().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(c.service.get(&id).unwrap()["state"], "paused", "still paused after the restart");
    c.service.resume(&id).unwrap();
    let job = c.service.when_idle(&id).unwrap();
    assert_eq!(job["state"], "completed");
    c.shutdown();
    // a cancel: the clips not done are cancelled, the converted ones kept
    let base2 = make_base("cancel", 4);
    let probe = holding_probe(&base2);
    let c = open(&base2, "ffmpeg", &probe, None);
    c.start().unwrap();
    let id = c.service.start(&config(&base2, "replace", "direct", 1)).unwrap();
    assert!(until(|| base2.join("reached").exists(), 60_000));
    let job = c.service.cancel(&id).unwrap();
    assert_eq!(job["state"], "cancelled");
    let states: Vec<&str> = job["items"].as_array().unwrap().iter().map(|i| i["state"].as_str().unwrap()).collect();
    assert_eq!(states, vec!["completed", "completed", "cancelled", "cancelled"]);
    assert_eq!(leftovers(&base2), Vec::<String>::new());
    c.shutdown();
    fs::remove_dir_all(&base).unwrap();
    fs::remove_dir_all(&base2).unwrap();
}

// ---- leftover BACKUP- names after a discarded job ------------------------------

/// A Recycle Bin that keeps what it is given in `<base>/bin` (the real one is footage/bin.rs).
struct SinkBin(PathBuf);

impl super::super::leftovers::OriginalsBin for SinkBin {
    fn adopt_original(&self, backup: &Path, original: &Path, dev: u64, ino: u64) -> Result<String, String> {
        use std::os::unix::fs::MetadataExt;
        let st = fs::symlink_metadata(backup).map_err(|e| e.to_string())?;
        assert_eq!((st.dev(), st.ino()), (dev, ino));
        fs::create_dir_all(&self.0).unwrap();
        fs::rename(backup, self.0.join(original.file_name().unwrap())).map_err(|e| e.to_string())?;
        Ok("sink-1".into())
    }
    fn holds(&self, _original: &Path) -> bool {
        false
    }
}

/// Killed at `point` in a replace, the job then discarded (its record set aside, as the
/// owner's Discard does), and a new replace job of the same folder run to the end.
fn discard_then_replace_again(point: &str, no_links: bool, bin: bool) -> (PathBuf, Vec<String>, Vec<String>, Value, String) {
    let base = make_base(&format!("tidy-{point}"), 1);
    let (names, before) = names_and_hashes(&base);
    let died = crash(&base, point, "replace", "direct", 1, no_links);
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(died.status.signal(), Some(libc::SIGKILL), "died at {point}: {}", String::from_utf8_lossy(&died.stderr).chars().take(600).collect::<String>());
    let backup = format!("BACKUP-{}", names[0]);
    assert!(base.join("footage").join(EVENT).join(&backup).exists(), "{point}: the crash left {backup}");
    // Discard, before anything recovers it: the record is set aside
    let jobs = fs::canonicalize(base.join("data")).unwrap().join("converter-jobs");
    let store = super::super::jobstore::JobStore::new(&jobs).unwrap();
    let old = store.list().unwrap()[0].id().to_string();
    assert!(store.discard(&old).unwrap());
    let c = Converter::open(RuntimeOptions {
        tune: Some(Box::new(|o| {
            o.backoff_initial_ms = 50;
            o.backoff_max_ms = 200;
        })),
        originals_bin: if bin { Some(Arc::new(SinkBin(base.join("bin")))) } else { None },
        ..RuntimeOptions::new(fs::canonicalize(base.join("data")).unwrap(), fs::canonicalize(base.join("temp")).unwrap(), "ffmpeg", "ffprobe")
    })
    .unwrap();
    c.start().unwrap();
    let id = c.service.start(&config(&base, "replace", "direct", 1)).unwrap();
    let job = c.service.when_idle(&id).unwrap();
    let snap = c.service.get(&id).unwrap();
    c.shutdown();
    // the job file and its journal keep their format
    for f in ["job.json", "job.journal"] {
        let text = fs::read_to_string(jobs.join(&id).join(f)).unwrap_or_default();
        assert!(!text.contains("backupCleanup"), "{f}");
    }
    let mut job = job;
    job["backupCleanup"] = snap["backupCleanup"].clone();
    (base, names, before, job, backup)
}

fn tidy_logged(needle: &str) -> usize {
    super::LOGGED.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|l| l.starts_with("[CONVERTER] BACKUP cleanup: ") && l.contains(needle)).count()
}

#[test]
fn a_discarded_jobs_leftover_backup_is_tidied_by_the_next_replace() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    // killed after the backup link (P1): the second name goes, the clip converts
    let (base, names, before, job, backup) = discard_then_replace_again("backup-renamed", false, false);
    assert_recovered(&base, &job, "replace", &names, &before);
    // (the second name, and the unfinished copy the replace had written beside the clip)
    assert_eq!(job["backupCleanup"], json!({ "removed": 2, "restored": 0, "binned": 0, "kept": 0, "keptWhy": [] }));
    assert_eq!(tidy_logged(&format!("removed the second name \"{backup}\" in \"SentryClips/2026-10-20_07-44-14/\"")), 1);
    assert_eq!(tidy_logged(&format!("removed the unfinished copy \"TEMP-H265-{}\" in \"SentryClips/2026-10-20_07-44-14/\" (H.265;", names[0])), 1);
    fs::remove_dir_all(&base).unwrap();

    // no hard links, killed after the original was moved aside (P6): it is put back and converted
    let (base, names, before, job, backup) = discard_then_replace_again("backup-renamed", true, false);
    assert_recovered(&base, &job, "replace", &names, &before);
    assert_eq!(job["backupCleanup"], json!({ "removed": 1, "restored": 1, "binned": 0, "kept": 0, "keptWhy": [] }));
    assert_eq!(tidy_logged(&format!("put the original back: \"{backup}\" -> \"{}\"", names[0])), 1);
    fs::remove_dir_all(&base).unwrap();

    // killed after the copy was renamed over the original (P3): the clip is the converted
    // copy, its original goes to the Recycle Bin
    let (base, names, before, job, backup) = discard_then_replace_again("after-final", false, true);
    assert_eq!(job["state"], "completed");
    assert_eq!(job["items"][0]["resultCode"], "already-converted", "{}", job["items"][0]);
    assert_eq!(job["backupCleanup"]["binned"], 1, "{}", job["backupCleanup"]);
    assert_eq!(sha(&base.join("bin").join(&names[0])), before[0], "the original, whole, in the bin");
    assert_eq!(codec_of(&base.join("footage").join(EVENT).join(&names[0])), "hevc");
    assert!(!base.join("footage").join(EVENT).join(&backup).exists());
    assert_eq!(tidy_logged(&format!("moved \"{backup}\" in \"SentryClips/2026-10-20_07-44-14/\" to the Recycle Bin as the original of \"{}\" (item sink-1;", names[0])), 1);
    fs::remove_dir_all(&base).unwrap();

    // the same without a Recycle Bin: kept, and the snapshot says why
    let (base, names, before, job, backup) = discard_then_replace_again("after-final", false, false);
    assert_eq!(job["backupCleanup"]["kept"], 1);
    let why = &job["backupCleanup"]["keptWhy"][0];
    assert_eq!(why["path"], format!("SentryClips/2026-10-20_07-44-14/{backup}"));
    assert!(why["why"].as_str().unwrap().contains("no Recycle Bin"), "{why}");
    assert_eq!(sha(&base.join("footage").join(EVENT).join(&backup)), before[0], "the original is kept");
    let _ = names;
    fs::remove_dir_all(&base).unwrap();
}

#[test]
fn a_backup_a_stopped_job_can_still_recover_is_left_to_it() {
    if !available() {
        eprintln!("skipped: needs ffmpeg with libx265 and node");
        return;
    }
    // killed after the backup link, not discarded: a new replace job of that folder is
    // refused while the stopped one is unfinished, and its recovery settles the name itself
    let base = make_base("tidy-owned", 1);
    let (names, before) = names_and_hashes(&base);
    crash(&base, "backup-renamed", "replace", "direct", 1, false);
    let c = open(&base, "ffmpeg", "ffprobe", None);
    let jobs = c.store.list().unwrap();
    let old = jobs[0].id().to_string();
    // its record owns the backup: the tidy keeps it
    let mut o = super::super::leftovers::Owners::default();
    o.add_manifest(&jobs[0], false);
    let folder = fs::canonicalize(base.join("footage").join(EVENT)).unwrap();
    let why = o.why(&[folder.join(&names[0])], &[folder.join(format!("BACKUP-{}", names[0]))]).unwrap();
    assert!(why.starts_with(&format!("job {old} ")), "{why}");
    c.start().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let job = c.service.when_idle(&old).unwrap();
    c.shutdown();
    assert_recovered(&base, &job, "replace", &names, &before);
    fs::remove_dir_all(&base).unwrap();
}

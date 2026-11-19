//! The job service end to end on Tesla-like clips (needs ffmpeg with
//! libx265):
//! - conversions in place (direct and through local staging) and to a
//!   separate folder, compared with how the Node converter ran the same job
//!   (frozen in tests/fixtures/node-reference/converter-jobs.json: the job's
//!   shape, its events, each output's codec and digest);
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

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

struct Fixtures {
    dir: PathBuf,
    clip: PathBuf,
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
        Fixtures { dir, clip }
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
        if n.starts_with("TEMP-") || n.starts_with("BACKUP-") || n.starts_with(".sentry-owned-remove-") || n.ends_with(".partial") {
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

/// RECORDING ONLY: the Node converter (lean/parity/converterJobs.js).
fn node_json(args: &[&str]) -> Value {
    let out = Command::new("node").arg(repo().join("lean/parity/converterJobs.js")).args(args).output().unwrap();
    assert!(out.status.success(), "node {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
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
        let c = open(&rust_base, "ffmpeg", "ffprobe", None);
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
        if crate::record::recording() {
            let helper = fixtures().dir.join("noreplace-rename");
            if !helper.exists() {
                let out = Command::new("cc").args(["-O2", "-o"]).arg(&helper).arg(repo().join("native/noreplace-rename.c")).output().unwrap();
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            }
            let theirs = node_json(&["run", node_base.to_str().unwrap(), mode, network, helper.to_str().unwrap()]);
            let node_events: Vec<String> = theirs["events"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
            let outputs: Vec<Value> = names.iter().map(|name| { let b = output_of(&node_base, mode, name); json!({ "name": name, "codec": codec_of(&b), "sha256": sha(&b) }) }).collect();
            let doc = json!({ "ffmpeg": ffmpeg_version(), "shape": shape(&theirs["job"]), "events": key(node_events), "outputs": outputs });
            crate::record::record("converter-jobs", "src/main/converter/runtime.js by lean/parity/converterJobs.js run, on job-clip.mp4, 2026-11-19", &[], &json!({ "mode": mode, "network": network }), &doc);
        }
        let theirs = crate::reference::answer("converter-jobs", &[], &json!({ "mode": mode, "network": network }));
        assert_eq!(shape(&job), theirs["shape"], "{mode} {network}");
        // the same events, apart from how many live updates went out
        assert_eq!(json!(key(events.lock().unwrap().clone())), theirs["events"], "{mode} {network}");
        // (libx265 at a set bitrate, the same telemetry writer: byte for byte
        // with the same ffmpeg; another ffmpeg encodes other bytes)
        let same_ffmpeg = theirs["ffmpeg"] == json!(ffmpeg_version());
        if !same_ffmpeg {
            eprintln!("note: {} is not the ffmpeg Node's outputs were made with ({}): their digests are not compared", ffmpeg_version(), theirs["ffmpeg"]);
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

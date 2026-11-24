//! Opt-in, generated-input memory reproduction. Run alone with --ignored --nocapture.
use super::*;
use crate::converter::runtime::{Converter, RuntimeOptions};
use crate::converter::testutil::tempdir;
use std::fs;
use std::time::{Duration, Instant};

fn clip(i: usize) -> Value {
    let rel = format!("RecentClips/2026-01-01_00-{:02}-{:02}-front.mp4", i / 60, i % 60);
    json!({"id": format!("item-{i:06}"), "state": "queued", "kind": "video", "group": "RecentClips",
        "relativePath": rel, "sourcePath": format!("/generated/TeslaCam/{rel}"),
        "sourceBytes": 40_000_000, "mtimeMs": 1760000000000i64, "attempts": 0,
        "eventId": null, "timestampKey": "2026-01-01_00-00-00", "camera": "front"})
}

fn config(root: &Path) -> Value {
    json!({"sourceRoot": root, "destinationRoot": null, "codec": "h265", "profileId": "aggressive", "networkMode": "direct",
        "outputMode": "replace", "replacementConfirmed": true, "concurrency": 6,
        "includedGroups": ["RecentClips", "SentryClips", "SavedClips"], "verifyMode": "quick", "keepOffTarget": true})
}

fn rss() -> String {
    fs::read_to_string("/proc/self/status").unwrap().lines()
        .filter(|l| l.starts_with("VmRSS:") || l.starts_with("Threads:")).collect::<Vec<_>>().join(" ")
}

#[test]
fn slow_snapshot_listener_keeps_one_delivery_and_gets_latest_update() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("temp")).unwrap();
    let mut o = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), "ffmpeg", "ffprobe");
    o.auto_timer = false;
    o.tune = Some(Box::new(|o| o.snapshot_interval_ms = 1));
    let c = Converter::open(o).unwrap();
    let rt = Runtime::new(c.store.create(json!({"id": "slow-listener", "state": "waiting", "config": config(dir.path()), "items": [clip(0)]}).as_object().unwrap()).unwrap());
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let entered = Arc::new(AtomicU64::new(0));
    let (tx, rx) = std::sync::mpsc::channel();
    let (g, n) = (gate.clone(), entered.clone());
    c.service.subscribe(Arc::new(move |e| {
        if e["type"] != "snapshot" { return; }
        n.fetch_add(1, Ordering::SeqCst);
        tx.send(e["snapshot"]["revision"].as_i64().unwrap()).unwrap();
        let (lock, cv) = &*g;
        let mut released = lock.lock().unwrap();
        while !*released { released = cv.wait(released).unwrap(); }
    }));
    c.service.queue_snapshot(&rt, false);
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 0);
    for revision in 1..=20 {
        rt.lock().manifest.top.insert("revision".into(), json!(revision));
        c.service.queue_snapshot(&rt, false);
        std::thread::sleep(Duration::from_millis(5));
    }
    let deliveries_while_blocked = entered.load(Ordering::SeqCst);
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    let until = Instant::now() + Duration::from_secs(5);
    let mut last = 0;
    while last != 20 && Instant::now() < until {
        last = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }
    assert_eq!(deliveries_while_blocked, 1, "each queued update must not retain another whole snapshot while delivery is blocked");
    assert_eq!(last, 20, "coalescing must deliver changes made during the previous delivery");
}

#[test]
fn running_job_reuses_snapshot_worker_between_updates() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("temp")).unwrap();
    let mut o = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), "ffmpeg", "ffprobe");
    o.auto_timer = false;
    o.tune = Some(Box::new(|o| o.snapshot_interval_ms = 1));
    let c = Converter::open(o).unwrap();
    let rt = Runtime::new(c.store.create(json!({"id": "worker-reuse", "state": "waiting", "config": config(dir.path()), "items": [clip(0)]}).as_object().unwrap()).unwrap());
    rt.lock().running = true;
    let (tx, rx) = std::sync::mpsc::channel();
    c.service.subscribe(Arc::new(move |e| {
        if e["type"] == "snapshot" { tx.send(std::thread::current().id()).unwrap(); }
    }));
    let mut threads = std::collections::HashSet::new();
    for _ in 0..10 {
        c.service.queue_snapshot(&rt, false);
        threads.insert(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        std::thread::sleep(Duration::from_millis(5));
    }
    rt.lock().running = false;
    assert_eq!(threads.len(), 1, "short-lived snapshot threads spread whole-job copies across allocator arenas");
}

#[test]
#[ignore = "large generated job / RSS diagnostic; run alone"]
fn memory_probe() {
    let mode = std::env::var("MEMORY_MODE").unwrap_or_else(|_| "snapshots".into());
    let count: usize = std::env::var("MEMORY_ITEMS").unwrap_or_else(|_| "40000".into()).parse().unwrap();
    let rounds: usize = std::env::var("MEMORY_ROUNDS").unwrap_or_else(|_| "300".into()).parse().unwrap();
    let dir = tempdir().unwrap();
    let root = dir.path();
    for p in ["data", "temp", "TeslaCam/RecentClips"] { fs::create_dir_all(root.join(p)).unwrap(); }
    let mut o = RuntimeOptions::new(root.join("data"), root.join("temp"), "ffmpeg", "ffprobe");
    o.auto_timer = false;
    let c = Converter::open(o).unwrap();
    let start = Instant::now();
    eprintln!("MEMORY mode={mode} items={count} rounds={rounds} pid={} root={} {}", std::process::id(), root.display(), rss());
    if mode == "encode" {
        let source = root.join("generated.mp4");
        let result = std::process::Command::new("ffmpeg").args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-threads", "1"]).arg(&source).status().unwrap();
        assert!(result.success());
        for i in 0..count {
            let date = format!("2026-01-{:02}", 1 + i / 1440);
            let folder = root.join("TeslaCam/RecentClips").join(&date);
            fs::create_dir_all(&folder).unwrap();
            fs::copy(&source, folder.join(format!("{date}_{:02}-{:02}-00-front.mp4", (i / 60) % 24, i % 60))).unwrap();
        }
        c.service.subscribe(Arc::new(|e| { if e["type"] == "snapshot" { let _ = crate::converter::ipc::sanitize_snapshot(&e["snapshot"]).unwrap(); } }));
        let id = c.service.start(&config(&root.join("TeslaCam"))).unwrap();
        let rt = c.service.runtime_of(&id).unwrap();
        while rt.lock().running && start.elapsed().as_secs() < rounds as u64 {
            std::thread::sleep(Duration::from_secs(5));
            let m = rt.manifest();
            eprintln!("MEMORY t={:.1} {} items={} done={} counters={}", start.elapsed().as_secs_f64(), rss(), m.items.len(), m.items.iter().filter(|i| i.state().is_terminal()).count(), m.get("counters").unwrap());
        }
        let stopped = Instant::now();
        c.shutdown();
        eprintln!("MEMORY shutdown_ms={} state={}", stopped.elapsed().as_millis(), c.service.get(&id).unwrap()["state"]);
    } else {
        let initial = json!({"id": "memory-job", "state": "waiting", "config": config(&root.join("TeslaCam")), "items": (0..count).map(clip).collect::<Vec<_>>(), "discoveryComplete": true});
        let rt = Runtime::new(c.store.create(initial.as_object().unwrap()).unwrap());
        rt.lock().running = true;
        drop(initial);
        let svc = if mode == "journal" {
            Service::new(Options::new(c.store.clone(), c.staging.clone(), Arc::new(tools::RealTools::new("ffmpeg", "ffprobe", c.registry.clone()))))
        } else { c.service.clone() };
        if mode == "snapshots" { svc.subscribe(Arc::new(|e| { if e["type"] == "snapshot" { let _ = crate::converter::ipc::sanitize_snapshot(&e["snapshot"]).unwrap(); } })); }
        for n in 0..rounds {
            svc.item_patch(&rt, &format!("item-{:06}", n % count), vec![("attempts", Some(json!(n % 3)))], vec![]).unwrap();
            if n % 10 == 0 { eprintln!("MEMORY t={:.1} n={n} {}", start.elapsed().as_secs_f64(), rss()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_secs(2));
        rt.lock().running = false;
        eprintln!("MEMORY final t={:.1} {}", start.elapsed().as_secs_f64(), rss());
    }
    #[cfg(target_env = "gnu")]
    unsafe { libc::malloc_trim(0); }
    eprintln!("MEMORY trimmed {}", rss());
}

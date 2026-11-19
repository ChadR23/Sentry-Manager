//! The job store: Node's rules (jobStore.js, test/journalDiscovery.test.js,
//! test/snapshotReuse.test.js) and parity with the Node store in both
//! directions (lean/parity/converterStore.js; needs node).

use super::*;
use serde_json::json;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lean-jobstore-{tag}-{}-{}", std::process::id(), random_uuid().unwrap()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn clip(i: usize) -> Value {
    let ts = format!("2026-10-{:02}_07-{:02}-00", 1 + (i % 28), i % 60);
    let rel = format!("SentryClips/{ts}/{ts}-front.mp4");
    json!({
        "id": format!("item-{:06}", i + 1), "state": "queued", "kind": "video", "group": "SentryClips", "eventId": ts,
        "relativePath": rel, "sourcePath": format!("/footage/car/TeslaCam/{rel}"), "sourceBytes": 40_000_000 + i,
        "mtimeMs": 1760000000000.0 + i as f64 * 1000.0 + 0.25, "timestampKey": ts, "camera": "front", "attempts": 0
    })
}

fn config_replace() -> Value {
    json!({
        "sourceRoot": "/footage/car/TeslaCam", "destinationRoot": null, "codec": "h265", "profileId": "balanced",
        "networkMode": "auto", "outputMode": "replace", "includedGroups": ["SavedClips", "SentryClips", "RecentClips"],
        "replacementConfirmed": true, "concurrency": 2, "verifyMode": "quick"
    })
}

fn initial(id: &str, items: Vec<Value>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("state".into(), json!("waiting"));
    m.insert("config".into(), config_replace());
    m.insert("items".into(), Value::Array(items));
    m.insert("discoveryComplete".into(), json!(true));
    m
}

fn quiet(root: &Path) -> JobStore {
    JobStore::new(root).unwrap().with_unreadable(Box::new(|_, _| {}))
}

fn changed(item: &Arc<Item>, changes: Value) -> ItemIn {
    let mut m = item.to_map();
    for (k, v) in changes.as_object().unwrap() {
        if v.is_null() {
            m.remove(k);
        } else {
            m.insert(k.clone(), v.clone());
        }
    }
    ItemIn::Raw(Value::Object(m))
}

#[test]
fn journal_appends_and_replays() {
    let root = tmp("journal");
    let store = quiet(&root);
    let created = store.create(&initial("job-a", (0..3).map(clip).collect())).unwrap();
    assert_eq!(created.revision(), 0);
    // the first change after create reads the file again: a full write
    let m1 = store.transition("job-a", Patch::new().set("state", json!("waiting"))).unwrap();
    assert!(!root.join("job-a/job.journal").exists());
    let job_json = fs::read(root.join("job-a/job.json")).unwrap();
    // later changes are journal lines; job.json is not rewritten
    let items: Vec<ItemIn> = m1.items.iter().enumerate().map(|(i, it)| if i == 1 { changed(it, json!({ "state": "processing" })) } else { ItemIn::Trusted(it.clone()) }).collect();
    let m2 = store.transition("job-a", Patch::new().set("state", json!("encoding")).set("activeItemId", json!("item-000002")).items(items)).unwrap();
    assert!(Arc::ptr_eq(&m2.items[0], &m1.items[0]) && !Arc::ptr_eq(&m2.items[1], &m1.items[1]), "unchanged clips are reused");
    let mut add = m2.items.iter().cloned().map(ItemIn::Trusted).collect::<Vec<_>>();
    add.push(ItemIn::Raw(clip(3)));
    let m3 = store.transition("job-a", Patch::new().items(add)).unwrap();
    assert_eq!(fs::read(root.join("job-a/job.json")).unwrap(), job_json);
    let journal = fs::read_to_string(root.join("job-a/job.journal")).unwrap();
    assert_eq!(journal.lines().count(), 2);
    assert!(journal.lines().nth(1).unwrap().contains("\"add\":["));
    // a fresh store sees the same job
    let again = quiet(&root).load("job-a").unwrap().unwrap();
    assert_eq!(again.to_json(), m3.to_json());
    assert_eq!(again.revision(), 3);
    // a torn last line (a crash mid-append) is ignored
    let mut f = OpenOptions::new().append(true).open(root.join("job-a/job.journal")).unwrap();
    f.write_all(b"{\"r\":4,\"top\":").unwrap();
    drop(f);
    assert_eq!(quiet(&root).load("job-a").unwrap().unwrap().to_json(), m3.to_json());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_damaged_journal_line_that_adds_clips_is_refused() {
    // test/journalDiscovery.test.js
    let root = tmp("journal-bad");
    let store = quiet(&root);
    store.create(&initial("job-b", vec![clip(0)])).unwrap();
    let m = store.transition("job-b", Patch::new()).unwrap();
    let mut items: Vec<ItemIn> = m.items.iter().cloned().map(ItemIn::Trusted).collect();
    items.push(ItemIn::Raw(clip(1)));
    store.transition("job-b", Patch::new().items(items)).unwrap();
    let file = root.join("job-b/job.journal");
    let text = fs::read_to_string(&file).unwrap();
    let mut record: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    record["add"] = json!("not a list");
    fs::write(&file, format!("{}\n", record)).unwrap();
    let err = quiet(&root).load("job-b").unwrap_err();
    assert_eq!(err.code, "CORRUPT_MANIFEST");
    // job.json is intact and kept; the journal's bytes were copied aside
    assert!(root.join("job-b/job.json").exists());
    assert!(fs::read_dir(root.join("job-b")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("job.json.corrupt-")));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refusals() {
    let root = tmp("refuse");
    let store = quiet(&root);
    // unknown and private fields
    let mut bad = initial("job-c", vec![clip(0)]);
    bad.insert("stderr".into(), json!("..."));
    assert_eq!(store.create(&bad).unwrap_err().code, "SENSITIVE_MANIFEST_DATA");
    let mut item = clip(0);
    item["telemetryPayload"] = json!("x");
    assert_eq!(store.create(&initial("job-c", vec![item])).unwrap_err().code, "SENSITIVE_MANIFEST_DATA");
    assert_eq!(store.create(&initial("CON", vec![])).unwrap_err().code, "INVALID_JOB_ID");
    assert_eq!(store.create(&initial("con", vec![])).unwrap_err().code, "INVALID_JOB_ID");
    let mut c = initial("job-c", vec![]);
    c["config"]["destinationRoot"] = json!("/out");
    assert_eq!(store.create(&c).unwrap_err().code, "INVALID_MANIFEST", "replace mode has no destination");
    let m = store.create(&initial("job-c", vec![clip(0), clip(1)])).unwrap();
    assert_eq!(store.create(&initial("job-c", vec![])).unwrap_err().code, "JOB_EXISTS");
    // a transaction state needs its clip
    assert_eq!(store.transition("job-c", Patch::new().set("state", json!("encoding"))).unwrap_err().code, "INVALID_MANIFEST");
    assert_eq!(store.transition("job-c", Patch::new().set("revision", json!(9))).unwrap_err().code, "INVALID_MANIFEST");
    assert_eq!(store.transition("job-c", Patch::new().set("password", json!(9))).unwrap_err().code, "SENSITIVE_MANIFEST_DATA");
    assert_eq!(store.transition("job-nope", Patch::new()).unwrap_err().code, "JOB_NOT_FOUND");
    // a stale save
    let mut v = m.to_value();
    v["state"] = json!("paused");
    assert_eq!(store.save(&v).unwrap_err().code, "STALE_MANIFEST_REVISION");
    v["revision"] = json!(5);
    assert_eq!(store.save(&v).unwrap().revision(), 5);
    // duplicate clips
    assert_eq!(store.transition("job-c", Patch::new().items(vec![ItemIn::Raw(clip(0)), ItemIn::Raw(clip(0))])).unwrap_err().code, "INVALID_MANIFEST");
    // a corrupt job.json is quarantined; list() skips it, the others stay
    store.create(&initial("job-d", vec![])).unwrap();
    fs::write(root.join("job-d/job.json"), b"{not json").unwrap();
    assert_eq!(store.load("job-d").unwrap_err().code, "CORRUPT_MANIFEST");
    let ids: Vec<String> = store.list().unwrap().iter().map(|m| m.id().to_string()).collect();
    assert_eq!(ids, vec!["job-c"]);
    // discard sets the job file aside
    assert!(store.discard("job-c").unwrap());
    assert!(store.load("job-c").unwrap().is_none());
    assert!(fs::read_dir(root.join("job-c")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("job.json.set-aside-")));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn frozen_items_are_reused_and_summaries_count() {
    // test/snapshotReuse.test.js: finished clips keep empty ownership and are reused
    let root = tmp("summaries");
    let store = quiet(&root);
    store.create(&initial("job-e", (0..5).map(clip).collect())).unwrap();
    let m = store.transition("job-e", Patch::new()).unwrap();
    let items: Vec<ItemIn> = m
        .items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            if i < 3 {
                changed(it, json!({ "state": "completed", "outputPath": it.str("sourcePath").unwrap(), "outputBytes": 1000, "resultCode": "converted", "ownedPaths": {}, "ownedArtifacts": {} }))
            } else if i == 3 {
                changed(it, json!({ "state": "failed", "failure": { "code": "x" } }))
            } else {
                ItemIn::Trusted(it.clone())
            }
        })
        .collect();
    let m = store.transition("job-e", Patch::new().items(items)).unwrap();
    let again = store.transition("job-e", Patch::new().set("state", json!("paused"))).unwrap();
    for (a, b) in m.items.iter().zip(&again.items) {
        assert!(Arc::ptr_eq(a, b));
    }
    let s = store.summaries().unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["itemCounts"], json!({ "converted": 3, "skipped": 0, "failed": 1 }));
    assert_eq!(s[0]["itemTotal"], json!(5));
    assert_eq!(s[0]["items"], json!([]));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn recover_takes_the_recorded_step() {
    let root = tmp("recover");
    let store = quiet(&root);
    store.create(&initial("job-f", vec![clip(0)])).unwrap();
    let m = store.transition("job-f", Patch::new()).unwrap();
    let it = changed(&m.items[0], json!({ "state": "processing", "expectedSource": { "size": 40000000, "sha256": "a".repeat(64), "device": "1", "inode": "2" } }));
    store
        .transition(
            "job-f",
            Patch::new()
                .set("state", json!("replacing"))
                .set("activeItemId", json!("item-000001"))
                .set("replacementPhase", json!("original-backed-up"))
                .items(vec![it]),
        )
        .unwrap();
    let facts = Facts { candidate_exists: true, backup_exists: true, ..Default::default() };
    let r = store.recover("job-f", &mut |_| Ok(facts), false).unwrap();
    assert_eq!(r.state(), "paused");
    assert_eq!(r.get("recovery").unwrap(), &json!({ "fromState": "replacing", "phase": "original-backed-up", "action": "promote-candidate" }));
    // recorded once: a second recover returns it unchanged
    let again = store.recover("job-f", &mut |_| panic!("not inspected again"), false).unwrap();
    assert_eq!(again.revision(), r.revision());
    // an inspection that fails
    store.create(&initial("job-g", vec![clip(0)])).unwrap();
    let m = store.transition("job-g", Patch::new()).unwrap();
    store.transition("job-g", Patch::new().set("state", json!("encoding")).set("activeItemId", json!(m.items[0].id()))).unwrap();
    assert_eq!(store.recover("job-g", &mut |_| Err(CError::code("EIO")), false).unwrap_err().code, "INSPECTION_FAILED");
    let r = store.recover("job-g", &mut |_| Ok(Facts::default()), false).unwrap();
    assert_eq!(r.get("recovery").unwrap(), &json!({ "fromState": "encoding", "action": "restart-encoding" }));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn ordering_and_numbers() {
    let mut names = vec!["a-b", "a_b", "a0", "ab", "a-", "a"];
    names.sort_by(|a, b| locale_cmp(a, b));
    // node -e "[...].sort((a, b) => a.localeCompare(b))"
    assert_eq!(names, vec!["a", "a_b", "a-", "a-b", "a0", "ab"]);
    assert_eq!(base36(1760000000000), "mgj6k3cw");
    assert_eq!(normalize::num(20.0), json!(20));
    assert_eq!(normalize::num(12.5), json!(12.5));
}

// ---- parity with the Node store -------------------------------------------------

/// The folders of the parity runs: `{T}-<tag>` in the reference.
fn prefix() -> String {
    std::env::temp_dir().join(format!("lean-jobstore-parity-{}", std::process::id())).to_string_lossy().into_owned()
}

fn ptmp(tag: &str) -> PathBuf {
    let d = PathBuf::from(format!("{}-{tag}", prefix()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// What the files and folders a command line names hold (their digests; a
/// summary.json without its stamp, the moment's file sizes and times).
fn args_state(args: &[&str]) -> Value {
    use sha2::{Digest, Sha256};
    Value::Array(args.iter().map(|a| {
        let p = Path::new(a);
        if p.is_dir() {
            let snap = crate::reference::snapshot(p);
            let files: Map<String, Value> = snap.as_object().unwrap().iter().map(|(k, v)| {
                let text = match (k.ends_with(SUMMARY_NAME), v.as_str().and_then(|t| serde_json::from_str::<Value>(t).ok())) {
                    (true, Some(mut j)) => {
                        j.as_object_mut().map(|o| o.remove("stamp"));
                        j.to_string()
                    }
                    _ => v.to_string(),
                };
                (k.clone(), json!(format!("{:x}", Sha256::digest(text.as_bytes()))))
            }).collect();
            json!({ "dir": files })
        } else if p.is_file() {
            json!({ "file": format!("{:x}", Sha256::digest(fs::read(p).unwrap())) })
        } else {
            Value::Null
        }
    }).collect())
}

/// Node's store (lean/parity/converterStore.js <args>, over
/// src/main/converter/jobStore.js), frozen in
/// tests/fixtures/node-reference/converter-store.json: its answer to the
/// same command on folders that hold the same files, and, for the commands
/// that write (run, step, recover), the folders as Node left them, put back
/// here.
fn node(args: &[&str]) -> Value {
    let places = [("{T}", prefix())];
    let input = json!({ "args": args, "state": args_state(args) });
    let writes = matches!(args[0], "run" | "step" | "recover");
    let out = crate::reference::answer("converter-store", &places, &input);
    if writes {
        crate::reference::restore(Path::new(args[1]), &out["after"]);
    }
    out["stdout"].clone()
}

fn apply_step(store: &JobStore, prev: &Manifest, step: &Value) -> R<Manifest> {
    if step.get("complete") == Some(&json!(true)) {
        let mut counters = super::super::contracts::create_empty_counters();
        for it in &prev.items {
            counters = super::super::contracts::add_completed_file(&counters, it.value());
        }
        let summary = super::super::contracts::serialize_summary(&counters);
        return store.transition(prev.id(), Patch::new().set("state", json!("completed")).set("counters", counters).set("summary", summary));
    }
    let mut patch = Patch::new();
    for (k, v) in step.get("top").and_then(Value::as_object).cloned().unwrap_or_default() {
        patch = patch.set(&k, v);
    }
    if step.get("set").is_some() || step.get("add").is_some() {
        let set = step.get("set").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut items: Vec<ItemIn> = prev.items.iter().enumerate().map(|(i, it)| match set.get(&i.to_string()) {
            Some(c) => changed(it, c.clone()),
            None => ItemIn::Trusted(it.clone()),
        }).collect();
        if let Some(add) = step.get("add").and_then(Value::as_array) {
            items.extend(add.iter().cloned().map(ItemIn::Raw));
        }
        patch = patch.items(items);
    }
    store.transition(prev.id(), patch)
}

fn run_scenarios(root: &Path, scenarios: &Value) -> Map<String, Value> {
    let store = quiet(root);
    let mut out = Map::new();
    for sc in scenarios.as_array().unwrap() {
        let mut m = store.create(sc["create"].as_object().unwrap()).unwrap();
        for step in sc["steps"].as_array().unwrap() {
            m = apply_step(&store, &m, step).unwrap();
        }
        out.insert(sc["name"].as_str().unwrap().into(), Value::String(m.to_json()));
    }
    out
}

#[test]
fn parity_with_node_store() {
    let scenarios = node(&["scenarios"]);
    let node_dir = ptmp("node");
    let rust_dir = ptmp("rust");
    let node_out = node(&["run", node_dir.to_str().unwrap()]);
    let rust_out = run_scenarios(&rust_dir, &scenarios);
    // the same jobs, the same files, byte for byte
    assert_eq!(Value::Object(rust_out.clone()), node_out);
    for sc in scenarios.as_array().unwrap() {
        let id = sc["create"]["id"].as_str().unwrap();
        for name in [MANIFEST_NAME, JOURNAL_NAME] {
            let a = fs::read(node_dir.join(id).join(name)).ok();
            let b = fs::read(rust_dir.join(id).join(name)).ok();
            assert_eq!(a.as_ref().map(|x| String::from_utf8_lossy(x).to_string()), b.as_ref().map(|x| String::from_utf8_lossy(x).to_string()), "{id}/{name}");
        }
    }
    // each reads the other's jobs (job.json + journal) as its own
    let rust_store = quiet(&node_dir);
    let listed: Vec<String> = rust_store.list().unwrap().iter().map(|m| m.id().to_string()).collect();
    let node_read = node(&["read", rust_dir.to_str().unwrap()]);
    assert_eq!(node_read["ids"], json!(listed));
    for id in &listed {
        let mine = rust_store.load(id).unwrap().unwrap().to_json();
        assert_eq!(node_read["loads"][id], json!(mine), "{id}");
    }
    // summaries: Node's summary.json read back by this store, and the same answers
    let node_summaries = node(&["read", node_dir.to_str().unwrap()]);
    let rust_summaries: Vec<Value> = quiet(&rust_dir).summaries().unwrap().iter().map(|s| Value::String(serde_json::to_string(&**s).unwrap())).collect();
    assert_eq!(node_summaries["summaries"], Value::Array(rust_summaries.clone()));
    let from_node_files: Vec<Value> = quiet(&node_dir).summaries().unwrap().iter().map(|s| Value::String(serde_json::to_string(&**s).unwrap())).collect();
    assert_eq!(from_node_files, rust_summaries);
    // continuing each other's jobs: Rust changes the jobs Node wrote, Node the
    // jobs Rust wrote, then the other way round once more
    let rounds = [
        json!({
            "job-separate": { "top": { "state": "waiting" }, "set": { "2": { "state": "skipped", "resultCode": "already-hevc" } } },
            "job-replace": { "top": { "state": "waiting", "recovery": null }, "add": [clip(30)] }
        }),
        json!({
            "job-separate": { "top": { "state": "paused" }, "set": { "3": { "attempts": 2 } } },
            "job-replace": { "top": {}, "add": [clip(31), clip(32)], "set": { "0": { "encoder": "libx265" } } }
        }),
    ];
    for (round, steps) in rounds.iter().enumerate() {
        let step_file = rust_dir.join(format!("steps-{round}.json"));
        fs::write(&step_file, steps.to_string()).unwrap();
        // Rust continues the jobs Node wrote, Node the jobs Rust wrote; the
        // next round the other way round
        let (writer, reader) = if round == 0 { (&node_dir, &rust_dir) } else { (&rust_dir, &node_dir) };
        let store = quiet(writer);
        let mut mine = Map::new();
        for (id, step) in steps.as_object().unwrap() {
            let cur = store.load(id).unwrap().unwrap();
            mine.insert(id.clone(), Value::String(apply_step(&store, &cur, step).unwrap_or_else(|e| panic!("{id}: {e:?}")).to_json()));
        }
        let theirs = node(&["step", reader.to_str().unwrap(), step_file.to_str().unwrap()]);
        assert_eq!(Value::Object(mine), theirs);
    }
    let a = node(&["read", rust_dir.to_str().unwrap()]);
    let b = node(&["read", node_dir.to_str().unwrap()]);
    assert_eq!(a["loads"], b["loads"]);
    for id in &listed {
        assert_eq!(a["loads"][id], json!(quiet(&node_dir).load(id).unwrap().unwrap().to_json()));
    }
    // recover() with the same facts takes the same step (both stores on
    // their own copy of the same jobs)
    let fact_cases = [
        json!({ "candidateExists": false, "sourceExists": true, "backupExists": true, "finalValid": true }),
        json!({ "sourceExists": true, "backupExists": false, "finalValid": true }),
        json!({ "partialExists": true, "sourceExists": true }),
        json!({}),
    ];
    for (n, f) in fact_cases.iter().enumerate() {
        let a = ptmp(&format!("rec-node-{n}"));
        let b = ptmp(&format!("rec-rust-{n}"));
        node(&["run", a.to_str().unwrap()]);
        run_scenarios(&b, &scenarios);
        let ids = ["job-separate", "job-replace", "job-failed", "job-interrupted-replace", "job-interrupted-encode"];
        let facts = json!({ "facts": ids.iter().map(|id| (id.to_string(), f.clone())).collect::<Map<String, Value>>() });
        let facts_file = b.join("facts.json");
        fs::write(&facts_file, facts.to_string()).unwrap();
        let theirs = node(&["recover", a.to_str().unwrap(), facts_file.to_str().unwrap()]);
        let store = quiet(&b);
        let g = |k: &str| f.get(k) == Some(&json!(true));
        let typed = Facts { candidate_exists: g("candidateExists"), partial_exists: g("partialExists"), final_exists: g("finalExists"), source_exists: g("sourceExists"), backup_exists: g("backupExists"), final_valid: g("finalValid"), partial_final_same_identity: g("partialFinalSameIdentity") };
        for id in ids {
            let mine = match store.recover(id, &mut |_| Ok(typed), false) {
                Ok(m) => m.to_json(),
                Err(e) => format!("error {}", e.code),
            };
            assert_eq!(theirs[id], json!(mine), "{id} with {f}");
        }
        fs::remove_dir_all(&a).unwrap();
        fs::remove_dir_all(&b).unwrap();
    }
    fs::remove_dir_all(&node_dir).unwrap();
    fs::remove_dir_all(&rust_dir).unwrap();
}

#[test]
fn parity_damaged_manifests() {
    let corpus = node(&["corpus"]);
    let dir = ptmp("corpus");
    let file = dir.join("corpus.json");
    fs::write(&file, corpus.to_string()).unwrap();
    let theirs = node(&["check", dir.join("node").to_str().unwrap(), file.to_str().unwrap()]);
    let mut differences = Vec::new();
    for (i, m) in corpus.as_array().unwrap().iter().enumerate() {
        let store = quiet(&dir.join("rust").join(format!("case-{i}")));
        let mine = match store.save(m) {
            Ok(x) => json!({ "ok": x.to_json() }),
            Err(e) => json!({ "code": if e.code.is_empty() { "NONE".to_string() } else { e.code } }),
        };
        if mine != theirs[i] {
            differences.push(format!("case {i}: node {} rust {}", theirs[i], mine));
        }
    }
    assert!(differences.is_empty(), "{} of {} differ:\n{}", differences.len(), corpus.as_array().unwrap().len(), differences.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    fs::remove_dir_all(&dir).unwrap();
}


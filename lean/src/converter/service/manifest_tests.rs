//! Synthetic catch-up state and real private snapshot cleanup; no owner footage.
use super::*;
use crate::converter::jobstore;
use super::lanes_tests::{Harness, HarnessOptions};
use std::fs;
use std::os::unix::fs::MetadataExt;
use sha2::{Digest, Sha256};

fn catch_up(h: &Harness, count: usize) -> Arc<Runtime> {
    let mut items = Vec::with_capacity(count);
    let mut counters = contracts::create_empty_counters();
    for n in 0..count {
        let rel = format!("SentryClips/generated/2026-01-01_00-00-00-front-{n}.mp4");
        let source = h.dir.path().join("footage").join(&rel);
        let mut item = json!({"id":format!("item-{n:06}"), "state":"queued", "kind":"video", "group":"SentryClips",
            "eventId":"generated", "relativePath":rel, "sourcePath":source, "sourceBytes":40_000_000,
            "mtimeMs":1760000000000u64, "timestampKey":"2026-01-01_00-00-00", "camera":"front", "attempts":0});
        if n < 14 {
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::write(&source, b"generated original stays intact").unwrap();
            let bytes = format!("generated verified snapshot {n}").into_bytes();
            let sha = crate::converter::tesla_sei::hex(&Sha256::digest(&bytes));
            let mut snap = h.conv.registry.create(&bytes, &sha, None, true).unwrap();
            snap.transfer().unwrap();
            let st = fs::metadata(&snap.path).unwrap();
            item["state"] = json!("processing");
            item["ownedPaths"] = json!({"publicationSnapshot":snap.path});
            item["ownedArtifacts"] = json!({"publicationSnapshot":{"path":snap.path,"nonce":"generated","state":"owned",
                "size":bytes.len(),"sha256":sha,"device":st.dev().to_string(),"inode":st.ino().to_string()}});
            item["publicationArtifact"] = json!({"path":snap.path,"token":snap.token,"size":bytes.len(),"sha256":sha});
        } else if n < 9381 {
            item["state"] = json!("completed");
            item["outputPath"] = item["sourcePath"].clone();
            item["outputBytes"] = json!(18_000_000);
            item["offTarget"] = json!({"savedPercent":47.9,"targetPercent":50});
            counters = contracts::add_completed_file(&counters, &item);
        } else if n < 9965 {
            item["state"] = json!("skipped");
            item["resultCode"] = json!("no-savings");
        } else if n < 10010 {
            item["state"] = json!("failed");
            item["failure"] = json!({"code":"frame-count-mismatch","retryable":false});
        } else if n < 10015 {
            item["resultCode"] = json!("gpu-memory-retry");
            item["encoder"] = json!("hevc_nvenc");
        }
        items.push(item);
    }
    let id = jobstore::random_uuid().unwrap();
    let mut config = h.config(json!({"outputMode":"replace","destinationRoot":null,"replacementConfirmed":true,
        "autoConvert":true,"profileId":"aggressive","keepRecent":{"days":30,"zone":"UTC"},
        "lanes":[{"device":"pci:0000:03:00.0","concurrency":8},{"device":"pci:0000:01:00.0","concurrency":6}]}));
    config.as_object_mut().unwrap().remove("bitrateKbps");
    let initial = json!({"id":id,"state":"waiting","revision":115160,"config":config,"items":items,"counters":counters,
        "summary":null,"discoveryComplete":true,"pausedMs":58222942,"moreAfter":"SentryClips/generated/thumb.png"});
    let m = h.service().store().create(initial.as_object().unwrap()).unwrap();
    let budget = jobstore::normalize::preflight(&m.to_value()).unwrap();
    eprintln!("generated catch-up: items={count} bytes={} budget={budget:?}", m.to_json().len());
    let rt = h.service().ensure_runtime(&id).unwrap();
    for item in &m.items[..14.min(count)] {
        Service::set_ownership(&rt, item.id(), Some(ownership_of(item.value())));
    }
    rt
}

#[test]
fn manifest_cleanup_failure_does_not_fail_a_40000_item_catch_up() {
    let h = Harness::new(HarnessOptions { clips:0, ..Default::default() });
    let rt = catch_up(&h, 40_000);
    let before = rt.manifest();
    for (n,item) in before.items[..14].iter().enumerate() {
        let code = ["DESTINATION_EXISTS","ENCODE_STALLED","CANCELLED","TRANSACTION_STATE_PERSIST_FAILED","GPU_MEMORY_PAUSED","NODE_WITHDRAWN","SOURCE_CHANGED"][n % 7];
        let r = h.service().fail_item(&rt, item.id(), &Fail::code(code));
        assert!(r.is_ok(), "cleanup must record the clip failure, not fail the job: {r:?}");
        assert_eq!(fs::read(item.str("sourcePath").unwrap()).unwrap(), b"generated original stays intact");
        assert!(!Path::new(item.value()["publicationArtifact"]["path"].as_str().unwrap()).exists());
        let saved = rt.manifest().item(item.id()).unwrap().value().clone();
        if ["GPU_MEMORY_PAUSED","NODE_WITHDRAWN"].contains(&code) {
            assert_eq!(saved["state"],"queued");
            assert!(saved.get("failure").is_none());
        } else {
            assert_eq!(saved["failure"]["code"], stable_failure(&Fail::code(code),"unused"));
        }
        assert!(saved.get("publicationArtifact").is_none());
        assert!(Service::ownership_for(&rt, item.id()).unwrap().publication.is_none());
    }
    let after = rt.manifest();
    assert_eq!(after.state(), JobState::Waiting);
    assert_eq!(after.get("counters"), before.get("counters"));
    assert_eq!(after.items[10010].value()["resultCode"], "gpu-memory-retry");
    let disk = JobStore::new(h.service().store().root()).unwrap().load(after.id()).unwrap().unwrap();
    assert_eq!(disk.to_json(), after.to_json(), "journal replays the exact accepted state");
}

#[test]
fn manifest_refusal_names_the_job_item_field_and_rule() {
    let h = Harness::new(HarnessOptions { clips:0, ..Default::default() });
    let rt = catch_up(&h, 14);
    for field in ["group", "eventId"] {
        let err = h.service().item_patch(&rt,"item-000000",vec![(field,Some(json!(false)))],vec![]).unwrap_err();
        assert_eq!(err.detail.as_deref(), Some(format!("items.item-000000.{field}: expected string").as_str()));
    }
    let err = h.service().item_patch(&rt,"item-000000",vec![("ownedPaths",None)],vec![]).unwrap_err();
    assert!(err.detail.as_deref().is_some_and(|d| d.contains("ownedArtifacts") && d.contains("path")), "{err:?}");
    let lines = LOGGED.lock().unwrap();
    assert!(lines.iter().any(|l| l.contains(rt.manifest().id()) && l.contains("item-000000") && l.contains("ownedArtifacts")), "{lines:?}");
}

#[test]
fn manifest_start_accepts_tested_lane_metadata_without_persisting_it() {
    let h=Harness::new(HarnessOptions{clips:0,..Default::default()});
    let c=h.config(json!({"deviceSettingsSource":"test","concurrency":14,"lanes":[{"device":"pci:0000:03:00.0","concurrency":8},{"device":"pci:0000:01:00.0","concurrency":6}]}));
    let id=h.service().start(&c).expect("UI metadata must not poison a new job");
    let job=h.finish_job(&id);
    assert_eq!(job["state"],"completed");
    assert_eq!(job["config"]["concurrency"],14);
    assert!(job["config"].get("deviceSettingsSource").is_none());
}

#[test]
fn manifest_write_refusal_preserves_original_through_replacement() {
    for stop in ["replacement-prepare", "replacement-candidate-owned", "candidate-written", "original-backed-up", "candidate-promoted"] {
        let h = Harness::new(HarnessOptions { clips:0, ..Default::default() });
        let rt = catch_up(&h, 14);
        let m = rt.manifest();
        let item = m.items[0].value();
        let source = item["sourcePath"].as_str().unwrap();
        let artifact: crate::converter::snapshot::Artifact = serde_json::from_value(item["publicationArtifact"].clone()).unwrap();
        let tx = &h.service().0.o.staging;
        let expected = tx.capture_source(source, None).unwrap();
        let persist = h.service().persistence(&rt, "item-000000", true);
        let hit = AtomicBool::new(false);
        let reject = |snapshot: &Value| -> Result<(), String> {
            if snapshot["step"] == stop || snapshot["phase"] == stop {
                hit.store(true, Ordering::SeqCst);
                return h.service().item_patch(&rt, "item-000000", vec![("attempts",Some(json!(4)))],vec![])
                    .map(|_| ()).map_err(|e| e.to_string());
            }
            persist(snapshot)
        };
        let op = staging::Op { job_id:m.id().into(), item_id:"item-000000".into(), source:Some(source.into()),
            source_root:m.config()["sourceRoot"].as_str().map(str::to_string), codec:Some("h265".into()),
            expected_source:Some(expected), publication_artifact:Some(artifact.clone()), persist:Some(&reject), ..Default::default() };
        let result = tx.prepare_replacement(&op).and_then(|p| tx.swap_replacement(&staging::Op {prepared:Some(&p),persist:Some(&reject),..Default::default()}));
        assert!(hit.load(Ordering::SeqCst), "{stop} was exercised: {result:?}");
        assert!(result.is_err(), "a refused manifest must stop the replacement at {stop}");
        assert_eq!(fs::read(source).unwrap(), b"generated original stays intact", "{stop}");
        // No original backup may be left untracked. Any private candidate is
        // still recorded and can be cleaned by the normal ownership path.
        let folder = Path::new(source).parent().unwrap();
        assert!(!fs::read_dir(folder).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("BACKUP-")), "{stop}");
        let own = Service::ownership_for(&rt,"item-000000").unwrap();
        assert!(h.service().cleanup_ownership(&rt,"item-000000",Some(&own),None,true).cleaned, "{stop}");
        assert!(!Path::new(&artifact.path).exists());
        assert!(!fs::read_dir(folder).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("TEMP-")), "{stop}");
    }
}

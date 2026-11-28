//! Generated media, real permissions and a fresh converter across restart.
use super::{generate, tempdir};
use crate::converter::{contracts, jobstore, runtime::{Converter, RuntimeOptions}};
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::{Arc, atomic::{AtomicBool, Ordering}}};

fn chmod(dir: &Path, mode: u32) {
    assert_ne!(unsafe { libc::geteuid() }, 0, "permission tests require an unprivileged process");
    fs::set_permissions(dir, fs::Permissions::from_mode(mode)).unwrap();
}

fn open(base: &Path, cheap: Arc<AtomicBool>) -> Converter {
    fs::create_dir_all(base.join("temp")).unwrap();
    let mut options = RuntimeOptions::new(base.join("data"), base.join("temp"), "ffmpeg", "ffprobe");
    options.auto_timer = false;
    options.is_cheap_now = Some(Arc::new(move |_| Some(cheap.load(Ordering::SeqCst))));
    Converter::open(options).unwrap()
}

fn config(base: &Path, separate: bool) -> Value {
    json!({"sourceRoot":base.join("footage"), "destinationRoot":separate.then(|| base.join("copies")),
        "outputMode":if separate {"separate"} else {"replace"}, "replacementConfirmed":!separate,
        "codec":"h265", "profileId":"balanced", "includedGroups":["RecentClips"], "networkMode":"direct",
        "verifyMode":"quick", "concurrency":2})
}

const NAME: &str = "2020-01-01_12-00-00-front.mp4";

#[test]
fn writable_clips_publish_and_partial_repairs_resume_the_same_job() {
    for separate in [false, true] {
        let dir = tempdir().unwrap();
        let base = dir.path();
        let source = base.join("footage/RecentClips");
        let destination = if separate { base.join("copies/RecentClips") } else { source.clone() };
        for day in ["a", "b", "c"] {
            fs::create_dir_all(source.join(day)).unwrap();
            fs::create_dir_all(destination.join(day)).unwrap();
        }
        generate(&source.join("a").join(NAME), &[400; 48]);
        let original = fs::read(source.join("a").join(NAME)).unwrap();
        for day in ["b", "c"] { fs::write(source.join(day).join(NAME), &original).unwrap(); }
        // Two separate output folders, or the two actual source folders in replace mode.
        for day in ["a", "b"] { chmod(&destination.join(day), 0o555); }
        let converter = open(base, Arc::new(AtomicBool::new(true)));
        converter.start().unwrap();
        let setup = config(base, separate);
        converter.auto.configure(&json!({"enabled":true, "config":setup, "catchUp":true})).unwrap();
        converter.auto.check_now();
        let state = converter.auto.get_state();
        let id = state["status"]["active"][setup["sourceRoot"].as_str().unwrap()]["jobId"]
            .as_str().expect("mixed permissions must allow an automatic start");
        converter.service.when_idle(id).unwrap();
        let paused = converter.service.get(id).unwrap();
        assert_eq!(paused["state"], "paused", "{paused}");
        assert_eq!(paused["permissionBlock"]["readOnlyCount"], 2);
        let items = paused["items"].as_array().unwrap();
        assert_eq!(items.iter().filter(|i| i["state"] == "completed" && i["resultCode"] == "converted").count(), 1);
        assert_eq!(items.iter().filter(|i| i["state"] == "skipped" && i["resultCode"] == "folder-not-writable" && i["failure"]["retryable"] == true).count(), 2);
        for day in ["a", "b"] {
            assert_eq!(fs::read(source.join(day).join(NAME)).unwrap(), original);
            assert_eq!(fs::read_dir(destination.join(day)).unwrap().count(), usize::from(!separate));
        }
        assert!(fs::metadata(destination.join("c").join(NAME)).unwrap().len() < original.len() as u64);
        assert!(converter.service.resume(id).unwrap_err().is("FOLDERS_NOT_WRITABLE"));
        chmod(&destination.join("a"), 0o755);
        converter.auto.tick();
        converter.service.when_idle(id).unwrap();
        let partial = converter.service.get(id).unwrap();
        assert_eq!(partial["state"], "paused", "{partial}");
        assert_eq!(partial["counters"]["files"], 2);
        assert_eq!(partial["permissionBlock"]["readOnlyCount"], 1);
        converter.auto.tick();
        let source_status = || converter.auto.get_state()["status"]["sources"][setup["sourceRoot"].as_str().unwrap()].clone();
        assert_eq!(source_status()["blocked"], true);
        // The owner can take over a permission pause. The next tick must respect it.
        converter.service.pause(id).unwrap();
        chmod(&destination.join("b"), 0o755);
        converter.auto.tick();
        assert_eq!(converter.service.get(id).unwrap()["state"], "paused");
        assert_ne!(source_status()["blocked"], true, "the remaining pause belongs to the owner");
        converter.service.resume(id).unwrap();
        converter.service.when_idle(id).unwrap();
        let done = converter.service.get(id).unwrap();
        assert_eq!(done["state"], "completed", "{done}");
        assert_eq!(done["counters"]["files"], 3);
        assert!(done["permissionBlock"].is_null() && done["folderWarning"].is_null());
        for item in done["items"].as_array().unwrap() {
            assert_eq!(item["resultCode"], "converted");
            assert_eq!(item["attempts"], 1);
            let output = Path::new(item["outputPath"].as_str().unwrap());
            assert_eq!(fs::read_dir(output.parent().unwrap()).unwrap().count(), 1);
            assert!(fs::metadata(output).unwrap().len() < original.len() as u64);
            if separate { assert_eq!(fs::read(item["sourcePath"].as_str().unwrap()).unwrap(), original); }
        }
        converter.shutdown();
    }
}

#[test]
fn build30_pause_restarts_inside_the_electricity_window_with_newer_folder_still_locked() {
    let dir = tempdir().unwrap();
    let base = dir.path();
    let group = base.join("footage/RecentClips");
    let locked = group.join("2026-11-27");
    fs::create_dir_all(&locked).unwrap();
    generate(&group.join(NAME), &[400; 48]);
    let cheap = Arc::new(AtomicBool::new(false));
    let mut setup = config(base, false);
    setup["autoConvert"] = json!(true);
    let before = open(base, cheap.clone());
    before.start().unwrap();
    before.auto.configure(&json!({"enabled":true, "config":setup, "window":{"follow":"off-peak"}, "catchUp":false})).unwrap();
    chmod(&locked, 0o555);
    let meta = fs::metadata(group.join(NAME)).unwrap();
    // The old manifest has no warning field. Its only queued clip is outside the reported folder.
    let old = before.store.create(json!({"config":setup, "state":"paused", "discoveryComplete":true,
        "counters":contracts::create_empty_counters(),
        "permissionBlock":{"roots":[{"root":base.join("footage"),"role":"Source","readOnlyCount":1,
            "examples":[{"folder":locked,"mode":"0555","ownerUid":1000,"ownerGid":1000}],"unreadable":{"count":0,"examples":[]}}],
            "readOnlyCount":1,"processUid":1000,"processGid":1000,"hint":"Check folder permissions"},
        "items":[{"id":"item-000001","state":"queued","kind":"video","group":"RecentClips","eventId":null,
            "camera":"front","timestampKey":"2020-01-01_12-00-00","attempts":0,"relativePath":format!("RecentClips/{NAME}"),
            "sourcePath":group.join(NAME),"sourceBytes":meta.len(),"mtimeMs":jobstore::mtime_ms(&meta)}]}).as_object().unwrap()).unwrap();
    before.shutdown();
    drop(before);

    let after = open(base, cheap.clone());
    after.start().unwrap();
    after.service.when_idle(old.id()).unwrap();
    assert_eq!(after.service.get(old.id()).unwrap()["state"], "paused", "outside electricity hours");
    cheap.store(true, Ordering::SeqCst);
    after.auto.tick(); // the ordinary timer path, with no owner action
    after.service.when_idle(old.id()).unwrap();
    let done = after.service.get(old.id()).unwrap();
    assert_eq!(done["state"], "completed", "{done}");
    assert_eq!(done["items"][0]["resultCode"], "converted");
    assert!(done["permissionBlock"].is_null());
    assert_eq!(done["folderWarning"]["readOnlyCount"], 1);
    assert_eq!(done["folderWarning"]["roots"][0]["examples"][0]["folder"], json!(locked));
    assert_eq!(fs::read_dir(&locked).unwrap().count(), 0);
    chmod(&locked, 0o755);
    after.shutdown();
}

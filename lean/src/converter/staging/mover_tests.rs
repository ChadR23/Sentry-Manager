use super::*;
use crate::converter::{
    auto_convert, contracts, jobstore,
    runtime::{Converter, RuntimeOptions},
};

// The old file still exists when the new one is allocated, so even a busy
// filesystem cannot accidentally satisfy this test by reusing its inode.
fn relocate(path: &Path) {
    let copy = path.with_extension("moving");
    let old = fs::metadata(path).unwrap();
    fs::copy(path, &copy).unwrap();
    File::options().write(true).open(&copy).unwrap().set_modified(old.modified().unwrap()).unwrap();
    fs::rename(copy, path).unwrap();
    assert_ne!(old.ino(), fs::metadata(path).unwrap().ino());
}

#[test]
fn mover_between_write_and_readback_publishes_the_verified_bytes() {
    let env = setup("mover-readback");
    let target = PathBuf::from(env.candidate());
    let moved = Arc::new(AtomicBool::new(false));
    let observed = moved.clone();
    *crate::converter::fs_hook::HOOK.write().unwrap() = Some(Arc::new(move |event, path| {
        if event == "copied" && path == target {
            relocate(path);
            observed.store(true, Ordering::SeqCst);
        }
        None
    }));
    let result = env.tx.replace_original(&env.op(&env.recorder()));
    *crate::converter::fs_hook::HOOK.write().unwrap() = None;
    assert!(moved.load(Ordering::SeqCst));
    assert!(result.unwrap().owned_paths.is_empty());
    assert_eq!(fs::read(&env.source).unwrap(), env.conversion);
    assert_eq!(env.names().len(), 1);
    assert!(!Path::new(&env.artifact.path).exists());
}

#[test]
fn mover_between_publication_steps_reproves_the_source_candidate_backup_and_final() {
    for step in ["replacement-candidate-owned", "candidate-written", "candidate-promoted"] {
        let env = setup(step);
        let rec = |v: &Value| {
            if v["step"] == step || v["phase"] == step {
                match step {
                    "replacement-candidate-owned" => relocate(Path::new(&env.source)),
                    "candidate-written" => relocate(Path::new(&env.candidate())),
                    _ => {
                        relocate(Path::new(v["ownedPaths"]["replacementBackup"].as_str().unwrap()));
                        relocate(Path::new(&env.source));
                    }
                }
            }
            Ok(())
        };
        let r = env.tx.replace_original(&env.op(&rec)).unwrap_or_else(|e| panic!("{step}: {e:?}"));
        assert!(r.owned_paths.is_empty());
        assert_eq!(env.names().len(), 1);
        assert_eq!(fs::read(&env.source).unwrap(), env.conversion);
    }
}

#[test]
fn mover_between_prepare_and_commit_of_a_separate_output() {
    let env = setup("mover-partial");
    let dest = s(&env.root.join("dest.mp4"));
    let rec = env.recorder();
    let p = env.tx.prepare_publication(&Op { destination: Some(dest.clone()), ..env.op(&rec) }).unwrap();
    relocate(Path::new(&p.partial));
    let r = env.tx.commit_publication(&Op { prepared: Some(&p), ..env.op(&rec) }).unwrap();
    assert_eq!(fs::read(dest).unwrap(), env.conversion);
    assert!(!Path::new(&p.partial).exists());
    assert_eq!(fs::read(&env.source).unwrap(), env.original);
    assert!(
        env.tx.cleanup_owned_artifacts(&Op { owned_paths: r.owned_paths, owned_artifacts: r.owned_artifacts, ..env.op(&rec) }).unwrap().cleaned
    );
}

#[test]
fn mover_recovery_of_a_separate_copy_requires_evidence_that_promotion_happened() {
    for published in [false, true] {
        let env = setup("mover-separate-recovery");
        let dest = s(&env.root.join("dest.mp4"));
        let rec = env.recorder();
        let p = env.tx.prepare_publication(&Op { destination: Some(dest.clone()), ..env.op(&rec) }).unwrap();
        if published {
            fs::hard_link(&p.partial, &dest).unwrap();
            relocate(Path::new(&p.partial));
        } else {
            fs::copy(&p.partial, &dest).unwrap();
        }
        let r = env.tx.recover_copy(&Op {
            destination: Some(dest.clone()),
            action: Some("finalize-copy".into()),
            owned_paths: p.owned_paths,
            owned_artifacts: p.owned_artifacts,
            ..env.op(&rec)
        });
        if published {
            assert!(r.unwrap().owned_paths.is_empty());
            assert!(!Path::new(&p.partial).exists());
        } else {
            assert_eq!(r.err().unwrap().code, "MANUAL_INTERVENTION");
            assert!(Path::new(&p.partial).exists());
        }
        assert_eq!(fs::read(dest).unwrap(), env.conversion);
        assert_eq!(fs::read(&env.source).unwrap(), env.original);
    }
}

#[test]
fn mover_during_the_two_name_swap_rolls_back_without_losing_the_original() {
    for step in ["original-backed-up", "candidate-promoted"] {
        let env = setup("mover-rollback");
        let rec = |v: &Value| {
            if v["phase"] == step {
                relocate(Path::new(&env.source));
                if step == "candidate-promoted" {
                    return Err("interrupted after the final moved".into());
                }
            }
            Ok(())
        };
        let error = env.tx.replace_original(&env.op(&rec)).unwrap_err();
        assert!(error.rolled_back.is_some(), "{step}: {error:?}");
        assert_eq!(fs::read(&env.source).unwrap(), env.original);
        assert_eq!(env.names().len(), 1);
        assert!(!Path::new(&env.artifact.path).exists());
    }
}

#[test]
fn mover_never_authorizes_wrong_bytes_with_the_proven_mtime() {
    let env = setup("mover-wrong");
    let p = env.tx.prepare_replacement(&env.op(&env.recorder())).unwrap();
    let path = Path::new(&p.owned_paths["replacementCandidate"]);
    relocate(path);
    let mtime = fs::metadata(path).unwrap().modified().unwrap();
    let wrong = vec![b'x'; env.conversion.len()];
    fs::write(path, &wrong).unwrap();
    File::options().write(true).open(path).unwrap().set_modified(mtime).unwrap();
    assert!(env.tx.swap_replacement(&Op { prepared: Some(&p), ..env.op(&env.recorder()) }).is_err());
    assert_eq!(fs::read(&env.source).unwrap(), env.original);
    assert_eq!(fs::read(path).unwrap(), wrong);
}

#[test]
fn mover_cleanup_requires_the_complete_snapshot_or_committed_journal_bytes() {
    for kind in ["complete", "committed", "wrong bytes", "uncommitted prefix", "hard link", "symbolic link"] {
        let env = setup("mover-cleanup");
        let cand = env.candidate();
        fs::write(&cand, []).unwrap();
        let mut meta = env.stat_meta(&cand, "n", "writing", &empty_sha());
        meta.journal = Some(empty_journal());
        let bytes = match kind {
            "committed" | "uncommitted prefix" => &env.conversion[..50],
            "wrong bytes" => &env.original[..env.conversion.len()],
            _ => &env.conversion,
        };
        fs::write(&cand, bytes).unwrap();
        if kind == "committed" {
            meta.size = Some(50);
            meta.sha256 = Some(sha(bytes));
            meta.journal = Some(Journal { committed: Some(Mark { size: 50, sha256: sha(bytes) }), pending: None });
        }
        relocate(Path::new(&cand));
        let alias = env.root.join("other");
        if kind == "hard link" {
            fs::hard_link(&cand, alias).unwrap();
        } else if kind == "symbolic link" {
            fs::rename(&cand, &alias).unwrap();
            std::os::unix::fs::symlink(alias, &cand).unwrap();
        }
        let res = env.cleanup(vec![("replacementCandidate", cand.clone())], vec![("replacementCandidate", meta)]);
        if matches!(kind, "complete" | "committed") {
            assert!(res.unwrap().cleaned, "{kind}");
            assert!(!Path::new(&cand).exists());
        } else {
            assert_eq!(res.err().expect(kind).code, "UNSAFE_OWNED_PATH");
            assert_eq!(fs::read(&cand).unwrap(), bytes);
        }
        assert_eq!(fs::read(&env.source).unwrap(), env.original);
    }
}

#[test]
fn mover_restart_releases_a_terminal_jobs_names_before_automatic_conversion() {
    for (state, proven) in [("completed", true), ("failed", true), ("completed", false)] {
        let env = setup("mover-restart");
        fs::remove_file(&env.source).unwrap();
        let dir = env.footage.join("RecentClips");
        fs::create_dir(&dir).unwrap();
        let name = "2020-01-01_00-00-00-front.mp4";
        let source = dir.join(name);
        let ff = std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x96:rate=25",
                "-frames:v",
                "48",
                "-c:v",
                "libx264",
                "-qp",
                "0",
                "-bf",
                "0",
                "-bsf:v",
                "filter_units=remove_types=6",
                "-use_editlist",
                "0",
            ])
            .arg(&source)
            .output()
            .unwrap();
        assert!(ff.status.success(), "{}", String::from_utf8_lossy(&ff.stderr));
        let original = fs::read(&source).unwrap();
        let config = json!({"sourceRoot":env.footage, "destinationRoot":null, "outputMode":"replace", "replacementConfirmed":true,
            "codec":"h265","profileId":"balanced","keepOffTarget":true,"verifyMode":"quick","networkMode":"direct","includedGroups":["RecentClips"],
            "concurrency":1,"autoConvert":true,"lanes":[{"device":"cpu","concurrency":1}]});
        let cand = s(&dir.join(format!("TEMP-H265-{name}")));
        fs::write(&cand, []).unwrap();
        let mut writing = env.stat_meta(&cand, "cand", "writing", &empty_sha());
        writing.journal = Some(empty_journal());
        fs::write(&cand, &env.conversion).unwrap();
        relocate(Path::new(&cand));
        if !proven {
            fs::write(&cand, vec![9; env.conversion.len()]).unwrap();
        }
        let id = jobstore::random_uuid().unwrap();
        let missing = s(&env.temp_root.join(format!("{id}-{ITEM}-enc-encoded.mp4")));
        let paths = json!({"replacementCandidate":cand,"publicationSnapshot":env.artifact.path,"encodedCandidate":missing});
        let arts = json!({"replacementCandidate":writing,"publicationSnapshot":env.stat_meta(&env.artifact.path,"snap","owned",&env.artifact.sha256),
            "encodedCandidate":artifact_metadata(&missing,"enc",ArtifactState::Intent,None,None,0,None)});
        let item = json!({"id":ITEM, "state":"failed","kind":"video","group":"RecentClips","eventId":null,"camera":"front",
            "relativePath":format!("RecentClips/{name}"),"sourcePath":source,"sourceBytes":original.len(),
            "mtimeMs":jobstore::mtime_ms(&fs::metadata(&source).unwrap()),"timestampKey":"2020-01-01_00-00-00","attempts":1,
            "resultCode":"cleanup-pending","failure":{"code":"publication-artifact-changed","retryable":false},
            "expectedSource":env.tx.capture_source(source.to_str().unwrap(),None).unwrap(),"ownedPaths":paths,"ownedArtifacts":arts,"publicationArtifact":env.artifact});
        let open = || {
            let mut opts = RuntimeOptions::new(env.root.join("data"), env.root.join("tmp"), "ffmpeg", "ffprobe");
            opts.auto_timer = false;
            let before = original.clone();
            let old_snapshot = PathBuf::from(&env.artifact.path);
            opts.before_replace_original = Some(Box::new(move |r| {
                assert_eq!(fs::read(r.source).unwrap(), before);
                assert!(!old_snapshot.exists(), "old ownership is settled before the new publication");
                Ok(())
            }));
            Converter::open(opts).unwrap()
        };
        let old = open();
        let counters = contracts::create_empty_counters();
        old.store.create(json!({"id":id, "state":state,"config":config,"discoveryComplete":true,"counters":counters,"summary":(state=="completed").then(|| contracts::serialize_summary(&counters)),
            "failure":(state=="failed").then(|| json!({"code":"interrupted","retryable":false})),
            "items":[item],"ownedPaths":paths,"ownedArtifacts":arts,"publicationArtifact":env.artifact}).as_object().unwrap()).unwrap();
        old.shutdown();
        drop(old);
        let auto = env.root.join("data/converter-auto");
        fs::create_dir_all(&auto).unwrap();
        fs::write(auto.join("settings.json"), json!({"enabled":proven,"configs":[config],"catchUp":true,"intervalMinutes":60}).to_string())
            .unwrap();
        if state == "failed" {
            // Later collision failures can already have exhausted Build 28's three sweeps.
            let index = auto.join(format!("index-{}.json", auto_convert::setup_key(&config)));
            let rel = item["relativePath"].as_str().unwrap();
            fs::write(index, json!({"v":2,"gaveUp":{rel:[original.len(), item["mtimeMs"], 7]}}).to_string()).unwrap();
            // A restart during the guarded unlink must still recognize the
            // relocated inode under its quarantine name on the next start.
            let _lock = OWNED_HOOK_LOCK.lock().unwrap();
            let target = PathBuf::from(&cand);
            *owned::TEST_HOOK.write().unwrap() = Some(Arc::new(move |step, from, _| {
                if step == "quarantined" && from == target {
                    return Err(io::Error::from_raw_os_error(libc::EIO));
                }
                Ok(())
            }));
            let interrupted = open();
            let result = interrupted.service.sweep_terminal_leftovers(&interrupted.store.summaries().unwrap());
            *owned::TEST_HOOK.write().unwrap() = None;
            result.unwrap();
            interrupted.shutdown();
            let quarantined = fs::read_dir(&dir).unwrap().flatten().find(|f| f.file_name().to_string_lossy().starts_with(".sentry-owned-remove-")).unwrap();
            let saved = interrupted.store.load(&id).unwrap().unwrap().to_value();
            for record in [&saved, &saved["items"][0]] {
                assert_eq!(record["ownedArtifacts"]["replacementCandidate"]["inode"], quarantined.metadata().unwrap().ino().to_string());
                assert_eq!(record["ownedArtifacts"]["replacementCandidate"]["sha256"], env.artifact.sha256);
            }
            assert!(Path::new(&env.artifact.path).exists(), "retain the snapshot until the candidate is settled");
        }
        let restarted = open();
        restarted.start().unwrap();
        let old = restarted.store.load(&id).unwrap().unwrap().to_value();
        if !proven {
            assert_eq!(fs::read(&cand).unwrap(), vec![9; env.conversion.len()]);
            assert_eq!(fs::read(&env.artifact.path).unwrap(), env.conversion);
            assert_eq!(fs::read(&source).unwrap(), original);
            assert_eq!(old["items"][0]["resultCode"], "cleanup-pending");
            assert_eq!(old["items"][0]["ownedPaths"], paths);
            restarted.shutdown();
            continue;
        }
        assert!(!Path::new(&env.artifact.path).exists());
        for v in [&old, &old["items"][0]] {
            assert!(v["ownedPaths"].as_object().is_none_or(|m| m.is_empty()));
            assert!(v["ownedArtifacts"].as_object().is_none_or(|m| m.is_empty()));
            assert!(v["publicationArtifact"].is_null());
        }
        assert_eq!(old["items"][0]["resultCode"], "publication-artifact-changed");
        restarted.auto.tick();
        let auto_state = restarted.auto.get_state();
        let next = auto_state["status"]["lastJobId"].as_str().unwrap();
        restarted.service.when_idle(next).unwrap();
        let next = restarted.store.load(next).unwrap().unwrap().to_value();
        assert_eq!(next["items"].as_array().unwrap().len(), 1);
        assert_eq!(next["items"][0]["resultCode"], "converted", "{next}");
        assert!(fs::metadata(&source).unwrap().len() < original.len() as u64);
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
        restarted.shutdown();
    }
}

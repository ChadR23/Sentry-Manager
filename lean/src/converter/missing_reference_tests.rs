use super::{
    auto_convert, contracts, ipc, jobstore,
    runtime::{Converter, RuntimeOptions},
    testutil::tempdir,
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

const REL: &str = "RecentClips/2020-01-01_00-00-00-back.mp4";
const KEPT: &str = "source-missing-reference-frames";

fn ffmpeg(args: &[&str], output: &Path) {
    let r = Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).arg(output).output().unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
}

// Four 16-picture GOPs. Remove just the second IDR access unit before
// remuxing: frame_num 15 is followed by a reference P with frame_num 1.
fn source(base: &Path, missing_idr: bool) -> PathBuf {
    let path = base.join("footage").join(REL);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    for folder in ["out", "temp"] {
        fs::create_dir_all(base.join(folder)).unwrap();
    }
    let raw = base.join("generated.h264");
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x96:rate=25",
            "-frames:v",
            "64",
            "-c:v",
            "libx264",
            "-crf",
            "1",
            "-bf",
            "0",
            "-x264-params",
            "ref=1:scenecut=0:keyint=16",
            "-bsf:v",
            if missing_idr { r"noise=drop=eq(n\,16),filter_units=remove_types=6" } else { "filter_units=remove_types=6" },
            "-f",
            "h264",
        ],
        &raw,
    );
    ffmpeg(&["-r", "25", "-i", raw.to_str().unwrap(), "-c:v", "copy", "-use_editlist", "0"], &path);
    let result = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_packets",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_packets,nb_read_frames:frame=pts_time",
            "-show_frames",
            "-of",
            "json",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(result.status.success() && result.stderr.is_empty(), "{}", String::from_utf8_lossy(&result.stderr));
    let proof: Value = serde_json::from_slice(&result.stdout).unwrap();
    let counts = &proof["streams"][0];
    if missing_idr {
        assert_eq!(counts["nb_read_packets"], "63");
        assert_eq!(counts["nb_read_frames"], "49");
        assert_eq!(proof["frames"][15]["pts_time"], "0.600000");
        assert_eq!(proof["frames"][16]["pts_time"], "1.200000");
    } else {
        assert_eq!(counts["nb_read_packets"], "64");
        assert_eq!(counts["nb_read_frames"], "64");
    }
    path
}

fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn open(base: &Path) -> Converter {
    let encoder = base.join("encoder");
    // Only capability selection is simulated. A real software encoder
    // produces the HEVC candidate, including its deliberately dropped frames
    // when the control file is present. All verification is the real service.
    script(
        &encoder,
        r#"#!/bin/sh
set -eu
prev=
src=
for arg do
  if [ "$prev" = -i ] && [ -z "$src" ]; then src=$arg; fi
  prev=$arg
done
case "$arg" in
  -encoders) printf '%s\n' ' V..... hevc_nvenc' ' V..... libx265' ;;
  /dev/null) exit 0 ;;
  *.mp4)
    echo encode >> "$0.runs"
    filter=null
    if [ -e "$0.drop" ]; then filter='select=not(between(n\,8\,10))'; fi
    exec ffmpeg -nostdin -v error -y -i "$src" -vf "$filter" -fps_mode passthrough -enc_time_base demux -c:v libx265 -x265-params pools=1:log-level=error -bf 0 -tag:v hvc1 -use_editlist 0 "$arg" ;;
  *) exec ffmpeg "$@" ;;
esac
"#,
    );
    let probe = base.join("probe");
    script(
        &probe,
        r#"#!/bin/sh
for last do :; done
for arg do
  if [ "$arg" = -show_frames ]; then
    printf '%s\n' "$last" >> "$0.proofs"
    if [ -e "$0.error" ]; then echo 'decoder error' >&2; fi
  fi
done
exec ffprobe "$@"
"#,
    );
    let mut options = RuntimeOptions::new(base.join("data"), base.join("temp"), encoder.to_str().unwrap(), probe.to_str().unwrap());
    options.auto_timer = false;
    Converter::open(options).unwrap()
}

fn config(base: &Path, mode: &str) -> Value {
    json!({"sourceRoot":base.join("footage"), "destinationRoot":(mode=="separate").then(||base.join("out")),
        "outputMode":mode,"replacementConfirmed":mode=="replace","codec":"h265","profileId":"balanced","verifyMode":"quick",
        "includedGroups":["RecentClips"],"keepOffTarget":true,"networkMode":"staging","concurrency":1})
}

fn copies(base: &Path) -> usize {
    fs::read_to_string(base.join("encoder.runs")).unwrap_or_default().lines().count()
}

#[test]
fn missing_reference_proof_precedes_gpu_retry_and_only_runs_for_a_short_output() {
    for (missing, drop_frame, noisy, expected) in [
        (true, false, false, KEPT),
        (true, false, true, "frame-count-mismatch"),
        (false, true, false, "frame-count-mismatch"),
        (false, false, false, "converted"),
    ] {
        let dir = tempdir().unwrap();
        let base = dir.path();
        let src = source(base, missing);
        let original = fs::read(&src).unwrap();
        if drop_frame {
            fs::write(base.join("encoder.drop"), []).unwrap();
        }
        if noisy {
            fs::write(base.join("probe.error"), []).unwrap();
        }
        let service = open(base);
        let id = service.service.start(&config(base, "separate")).unwrap();
        service.service.when_idle(&id).unwrap();
        let job = service.store.load(&id).unwrap().unwrap().to_value();
        let item = &job["items"][0];
        assert_eq!(item["encoder"], "hevc_nvenc", "{item}");
        assert_eq!(item["resultCode"], expected, "{item}");
        let proofs = fs::read_to_string(base.join("probe.proofs")).unwrap_or_default();
        assert_eq!(proofs.lines().collect::<Vec<_>>(), if missing || drop_frame { vec![src.to_str().unwrap()] } else { vec![] });
        assert_eq!(copies(base), 1);
        assert_eq!(fs::read(&src).unwrap(), original);
        if expected == "frame-count-mismatch" {
            assert_eq!(item["state"], "failed");
            assert!(service.service.retry_temporary(&id).is_ok(), "genuine GPU losses remain retryable");
            service.service.when_idle(&id).unwrap();
            assert_eq!(copies(base), 2);
            assert!(!base.join("out").join(REL).exists());
        } else {
            assert_eq!(item["state"], "completed");
            assert!(item["failure"].is_null());
            if expected == KEPT {
                assert_eq!(fs::read(base.join("out").join(REL)).unwrap(), original);
                assert_eq!(job["counters"]["savedBytes"], 0);
                assert!(service.service.retry_temporary(&id).is_err());
                assert_eq!(copies(base), 1);
            }
        }
        assert_eq!(fs::read_dir(base.join("temp/sentry-six-converter")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(base.join("temp")).unwrap().count(), 1);
        service.shutdown();
    }
}

#[test]
fn missing_reference_old_automatic_failure_becomes_kept_and_survives_restart() {
    let dir = tempdir().unwrap();
    let base = dir.path();
    let src = source(base, true);
    let original = fs::read(&src).unwrap();
    let mtime = jobstore::mtime_ms(&fs::metadata(&src).unwrap());
    let mut cfg = config(base, "replace");
    cfg["autoConvert"] = json!(true);
    let old = open(base);
    let counters = contracts::create_empty_counters();
    let previous = old.store.create(json!({"config":cfg,"state":"completed","discoveryComplete":true,
        "counters":counters,"summary":contracts::serialize_summary(&counters),
        "items":[{"id":"item-000001","state":"failed","kind":"video","group":"RecentClips","relativePath":REL,"sourcePath":src,
            "sourceBytes":original.len(),"mtimeMs":mtime,"eventId":null,"camera":"back","timestampKey":"2020-01-01_00-00-00",
            "attempts":1,"resultCode":"frame-count-mismatch","failure":{"code":"frame-count-mismatch","retryable":false},"encoder":"hevc_nvenc"}]
    }).as_object().unwrap()).unwrap();
    old.shutdown();
    drop(old);
    let auto = base.join("data/converter-auto");
    fs::create_dir_all(&auto).unwrap();
    fs::write(auto.join("settings.json"), json!({"enabled":true,"configs":[cfg],"catchUp":true,"intervalMinutes":60}).to_string()).unwrap();
    let index = auto.join(format!("index-{}.json", auto_convert::setup_key(&cfg)));
    fs::write(&index, json!({"v":2,"files":{},"gaveUp":{REL:[original.len(),mtime,7]},"failures":{}}).to_string()).unwrap();

    let restarted = open(base);
    restarted.start().unwrap();
    restarted.auto.tick();
    let status = restarted.auto.get_state();
    let id = status["status"]["lastJobId"].as_str().expect("rediscovered revision-7 failure");
    assert_ne!(previous.id(), id);
    restarted.service.when_idle(id).unwrap();
    restarted.auto.tick();
    let job = restarted.store.load(id).unwrap().unwrap().to_value();
    let item = &job["items"][0];
    assert_eq!(item["state"], "skipped", "{item}");
    assert_eq!(item["resultCode"], KEPT);
    assert!(item["failure"].is_null() && item["outputPath"].is_null());
    for v in [item, &job] {
        for k in ["ownedPaths", "ownedArtifacts"] {
            assert!(v[k].as_object().is_none_or(|o| o.is_empty()));
        }
        assert!(v["publicationArtifact"].is_null());
    }
    assert_eq!(fs::read(&src).unwrap(), original);
    assert_eq!(copies(base), 1);
    let saved: Value = serde_json::from_slice(&fs::read(index).unwrap()).unwrap();
    assert_eq!(saved["files"][REL], json!([original.len(), item["mtimeMs"]]));
    assert!(saved["gaveUp"][REL].is_null() && saved["failures"][REL].is_null());
    assert!(restarted.converted_index.has(item).is_none());
    let trimmed = ipc::sanitize_snapshot(&json!({"items":vec![item; 257]})).unwrap();
    assert_eq!(trimmed["itemKeptCounts"][KEPT], 257);
    assert_eq!(trimmed["itemStateCounts"]["failed"], 0);
    restarted.shutdown();
    drop(restarted);

    let again = open(base);
    again.start().unwrap();
    again.auto.tick();
    assert_eq!(again.service.list().unwrap().len(), 2);
    assert_eq!(copies(base), 1);
    again.shutdown();
}

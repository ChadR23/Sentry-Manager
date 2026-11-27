use super::{auto_convert, contracts, ipc, jobstore, mp4w, runtime::{Converter, RuntimeOptions}, testutil::tempdir};
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::{Path, PathBuf}, process::Command};

const FRONT: &str = "RecentClips/2020-01-01_00-00-00-front.mp4";
const BACK: &str = "RecentClips/2020-01-01_00-00-00-back.mp4";

// Three playable frames in a small H.264 container. Re-encoding has to pay
// the new codec and container overhead, even at the minimum bitrate.
fn tiny_clip(base: &Path) -> Vec<u8> {
    let source = base.join("footage").join(FRONT);
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::create_dir_all(base.join("out")).unwrap();
    let encoded = Command::new("ffmpeg").args([
        "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25",
        "-frames:v", "3", "-c:v", "libx264", "-crf", "48", "-bf", "0",
        "-bsf:v", "filter_units=remove_types=6", "-use_editlist", "0",
    ]).arg(&source).output().unwrap();
    assert!(encoded.status.success(), "{}", String::from_utf8_lossy(&encoded.stderr));
    fs::read(source).unwrap()
}

fn open(base: &Path, ffmpeg: &str) -> Converter {
    fs::create_dir_all(base.join("temp")).unwrap();
    let mut options = RuntimeOptions::new(base.join("data"), base.join("temp"), ffmpeg, "ffprobe");
    options.auto_timer = false;
    Converter::open(options).unwrap()
}

fn config(base: &Path, mode: &str) -> Value {
    json!({
        "sourceRoot": base.join("footage"), "destinationRoot": (mode == "separate").then(|| base.join("out")),
        "outputMode": mode, "replacementConfirmed": mode == "replace", "codec": "h265",
        "profileId": "aggressive", "keepOffTarget": mode == "replace", "verifyMode": if mode == "replace" {"quick"} else {"full"},
        "includedGroups": ["RecentClips"], "networkMode": "staging", "concurrency": 1, "lanes": [{"device": "cpu", "concurrency": 1}]
    })
}

fn assert_no_temp_files(temp: &Path) {
    assert_eq!(fs::read_dir(temp).unwrap().count(), 1, "no verification snapshots left");
    assert_eq!(fs::read_dir(temp.join("sentry-six-converter")).unwrap().count(), 0, "no staged source or candidate");
}

fn encoder_wrapper(base: &Path, script: &str) -> PathBuf {
    let path = base.join("encoder");
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn replace_keeps_the_original_on_the_next_automatic_run() {
    recover_not_smaller("replace");
}

#[test]
fn separate_copies_the_original_on_the_next_automatic_run() {
    recover_not_smaller("separate");
}

fn recover_not_smaller(mode: &str) {
    let dir = tempdir().unwrap();
    let base = dir.path();
    let before = tiny_clip(base);
    let root = base.join("footage");
    fs::write(root.join(BACK), &before).unwrap();
    let mut config = config(base, mode);
    config["autoConvert"] = json!(true);
    let mut items = vec![];
    for (n, relative) in [FRONT, BACK].iter().enumerate() {
        let source = root.join(relative);
        items.push(json!({
            "id": format!("item-{:06}", n + 1), "state": "failed", "kind": "video", "eventId": null,
            "group": "RecentClips", "relativePath": relative, "sourcePath": source, "sourceBytes": before.len(),
            "mtimeMs": jobstore::mtime_ms(&fs::metadata(source).unwrap()), "timestampKey": "2020-01-01_00-00-00",
            "camera": if n == 0 {"front"} else {"back"}, "attempts": 1, "resultCode": "not-smaller",
            "failure": {"code": "not-smaller", "retryable": false}
        }));
    }
    let previous = open(base, "ffmpeg");
    let counters = contracts::create_empty_counters();
    let old = previous.store.create(json!({
        "config": config, "state": "completed", "items": items, "discoveryComplete": true,
        "counters": counters, "summary": contracts::serialize_summary(&counters)
    }).as_object().unwrap()).unwrap();
    previous.shutdown();
    drop(previous);

    let auto = base.join("data/converter-auto");
    fs::create_dir_all(&auto).unwrap();
    fs::write(auto.join("settings.json"), json!({"enabled": true, "configs": [config], "catchUp": true, "intervalMinutes": 60}).to_string()).unwrap();
    let index = auto.join(format!("index-{}.json", auto_convert::setup_key(&config)));
    // Build 27 records one or two failures by count. After the third, the
    // entry has revision 6 and no reason. Neither clip was ever converted.
    fs::write(&index, json!({
        "v": 2, "files": {}, "failures": {FRONT: 1}, "gaveUp": {BACK: [before.len(), items[1]["mtimeMs"], 6]}
    }).to_string()).unwrap();

    let restarted = open(base, "ffmpeg");
    restarted.start().unwrap();
    restarted.auto.tick();
    let status = restarted.auto.get_state();
    let id = status["status"]["lastJobId"].as_str().expect("next automatic job");
    assert_ne!(id, old.id());
    restarted.service.when_idle(id).unwrap();
    restarted.auto.tick();
    let job = restarted.store.load(id).unwrap().unwrap().to_value();
    let saved: Value = serde_json::from_slice(&fs::read(&index).unwrap()).unwrap();
    assert_eq!(job["state"], "completed");
    for relative in [FRONT, BACK] {
        let item = job["items"].as_array().unwrap().iter().find(|i| i["relativePath"] == relative).expect("previous failure rediscovered");
        assert_eq!(item["resultCode"], "no-savings", "{item}");
        assert_eq!(item["state"], if mode == "replace" { "skipped" } else { "completed" });
        assert_eq!(item["attempts"], 1, "size targets add no under-source encodes");
        assert!(item["failure"].is_null());
        assert_eq!(fs::read(root.join(relative)).unwrap(), before);
        assert!(restarted.converted_index.has(item).is_none());
        if mode == "replace" {
            assert!(item["outputPath"].is_null());
            assert_eq!(saved["gaveUp"][relative], json!([item["sourceBytes"], item["mtimeMs"], auto_convert::CONVERTER_REVISION, "no-savings"]));
            assert!(saved["files"][relative].is_null());
        } else {
            assert_eq!(fs::read(base.join("out").join(relative)).unwrap(), before);
            assert_eq!(item["outputBytes"], before.len());
            assert_eq!(saved["files"][relative], json!([item["sourceBytes"], item["mtimeMs"]]));
        }
        for record in [item, &job] {
            for key in ["ownedArtifacts", "ownedPaths"] {
                assert!(record[key].as_object().is_none_or(|m| m.is_empty()), "{key}: {}", record[key]);
            }
            assert!(record["publicationArtifact"].is_null());
        }
    }
    assert!(saved["failures"].as_object().unwrap().is_empty());
    assert_eq!(job["counters"]["savedBytes"], 0);
    assert_eq!(fs::read_dir(root.join("RecentClips")).unwrap().count(), 2);
    if mode == "separate" { assert_eq!(fs::read_dir(base.join("out/RecentClips")).unwrap().count(), 2); }
    assert_no_temp_files(&restarted.temp_path);
    assert_eq!(restarted.service.get(old.id()).unwrap()["items"], json!(items), "retain the previous job history");
    restarted.shutdown();
    drop(restarted);

    let again = open(base, "ffmpeg");
    again.start().unwrap();
    again.auto.tick();
    assert_eq!(again.auto.get_state()["status"]["sources"][root.to_str().unwrap()]["lastNewFiles"], 0);
    assert_eq!(again.service.list().unwrap().len(), 2, "the kept clips survive another restart");
    again.shutdown();
}

#[test]
fn always_convert_can_keep_a_larger_verified_output_only_after_the_no_target_retries() {
    for keep_larger in [false, true] {
        let dir = tempdir().unwrap();
        let base = dir.path();
        let before = tiny_clip(base);
        let converter = open(base, "ffmpeg");
        let mut config = config(base, "separate");
        config["profileId"] = json!("custom");
        config["bitrateKbps"] = json!(250);
        config["keepLarger"] = json!(keep_larger);
        let id = converter.service.start(&config).unwrap();
        converter.service.when_idle(&id).unwrap();
        let item = &converter.service.get(&id).unwrap()["items"][0];
        assert_eq!(item["state"], "completed", "{item}");
        assert_eq!(item["attempts"], 3);
        let output = fs::read(base.join("out").join(FRONT)).unwrap();
        if keep_larger {
            assert_eq!(item["resultCode"], "converted");
            assert!(output.len() > before.len());
        } else {
            assert_eq!(item["resultCode"], "no-savings");
            assert_eq!(output, before);
        }
        assert_eq!(fs::read(base.join("footage").join(FRONT)).unwrap(), before);
        converter.shutdown();
    }
}

// A valid free box changes the file size without changing a frame. At
// 6,000 bytes this source is larger than its encode but misses a 50% target.
fn padded_original(base: &Path) -> Vec<u8> {
    let mut original = tiny_clip(base);
    let payload = vec![0; 6000 - original.len() - 8];
    original.extend(mp4w::make_box(b"free", &payload).unwrap());
    fs::write(base.join("footage").join(FRONT), &original).unwrap();
    original
}

#[test]
fn smaller_off_target_output_still_obeys_the_option_after_the_size_retry() {
    for keep in [false, true] {
        let dir = tempdir().unwrap();
        let base = dir.path();
        let original = padded_original(base);
        let converter = open(base, "ffmpeg");
        let mut config = config(base, "separate");
        config["keepOffTarget"] = json!(keep);
        let id = converter.service.start(&config).unwrap();
        converter.service.when_idle(&id).unwrap();
        let item = &converter.service.get(&id).unwrap()["items"][0];
        assert_eq!(item["attempts"], 2, "{item}");
        let output = base.join("out").join(FRONT);
        if keep {
            assert_eq!(item["resultCode"], "converted", "{item}");
            assert_eq!(item["offTarget"]["targetPercent"], 50.0);
            let bytes = fs::metadata(output).unwrap().len();
            assert!(bytes > 3120 && bytes < 6000, "verified smaller file outside target tolerance: {bytes}");
        } else {
            assert_eq!(item["state"], "failed");
            assert_eq!(item["failure"]["code"], "profile-size");
            assert!(!output.exists());
        }
        assert_eq!(fs::read(base.join("footage").join(FRONT)).unwrap(), original);
        assert_no_temp_files(&converter.temp_path);
        converter.shutdown();
    }
}

#[test]
fn larger_output_on_the_size_retry_discards_both_candidates() {
    let dir = tempdir().unwrap();
    let base = dir.path();
    let original = padded_original(base);
    // The real encoder, with an extra valid MP4 box on its second output.
    let encoder = encoder_wrapper(base, r#"#!/bin/sh
set -e
ffmpeg "$@"
for last do :; done
case "$last" in
  *.mp4)
    if [ -e "$0.first" ]; then cat "$0.padding" >> "$last"; else touch "$0.first"; fi ;;
esac
"#);
    fs::write(encoder.with_extension("padding"), mp4w::make_box(b"free", &[0; 4096]).unwrap()).unwrap();
    let converter = open(base, encoder.to_str().unwrap());
    let id = converter.service.start(&config(base, "replace")).unwrap();
    converter.service.when_idle(&id).unwrap();
    let item = &converter.service.get(&id).unwrap()["items"][0];
    assert_eq!(item["attempts"], 2, "{item}");
    assert_eq!(item["resultCode"], "no-savings", "{item}");
    assert_eq!(item["state"], "skipped");
    assert_eq!(fs::read(base.join("footage").join(FRONT)).unwrap(), original);
    assert_no_temp_files(&converter.temp_path);
    converter.shutdown();
}

#[test]
fn an_oversized_candidate_with_wrong_dimensions_still_fails_verification() {
    let dir = tempdir().unwrap();
    let base = dir.path();
    let original = tiny_clip(base);
    let encoder = encoder_wrapper(base, r#"#!/bin/sh
set -e
for last do :; done
case "$last" in
  *.mp4)
    ffmpeg -v error -y -f lavfi -i testsrc2=size=96x64:rate=25 -frames:v 3 -c:v libx265 -x265-params pools=1 -bf 0 -tag:v hvc1 -use_editlist 0 "$last"
    wc -c < "$last" > "$0.size" ;;
  *) exec ffmpeg "$@" ;;
esac
"#);
    let converter = open(base, encoder.to_str().unwrap());
    let id = converter.service.start(&config(base, "replace")).unwrap();
    converter.service.when_idle(&id).unwrap();
    let size: usize = fs::read_to_string(encoder.with_extension("size")).unwrap().trim().parse().unwrap();
    assert!(size > original.len());
    let item = &converter.service.get(&id).unwrap()["items"][0];
    assert_eq!(item["failure"]["code"], "dimension-mismatch", "{item}");
    assert_eq!(item["state"], "failed");
    assert_eq!(item["attempts"], 1);
    assert_eq!(fs::read(base.join("footage").join(FRONT)).unwrap(), original);
    assert_no_temp_files(&converter.temp_path);
    converter.shutdown();
}

#[test]
fn no_savings_counts_include_copied_and_skipped_originals_in_trimmed_snapshots() {
    let items: Vec<_> = (0..300).map(|n| json!({
        "id": format!("item-{n:06}"), "state": if n % 2 == 0 { "skipped" } else { "completed" }, "resultCode": "no-savings"
    })).collect();
    let snapshot = ipc::sanitize_snapshot(&json!({"items": items})).unwrap();
    assert_eq!(snapshot["itemKeptCounts"]["no-savings"], 300);
    assert_eq!(snapshot["itemStateCounts"]["failed"], 0);
}

//! A clip that ends with unsafe-owned-path says why: one log line naming the
//! clip, the check and the values that did not match, and failure.detail in
//! the job snapshot (kept in memory only: after a restart the snapshot says
//! the reason is not known). A Retry failed that cannot clean up a clip's
//! kept files says which clip stopped it.

use super::lanes_tests::{Harness, HarnessOptions};
use super::*;
use std::fs;

fn has_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}

fn logged(needle: &str) -> Vec<String> {
    LOGGED.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|l| l.contains(needle)).cloned().collect()
}

/// ffmpeg that leaves a second hard link to the file it wrote (as a backup
/// or deduplication tool on a NAS would): the candidate the converter owns is
/// no longer its own file, and the converter refuses to adopt it.
const LINKING_FFMPEG: &str = r#"#!/bin/sh
for last; do :; done
printf 'fps=100\nprogress=end\n'
printf 'encoded' > "$last"
ln "$last" "$last.extra"
"#;

fn linking(h: &Harness) {
    use std::os::unix::fs::PermissionsExt;
    let p = h.ctl.join("ffmpeg");
    fs::write(&p, LINKING_FFMPEG).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
}

fn refused_job(h: &Harness) -> (String, Value) {
    linking(h);
    let id = h.service().start(&h.config(json!({}))).unwrap();
    let job = h.finish_job(&id);
    (id, job)
}

const CLIP: &str = "RecentClips/2026-10-20_07-10-00-front.mp4";

#[test]
fn a_refused_clip_logs_its_name_and_why_and_the_snapshot_shows_it() {
    if !has_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 1, verify_ok: true, ..Default::default() });
    let (id, job) = refused_job(&h);
    let item = &job["items"][0];
    assert_eq!(item["relativePath"], CLIP);
    assert_eq!(item["state"], "failed");
    assert_eq!(item["failure"], json!({ "code": "unsafe-owned-path", "retryable": false, "detail": "regular-unaliased: nlink 2 != 1" }));
    // one line for the clip: its name, the check, what did not match
    let lines = logged(&format!("UNSAFE_OWNED_PATH clip \"{CLIP}\" ({id} item-000001) failed: regular-unaliased: nlink 2 != 1"));
    assert_eq!(lines.len(), 1, "{:?}", logged(&id));
    // the stored job keeps Node's format: no detail
    let stored = h.service().store().load(&id).unwrap().unwrap();
    assert!(stored.items[0].value()["failure"].get("detail").is_none());
}

#[test]
fn after_a_restart_the_snapshot_says_the_reason_is_not_known() {
    if !has_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 1, verify_ok: true, ..Default::default() });
    let (id, _) = refused_job(&h);
    // what a restart leaves: the stored failure, no detail in memory
    set_failure_detail(&id, "item-000001", None);
    let item = &h.service().get(&id).unwrap()["items"][0];
    assert_eq!(item["failure"], json!({ "code": "unsafe-owned-path", "retryable": false, "detail": DETAIL_NOT_KNOWN }));
    assert!(DETAIL_NOT_KNOWN.starts_with("not known"));
}

#[test]
fn a_retry_failed_that_cannot_clean_up_says_which_clip_stopped_it() {
    if !has_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 1, verify_ok: true, ..Default::default() });
    let (id, job) = refused_job(&h);
    assert_eq!(job["items"][0]["resultCode"], "cleanup-pending", "the linked candidate is kept");
    let e = h.service().retry_failed(&id).unwrap_err();
    assert_eq!(e.code.as_deref(), Some("RECOVERY_REQUIRED"));
    assert_eq!(logged(&format!("Retry failed refused: the files clip \"{CLIP}\" ({id} item-000001)")).len(), 1, "{:?}", logged(&id));
    // and why the files stayed: the cleanup's refusal, with the clip's name
    assert!(!logged(&format!("Cleanup kept the files of clip \"{CLIP}\" ({id} item-000001): UNSAFE_OWNED_PATH: remove-private-file: nlink 2 != 1")).is_empty(), "{:?}", logged(&id));
    // the clip still shows why it failed
    assert_eq!(h.service().get(&id).unwrap()["items"][0]["failure"]["detail"], "regular-unaliased: nlink 2 != 1");
}

#[test]
fn a_refusal_that_names_no_check_still_logs_and_says_so() {
    let job = format!("job-{}", crate::converter::jobstore::random_uuid().unwrap());
    let d = note_clip_refusal(&job, "item-000007", "SavedClips/e/x-back.mp4", &Fail::code("UNSAFE_OWNED_PATH"));
    assert_eq!(d, DETAIL_NOT_RECORDED);
    assert_eq!(failure_detail(&job, "item-000007").as_deref(), Some(DETAIL_NOT_RECORDED));
    assert_eq!(logged(&format!("UNSAFE_OWNED_PATH clip \"SavedClips/e/x-back.mp4\" ({job} item-000007) failed: {DETAIL_NOT_RECORDED}")).len(), 1);
}

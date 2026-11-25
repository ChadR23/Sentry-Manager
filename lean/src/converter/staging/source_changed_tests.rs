//! A clip whose original is not provably the version it was converted from
//! ends SOURCE_CHANGED and keeps the original. Each such refusal names the
//! check and what did not match (observed != recorded), and a metadata-only
//! change (ctime) while the original is first read is read once more and
//! taken only when the bytes are proven the same.

use super::tests::setup;
use super::*;
use std::os::unix::fs::PermissionsExt;

fn detail(e: &TxError) -> &str {
    assert_eq!(e.code, "SOURCE_CHANGED", "{e:?}");
    e.detail.as_deref().unwrap_or("")
}

fn base_name(env: &super::tests::Env) -> String {
    Path::new(&env.source).file_name().unwrap().to_string_lossy().into_owned()
}

fn with_hook<T>(hook: impl FnMut(&Path) + 'static, f: impl FnOnce() -> T) -> T {
    INSPECT_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(hook)));
    let r = f();
    INSPECT_HOOK.with(|h| *h.borrow_mut() = None);
    r
}

#[test]
fn a_second_link_left_by_an_earlier_replace_is_named() {
    let env = setup("sc-backup-link");
    let rec = env.recorder();
    let backup = env.footage.join(format!("BACKUP-{}", base_name(&env)));
    fs::hard_link(&env.source, &backup).unwrap();
    let e = env.tx.prepare_replacement(&env.op(&rec)).unwrap_err();
    let d = detail(&e);
    assert!(d.starts_with("source-identity: nlink 2 != 1 (also named \"BACKUP-2026-10-20_07-40-00-front.mp4\" (the Encoder's backup name for the original"), "{d}");
    assert_eq!(fs::read(&env.source).unwrap(), env.original, "the original is kept");
}

#[test]
fn a_second_link_elsewhere_says_it_is_not_in_the_folder() {
    let env = setup("sc-other-link");
    let rec = env.recorder();
    fs::hard_link(&env.source, env.root.join("elsewhere.mp4")).unwrap();
    let e = env.tx.prepare_replacement(&env.op(&rec)).unwrap_err();
    assert!(detail(&e).starts_with("source-identity: nlink 2 != 1 (no other name for it in its folder"), "{e:?}");
}

#[test]
fn a_replaced_resized_or_missing_original_says_which() {
    let env = setup("sc-replaced");
    let rec = env.recorder();
    let ino = env.expected.inode.clone();
    // (the same bytes in another file renamed over it: it cannot reuse the inode)
    let other = env.root.join("same-bytes.mp4");
    fs::write(&other, &env.original).unwrap();
    fs::rename(&other, &env.source).unwrap();
    let now = fs::symlink_metadata(&env.source).unwrap().ino();
    let e = env.tx.prepare_replacement(&env.op(&rec)).unwrap_err();
    assert_eq!(detail(&e), format!("source-identity: ino {now} != {ino}"));

    let env = setup("sc-resized");
    let rec = env.recorder();
    fs::OpenOptions::new().append(true).open(&env.source).unwrap().write_all_at(b"x", env.original.len() as u64).unwrap();
    let e = env.tx.prepare_replacement(&env.op(&rec)).unwrap_err();
    assert_eq!(detail(&e), format!("source-identity: size {} != {}", env.original.len() + 1, env.original.len()));

    // (a missing original is refused by the root check first; the identity check says why too)
    let env = setup("sc-missing");
    fs::remove_file(&env.source).unwrap();
    let e = env.tx.assert_source_identity(&env.source, &env.expected).unwrap_err();
    assert_eq!(detail(&e), "source-identity: lstat ENOENT (no file at its name now: moved or deleted)");
}

#[test]
fn an_original_rewritten_before_the_swap_says_its_bytes_differ() {
    let env = setup("sc-rewritten");
    let rec = env.recorder();
    let prepared = env.tx.prepare_replacement(&env.op(&rec)).unwrap();
    let mut rewritten = env.original.clone();
    rewritten[99] ^= 1;
    fs::OpenOptions::new().write(true).open(&env.source).unwrap().write_all_at(&rewritten, 0).unwrap();
    let e = env.tx.swap_replacement(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() }).unwrap_err();
    assert!(detail(&e).starts_with("link-backup: full hash: sha256 differs from record"), "{e:?}");
    assert_eq!(fs::read(&env.source).unwrap(), rewritten);
}

#[test]
fn without_hard_links_the_move_aside_keeps_its_reason() {
    let _hook = super::tests::OWNED_HOOK_LOCK.lock().unwrap();
    let env = setup("sc-nolinks");
    let tag = env.root.to_string_lossy().into_owned();
    let rec = env.recorder();
    let prepared = env.tx.prepare_replacement(&env.op(&rec)).unwrap();
    let mut rewritten = env.original.clone();
    rewritten[7] ^= 1;
    fs::OpenOptions::new().write(true).open(&env.source).unwrap().write_all_at(&rewritten, 0).unwrap();
    let t2 = tag.clone();
    *super::super::owned::TEST_HOOK.write().unwrap() = Some(std::sync::Arc::new(move |event: &str, from: &Path, _to: &Path| {
        if event == "link-before" && from.to_string_lossy().starts_with(&t2) {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "no links"));
        }
        Ok(())
    }));
    let r = env.tx.swap_replacement(&Op { prepared: Some(&prepared), persist: Some(&rec), ..Default::default() });
    *super::super::owned::TEST_HOOK.write().unwrap() = None;
    let e = r.unwrap_err();
    assert!(detail(&e).starts_with("move-original-aside: promote-no-replace: "), "{e:?}");
    assert!(detail(&e).contains("sha256 differs from record"), "{e:?}");
    assert_eq!(fs::read(&env.source).unwrap(), rewritten, "the original stays at its name");
}

#[test]
fn a_metadata_change_while_first_read_is_read_again_and_taken_when_the_same() {
    let env = setup("sc-ctime-once");
    let src = env.source.clone();
    let mut n = 0;
    let a = with_hook(
        move |p| {
            n += 1;
            if n == 1 && p == Path::new(&src) {
                // a permission change on the NAS while the clip is hashed: ctime only
                fs::set_permissions(&src, fs::Permissions::from_mode(0o640)).unwrap();
            }
        },
        || env.tx.capture_source(&env.source, None),
    )
    .unwrap();
    assert_eq!(a, env.expected, "the same version: bytes, size, device, inode");
}

#[test]
fn a_metadata_change_during_both_reads_is_refused_and_says_so() {
    let env = setup("sc-ctime-twice");
    let src = env.source.clone();
    let mut mode = 0o600;
    let e = with_hook(
        move |_| {
            mode ^= 0o040;
            fs::set_permissions(&src, fs::Permissions::from_mode(mode)).unwrap();
        },
        || env.tx.capture_source(&env.source, None),
    )
    .unwrap_err();
    let d = detail(&e);
    assert!(d.starts_with("capture-source: ctime_ns changed while hashed "), "{d}");
    assert!(d.contains("(dev, ino, size and mtime unchanged); read again: ctime_ns changed while hashed"), "{d}");
    assert!(d.ends_with("contents the same both times"), "{d}");
}

#[test]
fn bytes_rewritten_with_the_old_mtime_put_back_are_refused() {
    // a write that puts the old mtime back leaves only ctime changed: the
    // second read finds other bytes, so the first read's hash is not taken
    let env = setup("sc-ctime-bytes");
    let src = env.source.clone();
    let mut n = 0;
    let e = with_hook(
        move |_| {
            n += 1;
            if n == 1 {
                let old = fs::metadata(&src).unwrap().modified().unwrap();
                let f = fs::OpenOptions::new().write(true).open(&src).unwrap();
                f.write_all_at(b"Z", 10).unwrap();
                f.set_modified(old).unwrap();
            }
        },
        || env.tx.capture_source(&env.source, None),
    )
    .unwrap_err();
    let d = detail(&e);
    assert!(d.starts_with("capture-source: ctime_ns changed while hashed ") && d.ends_with("read again: its bytes differ (sha256)"), "{d}");
}

#[test]
fn a_write_while_first_read_says_what_changed() {
    let env = setup("sc-mtime");
    let src = env.source.clone();
    let e = with_hook(
        move |_| {
            let f = fs::OpenOptions::new().write(true).open(&src).unwrap();
            f.write_all_at(b"Z", 10).unwrap();
            f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(3)).unwrap();
        },
        || env.tx.capture_source(&env.source, None),
    )
    .unwrap_err();
    assert!(detail(&e).starts_with("capture-source: mtime_ns changed while hashed "), "{e:?}");
}

#[test]
fn other_codes_from_inspect_stay_strict_and_without_detail() {
    // (recovery's backup read: a ctime change while it is read is still refused)
    let env = setup("sc-recover-strict");
    let src = env.source.clone();
    let e = with_hook(
        move |_| fs::set_permissions(&src, fs::Permissions::from_mode(0o640)).unwrap(),
        || env.tx.inspect_exact_file(&env.source, None, "REPLACEMENT_FAILED"),
    )
    .err()
    .unwrap();
    assert_eq!((e.code.as_str(), e.detail.as_deref()), ("REPLACEMENT_FAILED", None));
}

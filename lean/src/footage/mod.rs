//! The footage area (PORT_PLAN.md): vehicles and shares, the scan, the
//! catalog and inventory, the Recycle Bin, cleanup policies, protect, stars
//! and the footage check. What it needs from the rest of the server is the
//! small `ctx::Ctx` trait.

mod names;
pub use names::*;

pub mod catalog;
pub mod inventory;
pub mod scanner;

pub mod bin;
pub mod deleted_clips;
pub mod integrity;
pub mod policies;
pub mod routes;
pub mod stars;

pub mod cars;
pub mod ctx;
pub mod js;
pub mod mdb;
pub mod safe_fs;
pub mod share;
pub mod smb;
pub mod tz;
pub mod vehicles;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

/// One vehicle's scan: one at a time, and how many have finished (a caller that waited
/// for a running one takes its answer, as inventory.js shares the scan's promise).
#[derive(Default)]
pub struct ScanLock {
    pub running: Mutex<()>,
    pub done: AtomicU64,
    /// why the last scan saw nothing, and the footage source it read, for a scan that waited for it
    pub failed: Mutex<Option<(String, ctx::Fail)>>,
    /// held while a scan's or a Recycle Bin move's files go into the state and the catalog, so
    /// neither writes over the other's newer files
    pub writing: Mutex<()>,
    /// files the Recycle Bin moved since the running scan began its walk, by footage source: not
    /// put back by a scan of that source
    pub moved: Mutex<std::collections::HashSet<(String, String)>>,
    /// Recycle Bin restores so far; and how many there had been when the running scan, and the
    /// last finished one, began walking: a scan that waited does not take the answer of one that
    /// walked before a restore
    pub restores: AtomicU64,
    pub walking_from: AtomicU64,
    pub walk_restores: AtomicU64,
}

/// The footage area's own state in the server (App.footage).
#[derive(Default)]
pub struct State {
    scans: Mutex<HashMap<String, Arc<ScanLock>>>,
    /// recycleBin.js locks: protect and trash take the same per-vehicle lock
    bin_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub integrity: integrity::Runs,
    /// smbTest.js: whether one runs, and when the last minute's started
    pub smb_test: Mutex<(bool, Vec<f64>)>,
    /// cleanups that met footage that cannot be read now: when each is tried again
    pub policy_retry: Mutex<HashMap<String, f64>>,
}

impl State {
    pub fn scan_lock(&self, vid: &str) -> Arc<ScanLock> {
        self.scans.lock().unwrap().entry(vid.to_string()).or_default().clone()
    }

    pub fn bin_lock(&self, vid: &str) -> Arc<Mutex<()>> {
        self.bin_locks.lock().unwrap().entry(vid.to_string()).or_default().clone()
    }
}

/// Four random bytes as hex (recycleBin.js item ids, stars ids take more).
pub fn random_hex(bytes: usize) -> String {
    use std::io::Read;
    let mut b = vec![0u8; bytes];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        let t = scanner::now_ms().to_bits() ^ (std::process::id() as u64) << 32;
        for (i, x) in b.iter_mut().enumerate() {
            *x = (t >> ((i % 8) * 8)) as u8;
        }
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

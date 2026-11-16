//! The viewer area: telemetry, speeds and the speed index, scrub previews,
//! clip filmstrips, moments, places and the map, drives and driving, the
//! event map, the place tags on recordings, background work limits and the
//! Studio viewer's routes. Handlers take the small `Ctx` trait (ctx.rs) for
//! what they need of the rest of the server; `glue.rs` implements it on
//! today's `App` until core lands.
//!
//! Its caches are the Node server's, in the same files under DATA_PATH, so
//! either server reads what the other wrote: speeds/, telemetry/, scrub/,
//! clip-thumbnails/, drive-data/.

pub mod archive_gap;
pub mod ctx;
pub mod drive_data;
pub mod drives;

pub mod js;
pub mod pace;
pub mod places;
pub mod recording_place;
pub mod routes;
pub mod scrub;
pub mod speed_index;
pub mod speed_reader;
pub mod studio;
pub mod telemetry_api;
#[cfg(test)]
pub mod testkit;
pub mod work_limits;

use ctx::Ctx;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

pub struct Viewer {
    pub ctx: Arc<dyn Ctx>,
    pub resources: work_limits::Resources,
    pub limits: Arc<RwLock<work_limits::Limits>>,
    pub pace: Arc<pace::Pace>,
    pub speed_index: Arc<speed_index::SpeedIndex>,
    pub telemetry: telemetry_api::Telemetry,
    pub scrub: Arc<scrub::ScrubFrames>,
    pub prepare: Arc<scrub::ScrubPrepare>,
    pub strips: Arc<studio::ClipStrips>,
    pub drive_data: Arc<drive_data::DriveData>,
    pub spots: places::EventSpots,
    pub archive: Arc<archive_gap::ArchiveGap>,
    /// CAN Bridge GPS for place tags and drive ends (the CAN index's minute files)
    pub can_gps: recording_place::CanGps,
}

static VIEWER: OnceLock<Arc<Viewer>> = OnceLock::new();

/// The running viewer (None before `start`).
pub fn get() -> Option<&'static Arc<Viewer>> {
    VIEWER.get()
}

impl Viewer {
    /// Everything with its limits; nothing runs until `start`.
    pub fn new(ctx: Arc<dyn Ctx>) -> Arc<Viewer> {
        let data = ctx.data_dir();
        let resources = work_limits::detect_resources();
        let limits = Arc::new(RwLock::new(work_limits::pick_limits(resources.clone(), ctx.setting("work-limits").as_ref())));
        let l = limits.read().unwrap().clone();
        eprintln!(
            "Background work: {} ({:.1} GB from the {}, {} CPUs from the {})",
            work_limits::KEYS.iter().map(|k| format!("{k} {}", l.get(k))).collect::<Vec<_>>().join(", "),
            resources.memory_bytes / 1024f64.powi(3),
            resources.memory_from,
            resources.cpus,
            resources.cpus_from
        );
        let limit = |key: &'static str| {
            let l = limits.clone();
            move || l.read().unwrap().get(key)
        };
        let busy_ctx = ctx.clone();
        let pace = Arc::new(pace::Pace::new(limit("speedIndex"), move || busy_ctx.busy(), crate::scanner::now_ms, pace::SleepLag::start()));
        let reads = limit("telemetryReads");
        let full = telemetry_api::Limiter::new(move || reads() as usize);
        let telemetry = telemetry_api::Telemetry::new(data.join("telemetry"), full.clone());
        let speed_index = speed_index::SpeedIndex::new(data.join("speeds"), ctx.clone(), pace.clone(), 100, full);
        let previews = limit("scrubPreviews");
        let scrub = scrub::ScrubFrames::new(data.join("scrub"), ctx.ffmpeg(), ctx.ffprobe(), move || previews() as usize);
        let (p2, busy2) = (pace.clone(), ctx.clone());
        let prepare = scrub::ScrubPrepare::new(ctx.clone(), scrub.clone(), scrub::ScrubPrepare::days_from_env(), move || !busy2.busy() && !p2.strained());
        let strips = studio::ClipStrips::new(data.join("clip-thumbnails"), ctx.ffmpeg(), ctx.ffprobe().unwrap_or_else(|| "ffprobe".into()));
        let drive_data = drive_data::DriveData::new(data.join("drive-data"), ctx.clone());
        let _ = std::fs::create_dir_all(data.join("converted"));
        let archive = archive_gap::ArchiveGap::new(ctx.clone(), speed_index.clone());
        let can_gps = recording_place::CanGps::new(data.join("can-index"));
        Arc::new(Viewer { ctx, resources, limits, pace, speed_index, telemetry, scrub, prepare, strips, drive_data, spots: places::EventSpots::default(), archive, can_gps })
    }

    /// Start the background work and make this the server's viewer: the pace's clock,
    /// a speed-index pass and the previews made ahead after every finished scan, and the
    /// place search's cache half a minute after start.
    pub fn start(ctx: Arc<dyn Ctx>) -> Arc<Viewer> {
        let v = Viewer::new(ctx);
        let _ = VIEWER.set(v.clone());
        v.pace.start();
        let w = v.clone();
        std::thread::Builder::new()
            .name("viewer-scans".into())
            .spawn(move || {
                let mut seen: HashMap<String, f64> = HashMap::new();
                loop {
                    for veh in w.ctx.vehicles() {
                        let Some(stamp) = w.ctx.scan_stamp(&veh.id) else { continue };
                        if seen.get(&veh.id) != Some(&stamp) {
                            seen.insert(veh.id.clone(), stamp);
                            w.speed_index.kick();
                            w.prepare.kick();
                            let (a, id) = (w.archive.clone(), veh.id.clone());
                            std::thread::spawn(move || a.check(&id));
                        }
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            })
            .ok();
        let w = v.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(30));
            let ids: Vec<String> = w.ctx.vehicles().into_iter().map(|v| v.id).collect();
            w.speed_index.warm(&ids, 20);
        });
        v
    }

    /// Footage is playing in the Viewer while this lives: background reading slows to one clip.
    pub fn watching(&self) -> pace::Watching {
        self.pace.viewer()
    }
}

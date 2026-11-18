//! Sentry USB checksums: the share's record of clip checksums
//! (server/originalChecksums.js, `record.rs`), the hasher that gives every
//! arrived clip a line (server/arrivalChecksums.js, `engine.rs`), the
//! converter's before-replace hook, Sentry USB's `holds` rule (`holds.rs`)
//! and the route logic (`routes.rs`). Library only: README.md here says how
//! the integrator mounts it.

pub mod ctx;
pub mod engine;
pub mod holds;
pub mod index;
pub mod js;
pub mod record;
pub mod routes;

#[cfg(test)]
mod tests;

pub use ctx::{ArrivalCtx, ArrivedFile, Car, InventoryView, KnownCodec};
pub use engine::{Arrival, Options};
pub use record::{Recorder, RecordError, RecordSink};

use std::path::Path;
use std::sync::Arc;

/// The area as index.js makes it: one Recorder (writes only inside a
/// vehicle's folder) shared by the converter's hook and the hasher, and the
/// hasher with its index under `<DATA>/arrival-checksums`.
pub struct Area {
    pub recorder: Arc<Recorder>,
    pub arrival: Arrival,
    ctx: Arc<dyn ArrivalCtx>,
}

impl Area {
    pub fn open(ctx: Arc<dyn ArrivalCtx>, data_path: &Path) -> Area {
        let c = ctx.clone();
        let l = ctx.clone();
        let recorder = Arc::new(Recorder::new(move |dir| c.vehicle_for_path(dir).is_some()).with_log(Arc::new(move |level, line| l.log_converter(level, line))));
        let arrival = Arrival::new(ctx.clone(), recorder.clone(), Options::new(data_path.join("arrival-checksums")));
        Area { recorder, arrival, ctx }
    }

    /// index.js `arrivalRef.start()`
    pub fn start(&self) {
        self.arrival.start();
    }

    /// The converter's `RuntimeOptions.before_replace_original`.
    pub fn before_replace_fn(&self) -> crate::converter::staging::BeforeReplaceFn {
        let ctx = self.ctx.clone();
        record::before_replace_fn(self.recorder.clone(), Arc::new(move |line| ctx.log_converter("error", line)))
    }

    /// For `ConverterCtx::before_replace_original` (the same hook, by call).
    pub fn before_replace_original(&self, source: &str, source_root: &str, sha256: &str) -> Result<(), String> {
        record::before_replace_original(&self.recorder, source, source_root, sha256, &|line| self.ctx.log_converter("error", line))
    }

    /// The converter's onClipConverted: our in-place output, never hashed.
    pub fn clip_converted(&self, output_path: &str) {
        let a = self.arrival.clone();
        let p = output_path.to_string();
        std::thread::spawn(move || a.converted(&p));
    }

    /// The inventory finished a scan (index.js onScanned, after sentryUsb.refresh).
    pub fn scanned(&self) {
        self.arrival.kick();
    }
}

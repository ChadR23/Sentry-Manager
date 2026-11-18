//! What the converter needs from core, until core lands (PORT_PLAN.md:
//! "<area>/ctx.rs"). The integrator implements this on core's AppState and
//! hands it to `ipc::Bridge::new` and `runtime::Converter::open`.

use std::path::PathBuf;

pub trait ConverterCtx: Send + Sync {
    /// The data folder (`DATA_PATH`): the job store is `<data>/converter-jobs`.
    fn data_path(&self) -> PathBuf;
    /// The converter's own local temp folder (Node: converterHost tempDir).
    fn temp_path(&self) -> PathBuf;
    fn ffmpeg_path(&self) -> String {
        "ffmpeg".into()
    }
    fn ffprobe_path(&self) -> String {
        "ffprobe".into()
    }
    /// The footage guard (server/safePath.js createRealGuard, as
    /// converterBridge's resolvePath): the real path of an allowed folder
    /// (a vehicle's share or an output folder), or None. `must_exist` is
    /// false only for a destination, which may not exist yet.
    fn resolve_path(&self, path: &str, must_exist: bool) -> Option<String>;
    /// Sentry USB (docs/sentry-usb.md): record the original's checksum on the
    /// share before it is replaced in place; an Err keeps the original.
    fn before_replace_original(&self, _source: &str, _source_root: &str, _sha256: &str, _size: u64) -> Result<(), String> {
        Ok(())
    }
    /// A clip was converted (thumbnails and previews refresh it).
    fn clip_converted(&self, _output_path: &str) {}
    /// The audit / log line ("Converter converter:start failed: ...").
    fn log_error(&self, line: &str) {
        eprintln!("{line}");
    }
    fn log_info(&self, line: &str) {
        eprintln!("{line}");
    }
}

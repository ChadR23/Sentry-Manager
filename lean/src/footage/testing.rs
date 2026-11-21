//! (tests) The footage area on core's database as the server has it: reads go to a connection
//! of their own, so `Db::fail_setting_reads` makes one fail there while writes go on.

use super::ctx::LocalCore;
use super::vehicles::{Options, Vehicles};
use crate::app::App;
use crate::core::db::Db;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

pub(crate) struct OnCore {
    pub dir: PathBuf,
    pub db: Arc<Db>,
    pub core: Arc<LocalCore>,
    pub app: Arc<App>,
}

impl Drop for OnCore {
    fn drop(&mut self) {
        self.app.vehicles.stop_all();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A folder vehicle "car" (not scanned).
pub(crate) fn on_core(name: &str) -> OnCore {
    let dir = std::env::temp_dir().join(format!("lean-oncore-{name}-{}-{}", std::process::id(), super::random_hex(3)));
    let _ = std::fs::remove_dir_all(&dir);
    let (footage, data) = (dir.join("footage"), dir.join("data"));
    std::fs::create_dir_all(footage.join("car")).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(dir.join("mountinfo"), "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n").unwrap();
    let db = Arc::new(Db::open(&data.join("manager.db")).unwrap());
    let core = Arc::new(LocalCore::on_core(db.clone(), &data));
    let vehicles = Vehicles::new(core.clone(), Options { footage_root: footage.clone(), folder_roots: vec![footage.clone()], protected_dirs: vec![data.clone()], mountinfo: dir.join("mountinfo"), default_tz: None });
    let catalog = crate::catalog::Catalog::open(&data.join("lean-catalog.sqlite")).unwrap();
    let app = App::new(vehicles, core.clone(), catalog, dir.clone(), crate::thumbnails::Thumbnails::new(data.join("thumbnails"), "ffmpeg".into(), 1));
    app.vehicles.add(&json!({ "id": "car", "name": "Car", "source": { "type": "path", "path": footage.join("car").to_string_lossy() } })).unwrap();
    for _ in 0..200 {
        if app.vehicles.share("car").is_some_and(|s| s.is_writable()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    OnCore { dir, db, core, app }
}

impl OnCore {
    /// The setting as kept (read on the shared connection, which the tests never break).
    pub fn kept(&self, key: &str) -> Option<serde_json::Value> {
        let text: Option<String> = crate::core::db::one(self.db.conn().query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))).unwrap();
        text.map(|t| serde_json::from_str(&t).unwrap())
    }

    /// The log lines that contain `part`.
    pub fn logged(&self, part: &str) -> usize {
        self.core.logs.lock().unwrap().iter().filter(|l| l.contains(part)).count()
    }
}

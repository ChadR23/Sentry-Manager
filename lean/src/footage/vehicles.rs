//! Vehicles (a port of server/vehicles.js): each has its own footage source,
//! an SMB share mounted at <footage root>/<id> or a folder already mounted
//! into the container, and its own Share keeping it healthy. They are kept
//! in the manager database's `vehicles` setting, as the Node server keeps
//! them.
//!
//! A folder vehicle must live under one of the folder roots (/footage, and
//! FOLDER_ROOTS and FOOTAGE_PATH) and can never be, contain or sit inside
//! the manager's own data, the app or system folders; no two vehicles may
//! share or nest inside each other's folders.

use super::ctx::{Ctx, Fail, Level, Res};
use super::js;
use super::share::{Share, ShareEvent};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

const SYSTEM_DIRS: [&str; 7] = ["/proc", "/sys", "/dev", "/etc", "/root", "/run", "/boot"];
/// the mount point of Settings > Test connection (smbTest.js)
pub const TEST_ID: &str = "x-smb-test";

/// A vehicle as the rest of the server uses it.
#[derive(Debug, Clone)]
pub struct Vehicle {
    pub id: String,
    pub name: String,
    pub timezone: String,
    /// where its footage is inside the container (vehicles.js rootOf)
    pub root: PathBuf,
    /// { type: 'path', path } or the SMB source (with its password)
    pub source: Value,
    /// the record as stored in the `vehicles` setting
    pub raw: Value,
}

impl Vehicle {
    pub fn is_smb(&self) -> bool {
        self.source.get("type").and_then(Value::as_str) != Some("path")
    }

    /// The footage this vehicle's scans read: its folder, and for a share which share (a share is
    /// mounted on the same folder whichever it is). What is known of one is not used for another.
    pub fn source_key(&self) -> String {
        let root = self.root.to_string_lossy();
        if !self.is_smb() {
            return root.into_owned();
        }
        let s = |k: &str| self.source.get(k).map_or(String::new(), |v| v.as_str().map_or_else(|| v.to_string(), String::from));
        format!("{root} (SMB {} port {})", s("share"), s("port"))
    }
}

/// A plain folder vehicle (tests, tools).
pub fn folder_vehicle(id: &str, name: &str, timezone: &str, root: PathBuf) -> Vehicle {
    let source = json!({ "type": "path", "path": root.to_string_lossy() });
    let raw = json!({ "id": id, "name": name, "timezone": timezone, "source": source, "car": { "model": "auto", "generation": "auto" }, "createdAt": 0 });
    Vehicle { id: id.into(), name: name.into(), timezone: timezone.into(), root, source, raw }
}

/// safePath.js isInside
pub fn is_inside(abs: &Path, root: &Path) -> bool {
    abs == root || abs.starts_with(root)
}

fn real_or(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn bad(m: impl Into<String>) -> Fail {
    Fail::new(400, m)
}

/// The shallowest folder at most three levels down with clip folders in it, preferring one
/// called TeslaCam (vehicles.js findClipRoot); else None.
pub fn find_clip_root(root: &Path) -> Option<PathBuf> {
    crate::app::find_clip_root(root)
}

pub struct Options {
    pub footage_root: PathBuf,
    pub folder_roots: Vec<PathBuf>,
    pub protected_dirs: Vec<PathBuf>,
    pub mountinfo: PathBuf,
    /// process.env.TZ (the default time zone of a new vehicle)
    pub default_tz: Option<String>,
}

impl Options {
    /// As index.js makes them: FOOTAGE_ROOT, FOLDER_ROOTS, FOOTAGE_PATH; the data, app and run folders protected.
    pub fn from_env(data: &Path, app_root: &Path) -> Options {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let footage_root = super::safe_fs::resolve(Path::new(&env("FOOTAGE_ROOT").unwrap_or_else(|| "/footage".into())));
        let mut folder_roots = vec![footage_root.clone()];
        folder_roots.extend(env("FOLDER_ROOTS").unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
        if let Some(p) = env("FOOTAGE_PATH") {
            folder_roots.push(PathBuf::from(p));
        }
        let run = env("RUN_DIR").unwrap_or_else(|| "/run/sentry-six-manager".into());
        Options {
            footage_root,
            folder_roots,
            protected_dirs: vec![data.to_path_buf(), app_root.to_path_buf(), PathBuf::from(run)],
            mountinfo: PathBuf::from("/proc/self/mountinfo"),
            default_tz: env("TZ"),
        }
    }
}

pub enum VehicleEvent {
    /// the list changed (announce 'vehicles')
    Changed,
    /// a share's status changed
    Status(String),
    /// a share became healthy or stopped being so
    Health(String, bool),
}

pub struct Vehicles {
    ctx: Arc<dyn Ctx>,
    footage_root: PathBuf,
    folder_roots: Vec<PathBuf>,
    protected_dirs: Vec<PathBuf>,
    mountinfo: PathBuf,
    default_tz: Option<String>,
    shares: RwLock<HashMap<String, Arc<Share>>>,
    studio_roots: Mutex<HashMap<String, (PathBuf, PathBuf, f64)>>,
    events: OnceLock<Box<dyn Fn(VehicleEvent) + Send + Sync>>,
    /// one add / update / remove at a time
    edit: Mutex<()>,
}

fn of_raw(raw: &Value, footage_root: &Path) -> Option<Vehicle> {
    let id = raw.get("id")?.as_str()?.to_string();
    let source = raw.get("source").cloned().unwrap_or(json!({}));
    let root = if source.get("type").and_then(Value::as_str) == Some("path") {
        PathBuf::from(source.get("path").and_then(Value::as_str).unwrap_or(""))
    } else {
        footage_root.join(&id)
    };
    Some(Vehicle {
        name: raw.get("name").map(js::string).unwrap_or_default(),
        timezone: raw.get("timezone").and_then(Value::as_str).unwrap_or("UTC").to_string(),
        id,
        root,
        source,
        raw: raw.clone(),
    })
}

impl Vehicles {
    pub fn new(ctx: Arc<dyn Ctx>, o: Options) -> Arc<Vehicles> {
        let mut protected = o.protected_dirs;
        protected.extend(SYSTEM_DIRS.iter().map(PathBuf::from));
        Arc::new(Vehicles {
            ctx,
            footage_root: o.footage_root,
            folder_roots: o.folder_roots.iter().map(|r| super::safe_fs::resolve(r)).collect(),
            protected_dirs: protected.iter().map(|d| super::safe_fs::resolve(d)).collect(),
            mountinfo: o.mountinfo,
            default_tz: o.default_tz,
            shares: RwLock::new(HashMap::new()),
            studio_roots: Mutex::new(HashMap::new()),
            events: OnceLock::new(),
            edit: Mutex::new(()),
        })
    }

    /// Where share and list events go (set once, by the server).
    pub fn on_event(&self, f: impl Fn(VehicleEvent) + Send + Sync + 'static) {
        let _ = self.events.set(Box::new(f));
    }

    fn emit(&self, e: VehicleEvent) {
        if let Some(f) = self.events.get() {
            f(e);
        }
    }

    pub fn footage_root(&self) -> &Path {
        &self.footage_root
    }

    fn raw_list(&self) -> Vec<Value> {
        match self.ctx.db().get("vehicles") {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        }
    }

    pub fn list(&self) -> Vec<Vehicle> {
        self.raw_list().iter().filter_map(|r| of_raw(r, &self.footage_root)).collect()
    }

    pub fn get(&self, id: &str) -> Option<Vehicle> {
        self.list().into_iter().find(|v| v.id == id)
    }

    fn save(&self, list: &[Value]) {
        self.ctx.db().set("vehicles", &Value::Array(list.to_vec()));
    }

    /// checkFolder: refused unless a folder vehicle at `p` is allowed (see the top).
    pub fn check_folder(&self, p: &str, ignore: Option<&str>) -> Res<()> {
        let abs = super::safe_fs::resolve(Path::new(p));
        let real = real_or(&abs);
        let in_root = self.folder_roots.iter().any(|r| is_inside(&abs, r) && is_inside(&real, &real_or(r)));
        if !in_root {
            let roots: Vec<String> = self.folder_roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
            return Err(bad(format!("Folder vehicles must be inside {} (mount the folder there with a Docker volume).", roots.join(" or "))));
        }
        for d in &self.protected_dirs {
            for x in [&abs, &real] {
                if is_inside(x, d) || is_inside(d, x) {
                    return Err(bad(format!("A vehicle cannot use {p}: it overlaps {}.", d.display())));
                }
            }
        }
        self.check_overlap(&abs, ignore)
    }

    fn check_overlap(&self, root: &Path, ignore: Option<&str>) -> Res<()> {
        for v in self.list() {
            if Some(v.id.as_str()) == ignore {
                continue;
            }
            if is_inside(root, &v.root) || is_inside(&v.root, root) {
                return Err(bad(format!("That folder overlaps the footage of {} ({}).", v.name, v.root.display())));
            }
        }
        Ok(())
    }

    /// normalizeVehicle: { name, timezone, source, car } from what the page sent.
    pub fn normalize(&self, input: &Value, existing: Option<&Value>) -> Res<Map<String, Value>> {
        let ex = |k: &str| existing.and_then(|e| e.get(k));
        let name_raw = js::nn(input.get("name")).or_else(|| js::nn(ex("name"))).map(js::string).unwrap_or_default();
        let name = crate::app::vehicle_name(&name_raw).ok_or_else(|| bad("Give the vehicle a name."))?;
        let tz_raw = js::nn(input.get("timezone")).or_else(|| js::nn(ex("timezone"))).map(js::string).or_else(|| self.default_tz.clone()).unwrap_or_else(|| "UTC".into());
        let timezone = Some(js::trim(&tz_raw).to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| "UTC".into());
        if !super::tz::valid(&timezone) {
            return Err(bad(format!("Unknown time zone \"{timezone}\".")));
        }
        let empty = json!({});
        let src = js::nn(input.get("source")).or_else(|| js::nn(ex("source"))).unwrap_or(&empty);
        let source = if src.get("type").and_then(Value::as_str) == Some("path") {
            let p = js::trim(&if js::truthy(src.get("path")) { js::string(&src["path"]) } else { String::new() }).to_string();
            if !p.starts_with('/') || p.contains('\0') {
                return Err(bad("The folder must be an absolute path inside the container, e.g. /footage/car."));
            }
            json!({ "type": "path", "path": super::safe_fs::resolve(Path::new(&p)).to_string_lossy() })
        } else {
            let prev = ex("source").filter(|s| s.get("type").and_then(Value::as_str) == Some("smb"));
            super::smb::normalize_smb(src, prev)?
        };
        let car = super::cars::normalize_car(js::nn(input.get("car")).or_else(|| js::nn(ex("car"))));
        let mut out = Map::new();
        out.insert("name".into(), json!(name));
        out.insert("timezone".into(), json!(timezone));
        out.insert("source".into(), source);
        out.insert("car".into(), car);
        Ok(out)
    }

    pub fn add(self: &Arc<Self>, input: &Value) -> Res<Vehicle> {
        let _e = self.edit.lock().unwrap();
        let vehicle = self.normalize(input, None)?;
        let is_path = vehicle["source"]["type"] == "path";
        if is_path {
            self.check_folder(vehicle["source"]["path"].as_str().unwrap_or(""), None)?;
        }
        let mut taken: Vec<String> = self.list().into_iter().map(|v| v.id).collect();
        taken.push(TEST_ID.into());
        let free = |id: &str| !taken.iter().any(|t| t == id) && (is_path || self.check_overlap(&self.footage_root.join(id), None).is_ok());
        let name = vehicle["name"].as_str().unwrap_or("").to_string();
        let from = if js::truthy(input.get("id")) { js::string(&input["id"]) } else { name.clone() };
        let mut id = crate::app::slug(&from);
        let id_ok = |s: &str| {
            let b = s.as_bytes();
            !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        };
        if !id_ok(&id) {
            id = "vehicle".into();
        }
        let mut n = 2;
        while !free(&id) {
            if n > 1000 {
                return Err(bad(format!("A share needs a folder of its own below {}, but another vehicle uses all of it.", self.footage_root.display())));
            }
            id = format!("{}-{n}", crate::app::slug(&name).chars().take(36).collect::<String>());
            n += 1;
        }
        let mut full = Map::new();
        full.insert("id".into(), json!(id));
        full.extend(vehicle);
        full.insert("createdAt".into(), json!(js::now() as i64));
        let full = Value::Object(full);
        let mut list = self.raw_list();
        list.push(full.clone());
        self.save(&list);
        let v = of_raw(&full, &self.footage_root).unwrap();
        self.start_share(&v);
        self.emit(VehicleEvent::Changed);
        Ok(v)
    }

    /// The mount table this server reads (/proc/self/mountinfo).
    pub fn mountinfo(&self) -> &std::path::Path {
        &self.mountinfo
    }

    pub fn update(self: &Arc<Self>, id: &str, input: &Value) -> Res<Vehicle> {
        let _e = self.edit.lock().unwrap();
        let existing = self.get(id).ok_or_else(|| Fail::new(404, "No such vehicle."))?;
        let mut next = existing.raw.as_object().cloned().unwrap_or_default();
        next.extend(self.normalize(input, Some(&existing.raw))?);
        if next["source"]["type"] == "path" {
            self.check_folder(next["source"]["path"].as_str().unwrap_or(""), Some(id))?;
        } else {
            self.check_overlap(&self.footage_root.join(id), Some(id))?;
        }
        let next = Value::Object(next);
        let list: Vec<Value> = self.raw_list().into_iter().map(|v| if v.get("id").and_then(Value::as_str) == Some(id) { next.clone() } else { v }).collect();
        self.save(&list);
        let v = of_raw(&next, &self.footage_root).unwrap();
        if next["source"].to_string() != existing.source.to_string() {
            self.stop_share(id);
            self.start_share(&v);
        }
        self.emit(VehicleEvent::Changed);
        Ok(v)
    }

    /// Forget a vehicle. Its footage is never touched.
    pub fn remove(&self, id: &str) -> Res<()> {
        let _e = self.edit.lock().unwrap();
        if self.get(id).is_none() {
            return Err(Fail::new(404, "No such vehicle."));
        }
        self.stop_share(id);
        let list: Vec<Value> = self.raw_list().into_iter().filter(|v| v.get("id").and_then(Value::as_str) != Some(id)).collect();
        self.save(&list);
        self.emit(VehicleEvent::Changed);
        Ok(())
    }

    fn start_share(self: &Arc<Self>, v: &Vehicle) {
        let smb = v.is_smb().then(|| v.source.clone());
        let me = Arc::downgrade(self);
        let share = Share::new(&v.id, v.root.clone(), smb, self.ctx.clone(), self.mountinfo.clone(), Box::new(move |id, e| {
            if let Some(me) = me.upgrade() {
                match e {
                    ShareEvent::Status => me.emit(VehicleEvent::Status(id.to_string())),
                    ShareEvent::Health(h) => me.emit(VehicleEvent::Health(id.to_string(), h)),
                }
            }
        }));
        self.shares.write().unwrap().insert(v.id.clone(), share.clone());
        share.start();
    }

    fn stop_share(&self, id: &str) {
        let share = self.shares.write().unwrap().remove(id);
        if let Some(s) = share {
            s.stop();
        }
    }

    pub fn start_all(self: &Arc<Self>) {
        for v in self.list() {
            if !self.shares.read().unwrap().contains_key(&v.id) {
                self.start_share(&v);
            }
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.shares.read().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop_share(&id);
        }
    }

    pub fn share(&self, id: &str) -> Option<Arc<Share>> {
        self.shares.read().unwrap().get(id).cloned()
    }

    /// Create the vehicle of SMB_SHARE / FOOTAGE_PATH on the first start.
    pub fn bootstrap_from_env(self: &Arc<Self>) {
        if !self.raw_list().is_empty() {
            return;
        }
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let name = env("VEHICLE_NAME").unwrap_or_else(|| "My car".into());
        let tz = env("TZ").unwrap_or_else(|| "UTC".into());
        let input = if let Some(share) = env("SMB_SHARE") {
            if env("SMB_OPTIONS").is_some() {
                self.ctx.log("vehicles", Level::Warn, "SMB_OPTIONS is no longer used: mount options are fixed for security (see README).");
            }
            let mut src = json!({ "type": "smb", "share": share, "username": env("SMB_USERNAME").unwrap_or_default(), "password": env("SMB_PASSWORD").unwrap_or_default(),
                "domain": env("SMB_DOMAIN").unwrap_or_default(), "encrypt": std::env::var("SMB_ENCRYPT").ok().as_deref() != Some("false") });
            if let Some(v) = env("SMB_VERSION") {
                src["version"] = json!(v);
            }
            if let Some(p) = env("SMB_PORT") {
                src["port"] = json!(p);
            }
            json!({ "name": name, "timezone": tz, "source": src })
        } else if let Some(p) = env("FOOTAGE_PATH").filter(|p| Path::new(p).exists()) {
            json!({ "name": name, "timezone": tz, "source": { "type": "path", "path": p } })
        } else {
            return;
        };
        if let Err(e) = self.add(&input) {
            self.ctx.log("vehicles", Level::Error, &format!("Could not create the vehicle from the environment: {}", e.message));
        }
    }

    /// The folder Sentry Studio opens for a vehicle (kept a minute).
    pub fn studio_root(&self, v: &Vehicle) -> PathBuf {
        let now = js::now();
        if let Some((root, value, at)) = self.studio_roots.lock().unwrap().get(&v.id) {
            if *root == v.root && now - at < 60_000.0 {
                return value.clone();
            }
        }
        let value = find_clip_root(&v.root).unwrap_or_else(|| v.root.clone());
        self.studio_roots.lock().unwrap().insert(v.id.clone(), (v.root.clone(), value.clone(), now));
        value
    }

    /// publicView: no password, plus the live share status.
    pub fn public_view(&self, v: &Vehicle) -> Map<String, Value> {
        let mut source = v.source.as_object().cloned().unwrap_or_default();
        if source.get("type").and_then(Value::as_str) == Some("smb") {
            source.insert("passwordSet".into(), json!(js::truthy(source.get("password"))));
            let enc = source.get("encrypt") != Some(&Value::Bool(false));
            source.insert("encrypt".into(), json!(enc));
            source.shift_remove("password");
            source.shift_remove("options");
        }
        let mut out = Map::new();
        out.insert("id".into(), json!(v.id));
        out.insert("name".into(), json!(v.name));
        out.insert("timezone".into(), json!(v.timezone));
        out.insert("source".into(), Value::Object(source));
        out.insert("root".into(), json!(v.root.to_string_lossy()));
        out.insert("studioRoot".into(), json!(self.studio_root(v).to_string_lossy()));
        out.insert("share".into(), self.share(&v.id).map_or(Value::Null, |s| s.status()));
        out
    }

    /// Every vehicle folder, with where it must really be to count (safePath createRealGuard).
    pub fn roots(&self) -> Vec<(PathBuf, Vec<PathBuf>)> {
        self.list().into_iter().map(|v| {
            let within = if v.is_smb() { vec![self.footage_root.clone()] } else { self.folder_roots.clone() };
            (v.root, within)
        }).collect()
    }

    pub fn vehicle_for_path(&self, p: &Path) -> Option<Vehicle> {
        let abs = super::safe_fs::resolve(p);
        self.list().into_iter().find(|v| is_inside(&abs, &v.root))
    }
}

/// index.js describeSource (audit lines)
pub fn describe_source(src: &Value) -> String {
    let s = |k: &str| src.get(k).map(js::string).unwrap_or_else(|| "undefined".into());
    if src.get("type").and_then(Value::as_str) == Some("path") {
        format!("folder {}", s("path"))
    } else {
        format!("SMB {} as {} (SMB {}, {})", s("share"), s("username"), s("version"), if src.get("encrypt") == Some(&Value::Bool(false)) { "signed only" } else { "encrypted" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::footage::ctx::LocalCore;

    #[test]
    fn a_vehicle_s_source_is_its_folder_and_for_a_share_which_share() {
        let folder = folder_vehicle("car", "Car", "UTC", PathBuf::from("/footage/car"));
        assert_eq!(folder.source_key(), "/footage/car");
        let share = |s: &str| Vehicle { source: json!({ "type": "smb", "share": s, "username": "u", "password": "secret", "port": null }), ..folder_vehicle("nas", "NAS", "UTC", PathBuf::from("/footage/nas")) };
        assert_ne!(share("//nas/cam").source_key(), share("//nas2/cam").source_key(), "another share mounted on the same folder");
        assert_eq!(share("//nas/cam").source_key(), share("//nas/cam").source_key());
        assert!(!share("//nas/cam").source_key().contains("secret"));
    }

    fn manager(dir: &Path) -> Arc<Vehicles> {
        let ctx: Arc<dyn Ctx> = Arc::new(LocalCore::memory());
        Vehicles::new(ctx, Options {
            footage_root: dir.join("footage"),
            folder_roots: vec![dir.join("footage")],
            protected_dirs: vec![dir.join("footage/data")],
            mountinfo: dir.join("no-mountinfo"),
            default_tz: None,
        })
    }

    #[test]
    fn folder_vehicles_and_their_checks() {
        let dir = std::env::temp_dir().join(format!("lean-vehicles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for d in ["footage/a", "footage/b/c", "footage/data", "outside"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        let m = manager(&dir);
        let path = |p: &str| dir.join(p).to_string_lossy().into_owned();
        let a = m.add(&json!({ "name": "  Daily Driver ", "source": { "type": "path", "path": path("footage/a") } })).unwrap();
        assert_eq!((a.id.as_str(), a.name.as_str(), a.timezone.as_str()), ("daily-driver", "Daily Driver", "UTC"));
        // the same name: the next free id
        let b = m.add(&json!({ "name": "Daily Driver", "source": { "type": "path", "path": path("footage/b") } })).unwrap();
        assert_eq!(b.id, "daily-driver-2");
        let err = |input: Value| m.add(&input).unwrap_err().message;
        assert_eq!(err(json!({ "name": "x", "source": { "type": "path", "path": path("footage/b/c") } })), format!("That folder overlaps the footage of Daily Driver ({}).", path("footage/b")));
        assert_eq!(err(json!({ "name": "x", "source": { "type": "path", "path": path("outside") } })), format!("Folder vehicles must be inside {} (mount the folder there with a Docker volume).", path("footage")));
        assert!(err(json!({ "name": "x", "source": { "type": "path", "path": path("footage/data") } })).contains("it overlaps"));
        assert_eq!(err(json!({ "name": " ", "source": { "type": "path", "path": path("footage/a") } })), "Give the vehicle a name.");
        assert_eq!(err(json!({ "name": "x", "timezone": "Mars/Base" })), "Unknown time zone \"Mars/Base\".");
        assert_eq!(err(json!({ "name": "x", "source": { "type": "path", "path": "rel" } })), "The folder must be an absolute path inside the container, e.g. /footage/car.");
        // an SMB vehicle: its folder is <footage root>/<id>, its password never shown
        let s = m.add(&json!({ "name": "NAS", "source": { "share": "//nas/cam", "username": "u", "password": "secret" } })).unwrap();
        assert_eq!(s.root, dir.join("footage/nas"));
        let view = m.public_view(&s);
        assert_eq!(view["source"].to_string(), r#"{"type":"smb","share":"//nas/cam","username":"u","domain":"","version":"3.1.1","encrypt":true,"port":null,"passwordSet":true}"#);
        // update keeps the stored password and the record's key order
        let u = m.update("nas", &json!({ "name": "NAS 2", "source": { "share": "//nas/cam", "username": "u", "encrypt": false } })).unwrap();
        assert_eq!(u.source["password"], "secret");
        assert_eq!(u.raw.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["id", "name", "timezone", "source", "car", "createdAt"]);
        assert_eq!(m.update("nope", &json!({})).unwrap_err().status, 404);
        m.remove("nas").unwrap();
        assert_eq!(m.list().len(), 2);
        assert_eq!(m.remove("nas").unwrap_err().message, "No such vehicle.");
        m.stop_all();
        assert_eq!(describe_source(&s.source), "SMB //nas/cam as u (SMB 3.1.1, encrypted)");
    }
}

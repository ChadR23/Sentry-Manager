//! Persisted per-vehicle device choices and background speed tests. The auto
//! tick owns execution; reading state never starts work and needs no browser.
use super::*;

pub trait Backend: Send + Sync {
    fn devices(&self) -> Vec<Value>;
    fn run(&self, config: &Value, requested: bool, progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String>;
}

const FILE: &str = "speed-tests.json";

fn device_settings(c: &Value) -> Value {
    json!({"lanes":c.get("lanes"),"concurrency":c.get("concurrency").cloned().unwrap_or(json!(1))})
}

fn profile(c: &Value) -> Value {
    json!([c["codec"],c["profileId"],c["bitrateKbps"],c["qualityLevel"],c["verifyMode"]])
}

pub fn fingerprint(devices: &[Value]) -> String {
    use sha2::{Digest, Sha256};
    // Stable device identity, not enumeration order or a reboot's render-node index.
    let mut list: Vec<String> = devices.iter().filter(|d| d["kind"] != "node")
        .map(|d| json!([d["id"],d["kind"],d["vendor"],d["pci"],d["name"]]).to_string()).collect();
    list.sort();
    super::super::tesla_sei::hex(&Sha256::digest(list.join("\n").as_bytes()))
}

impl Auto {
    pub fn install_speed_backend(&self, backend: Arc<dyn Backend>) {
        *self.speed_backend.lock().unwrap() = Some(backend);
    }

    fn save_speed(&self) -> Result<(), String> {
        // Serialize capture and write so concurrent settings/progress writes cannot
        // race on the temporary file or replace a newer state with an older one.
        let _write = self.speed_write.lock().unwrap();
        let data = self.lock().status.get("speedTests").cloned();
        if let Some(data) = data { self.write_json(FILE, &data).map_err(|e| super::super::owned::code_of(&e).to_string())?; }
        Ok(())
    }

    pub(super) fn load_speed(&self) {
        if let Some(mut data) = self.read_json(FILE).filter(Value::is_object) {
            for entry in data.as_object_mut().unwrap().values_mut() {
                if entry["phase"] == "running" {
                    entry["phase"] = json!("cancelled");
                    entry["reason"] = json!("The server restarted during the speed test. Existing settings were kept.");
                }
            }
            self.lock().status["speedTests"] = data;
        }
    }

    pub(super) fn note_speed_settings(&self, config: &Value, explicit: bool) {
        let Some(root) = config["sourceRoot"].as_str() else { return };
        let settings = device_settings(config);
        let mut s = self.lock();
        let old = s.status["speedTests"][root].clone();
        let chosen = config["lanes"].as_array().is_some_and(|a| !a.is_empty()) || settings["concurrency"] != 1;
        if !explicit && old.is_null() && !chosen { return; }
        if !s.status["speedTests"].is_object() { s.status["speedTests"] = json!({}); }
        if !s.status["speedTests"][root].is_object() { s.status["speedTests"][root] = json!({}); }
        let entry = &mut s.status["speedTests"][root];
        if explicit || old.is_null() || (old.get("deviceSettings").is_some() && old["deviceSettings"] != settings) {
            entry["settingsSource"] = json!("user");
        }
        entry["deviceSettings"] = settings;
        if old["phase"] == "done" && old["result"]["profile"] != profile(config) {
            entry["phase"] = json!("stale");
            entry["reason"] = json!("The space level or verification setting changed. Test again for this setup.");
        }
        drop(s);
        let _ = self.save_speed();
    }

    fn speed_config(s: &Inner, root: &str) -> Option<Value> {
        Self::config_for(s, root).or_else(|| s.saved.iter().find(|c| c["sourceRoot"] == root).cloned())
    }

    pub(super) fn inherit_speed_source(&self, config: &mut Value) {
        let root = config["sourceRoot"].as_str().unwrap_or("");
        let s = self.lock();
        let e = &s.status["speedTests"][root];
        let tested = e["settingsSource"] == "test" && e["deviceSettings"] == device_settings(config);
        config.as_object_mut().unwrap().shift_remove("deviceSettingsSource");
        if tested { config["deviceSettingsSource"] = json!("test"); }
    }

    pub fn request_speed_test(self: &Arc<Self>, root: &str) -> Result<Value, String> {
        if self.speed_backend.lock().unwrap().is_none() { return Err("SPEED_TEST_UNAVAILABLE".into()); }
        {
            let mut s = self.lock();
            let c = Self::speed_config(&s, root).ok_or("SPEED_TEST_SETUP_REQUIRED")?;
            if c["codec"] != "h265" { return Err("SPEED_TEST_REQUIRES_H265".into()); }
            if ["queued","waiting","running"].contains(&s.status["speedTests"][root]["phase"].as_str().unwrap_or("")) {
                return Ok(Self::state_of(&s));
            }
            if !s.status["speedTests"].is_object() { s.status["speedTests"] = json!({}); }
            if !s.status["speedTests"][root].is_object() {
                s.status["speedTests"][root] = json!({"settingsSource":"default","deviceSettings":device_settings(&c)});
            }
            let e = &mut s.status["speedTests"][root];
            e["phase"] = json!("queued"); e["source"] = json!("requested"); e["reason"] = Value::Null;
        }
        self.save_speed()?;
        self.tick_soon();
        Ok(self.get_state())
    }

    pub fn apply_speed_test(&self, root: &str) -> Result<Value, String> {
        self.apply_speed_result(root, false)
    }

    fn apply_speed_result(&self, root: &str, automatic: bool) -> Result<Value, String> {
        let _edit = self.settings_edit.lock().unwrap();
        let backend = self.speed_backend.lock().unwrap().clone().ok_or("SPEED_TEST_UNAVAILABLE")?;
        let fp = fingerprint(&backend.devices());
        let mut s = self.lock();
        let mut c = Self::speed_config(&s, root).ok_or("SPEED_TEST_SETUP_REQUIRED")?;
        let e = s.status["speedTests"][root].clone();
        if (automatic && e["settingsSource"] == "user") || e["phase"] != "done" || e["result"]["profile"] != profile(&c) || e["result"]["fingerprint"] != fp {
            return Err("SPEED_TEST_STALE".into());
        }
        let devices = e["result"]["devices"].as_array().ok_or("SPEED_TEST_FAILED")?;
        let lanes = json!(devices.iter().map(|d| json!({"device":d["id"],"concurrency":d["concurrency"]})).collect::<Vec<_>>());
        let lanes = normalize_lanes(&lanes).map_err(|e| e.code)?.ok_or("SPEED_TEST_FAILED")?;
        c["concurrency"] = json!(lanes_total(&lanes)); c["lanes"] = lanes;
        c["deviceSettingsSource"] = json!("test");
        let mut settings = s.settings.clone();
        if let Some(slot) = settings["configs"].as_array_mut().unwrap().iter_mut().find(|v| v["sourceRoot"] == root) {
            *slot = c.clone();
            self.write_json(SETTINGS_FILE, &settings).map_err(|e| super::super::owned::code_of(&e).to_string())?;
            s.settings = settings;
        } else {
            let mut saved = s.saved.clone();
            *saved.iter_mut().find(|v| v["sourceRoot"] == root).ok_or("SPEED_TEST_SETUP_REQUIRED")? = c.clone();
            self.write_json(SAVED_FILE, &json!(saved)).map_err(|e| super::super::owned::code_of(&e).to_string())?;
            s.saved = saved;
        }
        s.status["speedTests"][root]["settingsSource"] = json!("test");
        s.status["speedTests"][root]["deviceSettings"] = device_settings(&c);
        drop(s);
        self.save_speed()?;
        self.changed();
        Ok(self.get_state())
    }

    /// Called under the auto tick's mutex. While the synchronous backend runs,
    /// no scheduler tick can start or resume work; its service lease also bars
    /// owner commands. The tick itself already lives off the HTTP/page thread.
    pub(super) fn speed_tick(&self) -> bool {
        let Some(backend) = self.speed_backend.lock().unwrap().clone() else { return false };
        let fp = fingerprint(&backend.devices());
        let configs = self.lock().settings["configs"].as_array().cloned().unwrap_or_default();
        {
            let mut s = self.lock();
            let roots: Vec<String> = s.status["speedTests"].as_object().into_iter().flatten().map(|(r,_)| r.clone()).collect();
            for root in roots {
                if Self::speed_config(&s, &root).is_none() {
                    s.status["speedTests"].as_object_mut().unwrap().shift_remove(&root);
                } else if Self::config_for(&s, &root).is_none() {
                    let e = &mut s.status["speedTests"][&root];
                    if e["source"] == "automatic" && ["queued","waiting"].contains(&e["phase"].as_str().unwrap_or("")) {
                        e["phase"] = json!("cancelled");
                        e["reason"] = json!("Automatic shrinking was turned off before the speed test started.");
                    }
                }
            }
        }
        for c in &configs {
            self.note_speed_settings(c, false);
            let root = c["sourceRoot"].as_str().unwrap_or("");
            let mut s = self.lock();
            let old = s.status["speedTests"][root].clone();
            if c["codec"] != "h265" || old["settingsSource"] == "user"
                || old["attemptedFingerprint"] == fp
                || ["queued","waiting","running"].contains(&old["phase"].as_str().unwrap_or("")) { continue; }
            if !s.status["speedTests"].is_object() { s.status["speedTests"] = json!({}); }
            let mut e = if old.is_object() { old } else { json!({"settingsSource":"default","deviceSettings":device_settings(c)}) };
            e["phase"] = json!("queued"); e["source"] = json!("automatic");
            s.status["speedTests"][root] = e;
        }
        let next = {
            let s = self.lock();
            s.status["speedTests"].as_object().into_iter().flatten()
                .filter(|(_,e)| ["queued","waiting"].contains(&e["phase"].as_str().unwrap_or("")))
                // An automatic test cannot borrow a paused job. Let a requested
                // test use that pause instead of waiting behind it indefinitely.
                .min_by_key(|(_,e)| e["source"] != "requested")
                .map(|(r,e)| (r.clone(),e["source"] == "requested",Self::speed_config(&s,r)))
        };
        let Some((root, requested, Some(config))) = next else { let _ = self.save_speed(); return false };
        // Window/device/preview-owned pauses are not the owner's paused job.
        let scheduler_pause = {
            let s = self.lock();
            s.status["active"].as_object().into_iter().flatten().any(|(_,v)| v["pausedForWindow"] == true || v["pausedForDevices"] == true)
                || s.status["heldManual"].as_array().is_some_and(|a| !a.is_empty())
        };
        let progress = |p: Value| {
            let mut s = self.lock();
            let e = &mut s.status["speedTests"][&root];
            if e["phase"] != "running" { e["startedAt"] = json!((self.o.now)()); }
            e["phase"] = json!("running"); e["progress"] = p; e["reason"] = Value::Null;
            e["attemptedFingerprint"] = json!(fp);
            drop(s);
            let _ = self.save_speed();
        };
        let outcome = if requested && scheduler_pause { Err("JOB_ACTIVE".into()) } else { backend.run(&config, requested, &progress) };
        if outcome.as_ref().is_err_and(|e| ["JOB_ACTIVE","BENCHMARK_ACTIVE","SPEED_TEST_RUNNING","PREVIEW_ACTIVE"].contains(&e.as_str())) {
            let mut s = self.lock(); let e = &mut s.status["speedTests"][&root];
            e["phase"] = json!("waiting");
            e["reason"] = json!(match outcome.as_ref().err().map(String::as_str) {
                Some("PREVIEW_ACTIVE") => "Waiting for the picture preview to finish.",
                Some("BENCHMARK_ACTIVE" | "SPEED_TEST_RUNNING") => "Waiting for the other speed test to finish.",
                _ if requested => "Waiting for shrinking to pause or finish, with no work still in progress.",
                _ => "Waiting for all shrinking jobs to finish. Paused jobs stay paused.",
            });
            drop(s); let _ = self.save_speed(); return true;
        }
        let mut apply = false;
        {
            let mut s = self.lock();
            let unchanged = Self::speed_config(&s, &root).is_some_and(|c| profile(&c) == profile(&config) && device_settings(&c) == device_settings(&config));
            let e = &mut s.status["speedTests"][&root];
            e["attemptedFingerprint"] = json!(fp);
            e["progress"] = Value::Null;
            match outcome {
                Ok(result) if unchanged => {
                    e["phase"] = json!("done"); e["reason"] = Value::Null;
                    e["result"] = json!({"devices":result["devices"],"testedAt":(self.o.now)(),"profileId":config["profileId"],
                        "profile":profile(&config),"fingerprint":fp,"source":if requested {"requested"} else {"automatic"}});
                    apply = e["settingsSource"] != "user";
                }
                Ok(_) => { e["phase"] = json!("stale"); e["reason"] = json!("Setup changed during the speed test. Existing settings were kept; test again."); }
                Err(error) => {
                    let (phase, reason) = match error.as_str() {
                        "BENCHMARK_SOURCE_REQUIRED" => ("skipped","No original H.264 clips remain to test. Shrinking keeps the existing settings."),
                        "CANCELLED" | "SERVICE_SHUTDOWN" => ("cancelled","The speed test was cancelled. Existing settings were kept."),
                        _ => ("failed","The speed test could not finish. Shrinking keeps the existing settings; you can test again."),
                    };
                    e["phase"] = json!(phase); e["reason"] = json!(reason); e["error"] = json!(error);
                }
            }
        }
        if let Err(error) = self.save_speed().and_then(|_| if apply { self.apply_speed_result(&root, true).map(|_| ()) } else { Ok(()) }) {
            let mut s = self.lock(); s.status["speedTests"][&root]["phase"] = json!("failed");
            s.status["speedTests"][&root]["reason"] = json!("The speed test result could not be saved. Check server storage before testing again.");
            s.status["speedTests"][&root]["error"] = json!(error);
        }
        self.changed();
        // Another queued vehicle gets its turn before new jobs are admitted.
        self.lock().status["speedTests"].as_object().into_iter().flatten().any(|(_,e)| ["queued","waiting"].contains(&e["phase"].as_str().unwrap_or("")))
    }
}

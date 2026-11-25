//! jobService.js runChild: one ffmpeg encode, its -progress lines parsed
//! exactly as Node parses them (activeEncodes' live numbers, the lead clip's
//! progress event), the stall watch and the end of the process.

use super::*;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Number.parseFloat
pub fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut any = i > digits_start;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 || any {
            any = any || j > i + 1;
            i = j;
        }
    }
    if !any {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let k = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > k {
            i = j;
        }
    }
    t[..i].parse().unwrap_or(f64::NAN)
}

fn round_to(x: f64, scale: f64) -> f64 {
    contracts::js_round(x * scale) / scale
}

/// progressCount
fn progress_count(v: &str) -> Value {
    let n = super::super::verifier::js_number(v);
    if n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= super::super::jobstore::normalize::MAX_SAFE as f64 {
        json!(n as i64)
    } else {
        Value::Null
    }
}

/// progressRate
fn progress_rate(v: &str, scale: f64) -> Value {
    let n = js_parse_float(v);
    if n.is_finite() && n >= 0.0 {
        super::super::jobstore::normalize::num(round_to(n, scale))
    } else {
        Value::Null
    }
}

/// What one -progress line changes.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    OutTime(i64),
    Fps(f64),
    Counter(&'static str, Value),
    Speed(Value),
    Bitrate(Value),
    Phase(String),
    Queued,
    Nothing,
}

/// One line of `-progress pipe:1` as runChild reads it.
pub fn parse_progress_line(line: &str) -> Progress {
    let Some(sep) = line.find('=').filter(|s| *s >= 1) else { return Progress::Nothing };
    let key = &line[..sep];
    let value = line[sep + 1..].trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    match key {
        "out_time_ms" | "out_time_us" => {
            let n = super::super::verifier::js_number(value);
            if n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= super::super::jobstore::normalize::MAX_SAFE as f64 {
                Progress::OutTime(n as i64)
            } else {
                Progress::Nothing
            }
        }
        "fps" => {
            let n = super::super::verifier::js_number(value);
            if n.is_finite() && n >= 0.0 {
                Progress::Fps(n)
            } else {
                Progress::Nothing
            }
        }
        "frame" => Progress::Counter("frame", progress_count(value)),
        "drop_frames" => Progress::Counter("dropFrames", progress_count(value)),
        "dup_frames" => Progress::Counter("dupFrames", progress_count(value)),
        "total_size" => Progress::Counter("totalSizeB", progress_count(value)),
        "speed" => Progress::Speed(progress_rate(value, 100.0)),
        "bitrate" => Progress::Bitrate(progress_rate(value, 10.0)),
        "progress" if value == "continue" || value == "end" => Progress::Phase(value.to_string()),
        // waiting in a node's queue (a clip sent ahead): not converting yet
        "queued" => Progress::Queued,
        _ => Progress::Nothing,
    }
}

/// renderDevice(args): the GPU an encode names
pub fn render_device(args: &[String]) -> Value {
    for i in 0..args.len().saturating_sub(1) {
        let v = &args[i + 1];
        if (args[i] == "-vaapi_device" || args[i] == "-hwaccel_device") && v.starts_with("/dev/") {
            return json!(v);
        }
        if args[i] == "-gpu" && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
            return json!(format!("nvidia{v}"));
        }
        if args[i] == "-init_hw_device" {
            for part in v.split(',') {
                if let Some(dev) = part.strip_prefix("child_device=") {
                    if dev.len() > 5 && dev.starts_with("/dev/") {
                        return json!(dev);
                    }
                }
            }
        }
    }
    Value::Null
}

pub struct EncodeRequest<'a> {
    pub source: &'a str,
    pub target: &'a str,
    pub codec: &'a str,
    pub encoder: &'a super::super::planner::Selected,
    pub bitrate: Option<f64>,
    pub quality: Option<&'a str>,
    pub duration_us: Option<i64>,
    /// Start and end in source microseconds; None encodes the whole clip.
    pub window: Option<(i64, i64)>,
    pub hold_frames: i64,
    /// Smallest (CPU only), and whether its clip keeps the original's frame order
    pub smallest: Option<super::super::planner::Smallest>,
    pub keep_order: bool,
    /// the decode tier's arguments (None: CPU decode)
    pub decode: Option<&'a [String]>,
    /// the lane (chosen GPU) this clip runs on
    pub lane_id: Option<&'a str>,
}

impl EncodeRequest<'_> {
    /// Shared by production and previews; a window never inherits lead-in holds.
    pub(crate) fn local_args(&self) -> Result<Vec<String>, &'static str> {
        let r = self;
        if r.encoder.remote || r.window.is_some_and(|(start, end)| start < 0 || end <= start) {
            return Err("encoder-start-failed");
        }
        let device = if r.encoder.hardware { r.encoder.device.as_ref() } else { None };
        let encode_args = super::super::planner::build_encode_args(&super::super::planner::EncodeArgs {
            codec: r.codec,
            encoder: &r.encoder.codec,
            bitrate: r.bitrate,
            quality: r.quality,
            hw_frames: r.decode.is_some_and(|d| d.iter().any(|a| a == "-hwaccel_output_format")),
            device,
            hold_frames: if r.window.is_some() { 0 } else { r.hold_frames },
            smallest: r.smallest,
            keep_order: r.smallest.is_some() && r.keep_order,
            ..Default::default()
        })
        .map_err(|_| "encoder-start-failed")?;
        let mut args: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-n"].iter().map(|s| s.to_string()).collect();
        args.extend(r.decode.unwrap_or(&[]).iter().cloned());
        if let Some((start, _)) = r.window {
            args.extend(["-ss".into(), format!("{start}us")]);
        }
        args.push("-i".into());
        args.push(r.source.into());
        args.extend(encode_args);
        if let Some((start, end)) = r.window {
            args.extend(["-t".into(), format!("{}us", end - start)]);
        }
        for a in ["-an", "-sn", "-dn", "-progress", "pipe:1", "-nostats", "-f", "mp4"] {
            args.push(a.into());
        }
        args.push(r.target.into());
        Ok(args)
    }
}

impl Service {
    /// liveCounts: clips waiting on a node, and those encoding now (here, or started on a node)
    fn live_counts(s: &RtState) -> (usize, usize) {
        let waiting = s.encodes.iter().filter(|(_, l)| l["waitingOnNode"] == true).count();
        let now = s.encodes.iter().filter(|(_, l)| l["waitingOnNode"] != true && (l["remote"] != true || l["started"] == true)).count();
        (waiting, now)
    }

    fn note_waiting(&self, rt: &Arc<Runtime>) {
        let progress = {
            let s = rt.lock();
            let mut p = Map::new();
            p.insert("phase".into(), json!("continue"));
            if let Some(Value::Object(l)) = &s.last_progress {
                for (k, v) in l {
                    p.insert(k.clone(), v.clone());
                }
            }
            let (w, e) = Self::live_counts(&s);
            p.insert("waitingOnNode".into(), json!(w));
            p.insert("encodingNow".into(), json!(e));
            Value::Object(p)
        };
        self.emit(rt, "progress", vec![("progress", progress)]);
    }

    /// runChild: Ok(()) or the failure code ('encoder-start-failed',
    /// 'encoder-failed', 'encoder-stalled', 'cancelled').
    pub fn run_child(&self, rt: &Arc<Runtime>, item_id: &str, r: &EncodeRequest) -> Result<(), &'static str> {
        if r.window.is_some_and(|(start, end)| start < 0 || end <= start || r.encoder.remote) {
            // The node protocol does not carry a window: never silently send a whole clip.
            return Err("encoder-start-failed");
        }
        if r.encoder.remote {
            return self.run_remote(rt, item_id, r);
        }
        let args = r.local_args()?;
        let gpu = r.encoder.hardware.then(|| r.encoder.device.clone().or_else(|| {
            let id=self.0.o.default_device.as_ref()?.as_ref()(r.codec)?;
            self.0.o.resolve_device.as_ref()?.as_ref()(&id).map(|v|super::super::devices::device_of(&v))
        }).unwrap_or_else(||super::super::planner::Device{id:"local-gpu".into(),..Default::default()}));
        let _memory = if let Some(device)=&gpu {
            let budget=super::super::gpu_memory::estimate_mib(self.0.o.tools.video_dimensions(r.source,&rt.signal()));
            let serial=rt.lock().item(item_id).is_some_and(|i|i["resultCode"]=="gpu-memory-retry");
            let started=Instant::now();
            Some(loop {
                if rt.lock().stopped() {return Err("cancelled");}
                if let Some(lease)=self.0.o.gpu_memory.try_reserve(device,budget,serial) {break lease;}
                if rt.lock().pause_requested {return Err("gpu-memory-paused");}
                if started.elapsed()>=Duration::from_secs(30) {return Err("gpu-memory-exhausted");}
                std::thread::sleep(Duration::from_millis(200));
            })
        } else {None};
        let ffmpeg = self.0.o.tools.ffmpeg_path().to_string();
        if super::super::process::validate_request(&ffmpeg, &args).is_err() {
            return Err("encoder-start-failed");
        }
        if let Some(f) = &self.0.o.on_spawn {
            f(&args);
        }
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if super::super::process::cuda_by_index(&args) {
            cmd.env("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
        }
        let mut child = cmd.spawn().map_err(|_| "encoder-start-failed")?;
        let pid = child.id() as i32;
        let live = {
            let mut s = rt.lock();
            s.children.insert(item_id.to_string(), ChildEntry { pid, termination_requested: false, remote: None, withdrawn: false });
            let rel = s.manifest.item(item_id).and_then(|i| i.str("relativePath").map(str::to_string));
            let live = json!({
                "jobId": s.manifest.id(), "itemId": item_id, "relativePath": rel, "encoder": r.encoder.codec,
                "hardware": r.encoder.hardware, "decode": if r.decode.is_some_and(|d| !d.is_empty()) { "gpu" } else { "cpu" },
                "device": render_device(&args), "node": null,
                "deviceId": r.lane_id, "remote": false, "started": true, "pid": pid, "fps": null, "speed": null,
                "bitrateKbps": null, "frame": null, "outTimeUs": null,
                "durationUs": r.duration_us.filter(|d| *d > 0), "dropFrames": null, "dupFrames": null, "totalSizeB": null
            });
            s.encodes.push((item_id.to_string(), live.clone()));
            live
        };
        let _ = live;
        self.note_waiting(rt);
        {
            let mut s = rt.lock();
            if s.cancel_requested || s.stop_requested || s.recovery_required {
                if let Some(c) = s.children.get_mut(item_id) {
                    c.termination_requested = true;
                }
                // SAFETY: our own child
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
        }
        let mut stderr = child.stderr.take().unwrap();
        let memory_error=Arc::new(AtomicBool::new(false));
        let memory_error2=memory_error.clone();
        let stderr_reader=std::thread::spawn(move || {
            let mut sink = [0u8; 8192];
            let mut tail=Vec::new();
            while let Ok(n)=stderr.read(&mut sink) {
                if n==0 {break;}
                tail.extend_from_slice(&sink[..n]);
                if super::super::gpu_memory::exhausted(&String::from_utf8_lossy(&tail)) {memory_error2.store(true,Ordering::SeqCst);}
                if tail.len()>8192 {tail.drain(..tail.len()-8192);}
            }
        });
        let mut stdout = child.stdout.take().unwrap();
        let last_activity = Arc::new(Mutex::new(Instant::now()));
        let me = self.clone();
        let rt2 = rt.clone();
        let id2 = item_id.to_string();
        let act2 = last_activity.clone();
        let reader = std::thread::spawn(move || {
            let mut buffered = String::new();
            let mut progress = Map::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                *act2.lock().unwrap() = Instant::now();
                buffered.push_str(&String::from_utf8_lossy(&chunk[..n]));
                // (the last 8,192 characters)
                let units: Vec<u16> = buffered.encode_utf16().collect();
                if units.len() > 8192 {
                    buffered = String::from_utf16_lossy(&units[units.len() - 8192..]);
                }
                let mut lines: Vec<String> = buffered.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();
                buffered = lines.pop().unwrap_or_default();
                for line in lines {
                    let p = parse_progress_line(&line);
                    let mut emit_progress = None;
                    {
                        let mut s = rt2.lock();
                        let s = &mut *s;
                        let live = s.encodes.iter_mut().find(|(i, _)| *i == id2).map(|(_, v)| v);
                        match p {
                            Progress::OutTime(t) => {
                                progress.insert("outTimeUs".into(), json!(t));
                                if let Some(l) = live {
                                    l["outTimeUs"] = json!(t);
                                }
                            }
                            Progress::Queued => {}
                            Progress::Fps(f) => {
                                s.encode_fps.insert(id2.clone(), f);
                                if let Some(l) = live {
                                    l["fps"] = super::super::jobstore::normalize::num(round_to(f, 10.0));
                                }
                            }
                            Progress::Counter(k, v) => {
                                if let Some(l) = live {
                                    l[k] = v;
                                }
                            }
                            Progress::Speed(v) => {
                                if let Some(l) = live {
                                    l["speed"] = v;
                                }
                            }
                            Progress::Bitrate(v) => {
                                if let Some(l) = live {
                                    l["bitrateKbps"] = v;
                                }
                            }
                            Progress::Phase(ph) => {
                                progress.insert("phase".into(), json!(ph));
                                if s.is_lead(&id2) {
                                    let fps: f64 = s.encode_fps.values().sum();
                                    let mut lp = progress.clone();
                                    lp.insert("fps".into(), super::super::jobstore::normalize::num(round_to(fps, 10.0)));
                                    s.last_progress = Some(Value::Object(lp.clone()));
                                    let (w, e) = Self::live_counts(s);
                                    lp.insert("waitingOnNode".into(), json!(w));
                                    lp.insert("encodingNow".into(), json!(e));
                                    emit_progress = Some(Value::Object(lp));
                                }
                            }
                            Progress::Nothing => {}
                        }
                    }
                    if let Some(p) = emit_progress {
                        me.emit(&rt2, "progress", vec![("progress", p)]);
                    }
                }
            }
        });
        let stall = Duration::from_millis(self.0.o.encode_stall_ms.max(1));
        let result = loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let _ = reader.join();
                    let _ = stderr_reader.join();
                    use std::os::unix::process::ExitStatusExt;
                    let s = rt.lock();
                    let stopped = s.cancel_requested || s.stop_requested || s.recovery_required || status.signal().is_some();
                    break if stopped {
                        Err("cancelled")
                    } else if gpu.is_some() && memory_error.load(Ordering::SeqCst) {
                        Err("gpu-memory-exhausted")
                    } else if status.code() == Some(0) {
                        Ok(())
                    } else {
                        Err("encoder-failed")
                    };
                }
                Ok(None) => {}
                Err(_) => break Err("encoder-start-failed"),
            }
            if last_activity.lock().unwrap().elapsed() >= stall {
                if let Some(c) = rt.lock().children.get_mut(item_id) {
                    c.termination_requested = true;
                }
                let _ = child.kill();
                // (not waiting for it: a process stuck on a dead share may not end)
                std::thread::spawn(move || {
                    let _ = child.wait();
                    let _ = reader.join();
                });
                break Err("encoder-stalled");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        {
            let mut s = rt.lock();
            s.children.remove(item_id);
            s.encodes.retain(|(i, _)| i != item_id);
            s.encode_fps.remove(item_id);
        }
        self.note_waiting(rt);
        if result==Err("gpu-memory-exhausted") {
            if let Some(device)=&gpu {self.0.o.gpu_memory.pressure(device);}
        }
        result
    }
}

impl Service {
    /// runChild for a lane on another server (Nodes): the clip is sent there
    /// and the encoded file comes back to `target`; the progress, stall and
    /// cancel handling is ffmpeg's; reading, telemetry, verification and
    /// saving stay here.
    fn run_remote(&self, rt: &Arc<Runtime>, item_id: &str, r: &EncodeRequest) -> Result<(), &'static str> {
        let Some(nodes) = self.0.o.remote_nodes.clone() else { return Err("encoder-start-failed") };
        let device = r.encoder.device.as_ref().map(|d| d.id.clone()).unwrap_or_default();
        let child = nodes
            .encode(crate::nodes::main_side::EncodeRequest {
                device: device.clone(),
                source: r.source.into(),
                target: r.target.into(),
                codec: r.codec.into(),
                bitrate: r.bitrate,
                quality: r.quality.map(str::to_string),
                hold_frames: r.hold_frames,
                duration_us: r.duration_us.map(|d| d as f64),
                benchmark: false,
            })
            .map_err(|_| "encoder-start-failed")?;
        let kill = child.kill.clone();
        let name = r.encoder.device.as_ref().and_then(|d| d.name.clone()).unwrap_or(device);
        {
            let mut s = rt.lock();
            s.children.insert(item_id.to_string(), ChildEntry { pid: 0, termination_requested: false, remote: Some(kill.clone()), withdrawn: false });
            let rel = s.manifest.item(item_id).and_then(|i| i.str("relativePath").map(str::to_string));
            let live = json!({
                "jobId": s.manifest.id(), "itemId": item_id, "relativePath": rel, "encoder": r.encoder.codec,
                "hardware": r.encoder.hardware, "decode": "cpu", "device": null, "node": name,
                "deviceId": r.lane_id, "remote": true, "started": false, "pid": null, "fps": null, "speed": null,
                "bitrateKbps": null, "frame": null, "outTimeUs": null,
                "durationUs": r.duration_us.filter(|d| *d > 0), "dropFrames": null, "dupFrames": null, "totalSizeB": null
            });
            s.encodes.push((item_id.to_string(), live));
            if s.cancel_requested || s.stop_requested || s.recovery_required {
                if let Some(c) = s.children.get_mut(item_id) {
                    c.termination_requested = true;
                }
                kill("SIGTERM");
            }
        }
        let stall = Duration::from_millis(self.0.o.encode_stall_ms.max(1));
        let mut last = Instant::now();
        let mut buffered = String::new();
        let mut progress = Map::new();
        let result = loop {
            match child.events.recv_timeout(Duration::from_millis(100)) {
                Ok(crate::nodes::main_side::ChildEvent::Stdout(text)) => {
                    last = Instant::now();
                    buffered.push_str(&text);
                    let mut lines: Vec<String> = buffered.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();
                    buffered = lines.pop().unwrap_or_default();
                    for line in lines {
                        self.remote_line(rt, item_id, &line, &mut progress);
                    }
                }
                Ok(crate::nodes::main_side::ChildEvent::Close { code, signal }) => {
                    let s = rt.lock();
                    let controlled = s.cancel_requested || s.stop_requested || s.recovery_required;
                    let withdrawn = s.children.get(item_id).is_some_and(|c| c.withdrawn);
                    break if withdrawn && !controlled {
                        Err("withdrawn")
                    } else if controlled || signal.is_some() {
                        Err("cancelled")
                    } else if code == Some(0) {
                        Ok(())
                    } else {
                        Err("encoder-failed")
                    };
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if last.elapsed() >= stall {
                        if let Some(c) = rt.lock().children.get_mut(item_id) {
                            c.termination_requested = true;
                        }
                        kill("SIGKILL");
                        break Err("encoder-stalled");
                    }
                }
                // (gone without a close: as a kill)
                Err(_) => {
                    let s = rt.lock();
                    let controlled = s.cancel_requested || s.stop_requested || s.recovery_required;
                    break if s.children.get(item_id).is_some_and(|c| c.withdrawn) && !controlled { Err("withdrawn") } else { Err("cancelled") };
                }
            }
        };
        {
            let mut s = rt.lock();
            s.children.remove(item_id);
            s.encodes.retain(|(i, _)| i != item_id);
            s.encode_fps.remove(item_id);
        }
        self.note_waiting(rt);
        result
    }

    fn remote_line(&self, rt: &Arc<Runtime>, id: &str, line: &str, progress: &mut Map<String, Value>) {
        let p = parse_progress_line(line);
        let mut note = false;
        let mut emit_progress = None;
        {
            let mut s = rt.lock();
            let s = &mut *s;
            let is_lead = s.is_lead(id);
            let live = s.encodes.iter_mut().find(|(i, _)| i == id).map(|(_, v)| v);
            let Some(l) = live else { return };
            match p {
                Progress::Queued => {
                    if l["waitingOnNode"] != true {
                        l["waitingOnNode"] = json!(true);
                        note = true;
                    }
                }
                Progress::OutTime(t) => {
                    progress.insert("outTimeUs".into(), json!(t));
                    l["outTimeUs"] = json!(t);
                    if l["waitingOnNode"] == true || l["started"] != true {
                        l["waitingOnNode"] = json!(false);
                        l["started"] = json!(true);
                        note = true;
                    }
                }
                Progress::Fps(f) => {
                    s.encode_fps.insert(id.to_string(), f);
                    l["fps"] = super::super::jobstore::normalize::num(round_to(f, 10.0));
                }
                Progress::Counter(k, v) => l[k] = v,
                Progress::Speed(v) => l["speed"] = v,
                Progress::Bitrate(v) => l["bitrateKbps"] = v,
                Progress::Phase(ph) => {
                    progress.insert("phase".into(), json!(ph));
                    if is_lead {
                        let fps: f64 = s.encode_fps.values().sum();
                        let mut lp = progress.clone();
                        lp.insert("fps".into(), super::super::jobstore::normalize::num(round_to(fps, 10.0)));
                        s.last_progress = Some(Value::Object(lp.clone()));
                        let (w, e) = Self::live_counts(s);
                        lp.insert("waitingOnNode".into(), json!(w));
                        lp.insert("encodingNow".into(), json!(e));
                        emit_progress = Some(Value::Object(lp));
                    }
                }
                Progress::Nothing => {}
            }
        }
        if note {
            self.note_waiting(rt);
            // (sent while its row was being set lower: it comes back)
            self.withdraw_from_nodes(rt);
        }
        if let Some(p) = emit_progress {
            self.emit(rt, "progress", vec![("progress", p)]);
        }
    }

    /// withdrawFromNodes(runtime): a node's row set lower or Off: the clips
    /// sent ahead that still wait in its queue come back, the last sent first
    pub fn withdraw_from_nodes(&self, rt: &Runtime) {
        let mut s = rt.lock();
        let s = &mut *s;
        let mut by_lane: indexmap::IndexMap<String, Vec<(String, bool)>> = Default::default();
        for (item, live) in &s.encodes {
            let Some(lane) = live["deviceId"].as_str().filter(|d| d.starts_with("node:")) else { continue };
            if s.children.get(item).is_some_and(|c| !c.withdrawn) {
                by_lane.entry(lane.to_string()).or_default().push((item.clone(), live["waitingOnNode"] == true));
            }
        }
        for (lane, list) in by_lane {
            let mut over = list.len() as i64 - s.lane_limit(&Some(lane)) as i64;
            for (item, _) in list.iter().filter(|(_, w)| *w).rev() {
                if over <= 0 {
                    break;
                }
                over -= 1;
                if let Some(c) = s.children.get_mut(item) {
                    c.withdrawn = true;
                    c.termination_requested = true;
                    if let Some(k) = &c.remote {
                        k("SIGTERM");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converter::{planner::{Selected, Smallest}, runtime::{Converter, RuntimeOptions}, testutil::tempdir};

    #[test]
    fn encoders_keep_demux_time_base() {
        for (family, codec) in [("h265", "libx265"), ("h265", "hevc_nvenc"), ("h265", "hevc_qsv"),
            ("h265", "hevc_vaapi"), ("h265", "hevc_amf"), ("h265", "hevc_videotoolbox"),
            ("av1", "libsvtav1"), ("av1", "libaom-av1"), ("av1", "av1_nvenc"), ("av1", "av1_qsv"),
            ("av1", "av1_amf"), ("av1", "av1_vaapi"), ("av1", "av1_videotoolbox")] {
            let encoder = Selected { family: family.into(), codec: codec.into(), hardware: !codec.starts_with("lib"),
                remote: false, timed_out: false, device: None };
            for (smallest, keep_order) in [(None, false), (Some(Smallest::default()), false), (Some(Smallest::default()), true)] {
                if smallest.is_some() && codec != "libx265" { continue; }
                for window in [None, Some((2_000_000, 8_000_000))] {
                    let request = EncodeRequest { source: "source.mp4", target: "output.mp4", codec: family, encoder: &encoder,
                        bitrate: Some(200_000.0), quality: None, duration_us: Some(6_000_000), window,
                        hold_frames: 0, smallest, keep_order, decode: None, lane_id: None };
                    let args = request.local_args().unwrap();
                    let context = format!("{codec}, smallest={smallest:?}, keep_order={keep_order}, window={window:?}");
                    assert_eq!(args.iter().filter(|a| *a == "-enc_time_base").count(), 1, "{context}");
                    assert_eq!(args.windows(2).filter(|w| *w == ["-enc_time_base", "demux"]).count(), 1, "{context}");
                    let reorder = smallest.is_some() && !keep_order;
                    assert_eq!(args.windows(2).any(|w| w == ["-bf", "0"]), family == "h265" && !reorder, "{context}");
                    assert_eq!(args.windows(2).any(|w| w == ["-movflags", "+negative_cts_offsets"]), reorder, "{context}");
                    assert_eq!(args.windows(2).any(|w| w == ["-avoid_negative_ts", "make_zero"]), !reorder, "{context}");
                }
            }
        }
    }

    #[test]
    fn segment_encode_is_bounded() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.mp4");
        let generated = Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=12:duration=20", "-c:v", "libx264", "-g", "24", "-keyint_min", "24", "-sc_threshold", "0", "-bf", "0", "-pix_fmt", "yuv420p", "-use_editlist", "0"])
            .arg(&source).output().unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let recorded = calls.clone();
        std::fs::create_dir_all(dir.path().join("temp")).unwrap();
        let mut options = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), "ffmpeg", "ffprobe");
        options.auto_timer = false;
        options.tune = Some(Box::new(move |o| o.on_spawn = Some(Arc::new(move |args| recorded.lock().unwrap().push(args.to_vec())))));
        let converter = Converter::open(options).unwrap();
        let initial = json!({ "state": "waiting", "config": {
            "sourceRoot": dir.path(), "destinationRoot": null, "codec": "h265", "profileId": "balanced",
            "networkMode": "auto", "outputMode": "replace", "includedGroups": ["SavedClips"],
            "replacementConfirmed": true, "concurrency": 1, "verifyMode": "quick"
        }});
        let manifest = converter.store.create(initial.as_object().unwrap()).unwrap();
        let rt = converter.service.ensure_runtime(manifest.id()).unwrap();
        let selected = Selected { family: "h265".into(), codec: "libx265".into(), hardware: false, remote: false, timed_out: false, device: None };

        for (name, smallest, keep_order) in [("bitrate", None, false), ("smallest", Some(Smallest::default()), false), ("smallest-ordered", Some(Smallest::default()), true)] {
            let target = dir.path().join(format!("{name}.mp4"));
            converter.service.run_child(&rt, name, &EncodeRequest {
                source: source.to_str().unwrap(), target: target.to_str().unwrap(), codec: "h265", encoder: &selected,
                bitrate: if smallest.is_some() { None } else { Some(200_000.0) }, quality: None,
                duration_us: Some(20_000_000), window: Some((7_000_000, 13_000_000)),
                hold_frames: 24, smallest, keep_order, decode: None, lane_id: None,
            }).unwrap();
            let probed = Command::new("ffprobe")
                .args(["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "format=duration:stream=nb_read_frames", "-of", "json"])
                .arg(&target).output().unwrap();
            assert!(probed.status.success(), "{}", String::from_utf8_lossy(&probed.stderr));
            let probe: Value = serde_json::from_slice(&probed.stdout).unwrap();
            let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
            let frames: u64 = probe["streams"][0]["nb_read_frames"].as_str().unwrap().parse().unwrap();
            eprintln!("{name}: duration={duration}s, frames={frames}");
            assert!((5.8..=6.3).contains(&duration), "{name}: duration {duration}, {probe}");
            assert!((70..=75).contains(&frames), "{name}: frames {frames}, {probe}");
            let recorded = calls.lock().unwrap();
            let args = recorded.last().unwrap();
            let seek = args.windows(2).position(|a| a == ["-ss", "7000000us"]).expect("seek to the requested start");
            assert!(seek < args.iter().position(|a| a == "-i").unwrap(), "{name}: the seek belongs to the input");
            assert!(!args.iter().any(|a| a.contains("tpad=")), "{name}: a segment must not inherit the source's lead-in hold");
        }

        let calls_before = calls.lock().unwrap().len();
        for window in [(-1, 6_000_000), (0, 0), (13_000_000, 7_000_000), (i64::MIN, i64::MAX)] {
            let target = dir.path().join("invalid.mp4");
            let result = converter.service.run_child(&rt, "invalid", &EncodeRequest {
                source: source.to_str().unwrap(), target: target.to_str().unwrap(), codec: "h265", encoder: &selected,
                bitrate: Some(200_000.0), quality: None, duration_us: None, window: Some(window),
                hold_frames: 0, smallest: None, keep_order: false, decode: None, lane_id: None,
            });
            assert_eq!(result, Err("encoder-start-failed"), "invalid window {window:?}");
            assert!(!target.exists());
        }
        assert_eq!(calls.lock().unwrap().len(), calls_before, "invalid windows must not spawn ffmpeg");
    }

    #[test]
    fn progress_lines_as_node_reads_them() {
        assert_eq!(parse_progress_line("out_time_us=1500000"), Progress::OutTime(1_500_000));
        assert_eq!(parse_progress_line("out_time_ms=-5"), Progress::Nothing);
        assert_eq!(parse_progress_line("out_time_us=N/A"), Progress::Nothing);
        assert_eq!(parse_progress_line("out_time_us="), Progress::OutTime(0), "Number('') is 0");
        assert_eq!(parse_progress_line("fps=23.97"), Progress::Fps(23.97));
        assert_eq!(parse_progress_line("frame=12"), Progress::Counter("frame", json!(12)));
        assert_eq!(parse_progress_line("total_size=N/A"), Progress::Counter("totalSizeB", Value::Null));
        assert_eq!(parse_progress_line("speed=1.234x"), Progress::Speed(json!(1.23)));
        assert_eq!(parse_progress_line("speed=N/A"), Progress::Speed(Value::Null));
        assert_eq!(parse_progress_line("bitrate=1234.56kbits/s"), Progress::Bitrate(json!(1234.6)));
        assert_eq!(parse_progress_line("bitrate=2000.0kbits/s"), Progress::Bitrate(json!(2000)));
        assert_eq!(parse_progress_line("progress=continue"), Progress::Phase("continue".into()));
        assert_eq!(parse_progress_line("progress=other"), Progress::Nothing);
        assert_eq!(parse_progress_line("=x"), Progress::Nothing);
        assert_eq!(js_parse_float(" 12.5e2x"), 1250.0);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert!(js_parse_float("x1").is_nan());
        assert_eq!(js_parse_float("1e"), 1.0);
        assert_eq!(render_device(&["-vaapi_device".into(), "/dev/dri/renderD129".into()]), json!("/dev/dri/renderD129"));
        assert_eq!(render_device(&["-gpu".into(), "1".into()]), json!("nvidia1"));
        assert_eq!(render_device(&["-init_hw_device".into(), "qsv=hw,child_device=/dev/dri/renderD128".into()]), json!("/dev/dri/renderD128"));
    }
}

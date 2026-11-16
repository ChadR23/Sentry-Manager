//! For the tests: small Tesla-like H.264 MP4s (an SEI record ahead of each
//! picture, as the car writes them) and a context with made-up vehicles.

use super::ctx::{Ctx, Files, VehicleRef};
use crate::footage;
use crate::inventory::{self, Recording};
use crate::scanner::{FileEntry, ms_of};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One frame's record: speed (m/s), lat, lon, forward and sideways acceleration.
#[derive(Clone, Copy, Default)]
pub struct Rec {
    pub v: f32,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub ax: Option<f64>,
    pub ay: Option<f64>,
}

fn varint(mut n: u64, out: &mut Vec<u8>) {
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n > 0 {
            out.push(b | 0x80);
        } else {
            out.push(b);
            return;
        }
    }
}

pub fn protobuf(frame: u64, r: &Rec) -> Vec<u8> {
    let mut p = vec![0x08, 0x01, 0x10, 0x01, 0x18];
    varint(frame, &mut p);
    p.push(0x25);
    p.extend(r.v.to_le_bytes());
    for (tag, v) in [(0x59, r.lat), (0x61, r.lon), (0x71, r.ax), (0x79, r.ay)] {
        if let Some(v) = v {
            p.push(tag);
            p.extend(v.to_le_bytes());
        }
    }
    p
}

/// An SEI NAL (type 6, payload 5) holding Tesla's record, with emulation prevention.
pub fn sei_nal(payload: &[u8]) -> Vec<u8> {
    let mut body = vec![0x42, 0x42, 0x42, 0x69];
    body.extend_from_slice(payload);
    let mut rbsp = vec![5u8];
    let mut size = body.len();
    while size >= 255 {
        rbsp.push(255);
        size -= 255;
    }
    rbsp.push(size as u8);
    rbsp.extend(body);
    rbsp.push(0x80);
    let mut nal = vec![0x06];
    let mut zeros = 0;
    for b in rbsp {
        if zeros >= 2 && b <= 3 {
            nal.push(3);
            zeros = 0;
        }
        nal.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    nal
}

fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    b.extend_from_slice(typ);
    b.extend_from_slice(body);
    b
}

fn full(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = vec![0, 0, 0, 0];
    b.extend_from_slice(body);
    bx(typ, &b)
}

fn u32s(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_be_bytes()).collect()
}

/// A clip of `recs.len()` frames at `fps` (timescale 1000 * fps), a keyframe every `gop` frames.
pub fn clip(path: &Path, fps: u32, recs: &[Option<Rec>], gop: usize) {
    build(path, fps, recs, gop, None);
}

/// The same clip as H.265 with each record in a standard prefix SEI NAL (type 39), as
/// archive converters write it; `extra` goes first in the first sample (another SEI, say).
pub fn clip_hevc(path: &Path, fps: u32, recs: &[Option<Rec>], gop: usize, extra: Option<Vec<u8>>) {
    build(path, fps, recs, gop, Some(extra));
}

/// sei_nal's record as an H.265 prefix SEI NAL
pub fn hevc_sei_nal(payload: &[u8]) -> Vec<u8> {
    let mut nal = vec![0x4e, 0x01];
    nal.extend_from_slice(&sei_nal(payload)[1..]);
    nal
}

fn build(path: &Path, fps: u32, recs: &[Option<Rec>], gop: usize, hevc: Option<Option<Vec<u8>>>) {
    let scale = 1000 * fps;
    let mut samples: Vec<Vec<u8>> = Vec::new();
    for (i, r) in recs.iter().enumerate() {
        let mut s = Vec::new();
        if let (0, Some(Some(extra))) = (i, &hevc) {
            s.extend((extra.len() as u32).to_be_bytes());
            s.extend(extra);
        }
        if let Some(r) = r {
            let nal = if hevc.is_some() { hevc_sei_nal(&protobuf(i as u64, r)) } else { sei_nal(&protobuf(i as u64, r)) };
            s.extend((nal.len() as u32).to_be_bytes());
            s.extend(nal);
        }
        let pic: Vec<u8> = match (hevc.is_some(), i % gop == 0) {
            (false, true) => vec![0x65, 0x88, 0x84, 0x00, 0x21, 0xff],
            (false, false) => vec![0x41, 0x9a, 0x02, 0x04],
            (true, true) => vec![0x26, 0x01, 0xaf, 0x00, 0x21, 0xff],
            (true, false) => vec![0x02, 0x01, 0xd0, 0x04],
        };
        s.extend((pic.len() as u32).to_be_bytes());
        s.extend(pic);
        samples.push(s);
    }
    let ftyp = bx(b"ftyp", if hevc.is_some() { b"isom\0\0\x02\0isomhvc1" } else { b"isom\0\0\x02\0isomavc1" });
    let mdat_body: Vec<u8> = samples.concat();
    let mdat = bx(b"mdat", &mdat_body);
    let first_offset = (ftyp.len() + 8) as u32;
    let n = samples.len() as u32;
    let dur = 1000 * n;
    let mut mvhd = u32s(&[0, 0, scale, dur, 0x00010000]);
    mvhd.extend([1, 0]);
    mvhd.extend([0u8; 10]);
    mvhd.extend(u32s(&[0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]));
    mvhd.extend([0u8; 24]);
    mvhd.extend(u32s(&[2]));
    let mut tkhd_body = u32s(&[0, 0, 1, 0, dur, 0, 0]);
    tkhd_body.extend([0u8; 8]);
    tkhd_body.extend(u32s(&[0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000, 320 << 16, 240 << 16]));
    let mut tkhd = vec![0, 0, 0, 3];
    tkhd.extend(tkhd_body);
    let tkhd = bx(b"tkhd", &tkhd);
    let mut mdhd = u32s(&[0, 0, scale, dur]);
    mdhd.extend([0x55, 0xc4, 0, 0]);
    let hdlr = full(b"hdlr", &[u32s(&[0]), b"vide".to_vec(), vec![0u8; 12], b"Video\0".to_vec()].concat());
    let sps = [0x67u8, 0x42, 0xc0, 0x1e, 0xd9];
    let pps = [0x68u8, 0xce, 0x3c, 0x80];
    let mut avcc = vec![1, 0x42, 0xc0, 0x1e, 0xff, 0xe1];
    avcc.extend((sps.len() as u16).to_be_bytes());
    avcc.extend(sps);
    avcc.push(1);
    avcc.extend((pps.len() as u16).to_be_bytes());
    avcc.extend(pps);
    let mut entry = vec![0u8; 6];
    entry.extend([0, 1]);
    entry.extend([0u8; 16]);
    entry.extend(320u16.to_be_bytes());
    entry.extend(240u16.to_be_bytes());
    entry.extend(u32s(&[0x480000, 0x480000, 0]));
    entry.extend(1u16.to_be_bytes());
    entry.extend([0u8; 32]);
    entry.extend(0x18u16.to_be_bytes());
    entry.extend((-1i16).to_be_bytes());
    assert_eq!(entry.len(), 78);
    let stsd = if hevc.is_some() {
        let mut hvcc = vec![1u8, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0];
        hvcc.push(0x0f);
        hvcc.push(0);
        entry.extend(bx(b"hvcC", &hvcc));
        full(b"stsd", &[u32s(&[1]), bx(b"hvc1", &entry)].concat())
    } else {
        entry.extend(bx(b"avcC", &avcc));
        full(b"stsd", &[u32s(&[1]), bx(b"avc1", &entry)].concat())
    };
    let stts = full(b"stts", &u32s(&[1, n, 1000]));
    let stsc = full(b"stsc", &u32s(&[1, 1, n, 1]));
    let mut stsz_b = u32s(&[0, n]);
    for s in &samples {
        stsz_b.extend((s.len() as u32).to_be_bytes());
    }
    let stsz = full(b"stsz", &stsz_b);
    let stco = full(b"stco", &u32s(&[1, first_offset]));
    let keys: Vec<u32> = (0..n).filter(|i| *i as usize % gop == 0).map(|i| i + 1).collect();
    let stss = full(b"stss", &[u32s(&[keys.len() as u32]), u32s(&keys)].concat());
    let stbl = bx(b"stbl", &[stsd, stts, stsc, stsz, stco, stss].concat());
    let vmhd = bx(b"vmhd", &[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    let dinf = bx(b"dinf", &full(b"dref", &[u32s(&[1]), bx(b"url ", &[0, 0, 0, 1])].concat()));
    let minf = bx(b"minf", &[vmhd, dinf, stbl].concat());
    let mdia = bx(b"mdia", &[full(b"mdhd", &mdhd), hdlr, minf].concat());
    let trak = bx(b"trak", &[tkhd, mdia].concat());
    let moov = bx(b"moov", &[full(b"mvhd", &mvhd), trak].concat());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, [ftyp, mdat, moov].concat()).unwrap();
}

/// Seconds of driving: `speeds[s]` m/s over second s, 4 frames a second, moving north-east.
pub fn drive(path: &Path, speeds: &[f32], lat: f64, lon: f64) {
    let mut recs = Vec::new();
    for (s, v) in speeds.iter().enumerate() {
        for k in 0..4 {
            let i = (s * 4 + k) as f64;
            recs.push(Some(Rec { v: *v, lat: Some(lat + i * 1e-5), lon: Some(lon + i * 1e-5), ax: Some(0.0), ay: Some(0.0) }));
        }
    }
    clip(path, 4, &recs, 4);
}

pub struct Car {
    pub ctx: Arc<TestCtx>,
    pub root: PathBuf,
    pub data: PathBuf,
}

pub struct TestCtx {
    pub data: PathBuf,
    pub vehicles: Vec<VehicleRef>,
    pub files: Mutex<HashMap<String, Files>>,
    pub recs: Mutex<HashMap<String, Arc<Vec<Recording>>>>,
    pub settings: Mutex<Map<String, Value>>,
    pub stamp: Mutex<f64>,
    pub announced: Mutex<Vec<String>>,
}

pub fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lean-viewer-{}-{}-{}", name, std::process::id(), crate::scanner::now_ms() as u64));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

impl Car {
    pub fn new(name: &str) -> Car {
        let base = tmp(name);
        let root = base.join("footage");
        let data = base.join("data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let v = VehicleRef { id: "v1".into(), name: "Car".into(), timezone: "UTC".into(), root: root.clone() };
        let ctx = Arc::new(TestCtx { data: data.clone(), vehicles: vec![v], files: Mutex::new(HashMap::new()), recs: Mutex::new(HashMap::new()), settings: Mutex::new(Map::new()), stamp: Mutex::new(1.0), announced: Mutex::new(Vec::new()) });
        Car { ctx, root, data }
    }

    /// Scan the footage again (what the scan would find: every file under the root).
    pub fn scan(&self) {
        let mut files = HashMap::new();
        let mut list = Vec::new();
        fn walk(dir: &Path, root: &Path, out: &mut Vec<FileEntry>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, root, out);
                    continue;
                }
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                let Some(c) = footage::classify(&rel) else { continue };
                let md = std::fs::metadata(&p).unwrap();
                let mtime_ms = ms_of(md.mtime(), md.mtime_nsec());
                let day = c.day.clone().unwrap_or_else(|| footage::local_day(mtime_ms));
                out.push(FileEntry { rel, size: md.size(), mtime_ms, ctime_ms: mtime_ms, birthtime_ms: 0.0, kind: c.kind, typ: c.typ, day, camera: c.camera, event_id: c.event_id });
            }
        }
        walk(&self.root, &self.root, &mut list);
        list.sort_by(|a, b| a.rel.cmp(&b.rel));
        let recs = inventory::build_recordings(&list, "v1");
        for f in list {
            files.insert(f.rel.clone(), f);
        }
        self.ctx.files.lock().unwrap().insert("v1".into(), Arc::new(files));
        self.ctx.recs.lock().unwrap().insert("v1".into(), Arc::new(recs));
        *self.ctx.stamp.lock().unwrap() += 1.0;
    }
}

impl Ctx for TestCtx {
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn app_root(&self) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }
    fn vehicles(&self) -> Vec<VehicleRef> {
        self.vehicles.clone()
    }
    fn studio_root(&self, id: &str) -> Option<PathBuf> {
        self.vehicle(id).map(|v| v.root)
    }
    fn files(&self, id: &str) -> Option<Files> {
        self.files.lock().unwrap().get(id).cloned()
    }
    fn recordings(&self, id: &str) -> Option<Arc<Vec<Recording>>> {
        self.recs.lock().unwrap().get(id).cloned()
    }
    fn scanning(&self, _id: &str) -> bool {
        false
    }
    fn scan_stamp(&self, _id: &str) -> Option<f64> {
        Some(*self.stamp.lock().unwrap())
    }
    fn setting(&self, key: &str) -> Option<Value> {
        self.settings.lock().unwrap().get(key).cloned()
    }
    fn set_setting(&self, key: &str, value: Value) {
        self.settings.lock().unwrap().insert(key.into(), value);
    }
    fn announce(&self, topic: &str) {
        self.announced.lock().unwrap().push(topic.into());
    }
    fn audit(&self, _line: &str) {}
}

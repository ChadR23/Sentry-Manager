//! MP4 metadata from box headers and the `moov` box alone: the video track's
//! sample index (offsets, sizes, decode and presentation times), timescale,
//! duration, codec and keyframes. Media data is never read here.
//!
//! A port of src/main/converter/mp4.js (parseMp4, selectVideoTrack,
//! buildSampleIndex) with the same checks: whatever that refuses, this
//! refuses too (tests/mp4_parity.rs compares the two on the same files).
//! The tree is built from the top-level box headers plus the moov bytes, as
//! server/speedReader.js does, so a clip costs a few small reads.

use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::Path;

#[derive(Debug)]
pub struct Mp4Error(pub String);

impl std::fmt::Display for Mp4Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Mp4Error {}

pub type Result<T> = std::result::Result<T, Mp4Error>;

pub fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(Mp4Error(msg.into()))
}

const CONTAINERS: [&[u8; 4]; 6] = [b"moov", b"trak", b"edts", b"mdia", b"minf", b"stbl"];
/// server/speedReader.js MAX_MOOV
pub const MAX_MOOV: u64 = 64 * 1024 * 1024;
const MAX_TOP_BOXES: usize = 64;

/// Read exactly `len` bytes at `pos`, or fail ("the clip ended early").
pub fn read_at(file: &File, pos: u64, len: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    let mut at = 0;
    while at < len {
        match file.read_at(&mut buf[at..], pos + at as u64) {
            Ok(0) => return err("The clip ended early"),
            Ok(n) => at += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return err(format!("read: {e}")),
        }
    }
    Ok(buf)
}

fn be32(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| Mp4Error("read past the end of a box".into()))
}
fn be64(b: &[u8], at: usize) -> Result<u64> {
    b.get(at..at + 8).map(|s| u64::from_be_bytes(s.try_into().unwrap())).ok_or_else(|| Mp4Error("read past the end of a box".into()))
}
fn bei32(b: &[u8], at: usize) -> Result<i32> {
    be32(b, at).map(|v| v as i32)
}

/// A top-level box, from its header alone.
#[derive(Debug, Clone)]
pub struct TopBox {
    pub typ: [u8; 4],
    pub start: u64,
    pub size: u64,
    pub header: u64,
    /// the size field as written (0 = "to the end of the file")
    declared: u32,
}

/// The top-level boxes of a file (speedReader.js topBoxes).
pub fn top_boxes(file: &File, file_size: u64) -> Result<Vec<TopBox>> {
    top_boxes_up_to(file, file_size, MAX_TOP_BOXES)
}

/// The top-level boxes, at most `most` of them.
fn top_boxes_up_to(file: &File, file_size: u64, most: usize) -> Result<Vec<TopBox>> {
    let mut out = Vec::new();
    let mut pos = 0u64;
    while pos < file_size {
        let h = read_at(file, pos, (file_size - pos).min(16) as usize)?;
        if h.len() < 8 {
            return err("Truncated box header");
        }
        let declared = be32(&h, 0)?;
        let typ: [u8; 4] = h[4..8].try_into().unwrap();
        let mut size = declared as u64;
        let mut header = 8;
        if declared == 1 {
            if h.len() < 16 {
                return err("Truncated box header");
            }
            size = be64(&h, 8)?;
            header = 16;
        } else if declared == 0 {
            size = file_size - pos;
        }
        if size < header || pos.checked_add(size).map_or(true, |e| e > file_size) {
            return err(format!("Invalid {} box", String::from_utf8_lossy(&typ)));
        }
        out.push(TopBox { typ, start: pos, size, header, declared });
        pos += size;
        if out.len() > most {
            return err("Too many top-level boxes");
        }
    }
    Ok(out)
}

/// A box of the tree; offsets are file offsets.
#[derive(Debug)]
pub struct Node {
    pub typ: [u8; 4],
    pub start: u64,
    pub content: u64,
    pub end: u64,
    pub children: Vec<Node>,
}

impl Node {
    /// Every box of this type in this subtree, depth first (mp4.js findBoxes).
    pub fn find<'a>(&'a self, typ: &[u8; 4], out: &mut Vec<&'a Node>) {
        if &self.typ == typ {
            out.push(self);
        }
        for c in &self.children {
            c.find(typ, out);
        }
    }
    pub fn find_all(&self, typ: &[u8; 4]) -> Vec<&Node> {
        let mut v = Vec::new();
        self.find(typ, &mut v);
        v
    }
    pub fn first(&self, typ: &[u8; 4]) -> Option<&Node> {
        self.find_all(typ).into_iter().next()
    }
    /// The only direct child of this type (mp4.js uniqueChild).
    fn unique(&self, typ: &[u8; 4], required: bool) -> Result<Option<&Node>> {
        let mut it = self.children.iter().filter(|c| &c.typ == typ);
        let first = it.next();
        if it.next().is_some() {
            return err(format!("Duplicate {} boxes are not supported", name(typ)));
        }
        if required && first.is_none() {
            return err(format!("Missing {} box", name(typ)));
        }
        Ok(first)
    }
    fn child(&self, typ: &[u8; 4]) -> Result<&Node> {
        Ok(self.unique(typ, true)?.unwrap())
    }
}

fn name(t: &[u8; 4]) -> String {
    String::from_utf8_lossy(t).into_owned()
}

/// A parsed file: the box tree, the moov bytes and the file's size.
pub struct Tree {
    pub root: Node,
    pub top: Vec<TopBox>,
    moov_start: u64,
    moov: Vec<u8>,
    pub file_size: u64,
}

impl Tree {
    /// A box's payload. Only boxes inside moov have bytes here.
    pub fn payload(&self, n: &Node) -> Result<&[u8]> {
        let (s, e) = (n.content, n.end);
        if s < self.moov_start || e > self.moov_start + self.moov.len() as u64 {
            return err("box outside moov");
        }
        Ok(&self.moov[(s - self.moov_start) as usize..(e - self.moov_start) as usize])
    }
    fn full_box(&self, n: &Node, min: usize) -> Result<&[u8]> {
        let p = self.payload(n)?;
        if p.len() < 4 + min {
            return err(format!("Truncated {} full box", name(&n.typ)));
        }
        Ok(p)
    }
}

fn parse_range(buf: &[u8], base: u64, start: u64, end: u64) -> Result<Vec<Node>> {
    let mut out = Vec::new();
    let mut cur = start;
    while cur < end {
        if end - cur < 8 {
            return err("Truncated MP4 box header");
        }
        let off = (cur - base) as usize;
        let declared = be32(buf, off)?;
        let typ: [u8; 4] = buf[off + 4..off + 8].try_into().unwrap();
        if declared == 0 {
            return err(format!("Size-zero MP4 box is not supported: {}", name(&typ)));
        }
        let header = if declared == 1 { 16 } else { 8 };
        if end - cur < header {
            return err(format!("Truncated MP4 box header: {}", name(&typ)));
        }
        let size = if declared == 1 { be64(buf, off + 8)? } else { declared as u64 };
        if size < header {
            return err(format!("Invalid MP4 box size: {}", name(&typ)));
        }
        let box_end = cur as u128 + size as u128;
        if box_end > end as u128 {
            return err(format!("MP4 box exceeds its containing range: {}", name(&typ)));
        }
        let box_end = box_end as u64;
        node_checks(&typ)?;
        let children = if CONTAINERS.contains(&&typ) { parse_range(buf, base, cur + header, box_end)? } else { Vec::new() };
        out.push(Node { typ, start: cur, content: cur + header, end: box_end, children });
        cur = box_end;
    }
    if cur != end {
        return err("Overlapping MP4 boxes are not supported");
    }
    Ok(out)
}

fn node_checks(typ: &[u8; 4]) -> Result<()> {
    if typ == b"moof" || typ == b"mvex" || typ == b"mfra" {
        return err(format!("Fragmented MP4 is not supported: {}", name(typ)));
    }
    Ok(())
}

/// Read the top-level headers and moov of a file and parse them (mp4.js parseMp4 of
/// speedReader.js' "image": every box header, moov whole, media left empty).
pub fn open_tree(file: &File) -> Result<Tree> {
    open_tree_up_to(file, MAX_TOP_BOXES)
}

/// open_tree with at most `most` top-level boxes (mp4.js parseMp4 of a whole file has no limit).
fn open_tree_up_to(file: &File, most: usize) -> Result<Tree> {
    let file_size = file.metadata().map_err(|e| Mp4Error(e.to_string()))?.len();
    let top = top_boxes_up_to(file, file_size, most)?;
    let moov = top.iter().find(|b| &b.typ == b"moov").cloned();
    let Some(moov) = moov else { return err("No usable moov") };
    if moov.size > MAX_MOOV {
        return err("No usable moov");
    }
    let bytes = read_at(file, moov.start, moov.size as usize)?;
    tree_from(top, moov.start, bytes, file_size)
}

fn tree_from(top: Vec<TopBox>, moov_start: u64, moov: Vec<u8>, file_size: u64) -> Result<Tree> {
    let mut children = Vec::with_capacity(top.len());
    for b in &top {
        if b.declared == 0 {
            return err(format!("Size-zero MP4 box is not supported: {}", name(&b.typ)));
        }
        node_checks(&b.typ)?;
        let content = b.start + b.header;
        let end = b.start + b.size;
        let kids = if &b.typ == b"moov" && b.start == moov_start {
            parse_range(&moov, moov_start, content, end)?
        } else if CONTAINERS.contains(&&b.typ) && end > content {
            // (another container at the top: its bytes are not read; mp4.js
            // sees zeros there, which it refuses)
            return err("Size-zero MP4 box is not supported");
        } else {
            Vec::new()
        };
        children.push(Node { typ: b.typ, start: b.start, content, end, children: kids });
    }
    let root = Node { typ: *b"root", start: 0, content: 0, end: file_size, children };
    let tree = Tree { root, top, moov_start, moov, file_size };
    for t in tree.root.find_all(b"trak") {
        validate_edit_list(&tree, t)?;
    }
    Ok(tree)
}

fn validate_edit_list(tree: &Tree, track: &Node) -> Result<()> {
    let Some(edts) = track.unique(b"edts", false)? else { return Ok(()) };
    let Some(elst) = edts.unique(b"elst", false)? else { return err("Edit-list is missing its elst box") };
    let p = tree.full_box(elst, 4)?;
    let version = p[0];
    if version != 0 && version != 1 {
        return err("Unsupported elst version");
    }
    if be32(p, 4)? != 1 {
        return err("Only one edit-list entry is supported");
    }
    let entry_size = if version == 1 { 20 } else { 12 };
    if p.len() < 8 + entry_size {
        return err("Truncated elst table");
    }
    let media_time: i64 = if version == 1 { be64(p, 16)? as i64 } else { bei32(p, 12)? as i64 };
    let rate_at = 8 + if version == 1 { 16 } else { 8 };
    let rate_int = i16::from_be_bytes([p[rate_at], p[rate_at + 1]]);
    let rate_frac = i16::from_be_bytes([p[rate_at + 2], p[rate_at + 3]]);
    if media_time != 0 || rate_int != 1 || rate_frac != 0 {
        return err("Only zero-based, rate-1 edit lists are supported");
    }
    Ok(())
}

fn track_id(tree: &Tree, track: &Node) -> Result<u32> {
    let p = tree.full_box(track.child(b"tkhd")?, 12)?;
    let at = match p[0] {
        0 => 12,
        1 => 20,
        _ => return err("Unsupported tkhd version"),
    };
    if p.len() < at + 4 {
        return err("Truncated tkhd track id");
    }
    be32(p, at)
}

fn is_video(tree: &Tree, track: &Node) -> Result<bool> {
    let hdlr = track.child(b"mdia")?.child(b"hdlr")?;
    let p = tree.full_box(hdlr, 8)?;
    Ok(&p[8..12] == b"vide")
}

/// The one video track (mp4.js selectVideoTrack) and its id.
pub fn video_track(tree: &Tree) -> Result<(&Node, u32)> {
    let tracks = tree.root.find_all(b"trak");
    let mut ids = std::collections::HashSet::new();
    for t in &tracks {
        let id = track_id(tree, t)?;
        if !ids.insert(id) {
            return err(format!("Duplicate track id {id}"));
        }
    }
    let mut video = Vec::new();
    for t in tracks {
        if is_video(tree, t)? {
            video.push(t);
        }
    }
    if video.len() != 1 {
        return err(if video.is_empty() { "No video track found" } else { "Multiple video tracks are not supported" });
    }
    let id = track_id(tree, video[0])?;
    Ok((video[0], id))
}

/// One sample (frame) of the track, in decode order.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub index: u32,
    pub description: u32,
    pub offset: u64,
    pub size: u32,
    pub dts: u64,
    pub pts: i64,
    pub duration: u32,
}

fn sample_table(track: &Node) -> Result<&Node> {
    let mdia = track.child(b"mdia")?;
    mdia.child(b"hdlr")?;
    mdia.child(b"minf")?.child(b"stbl")
}

fn table<'a>(tree: &'a Tree, n: &Node, entry: usize, versions: &[u8]) -> Result<(&'a [u8], usize)> {
    let p = tree.full_box(n, 4)?;
    if !versions.contains(&p[0]) {
        return err(format!("Unsupported {} version", name(&n.typ)));
    }
    let count = be32(p, 4)? as usize;
    if (p.len() as u128) < 8 + count as u128 * entry as u128 {
        return err(format!("Truncated {} table", name(&n.typ)));
    }
    Ok((p, count))
}

fn chunk_offsets(tree: &Tree, stbl: &Node) -> Result<Vec<u64>> {
    let stco: Vec<_> = stbl.children.iter().filter(|c| &c.typ == b"stco").collect();
    let co64: Vec<_> = stbl.children.iter().filter(|c| &c.typ == b"co64").collect();
    if stco.len() > 1 || co64.len() > 1 || (!stco.is_empty() && !co64.is_empty()) {
        return err("Track has duplicate chunk offset tables");
    }
    let Some(node) = stco.first().or(co64.first()) else { return err("Track is missing chunk offsets") };
    let width = if &node.typ == b"stco" { 4 } else { 8 };
    let (p, count) = table(tree, node, width, &[0])?;
    (0..count).map(|i| if width == 4 { be32(p, 8 + i * 4).map(u64::from) } else { be64(p, 8 + i * 8) }).collect()
}

fn sample_sizes(tree: &Tree, stbl: &Node) -> Result<Vec<u32>> {
    let p = tree.full_box(stbl.child(b"stsz")?, 12)?;
    if p[0] != 0 {
        return err("Unsupported stsz version");
    }
    let default = be32(p, 4)?;
    let count = be32(p, 8)? as usize;
    if default != 0 && count as u128 * default as u128 > tree.file_size as u128 {
        return err("stsz sample count exceeds the file");
    }
    if default != 0 {
        return Ok(vec![default; count]);
    }
    if (p.len() as u128) < 12 + count as u128 * 4 {
        return err("Truncated stsz table");
    }
    (0..count).map(|i| be32(p, 12 + i * 4)).collect()
}

/// (samples per chunk, sample description index) for each chunk.
fn decode_stsc(tree: &Tree, stbl: &Node, chunks: usize) -> Result<Vec<(u32, u32)>> {
    let (p, count) = table(tree, stbl.child(b"stsc")?, 12, &[0])?;
    if count == 0 {
        return err("stsc has no entries");
    }
    let mut entries: Vec<(u32, u32, u32)> = Vec::with_capacity(count);
    for i in 0..count {
        let at = 8 + i * 12;
        let (first, per, desc) = (be32(p, at)?, be32(p, at + 4)?, be32(p, at + 8)?);
        if first == 0 || first as usize > chunks || per == 0 || desc == 0 || entries.last().is_some_and(|e| first <= e.0) {
            return err("Invalid stsc entries");
        }
        entries.push((first, per, desc));
    }
    if entries[0].0 != 1 {
        return err("stsc must begin with chunk 1");
    }
    let mut out = Vec::with_capacity(chunks);
    let mut next = 0;
    for chunk in 1..=chunks as u32 {
        while next + 1 < entries.len() && entries[next + 1].0 <= chunk {
            next += 1;
        }
        out.push((entries[next].1, entries[next].2));
    }
    Ok(out)
}

/// stts / ctts run lengths, expanded to one value a sample.
fn time_table(tree: &Tree, stbl: &Node, typ: &[u8; 4], expected: usize) -> Result<Option<Vec<i64>>> {
    let ctts = typ == b"ctts";
    let Some(node) = stbl.unique(typ, !ctts)? else { return Ok(None) };
    let (p, count) = table(tree, node, 8, if ctts { &[0, 1] } else { &[0] })?;
    let signed = ctts && p[0] == 1;
    let mut runs = Vec::with_capacity(count);
    let mut total: u64 = 0;
    for i in 0..count {
        let at = 8 + i * 8;
        let n = be32(p, at)?;
        if n == 0 {
            return err(format!("Invalid {} sample count", name(typ)));
        }
        let v = if signed { bei32(p, at + 4)? as i64 } else { be32(p, at + 4)? as i64 };
        runs.push((n, v));
        total += n as u64;
        if total > (1u64 << 53) - 1 {
            return err(format!("{} sample count is unsafe", name(typ)));
        }
    }
    if total as usize != expected {
        return err(format!("{} sample count does not match stsz", name(typ)));
    }
    let mut out = Vec::with_capacity(expected);
    for (n, v) in runs {
        out.extend(std::iter::repeat(v).take(n as usize));
    }
    Ok(Some(out))
}

/// The video track's samples (mp4.js buildSampleIndex), checked against the mdat boxes.
pub fn sample_index(tree: &Tree, track: &Node) -> Result<Vec<Sample>> {
    track_id(tree, track)?;
    let stbl = sample_table(track)?;
    let offsets = chunk_offsets(tree, stbl)?;
    let sizes = sample_sizes(tree, stbl)?;
    let chunks = decode_stsc(tree, stbl, offsets.len())?;
    let durations = time_table(tree, stbl, b"stts", sizes.len())?.unwrap();
    let comp = time_table(tree, stbl, b"ctts", sizes.len())?;
    if chunks.iter().map(|c| c.0 as u64).sum::<u64>() != sizes.len() as u64 {
        return err("stsc sample count does not match stsz");
    }
    let mut out = Vec::with_capacity(sizes.len());
    let mut ends = Vec::with_capacity(sizes.len());
    let mut i = 0usize;
    let mut dts: u64 = 0;
    for (c, &(per, desc)) in chunks.iter().enumerate() {
        let mut offset = offsets[c] as u128;
        for _ in 0..per {
            let size = sizes[i];
            let pts = dts as i128 + comp.as_ref().map_or(0, |v| v[i]) as i128;
            ends.push((offset, offset + size as u128));
            out.push(Sample { index: i as u32, description: desc, offset: offset.min(u64::MAX as u128) as u64, size, dts, pts: pts as i64, duration: durations[i] as u32 });
            offset += size as u128;
            dts += durations[i] as u64;
            i += 1;
        }
    }
    validate_extents(tree, &mut ends)?;
    Ok(out)
}

fn validate_extents(tree: &Tree, ends: &mut [(u128, u128)]) -> Result<()> {
    let mdats = tree.root.find_all(b"mdat");
    if mdats.is_empty() {
        return err("Track samples require an mdat box");
    }
    for &(start, end) in ends.iter() {
        if end > u64::MAX as u128 {
            return err("Sample extent is outside the unsigned 64-bit range");
        }
        // binary search, as mp4.js mdatHolding (boxes in file order)
        let (mut lo, mut hi, mut found) = (0i64, mdats.len() as i64 - 1, None);
        while lo <= hi {
            let mid = (lo + hi) >> 1;
            if mdats[mid as usize].content as u128 <= start {
                found = Some(mdats[mid as usize]);
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if found.map_or(true, |m| end > m.end as u128) {
            return err("Sample extent is outside mdat media data");
        }
    }
    ends.sort_by_key(|e| e.0);
    if ends.windows(2).any(|w| w[1].0 < w[0].1) {
        return err("Sample extents overlap");
    }
    Ok(())
}

/// mdhd timescale of the track (speedReader.js: version 1 at 20, else at 12).
pub fn timescale(tree: &Tree, track: &Node) -> Result<u32> {
    let Some(mdhd) = track.first(b"mdhd") else { return err("No mdhd") };
    let md = tree.payload(mdhd)?;
    let scale = if md.first() == Some(&1) { be32(md, 20)? } else { be32(md, 12)? };
    if scale == 0 {
        return err("No timescale");
    }
    Ok(scale)
}

/// What the footage list and viewer want of a clip.
#[derive(Debug, Clone)]
pub struct ClipInfo {
    pub track_id: u32,
    /// the sample entry: avc1, hvc1, hev1, av01, ...
    pub entry: String,
    pub timescale: u32,
    pub mdhd_duration: u64,
    pub duration_ticks: u64,
    /// seconds
    pub duration: f64,
    /// sync sample numbers (1-based); None = every sample is one
    pub keyframes: Option<Vec<u32>>,
    pub samples: Vec<Sample>,
}

pub fn clip_info(path: &Path) -> Result<ClipInfo> {
    let file = File::open(path).map_err(|e| Mp4Error(e.to_string()))?;
    let tree = open_tree_up_to(&file, usize::MAX)?;
    let (track, track_id) = video_track(&tree)?;
    let samples = sample_index(&tree, track)?;
    let Some(mdhd) = track.first(b"mdhd") else { return err("No mdhd") };
    let md = tree.payload(mdhd)?;
    let v1 = md.first() == Some(&1);
    let timescale = if v1 { be32(md, 20)? } else { be32(md, 12)? };
    let mdhd_duration = if v1 { be64(md, 24)? } else { be32(md, 16)? as u64 };
    let Some(stsd) = track.first(b"stsd") else { return err("No stsd") };
    let desc = tree.payload(stsd)?;
    let entry = desc.get(12..16).map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default();
    let keyframes = match track.first(b"stss") {
        None => None,
        Some(stss) => {
            let p = tree.payload(stss)?;
            let n = be32(p, 4)? as usize;
            Some((0..n).map(|i| be32(p, 8 + i * 4)).collect::<Result<Vec<_>>>()?)
        }
    };
    let duration_ticks: u64 = samples.iter().map(|s| s.duration as u64).sum();
    Ok(ClipInfo { track_id, entry, timescale, mdhd_duration, duration_ticks, duration: duration_ticks as f64 / timescale as f64, keyframes, samples })
}

// ---- the codec alone (server/mp4codec.js): lenient, a few small reads

const MP4CODEC_MAX_MOOV: u64 = 16 * 1024 * 1024;

fn lenient_boxes(buf: &[u8], start: usize, end: usize) -> Vec<([u8; 4], usize, usize)> {
    let mut out = Vec::new();
    let mut at = start;
    while at + 8 <= end {
        let mut size = u32::from_be_bytes(buf[at..at + 4].try_into().unwrap()) as u64;
        let typ: [u8; 4] = buf[at + 4..at + 8].try_into().unwrap();
        let mut header = 8u64;
        if size == 1 {
            if at + 16 > end {
                break;
            }
            size = u64::from_be_bytes(buf[at + 8..at + 16].try_into().unwrap());
            header = 16;
        } else if size == 0 {
            size = (end - at) as u64;
        }
        if size < header || at as u128 + size as u128 > end as u128 {
            break;
        }
        out.push((typ, at + header as usize, at + size as usize));
        at += size as usize;
    }
    out
}

fn codec_name(entry: &[u8]) -> String {
    match entry {
        b"avc1" | b"avc3" => "h264".into(),
        b"hvc1" | b"hev1" => "h265".into(),
        b"av01" => "av1".into(),
        other => latin1(other),
    }
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// The codec of the first video track in a moov payload, or None (mp4codec.js codecFromMoov).
pub fn codec_from_moov(buf: &[u8]) -> Option<String> {
    for (typ, s, e) in lenient_boxes(buf, 0, buf.len()) {
        if &typ != b"trak" {
            continue;
        }
        let mut video = false;
        let mut entry: Option<[u8; 4]> = None;
        fn walk(buf: &[u8], s: usize, e: usize, video: &mut bool, entry: &mut Option<[u8; 4]>) {
            for (t, bs, be) in lenient_boxes(buf, s, e) {
                if &t == b"hdlr" && be - bs >= 12 {
                    *video = &buf[bs + 8..bs + 12] == b"vide";
                } else if &t == b"stsd" && be - bs >= 16 {
                    *entry = Some(buf[bs + 12..bs + 16].try_into().unwrap());
                } else if [b"trak", b"mdia", b"minf", b"stbl"].contains(&&t) {
                    walk(buf, bs, be, video, entry);
                }
            }
        }
        walk(buf, s, e, &mut video, &mut entry);
        if let (true, Some(en)) = (video, entry) {
            return Some(codec_name(&en));
        }
    }
    None
}

/// 'h264', 'h265', 'av1', another sample entry name, or None when the file has
/// no readable moov. Err only when the file cannot be opened or read.
pub fn video_codec(path: &Path) -> std::io::Result<Option<String>> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut at = 0u64;
    let mut head = [0u8; 16];
    for _ in 0..MAX_TOP_BOXES {
        if at + 8 > size {
            break;
        }
        let n = read_some(&file, &mut head, at)?;
        if n < 8 {
            return Ok(None);
        }
        let mut box_size = u32::from_be_bytes(head[0..4].try_into().unwrap()) as u64;
        let typ = &head[4..8];
        let mut header = 8;
        if box_size == 1 {
            if n < 16 {
                return Ok(None);
            }
            box_size = u64::from_be_bytes(head[8..16].try_into().unwrap());
            header = 16;
        } else if box_size == 0 {
            box_size = size - at;
        }
        if box_size < header {
            return Ok(None);
        }
        if typ == b"moov" {
            let len = (box_size - header).min(MP4CODEC_MAX_MOOV) as usize;
            let mut moov = vec![0u8; len];
            let got = read_some(&file, &mut moov, at + header)?;
            return Ok(codec_from_moov(&moov[..got]));
        }
        at = at.saturating_add(box_size);
    }
    Ok(None)
}

/// One read call, as fh.read does: as many bytes as come (fewer at the end of the file).
fn read_some(file: &File, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match file.read_at(&mut buf[got..], pos + got as u64) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

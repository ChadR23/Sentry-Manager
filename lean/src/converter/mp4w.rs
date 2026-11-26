//! src/main/converter/mp4.js for whole files in memory: the box tree, the
//! video track, its sample index with every check, and the chunk-offset
//! rewrite the AV1 telemetry writer uses. (lean/src/mp4.rs reads the same
//! tables from the moov alone for the footage list; this one also rewrites.)
//!
//! Offsets are u64 and every check the Node code makes with BigInt is made
//! here with u128 / i128, including "cannot be represented safely" (above
//! Number.MAX_SAFE_INTEGER).

use super::error::{CError, CResult};

pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
const UINT32_MAX: u64 = 0xffff_ffff;

fn mp4_error(message: impl Into<String>) -> CError {
    CError::new("INVALID_MP4", message)
}
fn unsupported(message: impl Into<String>) -> CError {
    CError::new("UNSUPPORTED_CONTAINER", message)
}

pub fn to_number(v: u64, context: &str) -> CResult<usize> {
    if v > MAX_SAFE {
        return Err(mp4_error(format!("{context} cannot be represented safely")));
    }
    Ok(v as usize)
}

pub fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}
pub fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
pub fn be64(b: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(b[at..at + 8].try_into().unwrap())
}
pub fn type_str(t: &[u8; 4]) -> String {
    t.iter().map(|&c| c as char).collect()
}

#[derive(Debug, Clone)]
pub struct BoxNode {
    pub typ: [u8; 4],
    pub start: u64,
    pub size: u64,
    pub header: u64,
    pub content: u64,
    pub end: u64,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
}

/// A parsed file. Node 0 is the root (the whole file).
pub struct Tree<'a> {
    pub buf: &'a [u8],
    pub nodes: Vec<BoxNode>,
}

const CONTAINERS: [&[u8; 4]; 6] = [b"moov", b"trak", b"edts", b"mdia", b"minf", b"stbl"];

pub const ROOT: usize = 0;

impl<'a> Tree<'a> {
    pub fn node(&self, i: usize) -> &BoxNode {
        &self.nodes[i]
    }
    pub fn typ(&self, i: usize) -> [u8; 4] {
        self.nodes[i].typ
    }
    pub fn top(&self) -> &[usize] {
        &self.nodes[ROOT].children
    }
    pub fn len(&self) -> u64 {
        self.buf.len() as u64
    }
    /// findBoxes(node, type): the node itself and its descendants, in file order.
    pub fn find(&self, from: usize, typ: &[u8; 4]) -> Vec<usize> {
        let mut out = Vec::new();
        self.visit(from, typ, &mut out);
        out
    }
    fn visit(&self, i: usize, typ: &[u8; 4], out: &mut Vec<usize>) {
        if i != ROOT && &self.nodes[i].typ == typ {
            out.push(i);
        }
        for &c in &self.nodes[i].children {
            self.visit(c, typ, out);
        }
    }
    pub fn children_of(&self, i: usize, typ: &[u8; 4]) -> Vec<usize> {
        self.nodes[i].children.iter().copied().filter(|&c| &self.nodes[c].typ == typ).collect()
    }
    /// nodePayload
    pub fn payload(&self, i: usize) -> CResult<&'a [u8]> {
        let n = &self.nodes[i];
        let s = to_number(n.content, "MP4 payload start")?;
        let e = to_number(n.end, "MP4 payload end")?;
        Ok(&self.buf[s..e])
    }
    pub fn unique_child(&self, i: usize, typ: &[u8; 4], required: bool) -> CResult<Option<usize>> {
        let c = self.children_of(i, typ);
        if c.len() > 1 {
            return Err(mp4_error(format!("Duplicate {} boxes are not supported", type_str(typ))));
        }
        if required && c.is_empty() {
            return Err(mp4_error(format!("Missing {} box", type_str(typ))));
        }
        Ok(c.first().copied())
    }
    fn req(&self, i: usize, typ: &[u8; 4]) -> CResult<usize> {
        Ok(self.unique_child(i, typ, true)?.unwrap())
    }
    pub fn full_box_data(&self, i: usize, min: usize) -> CResult<&'a [u8]> {
        let p = self.payload(i)?;
        if p.len() < 4 + min {
            return Err(mp4_error(format!("Truncated {} full box", type_str(&self.nodes[i].typ))));
        }
        Ok(p)
    }
}

fn parse_range(buf: &[u8], nodes: &mut Vec<BoxNode>, start: u64, end: u64, parent: usize) -> CResult<Vec<usize>> {
    let mut children = Vec::new();
    let mut cursor = start;
    while cursor < end {
        if end - cursor < 8 {
            return Err(mp4_error("Truncated MP4 box header"));
        }
        let off = to_number(cursor, "MP4 box offset")?;
        let declared = be32(buf, off) as u64;
        let mut typ = [0u8; 4];
        typ.copy_from_slice(&buf[off + 4..off + 8]);
        let ts = type_str(&typ);
        if declared == 0 {
            return Err(mp4_error(format!("Size-zero MP4 box is not supported: {ts}")));
        }
        let extended = declared == 1;
        let header = if extended { 16 } else { 8 };
        if end - cursor < header {
            return Err(mp4_error(format!("Truncated MP4 box header: {ts}")));
        }
        let size = if extended { be64(buf, off + 8) } else { declared };
        if size < header {
            return Err(mp4_error(format!("Invalid MP4 box size: {ts}")));
        }
        let box_end = cursor as u128 + size as u128;
        if box_end > end as u128 {
            return Err(mp4_error(format!("MP4 box exceeds its containing range: {ts}")));
        }
        let box_end = box_end as u64;
        if &typ == b"moof" || &typ == b"mvex" || &typ == b"mfra" {
            return Err(unsupported(format!("Fragmented MP4 is not supported: {ts}")));
        }
        let idx = nodes.len();
        nodes.push(BoxNode { typ, start: cursor, size, header, content: cursor + header, end: box_end, parent: Some(parent), children: vec![] });
        if CONTAINERS.contains(&&typ) {
            let kids = parse_range(buf, nodes, cursor + header, box_end, idx)?;
            nodes[idx].children = kids;
        }
        children.push(idx);
        cursor = box_end;
    }
    if cursor != end {
        return Err(mp4_error("Overlapping MP4 boxes are not supported"));
    }
    Ok(children)
}

/// parseMp4(buffer)
pub fn parse(buf: &[u8]) -> CResult<Tree<'_>> {
    let len = buf.len() as u64;
    let mut nodes = vec![BoxNode { typ: *b"root", start: 0, size: len, header: 0, content: 0, end: len, parent: None, children: vec![] }];
    let kids = parse_range(buf, &mut nodes, 0, len, ROOT)?;
    nodes[ROOT].children = kids;
    let tree = Tree { buf, nodes };
    for t in tree.find(ROOT, b"trak") {
        validate_simple_edit_list(&tree, t)?;
    }
    Ok(tree)
}

fn validate_simple_edit_list(tree: &Tree, track: usize) -> CResult<()> {
    let Some(edts) = tree.unique_child(track, b"edts", false)? else { return Ok(()) };
    let Some(elst) = tree.unique_child(edts, b"elst", false)? else {
        return Err(unsupported("Edit-list is missing its elst box"));
    };
    let p = tree.full_box_data(elst, 4)?;
    let version = p[0];
    if version != 0 && version != 1 {
        return Err(unsupported("Unsupported elst version"));
    }
    if be32(p, 4) != 1 {
        return Err(unsupported("Only one edit-list entry is supported"));
    }
    let entry_size = if version == 1 { 20 } else { 12 };
    if p.len() < 8 + entry_size {
        return Err(mp4_error("Truncated elst table"));
    }
    let media_time: i64 = if version == 1 { be64(p, 16) as i64 } else { be32(p, 12) as i32 as i64 };
    let rate = 8 + if version == 1 { 16 } else { 8 };
    let ri = be16(p, rate) as i16;
    let rf = be16(p, rate + 2) as i16;
    if media_time != 0 || ri != 1 || rf != 0 {
        return Err(unsupported("Only zero-based, rate-1 edit lists are supported"));
    }
    Ok(())
}

/// serializedBoxHeaderSize(payloadSize, originalHeaderSize)
pub fn serialized_header_size(payload: u64, original_header: u64) -> CResult<u64> {
    if original_header == 16 {
        return Ok(16);
    }
    if payload as u128 + 8 > UINT32_MAX as u128 {
        return Err(unsupported("Rebuilding this ordinary MP4 box would require an unsupported extended header"));
    }
    Ok(8)
}

/// serializeBox(type, payload, forceExtended)
pub fn serialize_box(typ: &[u8; 4], payload: &[u8], original_header: u64) -> CResult<Vec<u8>> {
    let h = serialized_header_size(payload.len() as u64, original_header)?;
    let total = payload.len() as u64 + h;
    let mut out = Vec::with_capacity(total as usize);
    if h == 16 {
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(typ);
        out.extend_from_slice(&total.to_be_bytes());
    } else {
        out.extend_from_slice(&(total as u32).to_be_bytes());
        out.extend_from_slice(typ);
    }
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn make_box(typ: &[u8; 4], payload: &[u8]) -> CResult<Vec<u8>> {
    serialize_box(typ, payload, 8)
}

pub fn make_full_box(typ: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> CResult<Vec<u8>> {
    if flags > 0xff_ffff {
        return Err(CError::type_error("MP4 full-box flags must fit in three bytes"));
    }
    let mut p = Vec::with_capacity(4 + payload.len());
    p.push(version);
    p.extend_from_slice(&flags.to_be_bytes()[1..]);
    p.extend_from_slice(payload);
    make_box(typ, &p)
}

pub fn track_id(tree: &Tree, track: usize) -> CResult<u32> {
    let tkhd = tree.req(track, b"tkhd")?;
    let p = tree.full_box_data(tkhd, 12)?;
    let v = p[0];
    if v != 0 && v != 1 {
        return Err(unsupported("Unsupported tkhd version"));
    }
    let at = if v == 1 { 20 } else { 12 };
    if p.len() < at + 4 {
        return Err(mp4_error("Truncated tkhd track id"));
    }
    Ok(be32(p, at))
}

fn is_video_track(tree: &Tree, track: usize) -> CResult<bool> {
    let mdia = tree.req(track, b"mdia")?;
    let hdlr = tree.req(mdia, b"hdlr")?;
    let p = tree.full_box_data(hdlr, 8)?;
    Ok(&p[8..12] == b"vide")
}

pub fn tracks_with_unique_ids(tree: &Tree) -> CResult<Vec<usize>> {
    let tracks = tree.find(ROOT, b"trak");
    let mut ids = std::collections::HashSet::new();
    for &t in &tracks {
        let id = track_id(tree, t)?;
        if !ids.insert(id) {
            return Err(mp4_error(format!("Duplicate track id {id}")));
        }
    }
    Ok(tracks)
}

/// selectVideoTrack: (trak node, track id)
pub fn select_video_track(tree: &Tree) -> CResult<(usize, u32)> {
    let mut video = Vec::new();
    for t in tracks_with_unique_ids(tree)? {
        if is_video_track(tree, t)? {
            video.push(t);
        }
    }
    if video.len() != 1 {
        return Err(unsupported(if video.is_empty() { "No video track found" } else { "Multiple video tracks are not supported" }));
    }
    Ok((video[0], track_id(tree, video[0])?))
}

pub fn sample_table(tree: &Tree, track: usize) -> CResult<usize> {
    let mdia = tree.req(track, b"mdia")?;
    tree.req(mdia, b"hdlr")?;
    let minf = tree.req(mdia, b"minf")?;
    tree.req(minf, b"stbl")
}

fn table_payload<'a>(tree: &Tree<'a>, i: usize, entry: u64, versions: &[u8]) -> CResult<(&'a [u8], u32)> {
    let p = tree.full_box_data(i, 4)?;
    if !versions.contains(&p[0]) {
        return Err(unsupported(format!("Unsupported {} version", type_str(&tree.nodes[i].typ))));
    }
    let count = be32(p, 4);
    if (p.len() as u64) < 8 + count as u64 * entry {
        return Err(mp4_error(format!("Truncated {} table", type_str(&tree.nodes[i].typ))));
    }
    Ok((p, count))
}

/// chunkOffsets(tree, stbl): (table node, offsets)
pub fn chunk_offsets(tree: &Tree, stbl: usize) -> CResult<(usize, Vec<u64>)> {
    let stco = tree.children_of(stbl, b"stco");
    let co64 = tree.children_of(stbl, b"co64");
    if stco.len() > 1 || co64.len() > 1 || (!stco.is_empty() && !co64.is_empty()) {
        return Err(mp4_error("Track has duplicate chunk offset tables"));
    }
    let Some(&node) = stco.first().or(co64.first()) else { return Err(mp4_error("Track is missing chunk offsets")) };
    let width = if &tree.nodes[node].typ == b"stco" { 4 } else { 8 };
    let (p, count) = table_payload(tree, node, width, &[0])?;
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let at = 8 + i * width as usize;
        out.push(if width == 4 { be32(p, at) as u64 } else { be64(p, at) });
    }
    Ok((node, out))
}

fn sample_sizes(tree: &Tree, stbl: usize) -> CResult<Vec<u32>> {
    let node = tree.req(stbl, b"stsz")?;
    // The full-box version/flags are counted by full_box_data: only
    // sample_size and sample_count follow. Constant-size tables have no entries.
    let p = tree.full_box_data(node, 8)?;
    if p[0] != 0 {
        return Err(unsupported("Unsupported stsz version"));
    }
    let default = be32(p, 4);
    let count = be32(p, 8);
    if default != 0 && count as u128 * default as u128 > tree.len() as u128 {
        return Err(mp4_error("stsz sample count exceeds the file"));
    }
    if default != 0 {
        return Ok(vec![default; count as usize]);
    }
    if (p.len() as u64) < 12 + count as u64 * 4 {
        return Err(mp4_error("Truncated stsz table"));
    }
    Ok((0..count as usize).map(|i| be32(p, 12 + i * 4)).collect())
}

fn decode_stsc(tree: &Tree, stbl: usize, chunk_count: usize) -> CResult<Vec<(u32, u32)>> {
    let node = tree.req(stbl, b"stsc")?;
    let (p, count) = table_payload(tree, node, 12, &[0])?;
    if count == 0 {
        return Err(mp4_error("stsc has no entries"));
    }
    let mut entries: Vec<(u32, u32, u32)> = Vec::new();
    for i in 0..count as usize {
        let at = 8 + i * 12;
        let (first, spc, sdi) = (be32(p, at), be32(p, at + 4), be32(p, at + 8));
        if first == 0 || first as usize > chunk_count || spc == 0 || sdi == 0 || entries.last().is_some_and(|e| first <= e.0) {
            return Err(mp4_error("Invalid stsc entries"));
        }
        entries.push((first, spc, sdi));
    }
    if entries[0].0 != 1 {
        return Err(mp4_error("stsc must begin with chunk 1"));
    }
    let mut out = Vec::with_capacity(chunk_count);
    let mut next = 0;
    for chunk in 1..=chunk_count {
        while next + 1 < entries.len() && entries[next + 1].0 as usize <= chunk {
            next += 1;
        }
        out.push((entries[next].1, entries[next].2));
    }
    Ok(out)
}

struct TimeTable {
    values: Vec<(u32, i64)>,
    total: u64,
}

fn decode_time_table(tree: &Tree, stbl: usize, typ: &[u8; 4], signed: bool) -> CResult<Option<TimeTable>> {
    let Some(node) = tree.unique_child(stbl, typ, typ == b"stts")? else { return Ok(None) };
    let versions: &[u8] = if typ == b"ctts" { &[0, 1] } else { &[0] };
    let (p, count) = table_payload(tree, node, 8, versions)?;
    let mut values = Vec::with_capacity(count as usize);
    let mut total: u64 = 0;
    for i in 0..count as usize {
        let at = 8 + i * 8;
        let n = be32(p, at);
        if n == 0 {
            return Err(mp4_error(format!("Invalid {} sample count", type_str(typ))));
        }
        let v = if signed && p[0] == 1 { be32(p, at + 4) as i32 as i64 } else { be32(p, at + 4) as i64 };
        values.push((n, v));
        total += n as u64;
        if total > MAX_SAFE {
            return Err(mp4_error(format!("{} sample count is unsafe", type_str(typ))));
        }
    }
    Ok(Some(TimeTable { values, total }))
}

fn expand(t: &TimeTable, expected: usize, label: &str) -> CResult<Vec<i64>> {
    if t.total != expected as u64 {
        return Err(mp4_error(format!("{label} sample count does not match stsz")));
    }
    let mut out = Vec::with_capacity(expected);
    for &(n, v) in &t.values {
        for _ in 0..n {
            out.push(v);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub index: usize,
    pub description: u32,
    pub offset: u64,
    pub size: u32,
    pub dts: i128,
    pub pts: i128,
    pub duration: i64,
}

fn mdat_holding(tree: &Tree, mdats: &[usize], offset: u64) -> Option<usize> {
    let (mut lo, mut hi) = (0isize, mdats.len() as isize - 1);
    let mut found = None;
    while lo <= hi {
        let mid = ((lo + hi) >> 1) as usize;
        if tree.nodes[mdats[mid]].content <= offset {
            found = Some(mdats[mid]);
            lo = mid as isize + 1;
        } else {
            hi = mid as isize - 1;
        }
    }
    found
}

pub fn validate_sample_extents(tree: &Tree, samples: &[Sample]) -> CResult<()> {
    let mdats = tree.find(ROOT, b"mdat");
    if mdats.is_empty() {
        return Err(mp4_error("Track samples require an mdat box"));
    }
    let mut extents = Vec::with_capacity(samples.len());
    for s in samples {
        let end = s.offset as u128 + s.size as u128;
        if end > u64::MAX as u128 {
            return Err(mp4_error("Sample extent is outside the unsigned 64-bit range"));
        }
        match mdat_holding(tree, &mdats, s.offset) {
            Some(m) if end <= tree.nodes[m].end as u128 => {}
            _ => return Err(mp4_error("Sample extent is outside mdat media data")),
        }
        extents.push((s.offset as u128, end));
    }
    extents.sort_by(|a, b| a.0.cmp(&b.0));
    for i in 1..extents.len() {
        if extents[i].0 < extents[i - 1].1 {
            return Err(mp4_error("Sample extents overlap"));
        }
    }
    Ok(())
}

/// buildSampleIndex(track)
pub fn build_sample_index(tree: &Tree, track: usize) -> CResult<Vec<Sample>> {
    track_id(tree, track)?;
    let stbl = sample_table(tree, track)?;
    let (_, offsets) = chunk_offsets(tree, stbl)?;
    let sizes = sample_sizes(tree, stbl)?;
    let chunks = decode_stsc(tree, stbl, offsets.len())?;
    let Some(stts) = decode_time_table(tree, stbl, b"stts", false)? else { return Err(mp4_error("Track is missing stts")) };
    let durations = expand(&stts, sizes.len(), "stts")?;
    let ctts = decode_time_table(tree, stbl, b"ctts", true)?;
    let comp = match &ctts {
        Some(c) => expand(c, sizes.len(), "ctts")?,
        None => vec![0; sizes.len()],
    };
    if chunks.iter().map(|c| c.0 as u64).sum::<u64>() != sizes.len() as u64 {
        return Err(mp4_error("stsc sample count does not match stsz"));
    }
    let mut out = Vec::with_capacity(sizes.len());
    let mut si = 0usize;
    let mut dts: i128 = 0;
    for (ci, &(spc, sdi)) in chunks.iter().enumerate() {
        let mut off = offsets[ci] as u128;
        for _ in 0..spc {
            let size = sizes[si];
            if off > u64::MAX as u128 {
                return Err(mp4_error("Sample extent is outside the unsigned 64-bit range"));
            }
            out.push(Sample { index: si, description: sdi, offset: off as u64, size, dts, pts: dts + comp[si] as i128, duration: durations[si] });
            off += size as u128;
            dts += durations[si] as i128;
            si += 1;
        }
    }
    validate_sample_extents(tree, &out)?;
    Ok(out)
}

/// mdhd timescale (telemetryTimeline.js readTrackTimescale).
pub fn track_timescale(tree: &Tree, track: usize, err: fn(&str, String) -> CError) -> CResult<u32> {
    let boxes = tree.find(track, b"mdhd");
    if boxes.len() != 1 {
        return Err(err("UNSUPPORTED_CONTAINER", "Video track must contain exactly one mdhd box".into()));
    }
    let n = &tree.nodes[boxes[0]];
    let (s, e) = (to_number(n.content, "mdhd start")?, to_number(n.end, "mdhd end")?);
    if e - s < 4 {
        return Err(err("", "Truncated mdhd box".into()));
    }
    let v = tree.buf[s];
    let at = match v {
        0 => 12,
        1 => 20,
        _ => return Err(err("UNSUPPORTED_CONTAINER", "Unsupported mdhd version".into())),
    };
    if e - s < at + 4 {
        return Err(err("", "Truncated mdhd timescale".into()));
    }
    let ts = be32(tree.buf, s + at);
    if ts == 0 {
        return Err(err("", "Video timescale must be non-zero".into()));
    }
    Ok(ts)
}

/// rewriteChunkOffsets(buffer, tree, delta): the whole file again with every
/// chunk offset moved by `delta`, stco tables promoted to co64 where needed.
pub fn rewrite_chunk_offsets(tree: &Tree, delta: i128) -> CResult<Vec<u8>> {
    let tracks = tracks_with_unique_ids(tree)?;
    let mut all = Vec::new();
    for t in tracks {
        all.extend(build_sample_index(tree, t)?);
    }
    validate_sample_extents(tree, &all)?;
    struct Table {
        node: usize,
        offsets: Vec<u64>,
        co64: bool,
        grew: bool,
    }
    let mut nodes = tree.find(ROOT, b"stco");
    nodes.extend(tree.find(ROOT, b"co64"));
    let mut tables = Vec::new();
    for n in nodes {
        let parent = tree.nodes[n].parent.unwrap();
        let (_, offsets) = chunk_offsets(tree, parent)?;
        tables.push(Table { node: n, co64: &tree.nodes[n].typ == b"co64", offsets, grew: false });
    }
    let rewritten = |offset: u64, promoted: &[(u64, usize)]| -> CResult<u128> {
        let shift: i128 = promoted.iter().filter(|(start, _)| *start < offset).map(|(_, count)| *count as i128 * 4).sum();
        let r = offset as i128 + delta + shift;
        if r < 0 || r > u64::MAX as i128 {
            return Err(mp4_error("Rewritten chunk offset is outside the unsigned 64-bit range"));
        }
        Ok(r as u128)
    };
    let mut changed = true;
    while changed {
        changed = false;
        let promoted: Vec<(u64, usize)> = tables.iter().filter(|t| t.grew).map(|t| (tree.nodes[t.node].start, t.offsets.len())).collect();
        for t in tables.iter_mut() {
            if t.co64 {
                continue;
            }
            let mut over = false;
            for &o in &t.offsets {
                if rewritten(o, &promoted)? > UINT32_MAX as u128 {
                    over = true;
                    break;
                }
            }
            if over {
                t.co64 = true;
                t.grew = true;
                changed = true;
            }
        }
    }
    let promoted: Vec<(u64, usize)> = tables.iter().filter(|t| t.grew).map(|t| (tree.nodes[t.node].start, t.offsets.len())).collect();
    let by_node: std::collections::HashMap<usize, usize> = tables.iter().enumerate().map(|(i, t)| (t.node, i)).collect();

    fn planned(tree: &Tree, i: usize, by_node: &std::collections::HashMap<usize, usize>, tables: &[(usize, bool)]) -> CResult<u64> {
        if i == ROOT {
            let mut s = 0u64;
            for &c in &tree.nodes[ROOT].children {
                s += planned(tree, c, by_node, tables)?;
            }
            return Ok(s);
        }
        let n = &tree.nodes[i];
        let payload = if let Some(&t) = by_node.get(&i) {
            8 + tables[t].0 as u64 * if tables[t].1 { 8 } else { 4 }
        } else if !n.children.is_empty() {
            let mut s = 0u64;
            for &c in &n.children {
                s += planned(tree, c, by_node, tables)?;
            }
            s
        } else {
            n.size - n.header
        };
        Ok(payload + serialized_header_size(payload, n.header)?)
    }
    let shape: Vec<(usize, bool)> = tables.iter().map(|t| (t.offsets.len(), t.co64)).collect();
    planned(tree, ROOT, &by_node, &shape)?;

    fn ser(
        tree: &Tree,
        i: usize,
        by_node: &std::collections::HashMap<usize, usize>,
        tables_out: &[(bool, Vec<u128>)],
        out: &mut Vec<u8>,
    ) -> CResult<()> {
        if i == ROOT {
            for &c in &tree.nodes[ROOT].children {
                ser(tree, c, by_node, tables_out, out)?;
            }
            return Ok(());
        }
        let n = &tree.nodes[i];
        if let Some(&t) = by_node.get(&i) {
            let original = tree.payload(i)?;
            let (co64, values) = &tables_out[t];
            let w = if *co64 { 8 } else { 4 };
            let mut p = vec![0u8; 8 + values.len() * w];
            p[..8].copy_from_slice(&original[..8]);
            for (k, &v) in values.iter().enumerate() {
                if *co64 {
                    p[8 + k * 8..16 + k * 8].copy_from_slice(&(v as u64).to_be_bytes());
                } else {
                    p[8 + k * 4..12 + k * 4].copy_from_slice(&(v as u32).to_be_bytes());
                }
            }
            out.extend(serialize_box(if *co64 { b"co64" } else { b"stco" }, &p, n.header)?);
            return Ok(());
        }
        let payload = if !n.children.is_empty() {
            let mut p = Vec::new();
            for &c in &n.children {
                ser(tree, c, by_node, tables_out, &mut p)?;
            }
            p
        } else {
            tree.payload(i)?.to_vec()
        };
        out.extend(serialize_box(&n.typ, &payload, n.header)?);
        Ok(())
    }
    let mut tables_out = Vec::new();
    for t in &tables {
        let mut v = Vec::with_capacity(t.offsets.len());
        for &o in &t.offsets {
            v.push(rewritten(o, &promoted)?);
        }
        tables_out.push((t.co64, v));
    }
    let mut out = Vec::with_capacity(tree.buf.len());
    ser(tree, ROOT, &by_node, &tables_out, &mut out)?;
    Ok(out)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn bx(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        make_box(typ, payload).unwrap()
    }
    pub fn full(typ: &[u8; 4], v: u8, payload: &[u8]) -> Vec<u8> {
        make_full_box(typ, v, 0, payload).unwrap()
    }
    fn u32s(v: &[u32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_be_bytes()).collect()
    }

    /// A one-track file: ftyp, mdat with `samples`, moov after it.
    pub fn simple(samples: &[&[u8]], handler: &[u8; 4]) -> Vec<u8> {
        let ftyp = bx(b"ftyp", b"isom\0\0\0\0");
        let media: Vec<u8> = samples.concat();
        let mdat = bx(b"mdat", &media);
        let first = (ftyp.len() + 8) as u32;
        let mut tkhd = vec![0u8; 80];
        tkhd[8..12].copy_from_slice(&1u32.to_be_bytes());
        let mut hdlr = vec![0u8; 20];
        hdlr[4..8].copy_from_slice(handler);
        let mut mdhd = vec![0u8; 20];
        mdhd[8..12].copy_from_slice(&1000u32.to_be_bytes());
        let n = samples.len() as u32;
        let stsz = full(b"stsz", 0, &[u32s(&[0, n]), u32s(&samples.iter().map(|s| s.len() as u32).collect::<Vec<_>>())].concat());
        let stbl = bx(
            b"stbl",
            &[
                full(b"stts", 0, &u32s(&[1, n, 33])),
                full(b"stsc", 0, &u32s(&[1, 1, n, 1])),
                stsz,
                full(b"stco", 0, &u32s(&[1, first])),
            ]
            .concat(),
        );
        let minf = bx(b"minf", &stbl);
        let mdia = bx(b"mdia", &[full(b"mdhd", 0, &mdhd), full(b"hdlr", 0, &hdlr), minf].concat());
        let trak = bx(b"trak", &[full(b"tkhd", 0, &tkhd), mdia].concat());
        let moov = bx(b"moov", &trak);
        [ftyp, mdat, moov].concat()
    }

    #[test]
    fn index_and_rewrite() {
        let f = simple(&[b"abcd", b"efghij"], b"vide");
        let t = parse(&f).unwrap();
        let (trak, id) = select_video_track(&t).unwrap();
        assert_eq!(id, 1);
        let s = build_sample_index(&t, trak).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(&f[s[1].offset as usize..s[1].offset as usize + 6], b"efghij");
        assert_eq!(s[1].dts, 33);
        // shift by 100: the offsets follow
        let shifted = rewrite_chunk_offsets(&t, 100).unwrap();
        assert_eq!(shifted.len(), f.len());
        let t2 = parse(&shifted).unwrap();
        let (trak2, _) = select_video_track(&t2).unwrap();
        let (_, offs) = chunk_offsets(&t2, sample_table(&t2, trak2).unwrap()).unwrap();
        assert_eq!(offs[0], s[0].offset + 100);
        // a shift past 4 GiB promotes stco to co64
        let big = rewrite_chunk_offsets(&t, 1 << 33).unwrap();
        assert_eq!(big.len(), f.len() + 4);
        assert!(big.windows(4).any(|w| w == b"co64"));
    }

    #[test]
    fn refusals() {
        assert_eq!(parse(&bx(b"moof", b"")).err().unwrap().code, "UNSUPPORTED_CONTAINER");
        assert_eq!(parse(&[0, 0, 0, 0, b'f', b'r', b'e', b'e']).err().unwrap().code, "INVALID_MP4");
        let mut f = simple(&[b"abcd"], b"vide");
        f.extend_from_slice(&[0, 0, 0]);
        assert!(parse(&f).is_err());
        let a = simple(&[b"abcd"], b"soun");
        let t = parse(&a).unwrap();
        assert_eq!(select_video_track(&t).err().unwrap().message, "No video track found");
    }
}

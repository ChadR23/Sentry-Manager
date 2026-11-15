//! src/main/converter/h265Telemetry.js: Tesla's telemetry written into an
//! H.265 encode, and the inspection the verifier compares with the original.
//!
//! Every sample gets, before its own NAL units: one standards prefix SEI
//! (user_data_unregistered under the app's UUID, the Tesla H.264 SEI inside)
//! per record, then one `66 01` compatibility record per record (what Tesla's
//! own viewers read), then the `61 01 80` picture marker.

use super::error::{CError, CResult};
use super::mp4w::{self, be32, serialized_header_size, Sample, Tree, ROOT};
use super::tesla_sei::{fingerprint, read_sei_field, remove_emulation_prevention_bytes, tesla_payload};
use super::timeline::MappedSample;
use std::collections::HashMap;

pub const PICTURE_MARKER: [u8; 3] = [0x61, 0x01, 0x80];
pub const PREFIX_SEI_UUID: &[u8; 16] = b"Sentry-Six-Tesla";
const UINT32_MAX: u64 = 0xffff_ffff;

fn h265_error(message: impl Into<String>) -> CError {
    CError::new("INVALID_H265", message)
}
fn err(code: &str, message: impl Into<String>) -> CError {
    CError::new(code, message)
}

fn safe(v: u64, label: &str) -> CResult<usize> {
    if v > mp4w::MAX_SAFE {
        return Err(err("UNSUPPORTED_CONTAINER", format!("{label} cannot be represented safely")));
    }
    Ok(v as usize)
}

pub struct Embedded {
    pub typ: [u8; 4],
    pub content: usize,
    pub end: usize,
}

/// parseEmbeddedBoxes (sample entries and their children), with the
/// writer's error codes (`code` for "invalid", `unsupported` for size zero).
pub fn parse_embedded(buf: &[u8], start: usize, end: usize, context: &str, code: &str) -> CResult<Vec<Embedded>> {
    let mut out = Vec::new();
    let mut c = start;
    while c < end {
        if end - c < 8 {
            return Err(err(code, format!("Truncated {context} box header")));
        }
        let declared = be32(buf, c);
        let mut typ = [0u8; 4];
        typ.copy_from_slice(&buf[c + 4..c + 8]);
        let ts = mp4w::type_str(&typ);
        if declared == 0 {
            return Err(err("UNSUPPORTED_CONTAINER", format!("Size-zero {context} box is not supported: {ts}")));
        }
        let header = if declared == 1 { 16 } else { 8 };
        if end - c < header {
            return Err(err(code, format!("Truncated {context} box header: {ts}")));
        }
        let size = if declared == 1 { mp4w::be64(buf, c + 8) } else { declared as u64 };
        if size < header as u64 || size > mp4w::MAX_SAFE {
            return Err(err(code, format!("Invalid {context} box size: {ts}")));
        }
        let box_end = c as u128 + size as u128;
        if box_end > end as u128 {
            return Err(err(code, format!("{context} box exceeds its containing range: {ts}")));
        }
        out.push(Embedded { typ, content: c + header, end: box_end as usize });
        c = box_end as usize;
    }
    if c != end {
        return Err(err(code, format!("Overlapping {context} boxes are not supported")));
    }
    Ok(out)
}

fn validate_hvcc(buf: &[u8], content: usize, end: usize) -> CResult<usize> {
    if end - content < 23 {
        return Err(h265_error("Truncated hvcC configuration record"));
    }
    if buf[content] != 1 {
        return Err(err("UNSUPPORTED_CONTAINER", "Unsupported hvcC configuration version"));
    }
    let length_size = (buf[content + 21] & 3) as usize + 1;
    let arrays = buf[content + 22];
    let mut c = content + 23;
    for _ in 0..arrays {
        if end - c < 3 {
            return Err(h265_error("Truncated hvcC NAL array"));
        }
        let n = mp4w::be16(buf, c + 1);
        c += 3;
        for _ in 0..n {
            if end - c < 2 {
                return Err(h265_error("Truncated hvcC NAL length"));
            }
            let size = mp4w::be16(buf, c) as usize;
            c += 2;
            if size == 0 || size > end - c {
                return Err(h265_error("Invalid hvcC NAL extent"));
            }
            c += size;
        }
    }
    if c != end {
        return Err(h265_error("Unexpected trailing bytes in hvcC configuration record"));
    }
    Ok(length_size)
}

/// readHvc1Info: the NAL length size.
fn read_hvc1_info(tree: &Tree, track: usize) -> CResult<usize> {
    let d = tree.find(track, b"stsd");
    if d.len() != 1 {
        return Err(err("UNSUPPORTED_CONTAINER", "Video track must contain exactly one stsd box"));
    }
    let n = tree.node(d[0]);
    let (cs, e) = (safe(n.content, "stsd content start")?, safe(n.end, "stsd end")?);
    safe(n.start, "stsd start")?;
    if e - cs < 8 {
        return Err(h265_error("Truncated stsd box"));
    }
    if tree.buf[cs] != 0 {
        return Err(err("UNSUPPORTED_CONTAINER", "Unsupported stsd version"));
    }
    let count = be32(tree.buf, cs + 4);
    let entries = parse_embedded(tree.buf, cs + 8, e, "sample entry", "INVALID_H265")?;
    if count != 1 || entries.len() != 1 {
        return Err(err("UNSUPPORTED_CONTAINER", "Video track must contain exactly one sample description"));
    }
    let entry = &entries[0];
    if &entry.typ != b"hvc1" {
        return Err(err("UNSUPPORTED_CONTAINER", format!("Video sample entry must be hvc1, received {}", mp4w::type_str(&entry.typ))));
    }
    if entry.end - entry.content < 78 {
        return Err(h265_error("Truncated hvc1 visual sample entry"));
    }
    let kids = parse_embedded(tree.buf, entry.content + 78, entry.end, "hvc1 child", "INVALID_H265")?;
    let configs: Vec<&Embedded> = kids.iter().filter(|k| &k.typ == b"hvcC").collect();
    if configs.len() != 1 {
        return Err(err("UNSUPPORTED_CONTAINER", "hvc1 sample entry must contain exactly one hvcC box"));
    }
    validate_hvcc(tree.buf, configs[0].content, configs[0].end)
}

pub fn hevc_nal_type(nal: &[u8]) -> u8 {
    (nal[0] >> 1) & 0x3f
}

fn read_uint_be(b: &[u8], at: usize, width: usize) -> usize {
    let mut v = 0usize;
    for i in 0..width {
        v = (v << 8) | b[at + i] as usize;
    }
    v
}

pub fn parse_hevc_nals(sample: &[u8], length_size: usize, index: usize) -> CResult<Vec<&[u8]>> {
    if !(1..=4).contains(&length_size) {
        return Err(err("UNSUPPORTED_H265", "HEVC NAL length size must be between 1 and 4 bytes"));
    }
    let mut nals = Vec::new();
    let mut c = 0;
    while c < sample.len() {
        if sample.len() - c < length_size {
            return Err(h265_error(format!("Truncated NAL length prefix in sample {index}")));
        }
        let size = read_uint_be(sample, c, length_size);
        c += length_size;
        if size < 2 {
            return Err(h265_error(format!("HEVC NAL in sample {index} is shorter than its two-byte header")));
        }
        if size > sample.len() - c {
            return Err(h265_error(format!("NAL length exceeds sample boundary in sample {index}")));
        }
        let nal = &sample[c..c + size];
        if nal[0] & 0x80 != 0 || nal[1] & 0x07 == 0 {
            return Err(h265_error(format!("Invalid HEVC NAL header in sample {index}")));
        }
        nals.push(nal);
        c += size;
    }
    if nals.is_empty() {
        return Err(h265_error(format!("H.265 sample {index} contains no NAL units")));
    }
    Ok(nals)
}

fn length_prefix(nal: &[u8], length_size: usize) -> CResult<Vec<u8>> {
    let max: u64 = (1u64 << (length_size * 8)) - 1;
    if nal.len() as u64 > max {
        return Err(err("UNSUPPORTED_H265", format!("Injected NAL does not fit the {length_size}-byte hvcC length field")));
    }
    let mut out = (nal.len() as u32).to_be_bytes()[4 - length_size..].to_vec();
    out.extend_from_slice(nal);
    Ok(out)
}

fn encode_sei_field(mut v: usize, out: &mut Vec<u8>) {
    while v >= 0xff {
        out.push(0xff);
        v -= 0xff;
    }
    out.push(v as u8);
}

pub fn add_emulation_prevention_bytes(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + 8);
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    out
}

fn prefix_sei_record(h264: &[u8], ls: usize) -> CResult<Vec<u8>> {
    let mut user = PREFIX_SEI_UUID.to_vec();
    user.extend_from_slice(h264);
    let mut rbsp = Vec::new();
    encode_sei_field(5, &mut rbsp);
    encode_sei_field(user.len(), &mut rbsp);
    rbsp.extend_from_slice(&user);
    rbsp.push(0x80);
    let mut nal = vec![0x4e, 0x01];
    nal.extend(add_emulation_prevention_bytes(&rbsp));
    length_prefix(&nal, ls)
}

fn compatibility_record(h264: &[u8], ls: usize) -> CResult<Vec<u8>> {
    let mut nal = vec![0x66, 0x01];
    nal.extend_from_slice(&h264[2..]);
    length_prefix(&nal, ls)
}

fn validate_mapped(mapped: &[MappedSample], count: usize) -> CResult<()> {
    if mapped.len() != count {
        return Err(h265_error("Mapped timeline must match the H.265 video sample count"));
    }
    for (si, m) in mapped.iter().enumerate() {
        if !m.picture_marker {
            return Err(h265_error(format!("Mapped timeline sample {si} is invalid")));
        }
        for (ri, r) in m.sei_nals.iter().enumerate() {
            if tesla_payload(&r.nal).is_none() {
                return Err(h265_error(format!("Mapped timeline sample {si} SEI {ri} is not one canonical Tesla H.264 type-5 message")));
            }
        }
    }
    Ok(())
}

fn require_sole_description(samples: &[Sample]) -> CResult<()> {
    if let Some(s) = samples.iter().find(|s| s.description != 1) {
        return Err(err("UNSUPPORTED_CONTAINER", format!("H.265 sample {} references unsupported sample description {}", s.index, s.description)));
    }
    Ok(())
}

fn compat_payload(nal: &[u8]) -> Option<Vec<u8>> {
    let mut h = vec![0x06, 0x05];
    h.extend_from_slice(&nal[2..]);
    tesla_payload(&h)
}

fn is_recognized_injected(nal: &[u8]) -> bool {
    if nal == PICTURE_MARKER {
        return true;
    }
    if standard_prefix_payload(nal).is_some() {
        return true;
    }
    if nal.len() >= 3 && nal[0] == 0x66 && nal[1] == 0x01 {
        return compat_payload(nal).is_some();
    }
    false
}

fn standard_prefix_payload(nal: &[u8]) -> Option<Vec<u8>> {
    if nal.len() < 2 || nal[0] != 0x4e || nal[1] != 0x01 {
        return None;
    }
    let rbsp = remove_emulation_prevention_bytes(&nal[2..])?;
    let mut c = 0;
    let typ = read_sei_field(&rbsp, &mut c);
    let size = read_sei_field(&rbsp, &mut c);
    let (Some(5), Some(size)) = (typ, size) else { return None };
    if size > rbsp.len() - c {
        return None;
    }
    let end = c + size;
    if end + 1 != rbsp.len() || rbsp[end] != 0x80 {
        return None;
    }
    let p = &rbsp[c..end];
    if p.len() <= PREFIX_SEI_UUID.len() || &p[..16] != PREFIX_SEI_UUID {
        return None;
    }
    tesla_payload(&p[16..])
}

fn direct_payload<'a>(tree: &Tree<'a>, i: usize) -> CResult<&'a [u8]> {
    let n = tree.node(i);
    let label = mp4w::type_str(&n.typ);
    let (cs, e) = (safe(n.content, &format!("{label} content start"))?, safe(n.end, &format!("{label} end"))?);
    safe(n.start, &format!("{label} start"))?;
    Ok(&tree.buf[cs..e])
}

struct ChunkTable {
    node: usize,
    offsets: Vec<u64>,
    co64: bool,
    out: Vec<u64>,
}

fn read_chunk_table(tree: &Tree, i: usize) -> CResult<ChunkTable> {
    let p = direct_payload(tree, i)?;
    let co64 = &tree.node(i).typ == b"co64";
    let w = if co64 { 8 } else { 4 };
    if p.len() < 8 || p[0] != 0 {
        return Err(err("UNSUPPORTED_CONTAINER", format!("Unsupported {} table", mp4w::type_str(&tree.node(i).typ))));
    }
    let count = be32(p, 4) as usize;
    if p.len() != 8 + count * w {
        return Err(h265_error(format!("Invalid {} table length", mp4w::type_str(&tree.node(i).typ))));
    }
    let offsets = (0..count).map(|k| if co64 { mp4w::be64(p, 8 + k * 8) } else { be32(p, 8 + k * 4) as u64 }).collect();
    Ok(ChunkTable { node: i, offsets, co64, out: vec![] })
}

/// planChunkOffsetTables: which stco tables must become co64 once every
/// offset is projected, and the final offsets.
pub fn plan_chunk_offset_tables(
    tables: &[(bool, u64, Vec<u64>)],
    project: &dyn Fn(u64) -> CResult<u128>,
) -> CResult<(u64, Vec<(bool, Vec<u64>)>)> {
    let mut promoted = vec![false; tables.len()];
    for (co64, _, offs) in tables {
        if !co64 && offs.iter().any(|&o| o > UINT32_MAX) {
            return Err(CError::new("INVALID_MP4", "Input stco offset exceeds 32 bits"));
        }
    }
    let projected = |promoted: &[bool], t: usize, e: usize| -> CResult<u128> {
        let original = tables[t].2[e];
        let base = project(original)?;
        let growth: u128 = tables.iter().enumerate().filter(|(k, c)| promoted[*k] && c.1 < original).map(|(_, c)| c.2.len() as u128 * 4).sum();
        let v = base + growth;
        if v > u64::MAX as u128 {
            return Err(h265_error("Rewritten chunk offset is outside the unsigned 64-bit range"));
        }
        Ok(v)
    };
    loop {
        let mut changed = false;
        for t in 0..tables.len() {
            if !tables[t].0 && !promoted[t] {
                let mut over = false;
                for e in 0..tables[t].2.len() {
                    if projected(&promoted, t, e)? > UINT32_MAX as u128 {
                        over = true;
                        break;
                    }
                }
                if over {
                    promoted[t] = true;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    let growth = tables.iter().enumerate().filter(|(k, _)| promoted[*k]).map(|(_, t)| t.2.len() as u64 * 4).sum();
    let mut out = Vec::new();
    for t in 0..tables.len() {
        let mut v = Vec::with_capacity(tables[t].2.len());
        for e in 0..tables[t].2.len() {
            v.push(projected(&promoted, t, e)? as u64);
        }
        out.push((tables[t].0 || promoted[t], v));
    }
    Ok((growth, out))
}

fn ser_box(typ: &[u8; 4], payload: &[u8], header: u64) -> CResult<Vec<u8>> {
    let h = serialized_header_size(payload.len() as u64, header)?;
    if payload.len() as u64 + h > mp4w::MAX_SAFE {
        return Err(err("UNSUPPORTED_CONTAINER", format!("Rebuilt {} box cannot be represented safely", mp4w::type_str(typ))));
    }
    mp4w::serialize_box(typ, payload, header)
}

fn stsz_payload(tree: &Tree, i: usize, sizes: &[u64]) -> CResult<Vec<u8>> {
    let o = direct_payload(tree, i)?;
    if o.len() < 12 || o[0] != 0 {
        return Err(err("UNSUPPORTED_CONTAINER", "Unsupported stsz table"));
    }
    if be32(o, 8) as usize != sizes.len() {
        return Err(h265_error("stsz sample count changed unexpectedly"));
    }
    let mut p = vec![0u8; 12 + sizes.len() * 4];
    p[..4].copy_from_slice(&o[..4]);
    p[8..12].copy_from_slice(&(sizes.len() as u32).to_be_bytes());
    for (k, &s) in sizes.iter().enumerate() {
        if s < 1 || s > UINT32_MAX {
            return Err(err("UNSUPPORTED_CONTAINER", "Injected sample size exceeds stsz limits"));
        }
        p[12 + k * 4..16 + k * 4].copy_from_slice(&(s as u32).to_be_bytes());
    }
    Ok(p)
}

/// validateAllTrackSamples: every track's samples readable, none overlapping
/// another's. Errors carry `path` as in Node.
pub fn validate_all_track_samples(tree: &Tree, code_unreadable: &str) -> CResult<Vec<(usize, Vec<Sample>)>> {
    let tracks = tree.find(ROOT, b"trak");
    let mut by = Vec::new();
    for (ti, &t) in tracks.iter().enumerate() {
        let r = (|| -> CResult<Vec<Sample>> {
            let samples = mp4w::build_sample_index(tree, t)?;
            for s in &samples {
                let start = safe(s.offset, &format!("Track {ti} sample offset"))?;
                let end = safe(s.offset + s.size as u64, &format!("Track {ti} sample end"))?;
                if end > tree.buf.len() || end - start != s.size as usize {
                    return Err(CError::new(code_unreadable, "Sample bytes are not fully readable"));
                }
            }
            Ok(samples)
        })();
        match r {
            Ok(s) => by.push((t, s)),
            Err(e) => return Err(e.with_path(format!("tracks[{ti}]"))),
        }
    }
    let mut ext: Vec<(u64, u64)> = by.iter().flat_map(|(_, s)| s.iter().map(|x| (x.offset, x.offset + x.size as u64))).collect();
    ext.sort_by(|a, b| a.0.cmp(&b.0));
    for k in 1..ext.len() {
        if ext[k].0 < ext[k - 1].1 {
            return Err(CError::new("INVALID_MP4", "Sample extents overlap across tracks").with_path("tracks"));
        }
    }
    Ok(by)
}

fn rebuild(tree: &Tree, video: usize, insertions_by_sample: &[Vec<u8>]) -> CResult<Vec<u8>> {
    let by = validate_all_track_samples(tree, "INVALID_MP4")?;
    let video_samples = &by.iter().find(|(t, _)| *t == video).unwrap().1;
    let stsz = tree.find(video, b"stsz");
    if stsz.len() != 1 {
        return Err(err("UNSUPPORTED_CONTAINER", "Video track must contain exactly one stsz box"));
    }
    let sizes: Vec<u64> = video_samples.iter().map(|s| s.size as u64 + insertions_by_sample[s.index].len() as u64).collect();
    let mut replacements: HashMap<usize, Vec<u8>> = HashMap::new();
    replacements.insert(stsz[0], stsz_payload(tree, stsz[0], &sizes)?);

    let mut ins: Vec<(u64, usize)> = video_samples.iter().map(|s| (s.offset, s.index)).collect();
    ins.sort_by(|a, b| a.0.cmp(&b.0));
    for k in 1..ins.len() {
        if ins[k].0 == ins[k - 1].0 {
            return Err(h265_error("Video samples share an insertion offset"));
        }
    }
    let mdats = tree.find(ROOT, b"mdat");
    let mut by_mdat: HashMap<usize, Vec<(u64, usize)>> = mdats.iter().map(|&m| (m, vec![])).collect();
    for &(off, si) in &ins {
        let Some(&m) = mdats.iter().find(|&&m| off >= tree.node(m).content && off < tree.node(m).end) else {
            return Err(h265_error("Telemetry insertion is outside mdat media data"));
        };
        by_mdat.get_mut(&m).unwrap().push((off, si));
    }
    let mut table_nodes = tree.find(ROOT, b"stco");
    table_nodes.extend(tree.find(ROOT, b"co64"));
    let mut tables = Vec::new();
    for n in table_nodes {
        tables.push(read_chunk_table(tree, n)?);
    }
    let table_of: HashMap<usize, usize> = tables.iter().enumerate().map(|(k, t)| (t.node, k)).collect();
    let growth_of = |m: usize| -> u64 { by_mdat[&m].iter().map(|&(_, si)| insertions_by_sample[si].len() as u64).sum() };

    // plannedSize with the tables' current widths
    fn planned(
        tree: &Tree,
        i: usize,
        repl: &HashMap<usize, Vec<u8>>,
        table_of: &HashMap<usize, usize>,
        widths: &[(usize, bool)],
        growth: &dyn Fn(usize) -> u64,
        cache: &mut HashMap<usize, u64>,
    ) -> CResult<u64> {
        if let Some(&v) = cache.get(&i) {
            return Ok(v);
        }
        let n = tree.node(i);
        let payload = if let Some(r) = repl.get(&i) {
            r.len() as u64
        } else if let Some(&t) = table_of.get(&i) {
            8 + widths[t].0 as u64 * if widths[t].1 { 8 } else { 4 }
        } else if &n.typ == b"mdat" {
            n.size - n.header + growth(i)
        } else if !n.children.is_empty() {
            let mut s = 0;
            for &c in &n.children {
                s += planned(tree, c, repl, table_of, widths, growth, cache)?;
            }
            s
        } else {
            n.size - n.header
        };
        let size = payload + serialized_header_size(payload, n.header)?;
        cache.insert(i, size);
        Ok(size)
    }
    let widths: Vec<(usize, bool)> = tables.iter().map(|t| (t.offsets.len(), t.co64)).collect();
    let mut base = HashMap::new();
    for &c in tree.top() {
        planned(tree, c, &replacements, &table_of, &widths, &growth_of, &mut base)?;
    }
    let map_offset = |old: u64| -> CResult<u128> {
        let mut preceding: i128 = 0;
        let mut containing = None;
        for &t in tree.top() {
            let n = tree.node(t);
            if old >= n.end {
                preceding += base[&t] as i128 - n.size as i128;
            } else if old >= n.content && old < n.end {
                if &n.typ != b"mdat" {
                    return Err(h265_error("Chunk offset does not point into top-level mdat media data"));
                }
                containing = Some(t);
                break;
            } else if old < n.start {
                break;
            }
        }
        let Some(m) = containing else { return Err(h265_error("Chunk offset does not point into mdat media data")) };
        let n = tree.node(m);
        let header = serialized_header_size(base[&m] - n.header, n.header)?;
        let in_growth: u64 = by_mdat[&m].iter().filter(|&&(o, _)| o < old).map(|&(_, si)| insertions_by_sample[si].len() as u64).sum();
        let mapped = n.start as i128 + preceding + header as i128 + (old - n.content) as i128 + in_growth as i128;
        if mapped < 0 || mapped > u64::MAX as i128 {
            return Err(h265_error("Rewritten chunk offset is outside the unsigned 64-bit range"));
        }
        Ok(mapped as u128)
    };
    let spec: Vec<(bool, u64, Vec<u64>)> = tables.iter().map(|t| (t.co64, tree.node(t.node).start, t.offsets.clone())).collect();
    let (_, plan) = plan_chunk_offset_tables(&spec, &map_offset)?;
    for (t, (co64, offs)) in tables.iter_mut().zip(plan) {
        t.co64 = co64;
        t.out = offs;
    }
    for t in &tables {
        let w = if t.co64 { 8 } else { 4 };
        let original = direct_payload(tree, t.node)?;
        let mut p = vec![0u8; 8 + t.offsets.len() * w];
        p[..4].copy_from_slice(&original[..4]);
        p[4..8].copy_from_slice(&(t.offsets.len() as u32).to_be_bytes());
        for (k, &v) in t.out.iter().enumerate() {
            if t.co64 {
                p[8 + k * 8..16 + k * 8].copy_from_slice(&v.to_be_bytes());
            } else {
                p[8 + k * 4..12 + k * 4].copy_from_slice(&(v as u32).to_be_bytes());
            }
        }
        replacements.insert(t.node, p);
    }

    fn ser(
        tree: &Tree,
        i: usize,
        repl: &HashMap<usize, Vec<u8>>,
        table_of: &HashMap<usize, usize>,
        tables: &[ChunkTable],
        by_mdat: &HashMap<usize, Vec<(u64, usize)>>,
        data: &[Vec<u8>],
        out: &mut Vec<u8>,
    ) -> CResult<()> {
        let n = tree.node(i);
        if let Some(r) = repl.get(&i) {
            let typ = match table_of.get(&i) {
                Some(&t) if tables[t].co64 => *b"co64",
                _ => n.typ,
            };
            out.extend(ser_box(&typ, r, n.header)?);
            return Ok(());
        }
        if &n.typ == b"mdat" {
            let (cs, e) = (safe(n.content, "mdat content start")?, safe(n.end, "mdat end")?);
            let mut p = Vec::with_capacity(e - cs + by_mdat[&i].iter().map(|x| data[x.1].len()).sum::<usize>());
            let mut cur = cs;
            for &(off, si) in &by_mdat[&i] {
                let off = safe(off, "Telemetry insertion offset")?;
                p.extend_from_slice(&tree.buf[cur..off]);
                p.extend_from_slice(&data[si]);
                cur = off;
            }
            p.extend_from_slice(&tree.buf[cur..e]);
            out.extend(ser_box(&n.typ, &p, n.header)?);
            return Ok(());
        }
        let payload = if !n.children.is_empty() {
            let mut p = Vec::new();
            for &c in &n.children {
                ser(tree, c, repl, table_of, tables, by_mdat, data, &mut p)?;
            }
            p
        } else {
            direct_payload(tree, i)?.to_vec()
        };
        out.extend(ser_box(&n.typ, &payload, n.header)?);
        Ok(())
    }
    let mut out = Vec::with_capacity(tree.buf.len() + insertions_by_sample.iter().map(|d| d.len()).sum::<usize>());
    for &c in tree.top() {
        ser(tree, c, &replacements, &table_of, &tables, &by_mdat, insertions_by_sample, &mut out)?;
    }
    Ok(out)
}

/// injectH265Telemetry(encodedMp4, mappedTimeline)
pub fn inject(encoded: &[u8], mapped: &[MappedSample]) -> CResult<Vec<u8>> {
    let tree = mp4w::parse(encoded)?;
    let (track, _) = mp4w::select_video_track(&tree)?;
    let ls = read_hvc1_info(&tree, track)?;
    let samples = mp4w::build_sample_index(&tree, track)?;
    require_sole_description(&samples)?;
    validate_mapped(mapped, samples.len())?;
    let mut insertions = Vec::with_capacity(samples.len());
    for s in &samples {
        let start = safe(s.offset, "H.265 sample offset")?;
        let nals = parse_hevc_nals(&encoded[start..start + s.size as usize], ls, s.index)?;
        if nals.iter().any(|n| is_recognized_injected(n)) {
            return Err(err("UNSUPPORTED_H265", format!("H.265 sample {} already contains a Tesla compatibility record", s.index)));
        }
        let mut d = Vec::new();
        for r in &mapped[s.index].sei_nals {
            d.extend(prefix_sei_record(&r.nal, ls)?);
        }
        for r in &mapped[s.index].sei_nals {
            d.extend(compatibility_record(&r.nal, ls)?);
        }
        d.extend(length_prefix(&PICTURE_MARKER, ls)?);
        insertions.push(d);
    }
    rebuild(&tree, track, &insertions)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedSample {
    pub index: usize,
    pub offset: u64,
    pub size: u32,
    pub has_picture_marker: bool,
    pub picture_marker_count: usize,
    pub sei_count: usize,
    pub compatibility_count: usize,
    pub telemetry_fingerprints: Vec<String>,
    pub compatibility_fingerprints: Vec<String>,
    pub nal_types: Vec<u8>,
    pub layout_valid: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub accepted: bool,
    pub layout_valid: bool,
    pub validation_errors: Vec<ValidationError>,
    pub sample_entry: String,
    pub length_size: usize,
    pub sample_count: usize,
    pub samples: Vec<InspectedSample>,
    pub telemetry_fingerprints: Vec<String>,
    pub compatibility_fingerprints: Vec<String>,
}

fn inspect_sample(nals: &[&[u8]], s: &Sample) -> InspectedSample {
    let mut tf = Vec::new();
    let mut cf = Vec::new();
    let mut markers = 0;
    for n in nals {
        if *n == PICTURE_MARKER {
            markers += 1;
        }
        if n.len() >= 3 && n[0] == 0x4e && n[1] == 0x01 {
            if let Some(p) = standard_prefix_payload(n) {
                tf.push(fingerprint(&p));
            }
        }
        if n.len() >= 3 && n[0] == 0x66 && n[1] == 0x01 {
            if let Some(p) = compat_payload(n) {
                cf.push(fingerprint(&p));
            }
        }
    }
    let mut canonical: Vec<u8> = tf.iter().map(|_| 39).collect();
    canonical.extend(cf.iter().map(|_| 51));
    canonical.push(48);
    let leading: Vec<u8> = nals.iter().take(canonical.len()).map(|n| hevc_nal_type(n)).collect();
    let layout_valid = markers == 1 && tf.len() == cf.len() && tf == cf && leading == canonical;
    InspectedSample {
        index: s.index,
        offset: s.offset,
        size: s.size,
        has_picture_marker: markers > 0,
        picture_marker_count: markers,
        sei_count: tf.len(),
        compatibility_count: cf.len(),
        telemetry_fingerprints: tf,
        compatibility_fingerprints: cf,
        nal_types: nals.iter().map(|n| hevc_nal_type(n)).collect(),
        layout_valid,
    }
}

/// inspectH265Telemetry(mp4Buffer): throws (Err) where the Node one throws.
pub fn inspect(buf: &[u8]) -> CResult<Inspection> {
    let tree = mp4w::parse(buf)?;
    let (track, _) = mp4w::select_video_track(&tree)?;
    let ls = read_hvc1_info(&tree, track)?;
    let index = mp4w::build_sample_index(&tree, track)?;
    require_sole_description(&index)?;
    let mut errors = Vec::new();
    if let Err(e) = validate_all_track_samples(&tree, "INVALID_MP4") {
        errors.push(ValidationError { code: e.code_or("INVALID_MP4").to_string(), path: e.path.clone().unwrap_or("tracks".into()), message: e.message });
    }
    let mut samples = Vec::with_capacity(index.len());
    for s in &index {
        let start = safe(s.offset, "H.265 sample offset")?;
        let end = (start + s.size as usize).min(buf.len());
        let nals = parse_hevc_nals(&buf[start.min(end)..end], ls, s.index)?;
        samples.push(inspect_sample(&nals, s));
    }
    let layout_valid = errors.is_empty() && samples.iter().all(|s| s.layout_valid);
    let tf = samples.iter().flat_map(|s| s.telemetry_fingerprints.clone()).collect();
    let cf = samples.iter().flat_map(|s| s.compatibility_fingerprints.clone()).collect();
    Ok(Inspection {
        accepted: layout_valid,
        layout_valid,
        validation_errors: errors,
        sample_entry: "hvc1".into(),
        length_size: ls,
        sample_count: samples.len(),
        samples,
        telemetry_fingerprints: tf,
        compatibility_fingerprints: cf,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_promotes_only_what_overflows() {
        let tables = vec![(false, 10u64, vec![100u64, 200]), (false, 50, vec![300])];
        let (g, out) = plan_chunk_offset_tables(&tables, &|o| Ok(o as u128)).unwrap();
        assert_eq!(g, 0);
        assert_eq!(out, vec![(false, vec![100, 200]), (false, vec![300])]);
        let (g, out) = plan_chunk_offset_tables(&tables, &|o| Ok(o as u128 + 0xffff_ff00)).unwrap();
        // only the second overflows; the first moves by its 4 extra bytes
        assert_eq!(g, 4);
        assert!(!out[0].0 && out[1].0);
        assert_eq!(out[0].1, vec![0xffff_ff00 + 104, 0xffff_ff00 + 204]);
        assert!(plan_chunk_offset_tables(&[(false, 0, vec![1u64 << 33])], &|o| Ok(o as u128)).is_err());
    }

    #[test]
    fn emulation_prevention_round_trip() {
        let raw = [0u8, 0, 1, 0, 0, 0, 0, 3, 0, 0, 2];
        let e = add_emulation_prevention_bytes(&raw);
        assert_eq!(remove_emulation_prevention_bytes(&e).unwrap(), raw.to_vec());
    }
}

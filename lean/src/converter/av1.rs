//! src/main/converter/av1Telemetry.js: Tesla's telemetry for an AV1 encode,
//! kept in a first `mdat` that no track references: per video sample, its
//! Tesla H.264 SEI records then the `61 01 80` picture marker, each with a
//! four-byte length. Every chunk offset moves by that box's size.

use super::error::{CError, CResult};
use super::h265::{parse_embedded, validate_all_track_samples, Embedded, ValidationError, PICTURE_MARKER};
use super::mp4w::{self, be32, Sample, Tree, ROOT};
use super::tesla_sei::{fingerprint, tesla_payload};
use super::timeline::MappedSample;

const LEN: usize = 4;

fn av1_error(message: impl Into<String>) -> CError {
    CError::new("INVALID_AV1", message)
}
fn unsupported(message: impl Into<String>) -> CError {
    CError::new("UNSUPPORTED_CONTAINER", message)
}
fn safe(v: u64, label: &str) -> CResult<usize> {
    if v > mp4w::MAX_SAFE {
        return Err(unsupported(format!("{label} cannot be represented safely")));
    }
    Ok(v as usize)
}

fn read_av01_info(tree: &Tree, track: usize) -> CResult<()> {
    let stbl = mp4w::sample_table(tree, track)?;
    let d = tree.children_of(stbl, b"stsd");
    if d.len() != 1 {
        return Err(unsupported("Active AV1 sample table must contain exactly one direct stsd box"));
    }
    let n = tree.node(d[0]);
    let (cs, e) = (safe(n.content, "stsd content start")?, safe(n.end, "stsd end")?);
    if e - cs < 8 {
        return Err(av1_error("Truncated stsd box"));
    }
    if tree.buf[cs] != 0 {
        return Err(unsupported("Unsupported stsd version"));
    }
    let count = be32(tree.buf, cs + 4);
    let entries = parse_embedded(tree.buf, cs + 8, e, "sample entry", "INVALID_AV1")?;
    if count != 1 || entries.len() != 1 {
        return Err(unsupported("Video track must contain exactly one sample description"));
    }
    let entry = &entries[0];
    if &entry.typ != b"av01" {
        return Err(unsupported(format!("Video sample entry must be av01, received {}", mp4w::type_str(&entry.typ))));
    }
    if entry.end - entry.content < 78 {
        return Err(av1_error("Truncated av01 visual sample entry"));
    }
    let kids = parse_embedded(tree.buf, entry.content + 78, entry.end, "av01 child", "INVALID_AV1")?;
    let configs: Vec<&Embedded> = kids.iter().filter(|k| &k.typ == b"av1C").collect();
    if configs.len() != 1 {
        return Err(unsupported("av01 sample entry must contain exactly one av1C box"));
    }
    let c = configs[0];
    if c.end - c.content < 4 || tree.buf[c.content] != 0x81 {
        return Err(av1_error("Invalid av1C configuration record"));
    }
    Ok(())
}

fn require_sole_description(samples: &[Sample]) -> CResult<()> {
    if let Some(s) = samples.iter().find(|s| s.description != 1) {
        return Err(unsupported(format!("AV1 sample {} references unsupported sample description {}", s.index, s.description)));
    }
    Ok(())
}

fn validate_mapped(mapped: &[MappedSample], count: usize) -> CResult<()> {
    if mapped.len() != count {
        return Err(av1_error("Mapped timeline must match the AV1 video sample count"));
    }
    for (si, m) in mapped.iter().enumerate() {
        if !m.picture_marker {
            return Err(av1_error(format!("Mapped timeline sample {si} is invalid")));
        }
        for (ri, r) in m.sei_nals.iter().enumerate() {
            if tesla_payload(&r.nal).is_none() {
                return Err(av1_error(format!("Mapped timeline sample {si} SEI {ri} is not one canonical Tesla H.264 type-5 message")));
            }
        }
    }
    Ok(())
}

fn record(nal: &[u8], out: &mut Vec<u8>) -> CResult<()> {
    if nal.len() as u64 > 0xffff_ffff {
        return Err(unsupported("Telemetry record exceeds its four-byte length field"));
    }
    out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
    out.extend_from_slice(nal);
    Ok(())
}

/// injectAv1Telemetry(encodedMp4, mappedTimeline)
pub fn inject(encoded: &[u8], mapped: &[MappedSample]) -> CResult<Vec<u8>> {
    let tree = mp4w::parse(encoded)?;
    let (track, _) = mp4w::select_video_track(&tree)?;
    read_av01_info(&tree, track)?;
    let samples = mp4w::build_sample_index(&tree, track)?;
    require_sole_description(&samples)?;
    validate_mapped(mapped, samples.len())?;
    let mut records = Vec::new();
    for m in mapped {
        for r in &m.sei_nals {
            record(&r.nal, &mut records)?;
        }
        record(&PICTURE_MARKER, &mut records)?;
    }
    let telemetry = mp4w::make_box(b"mdat", &records)?;
    let shifted = mp4w::rewrite_chunk_offsets(&tree, telemetry.len() as i128)?;
    let st = mp4w::parse(&shifted)?;
    let Some(&first) = st.top().iter().find(|&&c| &st.typ(c) == b"mdat") else {
        return Err(CError::new("INVALID_MP4", "AV1 MP4 has no real media mdat"));
    };
    let at = safe(st.node(first).start, "First real mdat offset")?;
    let mut out = Vec::with_capacity(shifted.len() + telemetry.len());
    out.extend_from_slice(&shifted[..at]);
    out.extend_from_slice(&telemetry);
    out.extend_from_slice(&shifted[at..]);
    Ok(out)
}

struct Group {
    fingerprints: Vec<String>,
    record_types: Vec<&'static str>,
    valid: bool,
}

fn parse_telemetry_payload(buf: &[u8]) -> (Vec<Group>, Vec<ValidationError>, usize) {
    let mut groups = Vec::new();
    let mut errors = Vec::new();
    let (mut fps, mut types, mut valid) = (Vec::new(), Vec::new(), true);
    let mut c = 0;
    let mut ri = 0;
    let ve = |path: String, message: &str| ValidationError { code: "INVALID_AV1_TELEMETRY".into(), path, message: message.into() };
    while c < buf.len() {
        if buf.len() - c < LEN {
            errors.push(ve(format!("telemetry.records[{ri}]"), "Truncated telemetry record length"));
            break;
        }
        let len = be32(buf, c) as usize;
        c += LEN;
        if len == 0 || len > buf.len() - c {
            errors.push(ve(format!("telemetry.records[{ri}]"), "Telemetry record length exceeds first mdat payload"));
            break;
        }
        let nal = &buf[c..c + len];
        c += len;
        if nal == PICTURE_MARKER {
            types.push("marker");
            groups.push(Group { fingerprints: std::mem::take(&mut fps), record_types: std::mem::take(&mut types), valid });
            valid = true;
        } else if let Some(p) = tesla_payload(nal) {
            fps.push(fingerprint(&p));
            types.push("sei");
        } else {
            errors.push(ve(format!("telemetry.records[{ri}]"), "Telemetry record is neither the exact picture marker nor one canonical Tesla H.264 SEI"));
            types.push("invalid");
            valid = false;
        }
        ri += 1;
    }
    if !fps.is_empty() {
        errors.push(ve("telemetry".into(), "Tesla SEI records are missing their terminating picture marker"));
    }
    (groups, errors, ri)
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
    pub telemetry_fingerprints: Vec<String>,
    pub record_types: Vec<&'static str>,
    pub is_gap: bool,
    pub layout_valid: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub accepted: bool,
    pub layout_valid: bool,
    pub validation_errors: Vec<ValidationError>,
    pub sample_entry: Option<String>,
    pub length_size: usize,
    pub sample_count: usize,
    pub telemetry_record_count: usize,
    pub first_mdat_unreferenced: bool,
    pub all_track_offsets_in_real_mdats: bool,
    pub samples: Vec<InspectedSample>,
    pub telemetry_fingerprints: Vec<String>,
}

/// inspectAv1Telemetry(mp4Buffer): never fails; problems are validation errors.
pub fn inspect(buf: &[u8]) -> Inspection {
    let mut errors: Vec<ValidationError> = Vec::new();
    let mut context = "mp4".to_string();
    let mut info = false;
    let mut video: Vec<Sample> = Vec::new();
    let r = (|| -> CResult<Inspection> {
        let tree = mp4w::parse(buf)?;
        context = "tracks".into();
        let (track, _) = mp4w::select_video_track(&tree)?;
        let vti = tree.find(ROOT, b"trak").iter().position(|&t| t == track).unwrap();
        context = "video.sampleDescription".into();
        read_av01_info(&tree, track)?;
        info = true;
        context = format!("tracks[{vti}]");
        video = mp4w::build_sample_index(&tree, track)?;
        require_sole_description(&video)?;
        let (all, tracks_valid) = match validate_all_track_samples(&tree, "INVALID_MP4") {
            Ok(by) => (by.into_iter().flat_map(|(_, s)| s).collect::<Vec<_>>(), true),
            Err(e) => {
                errors.push(ValidationError { code: e.code_or("INVALID_MP4").into(), path: e.path.clone().unwrap_or("tracks".into()), message: e.message });
                (vec![], false)
            }
        };
        let mdats: Vec<usize> = tree.top().iter().copied().filter(|&c| &tree.typ(c) == b"mdat").collect();
        let ve = |path: &str, message: &str| ValidationError { code: "INVALID_AV1_TELEMETRY".into(), path: path.into(), message: message.into() };
        if mdats.len() < 2 {
            errors.push(ve("mdat", "Telemetry layout requires a first telemetry mdat and at least one later real media mdat"));
        }
        let first = mdats.first().map(|&m| tree.node(m).clone());
        let real: Vec<_> = mdats.iter().skip(1).map(|&m| tree.node(m).clone()).collect();
        let first_unref = tracks_valid
            && first.as_ref().is_some_and(|f| all.iter().all(|s| s.offset >= f.end || s.offset + s.size as u64 <= f.content));
        let all_in_real = tracks_valid
            && !real.is_empty()
            && !all.is_empty()
            && all.iter().all(|s| real.iter().any(|m| s.offset >= m.content && s.offset + s.size as u64 <= m.end));
        if tracks_valid && !first_unref {
            errors.push(ve("mdat[0]", "First mdat is referenced by a real track"));
        }
        if tracks_valid && !all_in_real {
            errors.push(ve("tracks", "Every real track sample must point only into later real media mdats"));
        }
        context = "telemetry".into();
        let (groups, perrs, count) = match &first {
            Some(f) => {
                let (cs, e) = (safe(f.content, "Telemetry mdat content start")?, safe(f.end, "Telemetry mdat end")?);
                parse_telemetry_payload(&buf[cs..e])
            }
            None => (vec![], vec![], 0),
        };
        errors.extend(perrs);
        if groups.len() != video.len() {
            errors.push(ValidationError {
                code: "INVALID_AV1_TELEMETRY".into(),
                path: "telemetry.samples".into(),
                message: format!("Telemetry marker count {} does not match AV1 sample count {}", groups.len(), video.len()),
            });
        }
        let samples: Vec<InspectedSample> = video
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let g = groups.get(i);
                let fps = g.map(|g| g.fingerprints.clone()).unwrap_or_default();
                let markers = if g.is_some() { 1 } else { 0 };
                InspectedSample {
                    index: i,
                    offset: s.offset,
                    size: s.size,
                    has_picture_marker: markers == 1,
                    picture_marker_count: markers,
                    sei_count: fps.len(),
                    is_gap: g.is_some_and(|g| g.valid && fps.is_empty()),
                    layout_valid: g.is_some_and(|g| g.valid),
                    record_types: g.map(|g| g.record_types.clone()).unwrap_or_default(),
                    telemetry_fingerprints: fps,
                }
            })
            .collect();
        let layout_valid = errors.is_empty() && samples.iter().all(|s| s.layout_valid);
        Ok(Inspection {
            accepted: layout_valid,
            layout_valid,
            validation_errors: std::mem::take(&mut errors),
            sample_entry: Some("av01".into()),
            length_size: LEN,
            sample_count: samples.len(),
            telemetry_record_count: count,
            first_mdat_unreferenced: first_unref,
            all_track_offsets_in_real_mdats: all_in_real,
            telemetry_fingerprints: samples.iter().flat_map(|s| s.telemetry_fingerprints.clone()).collect(),
            samples,
        })
    })();
    match r {
        Ok(i) => i,
        Err(e) => {
            errors.push(ValidationError { code: e.code_or("INVALID_MP4").into(), path: e.path.clone().unwrap_or(context.clone()), message: e.message });
            Inspection {
                accepted: false,
                layout_valid: false,
                validation_errors: errors,
                sample_entry: if info { Some("av01".into()) } else { None },
                length_size: LEN,
                sample_count: video.len(),
                telemetry_record_count: 0,
                first_mdat_unreferenced: false,
                all_track_offsets_in_real_mdats: false,
                samples: vec![],
                telemetry_fingerprints: vec![],
            }
        }
    }
}

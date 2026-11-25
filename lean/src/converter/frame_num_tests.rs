//! Generated H.264 only: compare the frame-number model with FFmpeg's actual
//! output, then run the real planner, telemetry writer and Quick/Full verifier.
use super::*;
use super::source_checks_tests::{encode_profile, retime_generated, verify_profile};
use crate::converter::{frame_num, h265, lead_in, tesla_sei, testutil::tempdir};
use std::{fs, path::Path, process::Command};

fn generate_gap_source(path: &Path) -> Vec<u64> {
    let r = Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=25",
        "-frames:v", "104", "-c:v", "libx264", "-crf", "1", "-profile:v", "high", "-bf", "0",
        "-x264-params", "ref=1:cabac=0:weightp=0:scenecut=0:keyint=35:min-keyint=1",
        "-force_key_frames", "expr:eq(n,35)+eq(n,52)+eq(n,69)+eq(n,86)",
        "-bsf:v", "filter_units=remove_types=6,h264_metadata=tick_rate=20000/1:fixed_frame_rate_flag=0",
        "-video_track_timescale", "10000", "-use_editlist", "0"]).arg(path).output().unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let mut bytes = fs::read(path).unwrap();
    let avcc_at = bytes.windows(4).position(|b| b == b"avcC").unwrap();
    let avcc_end = avcc_at - 4 + be32(&bytes, avcc_at - 4) as usize;
    let (sps_units, pps_units) = frame_num::avc_parameter_sets(&bytes[avcc_at + 4..avcc_end]).unwrap();
    assert_eq!((sps_units.len(), pps_units.len()), (1, 1));
    let sps = frame_num::parse_sps(&sps_units[0]).unwrap();
    assert_eq!((sps.log2_max_frame_num, sps.poc_type, sps.max_ref_frames, sps.gaps_allowed, sps.frame_mbs_only), (4, 2, 1, 0, 1));
    let tree = mp4w::parse(&bytes).unwrap();
    let (track, _) = mp4w::select_video_track(&tree).unwrap();
    let samples = mp4w::build_sample_index(&tree, track).unwrap();
    for (i, s) in samples.iter().enumerate() {
        let start = s.offset as usize;
        let nals = crate::converter::timeline::parse_length_prefixed(&bytes[start..start + s.size as usize], 4).unwrap();
        assert_eq!(nals.len(), 1);
        let nal = nals[0];
        let at = nal.as_ptr() as usize - bytes.as_ptr() as usize;
        if nal[0] & 31 == 5 { continue; }
        // x264's first_mb=0, slice_type=5, pps_id=0 occupy seven bits.
        // Only change the four frame_num bits; CAVLC payload stays intact.
        assert_eq!(bytes[at + 1] & 0xfe, 0x9a);
        let old = ((bytes[at + 1] & 1) << 3) | (bytes[at + 2] >> 5);
        let value = if (18..35).contains(&i) { (old + 15) % 16 }
            else if [51, 68, 85].contains(&i) { assert_eq!(old, 0); 1 }
            else if (88..103).contains(&i) { (old + 1) % 16 } // 1 -> 3, no wrap: concealed
            else { old };
        bytes[at] = 0x21; // the recorder's reference P-slice nal_ref_idc=1
        bytes[at + 1] = (bytes[at + 1] & 0xfe) | (value >> 3);
        bytes[at + 2] = (bytes[at + 2] & 0x1f) | (value << 5);
    }
    fs::write(path, bytes).unwrap();
    let mut ticks: Vec<u64> = (0..104).map(|i| 270 + (i * 17) % 181).collect();
    ticks[7] = 1;
    ticks[103] = 0; // Literal stts zero; ffprobe may infer a positive packet duration.
    retime_generated(path, &ticks);
    ticks
}

fn with_sample_telemetry(bytes: &[u8]) -> Vec<u8> {
    let tree = mp4w::parse(bytes).unwrap();
    let (track, _) = mp4w::select_video_track(&tree).unwrap();
    let samples = mp4w::build_sample_index(&tree, track).unwrap();
    let (_, offsets) = mp4w::chunk_offsets(&tree, mp4w::sample_table(&tree, track).unwrap()).unwrap();
    assert_eq!(offsets, vec![samples[0].offset], "generated fixture uses one chunk before moov");
    let packets: Vec<Vec<u8>> = samples.iter().map(|s| {
        let sei = tesla_sei::build_sei(&[s.index as u8]);
        [(sei.len() as u32).to_be_bytes().to_vec(), sei, bytes[s.offset as usize..s.offset as usize + s.size as usize].to_vec()].concat()
    }).collect();
    fn rebuild(tree: &Tree, node: usize, packets: &[Vec<u8>]) -> Vec<u8> {
        let n = tree.node(node);
        let payload = match &n.typ {
            b"mdat" => packets.concat(),
            b"stsz" => [vec![0; 8], (packets.len() as u32).to_be_bytes().to_vec(),
                packets.iter().flat_map(|p| (p.len() as u32).to_be_bytes()).collect()].concat(),
            _ if n.children.is_empty() => tree.payload(node).unwrap().to_vec(),
            _ => n.children.iter().flat_map(|&c| rebuild(tree, c, packets)).collect(),
        };
        mp4w::make_box(&n.typ, &payload).unwrap()
    }
    tree.top().iter().flat_map(|&n| rebuild(&tree, n, &packets)).collect()
}

#[test]
fn frame_num_repeated_reference_does_not_hide_proven_drops() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("gap.mp4");
    let ticks = generate_gap_source(&source);
    let inspection = crate::converter::process::BoundedRunner::host().run("ffprobe",
        &crate::converter::service::tools::probe_args(source.to_str().unwrap()), &RunOptions::default()).unwrap();
    assert_eq!(crate::converter::service::tools::parse_video_probe(&inspection).unwrap().codec, "h264");
    let probe = Command::new("ffprobe").args(["-v", "error", "-count_packets", "-count_frames", "-show_entries",
        "stream=time_base,nb_read_packets,nb_read_frames:frame=pts:packet=pts,duration,flags", "-show_frames", "-show_packets", "-of", "json"])
        .arg(&source).output().unwrap();
    assert!(probe.status.success() && probe.stderr.is_empty(), "{}", String::from_utf8_lossy(&probe.stderr));
    let metadata: Value = serde_json::from_slice(&probe.stdout).unwrap();
    eprintln!("gap source stream: {}", metadata["streams"]);
    assert_eq!(metadata["streams"][0]["time_base"], "1/10000");
    assert_eq!(metadata["streams"][0]["nb_read_packets"], "104");
    assert_eq!(metadata["streams"][0]["nb_read_frames"], "100");
    let entries = metadata["packets_and_frames"].as_array().unwrap();
    let packets: Vec<_> = entries.iter().filter(|e| e["type"] == "packet").collect();
    eprintln!("gap terminal packet: {}", packets[103]);
    assert!(packets[103]["flags"].as_str().unwrap().contains('D'));
    let decoded: Vec<_> = entries.iter().filter(|e| e["type"] == "frame").map(|f| f["pts"].as_i64().unwrap()).collect();
    let mut pts = 0;
    let mut expected = Vec::new();
    for (i, &duration) in ticks.iter().enumerate() {
        if ![51, 68, 85, 103].contains(&i) { expected.push(pts); }
        pts += duration as i64;
    }
    assert_eq!(decoded, expected, "FFmpeg must output the repeated and forward-gap frames at their exact timestamps");
    let original = fs::read(&source).unwrap();
    for telemetry in [false, true] {
        fs::write(&source, if telemetry { with_sample_telemetry(&original) } else { original.clone() }).unwrap();
        let timeline = extract(&fs::read(&source).unwrap()).unwrap();
        eprintln!("gap scanner: {:?}", timeline.undecodable);
        for profile in ["custom", "smallest"] {
            let output = dir.path().join(format!("{profile}-{telemetry}.mp4"));
            encode_profile(&source, &output, profile);
            for mode in ["quick", "full"] {
                let verdict = verify_profile(&source, &output, mode, profile);
                eprintln!("gap {profile} {mode} telemetry={telemetry}: {}", verdict.to_json());
                assert!(verdict.ok, "{}", verdict.to_json());
                assert_eq!(verdict.details["undecodableFrames"], 3);
                assert_eq!(verdict.details["frameCountTolerance"], 0);
                assert_eq!(verdict.details["frameTiming"], "exact");
            }
            assert_eq!(timeline.undecodable.samples, vec![51, 68, 85]);
            assert_eq!(frame_num::undecodable_frames(Some(&timeline.undecodable)), 3);
            let encoded = fs::read(&output).unwrap();
            let output_timing = read_output_timing(&encoded).unwrap();
            assert_eq!(output_timing.samples.iter().map(|s| s.0).collect::<Vec<_>>(), expected.iter().map(|p| p * 100).collect::<Vec<_>>());
            let mut durations: Vec<u64> = ticks[..103].to_vec();
            for i in [85, 68, 51] { let d = durations.remove(i); durations[i - 1] += d; }
            assert_eq!(output_timing.duration_ticks, durations.iter().map(|&d| d as i64).collect::<Vec<_>>());
            let inspected = h265::inspect(&encoded).unwrap();
            assert_eq!(inspected.telemetry_fingerprints.len(), if telemetry { 104 } else { 0 });
            if telemetry {
                // Hand-derived ordinals: removed pictures' records attach to
                // the preceding display frame; the duplicate-number picture
                // keeps its own distinct record, and later records never shift.
                for (at, source_indices) in [(17, vec![17]), (18, vec![18]), (19, vec![19]),
                    (50, vec![50, 51]), (51, vec![52]), (66, vec![67, 68]),
                    (82, vec![84, 85]), (99, vec![102, 103])] {
                    let fingerprints: Vec<_> = source_indices.iter().map(|&i| tesla_sei::fingerprint(&[i])).collect();
                    assert_eq!(inspected.samples[at].telemetry_fingerprints, fingerprints);
                    assert_eq!(inspected.samples[at].compatibility_fingerprints, fingerprints);
                }
                // Same count and total length cannot hide a moved repeated frame.
                durations[17] += 1;
                durations[18] -= 1;
                let bad = lead_in::retime_to_source(&encoded, 10000, &durations).unwrap();
                fs::write(&output, bad).unwrap();
                for mode in ["quick", "full"] {
                    let verdict = verify_profile(&source, &output, mode, profile);
                    assert_eq!(verdict.reason, Some(R::DURATION_MISMATCH));
                    assert_eq!(verdict.details["kind"], "source-output-frame-timing");
                }
            }
        }
    }
}

#[test]
fn frame_num_proof_does_not_excuse_an_additional_missing_picture() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("gap.mp4");
    let output = dir.path().join("missing.mp4");
    generate_gap_source(&source);
    let r = Command::new("ffmpeg").args(["-v", "error", "-y", "-i"]).arg(&source).args([
        "-vf", "select=not(eq(n\\,18))", "-fps_mode", "passthrough", "-enc_time_base", "demux",
        "-c:v", "libx265", "-x265-params", "log-level=error:pools=1:frame-threads=1:bframes=0",
        "-b:v", "100k", "-tag:v", "hvc1", "-use_editlist", "0"]).arg(&output).output().unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    for mode in ["quick", "full"] {
        let verdict = verify_profile(&source, &output, mode, "custom");
        assert_eq!(verdict.reason, Some(R::FRAME_COUNT_MISMATCH), "{}", verdict.to_json());
        assert_eq!(verdict.details["undecodableFrames"], 3);
        assert_eq!(verdict.details["outputFrames"], 99);
        assert_eq!(verdict.details["frameDelta"], 1);
        assert_eq!(verdict.details["toleranceFrames"], 0);
    }
}

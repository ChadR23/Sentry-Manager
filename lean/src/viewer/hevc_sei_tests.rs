// H.265 clips whose records sit in standard prefix SEI NALs (archive converters write them so)

use super::*;
use crate::viewer::testkit::{self, Rec};

fn recs() -> Vec<Option<Rec>> {
    (0..12).map(|i| Some(Rec { v: 1.5 + i as f32, lat: Some(37.0 + i as f64 * 1e-5), lon: Some(-122.0), ax: Some(-0.5), ay: Some(0.25) })).collect()
}

/// an encoder's own SEI (x265 writes one in the first picture): not Tesla's
fn encoder_sei() -> Vec<u8> {
    let mut n = vec![0x4e, 0x01, 5, 20, 0x2c, 0xa2, 0xde, 0x09, 0xb5, 0x17, 0x47, 0xdb, 0xbb, 0x55, 0xa4, 0xfe, 0x7f, 0xc2, 0xfc, 0x4e];
    n.extend(b"x265");
    n.push(0x80);
    n
}

#[test]
fn every_reader_finds_the_records_of_a_standard_hevc_sei_clip() {
    let dir = std::env::temp_dir().join(format!("hevc-sei-{}", std::process::id()));
    let (avc, hevc) = (dir.join("avc-front.mp4"), dir.join("hevc-front.mp4"));
    testkit::clip(&avc, 4, &recs(), 4);
    testkit::clip_hevc(&hevc, 4, &recs(), 4, Some(encoder_sei()));
    for mode in [Mode::Short, Mode::Straight] {
        let a = read_samples(&avc, mode).unwrap();
        assert!(a.is_some(), "{mode:?}");
        assert_eq!(read_samples(&hevc, mode).unwrap(), a, "{mode:?}");
    }
    assert_eq!(crate::sei::read_samples(&hevc).unwrap(), crate::sei::read_samples(&avc).unwrap());
    let size = |p: &Path| std::fs::metadata(p).unwrap().len();
    let (ta, th) = (crate::telemetry::read_records(&avc, size(&avc)).unwrap(), crate::telemetry::read_records(&hevc, size(&hevc)).unwrap());
    assert_eq!(th.len(), 12);
    assert_eq!(th, ta);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn only_tesla_records_come_out_of_hevc_sei() {
    let rec = crate::viewer::testkit::protobuf(3, &Rec { v: 9.0, ..Rec::default() });
    let nal = testkit::hevc_sei_nal(&rec);
    assert_eq!(crate::sei::hevc_sei_payload(&nal), Some(rec));
    assert_eq!(crate::sei::hevc_sei_payload(&encoder_sei()), None);
    let mut suffix = nal.clone();
    suffix[0] = 40 << 1;
    assert!(crate::sei::hevc_sei_payload(&suffix).is_some());
    let mut other = nal;
    other[0] = 51 << 1;
    assert_eq!(crate::sei::hevc_sei_payload(&other), None);
}

/// an H.265 SEI NAL holding these messages (type, body), with emulation prevention
fn sei_messages(messages: &[(u8, Vec<u8>)]) -> Vec<u8> {
    let mut rbsp = Vec::new();
    for (t, body) in messages {
        rbsp.push(*t);
        rbsp.push(body.len() as u8);
        rbsp.extend(body);
    }
    rbsp.push(0x80);
    let mut nal = vec![0x4e, 0x01];
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

#[test]
fn the_record_is_found_among_other_sei_messages() {
    let rec = testkit::protobuf(7, &Rec { v: 0.0, lat: Some(37.0), ..Rec::default() });
    let mut tesla = vec![0x42, 0x42, 0x42, 0x69];
    tesla.extend(&rec);
    let other = vec![0x2c, 0xa2, 0xde, 0x09, 0, 0, 0, 1];
    assert_eq!(crate::sei::hevc_sei_payload(&sei_messages(&[(1, vec![0, 0]), (5, other.clone()), (5, tesla.clone())])), Some(rec.clone()));
    assert_eq!(crate::sei::hevc_sei_payload(&sei_messages(&[(5, tesla.clone())])), Some(rec));
    assert_eq!(crate::sei::hevc_sei_payload(&sei_messages(&[(5, other)])), None);
    let mut cut = sei_messages(&[(5, tesla)]);
    cut.truncate(cut.len() - 3);
    cut.push(0x80);
    assert_eq!(crate::sei::hevc_sei_payload(&cut), None);
}

#[test]
fn a_record_carried_twice_in_a_picture_counts_once() {
    let dir = std::env::temp_dir().join(format!("hevc-sei-twice-{}", std::process::id()));
    let hevc = dir.join("hevc-front.mp4");
    let again = testkit::hevc_sei_nal(&testkit::protobuf(0, &recs()[0].unwrap()));
    testkit::clip_hevc(&hevc, 4, &recs(), 4, Some(again));
    let size = std::fs::metadata(&hevc).unwrap().len();
    assert_eq!(crate::telemetry::read_records(&hevc, size).unwrap().len(), 12);
    std::fs::remove_dir_all(dir).unwrap();
}

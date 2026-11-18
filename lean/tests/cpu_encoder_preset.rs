// Its own test binary: it sets CPU_ENCODER_PRESET, which every encode in the process reads.
use sentry_lean::converter::planner::{build_encode_args, EncodeArgs};

fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2).find(|w| w[0] == flag).map(|w| w[1].as_str())
}

#[test]
fn the_cpu_encoders_take_cpu_encoder_preset_as_node_does() {
    let x265 = EncodeArgs { codec: "h265", encoder: "libx265", bitrate: Some(1_234_567.0), ..Default::default() };
    let svt = EncodeArgs { codec: "av1", encoder: "libsvtav1", quality: Some("balanced"), ..Default::default() };
    let aom = EncodeArgs { codec: "av1", encoder: "libaom-av1", quality: Some("balanced"), ..Default::default() };
    let vaapi = EncodeArgs { codec: "h265", encoder: "hevc_vaapi", bitrate: Some(1_234_567.0), ..Default::default() };

    std::env::remove_var("CPU_ENCODER_PRESET");
    assert_eq!(after(&build_encode_args(&x265).unwrap(), "-preset"), Some("medium"));
    let gpu = build_encode_args(&vaapi).unwrap();

    std::env::set_var("CPU_ENCODER_PRESET", " Faster ");
    assert_eq!(after(&build_encode_args(&x265).unwrap(), "-preset"), Some("faster"));
    assert_eq!(after(&build_encode_args(&svt).unwrap(), "-preset"), Some("10"));
    assert_eq!(after(&build_encode_args(&aom).unwrap(), "-cpu-used"), Some("8"));
    assert_eq!(build_encode_args(&vaapi).unwrap(), gpu, "GPU encoders stay as they are");
    assert_eq!(after(&build_encode_args(&EncodeArgs { cpu_preset: Some("fast"), ..x265.clone() }).unwrap(), "-preset"), Some("fast"), "a given preset wins");

    std::env::set_var("CPU_ENCODER_PRESET", "placebo");
    assert_eq!(after(&build_encode_args(&x265).unwrap(), "-preset"), Some("medium"), "only the listed speeds");
    std::env::remove_var("CPU_ENCODER_PRESET");
}

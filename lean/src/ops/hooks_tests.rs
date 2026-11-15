//! The hooks other areas call on `Ops`, /api/stats as index.js builds it,
//! savings from job snapshots and their backfill, the report's diagnostics
//! and heartbeat from the context's parts, crash notes.

use super::*;
use crate::ops::ctx::{ShareStatus, VehicleInfo};
use crate::ops::testing::FakeCtx;

fn ops() -> (Arc<FakeCtx>, Arc<Ops>) {
    let ctx = FakeCtx::new();
    *ctx.vehicles.lock().unwrap() = vec![VehicleInfo {
        id: "car".into(),
        name: "Daily Driver".into(),
        roots: vec!["/footage/car".into()],
        source_type: Some("path".into()),
        status: Some(ShareStatus { healthy: true, writable: Some(true), free_bytes: Some(1e9), total_bytes: Some(4e9), ..Default::default() }),
        footage_bytes: Some(3e9),
        recordings: Some(120.0),
        footage_minutes: Some(600.0),
        bin_items: Some(2.0),
        ..Default::default()
    }];
    let o = Ops::new(ctx.clone(), Arc::new(reports::NoNetwork), HashMap::new());
    (ctx, o)
}

// index.js GET /api/stats: "All servers" with each node's peak, the price, the encoder block
#[test]
fn stats_with_the_nodes_power_and_peaks() {
    let (ctx, o) = ops();
    *ctx.node_powers.lock().unwrap() = vec![node_power::NodeRow { id: "n1".into(), name: "Garage".into(), online: true, power: node_power::clean_report(&json!({ "cpuW": 20, "gpuW": 180, "totalW": 200, "todayWh": 250, "weekWh": 1000 })) }];
    let s = o.stats_answer();
    assert_eq!(s["power"]["nodes"][0]["name"], "Garage");
    assert_eq!(s["power"]["nodes"][0]["peakW"], 200);
    assert_eq!(s["power"]["combined"]["servers"], 2);
    assert!(s["power"]["combined"]["peakW"].as_f64().unwrap() >= 200.0);
    assert_eq!(s["price"], Value::Null);
    assert_eq!(s["encoder"], Value::Null);
    // no nodes: the power block as it is
    ctx.node_powers.lock().unwrap().clear();
    assert!(o.stats_answer()["power"].get("combined").is_none());
    o.stop();
}

// savings.record from the converter's job snapshots; the job's energy counted while it runs
#[test]
fn job_snapshots_record_savings_and_mark_the_job() {
    let (ctx, o) = ops();
    let snap = |running: bool, bytes: f64, clips: f64| JobSnapshot { id: "j1".into(), running, vehicle_id: Some("car".into()), saved_bytes: bytes, clips };
    o.job_snapshot(&snap(true, 1000.0, 2.0));
    assert!(o.stats.sampling(), "a running job keeps the monitor sampling");
    o.job_snapshot(&snap(true, 5000.0, 4.0));
    o.job_snapshot(&snap(false, 5000.0, 4.0));
    let v = power::for_vehicle(&ctx.db(), "car");
    assert_eq!((v["bytes"].as_f64(), v["clips"].as_f64()), (Some(5000.0), Some(4.0)), "each job adds only what it adds");
    // a job of no vehicle saves nothing anywhere
    o.job_snapshot(&JobSnapshot { id: "j2".into(), vehicle_id: None, saved_bytes: 99.0, ..Default::default() });
    assert_eq!(power::for_vehicle(&ctx.db(), "car")["bytes"].as_f64(), Some(5000.0));
    assert_eq!(o.job_energy("nothing"), Value::Null);
    // the benchmark's meter: nothing measured in no time
    let t = o.meter_start();
    assert_eq!(o.meter_stop(t), None);
    o.stop();
}

// savings by month: backfilled at the start from the job history
#[test]
fn savings_backfill_at_the_start() {
    let ctx = FakeCtx::new();
    let finished = 1_767_225_600_000i64;
    {
        let db = ctx.db();
        db.execute_batch("CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, vehicle_id TEXT, status TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT, external_id TEXT);").unwrap();
        db.execute("INSERT INTO jobs (type, status, title, started_at, finished_at, external_id) VALUES ('conversion', 'done', 't', ?1, ?2, 'converter:old')", [1_767_000_000_000i64, finished]).unwrap();
        store::set(&db, "savings", &json!({ "vehicles": { "car": { "bytes": 10, "clips": 1 } }, "jobs": { "old": { "vehicleId": "car", "bytes": 10, "clips": 1 } } }));
        use chrono::Datelike;
        let d = stats::energy::local_date(finished);
        assert_eq!(month_of_job(&db, "old"), Some(format!("{:04}-{:02}", d.year(), d.month())));
        assert_eq!(month_of_job(&db, "none"), None);
    }
    let o = Ops::new(ctx.clone(), Arc::new(reports::NoNetwork), HashMap::new());
    let s = store::get(&ctx.db(), "savings").unwrap();
    assert!(s["monthsSince"].as_f64().is_some(), "backfilled once");
    assert_eq!(s["months"]["car"].as_object().unwrap().values().map(|m| m["bytes"].as_f64().unwrap()).sum::<f64>(), 10.0);
    o.stop();
}

// the report's diagnostics and heartbeat, built from the context's parts, pass the payload schema
#[test]
fn diagnostics_and_heartbeat_from_the_parts() {
    let (ctx, o) = ops();
    store::set(&ctx.db(), "can", &json!({ "enabled": true }));
    let pl = o.reports.build_payload("heartbeat", None, None, false, None).unwrap();
    let h = &pl["heartbeat"];
    assert_eq!(h["vehicles"], 1);
    assert_eq!(h["footageSeconds"], 36000);
    assert_eq!(h["recordings"], 120);
    assert_eq!(h["features"]["can"], true);
    assert_eq!(h["freeBytes"], 1_000_000_000i64);
    let d = diag::diagnostics(&o);
    for k in ["system", "storage", "counts", "jobs", "converter", "settings", "features", "health", "logs", "crashes", "can"] {
        assert!(d.get(k).is_some(), "{k}");
    }
    assert_eq!(d["counts"]["binItems"], 2);
    assert_eq!(d["storage"]["footage"][0]["root"], "/footage/car");
    let support = o.reports.build_payload("support", None, None, true, None).unwrap();
    assert!(support["diagnostics"]["system"].is_object());
    o.stop();
}

// index.js: a 500 from a route is noted as a crash ('error'), kept locally
#[test]
fn server_errors_are_noted() {
    let (_ctx, o) = ops();
    o.note_server_error("TypeError", "x is undefined", "at y");
    let c = o.reports.recent_crashes();
    assert_eq!(c.len(), 1);
    assert_eq!((c[0]["name"].clone(), c[0]["source"].clone()), (json!("TypeError"), json!("error")));
    o.note_crash("Error", "boom", "");
    assert_eq!(o.reports.recent_crashes()[1]["source"], "crash");
    o.stop();
}

// the RAPL keep-alive asks only when supervised and wanted; a reading reaches the engine
#[test]
fn rapl_keepalive_and_readings() {
    let (ctx, o) = ops();
    o.rapl_keepalive();
    assert_eq!(*ctx.rapl_requests.lock().unwrap(), 0, "not supervised: nothing to ask");
    o.rapl_reading(&json!({ "at": 1, "packages": [{ "name": "package-0", "energyUj": 5 }] }));
    o.stop();
}

//! The converter's side of the helper servers (test/nodes.test.js and
//! test/nodePriority.test.js, the job service's part): a node lane's clip is
//! encoded there, checked here (pictures unless trusted, then verified) and
//! saved here; a node that fails, sends other pictures or an encode that does
//! not verify gives the clip to this server's own GPU first; with this
//! server set to Off the clip fails instead; a node lane is sent 15 clips
//! ahead; a row set lower takes back the clips waiting in its queue.

use super::lanes::{NodeLanes, RemoteEncode};
use super::lanes_tests::{cpu, until, uhd, Harness, HarnessOptions};
use crate::nodes::main_side::{ChildEvent, EncodeRequest};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const NODE: &str = "node:abcdefabcdef";

fn node_device(slots: i64) -> Value {
    json!({ "id": NODE, "kind": "node", "name": "pc (node)", "encoders": { "h265": "hevc_nvenc", "av1": null }, "online": true, "slots": slots })
}

/// A node: each encode waits (queued) until released, then writes the target
/// (or fails: 'fail'; other pictures: 'bad').
#[derive(Default)]
struct FakeNode {
    hold: AtomicBool,
    behaviour: Mutex<String>,
    sent: Mutex<Vec<EncodeRequest>>,
    running: AtomicUsize,
    release: Arc<AtomicBool>,
    trusted: AtomicBool,
    slots: Mutex<Vec<Value>>,
    killed: AtomicUsize,
}

impl NodeLanes for Arc<FakeNode> {
    fn list(&self) -> Vec<Value> {
        vec![node_device(8)]
    }
    fn encode(&self, r: EncodeRequest) -> Result<RemoteEncode, String> {
        let (tx, rx) = mpsc::channel();
        let me = self.clone();
        let target = r.target.clone();
        self.sent.lock().unwrap().push(r);
        let gone = Arc::new(AtomicBool::new(false));
        let g2 = gone.clone();
        self.running.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            if me.hold.load(Ordering::SeqCst) {
                let _ = tx.send(ChildEvent::Stdout("queued=1\n".into()));
                while !me.release.load(Ordering::SeqCst) && !g2.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            me.running.fetch_sub(1, Ordering::SeqCst);
            if g2.load(Ordering::SeqCst) {
                // (a kill: the close carries the signal, as nodes' RemoteKill sends it)
                let _ = tx.send(ChildEvent::Close { code: None, signal: Some("SIGTERM".into()) });
                return;
            }
            let b = me.behaviour.lock().unwrap().clone();
            let _ = tx.send(ChildEvent::Stdout("out_time_us=1000\nfps=50\nprogress=end\n".into()));
            if b == "fail" {
                let _ = tx.send(ChildEvent::Close { code: Some(1), signal: None });
                return;
            }
            std::fs::write(&target, if b == "bad" { "bad" } else { "node-encoded" }).unwrap();
            let _ = tx.send(ChildEvent::Close { code: Some(0), signal: None });
        });
        let me = self.clone();
        let (tx2, rx2) = (Arc::new(Mutex::new(None::<()>)), rx);
        let _ = tx2;
        Ok(RemoteEncode {
            events: rx2,
            kill: Arc::new(move |_s: &str| {
                if !gone.swap(true, Ordering::SeqCst) {
                    me.killed.fetch_add(1, Ordering::SeqCst);
                }
            }),
        })
    }
    fn trusted(&self, _d: &str) -> bool {
        self.trusted.load(Ordering::SeqCst)
    }
    fn set_slots(&self, d: &str, s: &Value) -> Result<(), String> {
        self.slots.lock().unwrap().push(json!([d, s]));
        Ok(())
    }
    fn priorities(&self) -> Value {
        json!({})
    }
}

struct Rig {
    h: Harness,
    node: Arc<FakeNode>,
    compared: Arc<Mutex<Vec<String>>>,
}

fn rig(clips: usize, mut devices: Vec<Value>, pictures_ok: bool) -> Rig {
    devices.push(super::lanes_tests::arc());
    let node = Arc::new(FakeNode::default());
    let compared = Arc::new(Mutex::new(vec![]));
    let c2 = compared.clone();
    let compare: Arc<dyn Fn(&str, &str, &Arc<AtomicBool>, Option<f64>) -> Value + Send + Sync> = Arc::new(move |_s: &str, cand: &str, _c: &Arc<AtomicBool>, _d: Option<f64>| {
        c2.lock().unwrap().push(cand.to_string());
        let bad = std::fs::read(cand).map_or(true, |b| b == b"bad");
        json!({ "ok": pictures_ok && !bad, "reason": if bad { "frames-missing" } else { "x" } })
    });
    let nodes: Arc<dyn NodeLanes> = Arc::new(node.clone());
    let h = Harness::new(HarnessOptions { clips, devices, hold: false, verify_ok: true, nodes: Some(nodes), compare: Some(compare), ..Default::default() });
    Rig { h, node, compared }
}

fn ffmpeg_on() -> bool {
    std::process::Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}

fn states(job: &Value) -> Vec<String> {
    job["items"].as_array().unwrap().iter().map(|i| format!("{}:{}", i["state"].as_str().unwrap_or(""), i["resultCode"].as_str().unwrap_or(""))).collect()
}

#[test]
fn a_node_lane_encodes_there_its_pictures_are_checked_here_and_the_clip_is_saved() {
    if !ffmpeg_on() {
        return;
    }
    let r = rig(3, vec![node_device(8), uhd(), cpu()], true);
    let id = r.h.service().start(&r.h.config(json!({ "lanes": [{ "device": NODE, "concurrency": 1 }] }))).unwrap();
    let job = r.h.finish_job(&id);
    assert_eq!(job["state"], "completed");
    assert!(states(&job).iter().all(|s| s == "completed:converted"), "{:?}", states(&job));
    assert_eq!(r.node.sent.lock().unwrap().len(), 3, "every clip encoded on the node");
    assert!(r.node.sent.lock().unwrap().iter().all(|s| s.device == NODE && s.codec == "h265"));
    assert_eq!(r.compared.lock().unwrap().len(), 3, "each one's pictures checked");
    assert!(r.h.spawned().is_empty(), "nothing encoded here");
    assert!(job["items"].as_array().unwrap().iter().all(|i| i["encoder"] == "hevc_nvenc"));
    // a node marked trusted: no picture check
    r.node.trusted.store(true, Ordering::SeqCst);
    r.compared.lock().unwrap().clear();
    std::fs::remove_dir_all(r.h.dir.path().join("out")).unwrap();
    std::fs::create_dir_all(r.h.dir.path().join("out")).unwrap();
    let id = r.h.service().start(&r.h.config(json!({ "lanes": [{ "device": NODE, "concurrency": 1 }] }))).unwrap();
    assert_eq!(r.h.finish_job(&id)["state"], "completed");
    assert!(r.compared.lock().unwrap().is_empty());
}

#[test]
fn a_node_that_fails_or_sends_other_pictures_hands_its_clip_to_this_servers_gpu() {
    if !ffmpeg_on() {
        return;
    }
    for behaviour in ["fail", "bad"] {
        let r = rig(2, vec![node_device(8), uhd(), cpu()], true);
        *r.node.behaviour.lock().unwrap() = behaviour.into();
        let id = r.h.service().start(&r.h.config(json!({ "lanes": [{ "device": NODE, "concurrency": 1 }, { "device": super::lanes_tests::arc()["id"], "concurrency": 1 }] }))).unwrap();
        let job = r.h.finish_job(&id);
        assert!(!r.node.sent.lock().unwrap().is_empty(), "{behaviour}: the node was tried");
        assert!(states(&job).iter().all(|s| s == "completed:converted"), "{behaviour}: {:?}", states(&job));
        assert!(job["items"].as_array().unwrap().iter().all(|i| i["encoder"] == "hevc_qsv"), "{behaviour}: this server's GPU encoder, not libx265");
    }
}

#[test]
fn this_server_set_to_off_a_nodes_failed_or_mismatched_clip_fails_and_nothing_is_encoded_here() {
    if !ffmpeg_on() {
        return;
    }
    for (behaviour, code) in [("fail", "node-encode-failed"), ("bad", "node-picture-mismatch")] {
        let r = rig(1, vec![node_device(8), uhd(), cpu()], true);
        *r.node.behaviour.lock().unwrap() = behaviour.into();
        let id = r.h.service().start(&r.h.config(json!({ "lanes": [{ "device": NODE, "concurrency": 1 }] }))).unwrap();
        let job = r.h.finish_job(&id);
        assert_eq!(states(&job), vec![format!("failed:{code}")], "{behaviour}");
        assert!(r.h.spawned().is_empty(), "{behaviour}: nothing encoded here");
    }
}

#[test]
fn a_node_lane_is_sent_15_clips_ahead_and_a_lower_row_takes_the_waiting_ones_back() {
    if !ffmpeg_on() {
        return;
    }
    let r = rig(24, vec![node_device(8), uhd(), cpu()], true);
    r.node.hold.store(true, Ordering::SeqCst);
    let id = r.h.service().start(&r.h.config(json!({ "lanes": [{ "device": NODE, "concurrency": 2 }] }))).unwrap();
    assert!(until(|| r.node.running.load(Ordering::SeqCst) == 17), "2 converting there and 15 sent ahead: {}", r.node.running.load(Ordering::SeqCst));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(r.node.running.load(Ordering::SeqCst), 17);
    assert_eq!(r.node.slots.lock().unwrap().first(), Some(&json!([NODE, 2])), "the node is told its number");
    assert_eq!(r.h.service().slots_of(&id), Some(2), "the clips sent ahead are not converting");
    // its row set lower: the clips waiting in its queue come back, none fails
    r.h.service().set_lanes(&id, &json!([{ "device": NODE, "concurrency": 1 }])).unwrap();
    assert!(until(|| r.node.killed.load(Ordering::SeqCst) >= 1), "taken back");
    r.node.release.store(true, Ordering::SeqCst);
    let job = r.h.finish_job(&id);
    assert_eq!(job["state"], "completed");
    assert!(states(&job).iter().all(|s| s == "completed:converted"), "{:?}", states(&job));
    assert!(job["items"].as_array().unwrap().iter().all(|i| i["attempts"].as_i64().unwrap_or(0) <= 1), "a try taken back is not counted");
}

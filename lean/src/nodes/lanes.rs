//! What the converter uses of the nodes (index.js `remoteNodes`, handed to
//! createConverterHost): the nodes as lanes, a remote encode that behaves
//! like ffmpeg's process, trust, a node row's clips at once, and each node's
//! Vehicles first list. The converter's job service takes an
//! `Arc<dyn RemoteNodes>`; `Nodes` implements it.

use super::main_side::{EncodeRequest, Nodes, RemoteChild};
use super::NodeError;
use indexmap::IndexMap;
use serde_json::Value;

pub trait RemoteNodes: Send + Sync {
    /// nodes.list(): one device per GPU / CPU of each node (or one per older
    /// node), as encodeDevices lists its own: { id, kind: 'node', nodeId,
    /// nodeName, deviceId?, deviceKind?, deviceName, name, isDefault?, node,
    /// index, pci, slots, online, encoders: { h265, av1 } }. Blocks while a
    /// node never asked before answers (8 s at most).
    fn list(&self) -> Vec<Value>;
    /// nodes.encode(request): the remote encode. Its events are ffmpeg's
    /// -progress lines ("queued=1" while it waits on the node) and the close
    /// (0: the encoded file is at the target, created new; 1: failed, encode
    /// it here; None with the signal after a kill).
    fn encode(&self, request: EncodeRequest) -> Result<RemoteChild, NodeError>;
    /// A trusted node's encodes skip the picture check (any lane of it).
    fn trusted(&self, device: &str) -> bool;
    /// A node's rows under Encoder > Parallel conversions: a number for a whole
    /// node, { lane: 0..8 } for its devices, one request per node.
    fn set_slots(&self, device: &str, slots: &Value) -> Result<(), NodeError>;
    /// { 'node:<id>': [the TeslaCam folder of each vehicle on its list] }
    /// (vehicles.studioRoot; a vehicle without one is left out).
    fn priorities(&self) -> IndexMap<String, Vec<String>>;
}

impl RemoteNodes for Nodes {
    fn list(&self) -> Vec<Value> {
        Nodes::list(self)
    }
    fn encode(&self, request: EncodeRequest) -> Result<RemoteChild, NodeError> {
        Nodes::encode(self, request)
    }
    fn trusted(&self, device: &str) -> bool {
        Nodes::trusted(self, device)
    }
    fn set_slots(&self, device: &str, slots: &Value) -> Result<(), NodeError> {
        Nodes::set_slots(self, device, slots).map(|_| ())
    }
    fn priorities(&self) -> IndexMap<String, Vec<String>> {
        let vehicles = self.ctx().vehicles();
        self.car_lists().into_iter().map(|(lane, ids)| {
            let roots = ids.iter().filter_map(|id| vehicles.iter().find(|v| &v.id == id).and_then(|v| v.studio_root.as_ref()).map(|p| p.to_string_lossy().into_owned())).collect();
            (lane, roots)
        }).collect()
    }
}

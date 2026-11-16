# Helper servers (nodes)

Port of `server/nodes.js` (main side), `server/nodeWorker.js` (worker side),
`server/nodeBenchmark.js`, `src/main/converter/pictureCheck.js`, the 12
`/api/nodes*` routes and the 7 `/node/v1/*` routes of `server/index.js`.
Blocking code (threads), like the converter: call it from `spawn_blocking`.

| File | Node source |
| --- | --- |
| `client.rs` | connectPinned, request (TLS 1.2+, ALPN http/1.1, idle timeout, deadline, cancel, 64 KiB answers) |
| `pin.rs` | pinMatches, the authority kept at pairing (X509 checkIssued + signature + validity) |
| `main_side.rs` | createNodes: list, overview, power, hardware, add, rename, setCars, forgetCar, setTrusted, trusted, carLists, remove, encode, setSlots, refresh, takeUploadSlot |
| `worker.rs` | createNodeWorker: settings, status, setEnabled, startPairing, cancelPairing, revoke, handle, attempts, devices, the sweeper |
| `benchmark.rs` | createNodeBenchmark, pickSamples, suggest |
| `picture.rs` | judgeFrames, comparePictures, ffmpegDecoder |
| `lanes.rs` | `RemoteNodes`: what the converter uses (index.js `remoteNodes`) |
| `routes.rs` | the routes, `access`, `NodesApi` |
| `serve.rs` | a small HTTPS/1.1 server for `/node/v1/*` (tests, parity, a model for core) |

## Mounting (for the integrator)

```rust
let api = Arc::new(nodes::routes::NodesApi::new(ctx /* Arc<dyn NodesCtx> */, nodes::routes::ApiOptions {
    work_dir: None,   // <data>/node-work (emptied at every start)
    bench_dir: None,  // <data>/converter-temp/node-benchmark
    poll_ms: None, spawn: None,
}));
// /api/nodes*: nodes::routes::access(method, path) -> Admin / AdminConfirmed (🔑 checked
// inside from Caller::confirmed, answering 403 CONFIRM_PASSWORD as requireConfirmed);
// then, in spawn_blocking:
//   api.handle(&nodes::routes::Request { method, path, body: &json, caller: &caller }) -> Option<Reply { status, body }>
// /node/v1/*: before the host-name and same-origin checks (no cookies), in spawn_blocking:
//   let mut req = WorkerRequest { method, path, headers, address: clientKey,
//       served_cert: Some(&der_of_the_certificate_this_connection_was_served_with),
//       body: &mut SyncIoBridge(request body) };
//   let reply = api.node_v1(is_https, &mut req).unwrap();   // 404 Not found without HTTPS / TLS_MODE=off
//   write reply.status, reply.headers and reply.body (Bytes, File(file, len), or Close: close
//   the connection without answering); then reply.delivered() once it was all written
//   (dropped unsent, the job it names is stopped, as Node's res 'close' does).
//   Read what the worker left of a refused upload before closing (serve.rs drains it),
//   or the main sees a reset instead of the answer.
// DELETE /api/vehicles/:id: api.forget_vehicle(id)
// OpsCtx::node_powers(): api.nodes.power_rows(); heartbeat nodes: api.nodes.hardware()
// on exit: api.close()
```

`NodesCtx` (`ctx.rs`): `setting` / `set_setting` (manager.db settings `nodes`
and `nodeWorker`, same JSON as Node), `audit`, `log` (scope `nodes`),
`hostname`, `tls_available` (TLS_MODE != off), `authority_pem`
(tlsSource.caPem()), `node_power` (call `ops::Ops::node_power`), `own_power`
(statsAskedAt, `stats.touch(45 s)`, `ops::node_power::power_report`),
`own_gpus` (CPU model and `ops::gpu::detect_gpus`; cached 10 min here),
`vehicles` (ids and `studioRoot`), `data_path`, ffmpeg/ffprobe paths,
`runtime` (the converter's `WorkerRuntime`).

## The converter's side

- `WorkerRuntime` (`ctx.rs`): selectEncoder, cpuEncoder, localDevices,
  selectEncoderFor(family, device, probe), encodingNow, over
  `converter::planner`. The converter implements it; core returns it from
  `NodesCtx::runtime` (None while the converter starts: the worker answers
  "The converter is starting." for clips then).
- `RemoteNodes` (`lanes.rs`, implemented by `Nodes`): `list()` (the lanes),
  `encode(EncodeRequest) -> RemoteChild` (events: progress lines and
  `Close { code, signal }`; `kill("SIGTERM")`), `trusted(device)`,
  `set_slots(device, n | { lane: n })`, `priorities()`. jobService uses
  them as Node does: a node lane's clip is encoded there, then telemetry,
  verify and save happen here; a failed encode goes to this server's own
  GPU first; `picture::compare_pictures` runs on it unless `trusted`.

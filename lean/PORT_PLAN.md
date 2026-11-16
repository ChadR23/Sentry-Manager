# Full port to Rust: plan and ground rules

The owner's decisions (2026-11-15):

- **Everything on the server moves to Rust**: every route, background job,
  the converter, the supervisor. The browser pages stay as they are (`web/`,
  `src/renderer` Studio pages, `examples/ui-packs`); Rust serves them and
  everything they call, so all six interfaces and uploaded packs keep working.
- **One switch at the end**: the Node server stays the shipped app until the
  Rust one answers every route the same way; then the image switches over and
  Node is removed. No half-and-half proxying.
- **The converter is ported early**, with every safety check it has today.

The Node code is the specification. Where the Rust code answers differently
from Node, Rust is wrong unless the owner says otherwise.

## Size

About 50,000 lines of JavaScript (`server/`, `src/main/`), 189 server routes
(`docs/api-contract.md`, regenerate with `node tools/contract/routes.js`), two
live-update streams, the converter's 22 IPC channels over
`POST /api/converter/invoke/:name`.

## Layout

One crate, `lean/`, binary `sentry-lean`. Each area is a module folder with
its own routes, merged in `src/api.rs`:

| Module | Area (contract groups) | Node source to port |
| --- | --- | --- |
| `core/` | config/env, `manager.db` (same schema as `server/db.js`), settings, accounts, sessions, sign-in throttle, access levels, CSRF header, HTTPS + own CA + ACME, audit + logs, live-update hub (`/api/events`), jobs, router helpers | `server/db.js`, `auth.js`, `accounts.js`, `access.js`, `acme.js`, `http.js`, `log.js`, `activity.js`, index.js glue |
| `supervisor/` | the root supervisor: starts the app as PUID/PGID, mounts SMB shares (mount.cifs), restarts | `server/supervisor.js`, `mounter.js`, `mountSpec.js` |
| `converter/` | converter + encoder + helper servers (nodes) + benchmarks + GPU detection | `src/main/converter/*`, `server/converterHost.js`, `converterBridge.js`, `nodes.js`, `nodeWorker.js`, `gpu.js`, `stats/gpu.js` |
| `footage/` | vehicles, shares, inventory, catalog, Recycle Bin, cleanup policies, protect, stars, integrity, arrival checksums | `server/vehicles*`, `inventory.js`, `catalog.js`, `scanner.js`, `recycleBin.js`, `deletedClips.js`, `integrity.js`, `arrivalChecksums.js` |
| `viewer/` | media ranges, telemetry, speeds, speed index, scrub previews, thumbnails, moments, places, map, drives/driving, event map, archive gaps | `server/media`, `telemetry.js`, `speedReader.js`, `speedIndex.js`, `scrub*.js`, `thumbnails.js`, `driveData.js`, `archiveGap.js`, places |
| `ops/` | notifications + rules, health, stats + history + export, power price + savings, updates, feedback reports, support bundle, snapshots, metrics | `server/health.js`, `stats/*`, `imageUpdates.js`, `reports*.js`, snapshots |
| `can/` | CAN logs, CAN Bridge uploads, device port, Sentry USB link | `server/can*.js`, `canPort.js`, `sentryUsb.js` |
| `ui/` | interface packs (list, upload, install, serve, HTML rewriting: versioned links, prefetch, critical bar), static files, exports | `server/uiPacks.js`, `exporter.js`, the static/HTML parts of index.js |

Areas are written in parallel with `core/`. Until core lands, an area
defines the few things it needs from core as a small trait in its own module
(`<area>/ctx.rs`: e.g. `db()`, `setting(key)`, `announce(topic)`,
`audit(line)`, `user role`) and its handlers take that trait; the coordinator
implements the traits on core's `AppState` when merging. Keep handler logic
in plain functions that are testable without HTTP.

Shared types live in `core/`. An area module only adds files in its own
folder, plus one line in `src/api.rs` (its routes) and its dependencies in
`Cargo.toml`; the coordinator merges those.

## How an area is done

1. Read the Node code for the area completely, including its tests in
   `test/`. Port behaviour, not just shapes: limits, ordering, error texts,
   status codes, audit lines, live-update topics, timing (debounces, retries).
2. Port the area's tests that make sense in Rust (`cargo test`).
3. Same answers: record goldens from the Node server (`tools/contract/record.js`
   against `tools/contract/fixture.js`, or the bench container) and compare
   the Rust server (`tools/contract/compare.js`). Every difference is fixed or
   listed in this file under "Known differences" with the owner's OK.
4. Write down what is not done yet in this file under the area.

## Ground rules (owner's)

- Footage is read-only except where Node writes today (converter replace,
  Recycle Bin, cleanup, restore), and there with the same checks, in the same
  order, tested only on copies.
- Passwords only over HTTPS, never plain HTTP.
- Everything stays in the one container: no extra services.
- The opt-in reports go only to the developers' receiver
  (`https://reports.skittles.live`), only when an admin turns it on or presses
  Send (docs/security.md, docs/reports-api.md).
- No co-author trailers, no model names in code or commits.
- `npm test` keeps passing while Node is still the shipped app.

## Status

| Module | State |
| --- | --- |
| footage list, recordings, media ranges, speeds, MP4/SEI reading | first slice done (see README.md) |
| supervisor | ported, see below and `src/supervisor/README.md` |
| converter | ported and tested (library, not mounted): file safety, telemetry, job store, job service, lanes per GPU, automatic conversion, benchmark, the helper servers' side, the 22 channels; see below |
| ops | ported; the encoder block and the wiring are the converter's and core's, see below |
| viewer | ported except where it needs CAN, Sentry USB status, notifications or accounts; see below |
| footage: arrival checksums | ported and tested with parity (`src/arrival/`, library, not mounted); see "Footage" below |
| helper servers (nodes) | main side, worker, benchmark, picture check and the 19 routes ported and tested (library, not mounted); see below |
| everything else | not started |

## Converter

Done, round 1 (`src/converter/`, library only: nothing is wired into
`api.rs` yet, so no route answers and nothing can touch footage from the
lean server):

- `owned.rs` (server/posixOwnedFs.js, native/noreplace-rename.c): remove,
  promote, linkBackup, replaceOver. Device, inode, size and a SHA-256 taken
  with the file held open and unchanged while hashed (or identity and mtime
  for content just proven), removal through a quarantine name with the inode
  checked again there, a guard file held open, renameat2(RENAME_NOREPLACE)
  called directly (link + unlink fallback where it is unsupported).
- `mp4w.rs` (mp4.js, whole-file tree and chunk-offset rewrite), `tesla_sei.rs`,
  `timeline.rs` (telemetryTimeline.js), `lead_in.rs`, `frame_num.rs`
  (frameNumGaps.js), `h265.rs`, `av1.rs` (inject and inspect), `adapters.rs`
  (outputTiming, the in-place telemetry writer with its identity checks).
- `verifier.rs` (verifier.js): every check in Node's order, same reasons and
  details; `snapshot.rs` (verificationSnapshot.js and the runtime's snapshot
  registry: structural ownership, consume-once, reconcile).
- `staging/` (staging.js): stageSource, reserve/adoptEncodeOutput, copyAsset,
  publishSeparate, prepare/commitPublication, prepare/swapReplacement,
  replaceOriginal, rollbackReplacement, recoverReplacement (all actions),
  recoverCopy, cleanupOwnedArtifacts, the journal snapshots (same JSON as
  Node's), classifyPath / checkStagingSpace / chooseStagingMode.
  Ported for the server's configuration only (posix adapters, private temp
  cleanup by identity, replace by link); the desktop branches are left out.
- `recovery.rs` (jobStore.js REPLACEMENT_TRUTH_TABLES / replacementAction and
  runtime.js createRecoveryInspector), `planner.rs` (encoderPlanner.js),
  `process.rs` (the bounded runner: timeout, output cap, cancel, SIGTERM,
  CUDA_DEVICE_ORDER), `contracts.rs` (profiles, size rules, verify modes,
  device ids).

Tests (`cargo test`): test/posixOwnedFs, ownedCleanup, stagingSplit,
verifierRepeatedMessage, leadIn (encode arguments) and frameNumGaps (the
rule) ported; a crash-point test kills a replacement before each of its
journal records (a panic, so no rollback runs) and recovers as jobService
does, asserting the original's name always holds the original or the
verified conversion and nothing unproven is removed. Parity with Node
(`src/converter/testdata/*.js`, needs node + ffmpeg; set
`LEAN_CONVERTER_FIXTURES=<dir>` to reuse fixtures): timelines of 7
Tesla-like originals (keyframe first, lead-in, frame_num gaps, unknown gap,
no keyframe), the H.265 and AV1 writer outputs byte-identical (12 files),
inspections identical, 168 verifier verdicts identical (good, raw,
truncated, tampered; Quick and Full; with and without a size profile), and
buildEncodeArgs / decodeAccelArgs over every encoder and option.

Round 2 (also library only; the integrator mounts it, see "Mounting"):

- `jobstore/` (jobStore.js): job.json + job.journal (append, replay, the
  1,000-record / 16 MiB limits, a torn last line ignored), every manifest
  rule of normalizeManifest in Node's order with Node's error codes, the
  normalized keys in Node's order (so the files are byte for byte Node's),
  preflight limits, quarantine of a corrupt job.json or journal, create /
  save / load / list (ICU order) / summaries (summary.json with Node's
  stamp) / transition (the store's own clips are not checked again: an
  `Item` only exists normalized) / recover (the recovery truth tables) /
  discard. Kill-point hooks (`StoreHooks`) as crashPoints.js wraps the store.
- `scanner.rs` (scanner.js, teslaFilename.mjs): the same clips in the same
  order (groups in groupOrder, then names by UTF-16 code unit), the same
  skips (hidden, TEMP-/BACKUP-, symbolic links, outside the real source,
  the destination inside the source), compareScanPaths.
- `service/` (jobService.js): start (one job at a time unless automatic jobs
  on separate devices), discovery in batches with follow-up parts at the
  clip limit, the workers (concurrency, raised and lowered while running),
  the lead and save-slot rules for job-level fields, per clip: ffprobe,
  staging or direct, the original's fingerprint, encode (ffmpeg -progress
  parsed exactly as Node, activeEncodes' live numbers, the stall watch),
  the telemetry writer, verify, size retries, the under-source retries
  (85 %, 60 %) and "keep the original" when nothing is saved, the split save
  (prepare outside the slot, swap/commit in it, rollback record), cleanup
  by recorded identity, failures, pause (settles when every worker parks),
  resume, cancel, discard, retry failed, dismiss summary, network waits
  (paused_network with its recovery record, backoff, "gone while the share
  answers"), shutdown (the stop record), recovery (every action of
  performRecovery: resume-queue/discovery/network, copies, replacements
  step by step through the truth tables, cleanup-and-restart), events and
  throttled snapshots (publicSnapshot / summaries).
- `runtime.rs` (runtime.js for the server): `<data>/converter-jobs`, the
  real temp path, `<temp>/sentry-six-converter`, startup recovery (deferred,
  then one job after the other), the startup sweeps (unreferenced
  verification folders, leftover work folders and encodes older than an hour).
- `ipc.rs` + `ctx.rs` (ipc.js + converterBridge.js): the 22 channels with
  their checks, error codes and answers (sanitizeSnapshot with the 256-clip
  cut, sanitizeLiveProgress, responseError), verification never Off for a
  server start, every folder through the footage guard
  (`ConverterCtx::resolve_path`), the SSE live updates.

Checked (`cargo test --lib converter`; the end-to-end ones need ffmpeg with
libx265 and node, `LEAN_CONVERTER_JOB_FIXTURES=<dir>` reuses the clip):

- job store parity (`lean/parity/converterStore.js`): the same scenarios
  run by both stores give byte-identical job.json and job.journal; each
  lists and loads the other's jobs (job.json + journal) as its own and
  continues them (two rounds, each way); summaries equal, Node's
  summary.json reused; recover() with the same facts takes the same step;
  7,842 damaged manifests (every field removed, nulled, retyped; unknown
  and private fields) get the same answer (the same code, or the same job);
  journalDiscovery and snapshotReuse rules;
- scanner parity (`lean/parity/converterScan.js`) on a tree with every skip;
- conversions (`lean/parity/converterJobs.js`): replace direct, replace
  through staging, separate; the same job (states, result codes, attempts,
  encoder, counters, summary), the same events (but live-update counts) and
  byte-identical outputs as Node's run on a copy; Node reads Rust's job;
- the crash suites (converterCrashReplace, converterCrashSeparate,
  converterCrashParallel, replaceCrash, crashPoints.js): the converter
  killed with SIGKILL (its process group) at encode, verify,
  snapshot-unrecorded, save-recorded, copy-recorded, slot-entered,
  backup-renamed, backup-recorded, before-final, after-final,
  final-recorded, quarantined, rolled-back, before-result, after-result,
  cleanup-unrecorded; on a share without hard links; through staging;
  separate; three at once; restarted by Rust, and by Node (Rust's
  interrupted jobs finished by the Node converter). Every time the job
  finishes by itself, every clip holds its verified H.265 conversion, the
  original was at its name or its backup at the moment of the kill, and
  nothing is left behind;
- restartResume (stopped between clips carries on; paused stays paused and
  Resume finishes it), a cancel; ffmpeg progress lines; formatBytes ties.
- bridge parity (`lean/parity/converterBridge.js`): 104 requests (start
  configs of every kind, ids, folders outside the guard, chooseFolder,
  oversized payloads, unknown channels) answered the same by Node's bridge
  and this one on the same stand-in service.

Round 3 (also library only):

- Lanes per GPU (`service/lanes.rs`, jobService.js): resolveLanes (each
  lane's device from the device list; a missing one logged and skipped; a
  whole-node lane finds the node's default device; helper servers told
  their number, at most 8, and sent 15 clips ahead in proportion), workers
  per lane with laneLimit / deviceActive / the default lane (a switch
  between no lanes and lanes never runs a GPU above its number), setLanes,
  setConcurrency on a lanes job (its one GPU still here, else no lanes),
  slotsOf; `planner.selectFor` per lane; the decode tiers (zero-copy, GPU,
  then CPU), a tier that failed and a slower one fixed recorded broken per
  GPU and encoder; GPU decode for a Full verify with its fallback count.
- `devices.rs` (encodeDevices.js + runtime.js): render nodes by PCI slot
  (char device numbers, else /sys/class/drm), nvidia-smi with its deadline
  (a wedged one is not joined by another), the CPU last; `Registry`: one
  lookup at a time, an answer reused 2 s, resolveDevice, defaultDeviceOf,
  devices() (each device's proven encoder per codec, nothing tested with
  fewer than two GPUs or while something encodes).
- `converted_index.rs` + `mp4_header.rs` (convertedIndex.js, mp4Header.js):
  discovery skips converted clips from the index or their MP4 header (a
  share error waited for, 20 s per check), converted outputs recorded, the
  same JSON file as Node's.
- `auto_convert.rs` (autoConvert.js): settings, the per-vehicle configs and
  saved-only vehicles, the give-up index (revision 5), the schedule and
  rounds, the time window (hours or off-peak), holdManual, one job per
  vehicle on devices of its own (planLanes with the helper servers'
  priorities and Off), setLanes / setConcurrency follow a running job,
  saveVehicle / forgetVehicle, restart adoption; the same files as Node's.
- `benchmark.rs` (benchmark.js) and `Converter::run_benchmark` (runtime.js):
  every level, bad clips left out, energy per level, the verify comparison;
  originals found in a mostly converted archive; isolated level runs; every
  GPU alone; progress as `converter:benchmarkProgress` on the asking
  window's `/api/converter/events`.
- `stats.rs` (encoderStats.js, convertStats.js), `host.rs` (converterHost
  start retries), sweepEmptySnapshotFolders (after a job ends and at start),
  holdDiscovered (`RuntimeOptions::hold_discovered`), the channels setLanes,
  devices (DEVICE_UNSUPPORTED on start), getAuto / setAuto / saveVehicle /
  forgetVehicle / checkAutoNow, runBenchmark / cancelBenchmark.
- The helper servers' side (`service/encode.rs` run_remote, `work.rs`):
  a node lane's clip is encoded there (ffmpeg's progress, "queued", stall
  and kill handling), its pictures checked here (`nodes::picture`) unless
  the node is trusted, verified and saved here; a node that fails, sends
  other pictures or an encode that does not verify gives the clip to this
  server's own GPU first (two at a time, NODE_FALLBACK_AT_ONCE); with this
  server Off the clip fails (NODE_ENCODE_FAILED / NODE_PICTURE_MISMATCH /
  NODE_NO_ENCODER); a row set lower takes back the clips waiting in the
  node's queue (re-queued first, the try not counted); checks per node at
  its number + 2. `nodes::ctx::WorkerRuntime` is implemented on `Converter`.
- Probes, verifies and telemetry runs have converterHost's 30-minute limit
  (they had 30 s: a loaded machine failed a verify Node waits for; that was
  the cause of `conversions_as_node_runs_them` failing once under load).

Checked (round 3): test/lanes (the job service's part, with an ffmpeg
stand-in script and the real planner over a fake probe), encodeDevices,
convertedIndex, mp4Header, autoGiveUp, autoPerVehicle, nodePriority
(planning), benchmark, encoderStats, the picture-check and converter tests
of nodes.test.js; the crash points inside a file copy (temp-created,
temp-torn, temp-complete, temp-readback, writer, staging-copy, through a
test-only fs hook, `fs_hook.rs`) and 'lowered', each killed with SIGKILL
(replace and separate, direct and staging, three at once, one restarted
by Node): every job finishes by itself, the original never lost. Parity
(`lean/parity/converterAuto.js`): automatic conversion over a 51-step
scenario (every state, every call to the job service, the files written,
byte for byte), the benchmark's events and results (5 scenarios), the
device list (fake /dev and /sys, three nvidia-smi answers) and devices() /
resolveDevice over 8 GPU sets, all equal to Node's.

### Mounting (for the integrator)

```rust
let mut o = converter::runtime::RuntimeOptions::new(data_path, temp_path, &ffmpeg, &ffprobe);
o.before_replace_original = Some(/* arrival::Area::before_replace_fn */);
o.hold_discovered = Some(/* Sentry USB copies in progress */);
o.power_meter = Some(/* energy per benchmark level */);
o.is_cheap_now = Some(/* off-peak rate now (ops power price) */);
o.nodes = Some(Arc::new(converter::service::lanes::FromNodes(nodes_api.nodes.clone() /* Arc<dyn RemoteNodes> */)));
let host = converter::host::Host::default();
let conv = host.start(&|| converter::runtime::Converter::open(make_options()), &*ctx, 5, Duration::from_secs(2))?;
let bridge = converter::ipc::Bridge::new(Arc::new(conv.service.clone()), ctx.clone(),
    converter::ipc::capabilities(&conv.staging.capabilities()));
bridge.mount_runtime(&conv);         // devices, automatic conversion, the benchmark
// POST /api/converter/invoke/:name  -> bridge.invoke(name, body (None if empty), client)  (blocking: spawn_blocking)
// GET  /api/converter/events?client= -> bridge.attach_events(client, sink); bridge.detach(client) on close
// OpsCtx::encoder_block(snapshot, energy) -> conv.encoder_block(snapshot, energy)
// OpsCtx::heartbeat_hardware -> converter::stats::heartbeat_hardware(&found, cpu, &convert_stats, &paired, 8),
//   with a ConvertStats (settings get/set) sampled from conv.active_encodes() every poll
// NodesCtx::runtime -> Some(conv.clone()) (WorkerRuntime)
// on exit: host.stop()
```
`RuntimeOptions::new` fills the rest (tools, tune, hooks, encoders,
discovery: tests; gpu_decode true; auto_timer true). `ConverterCtx` (ctx.rs):
data/temp paths, tool paths, the footage guard, the Sentry USB hook,
clip_converted (previews), log lines. `Converter` also answers
`active_encodes()` (a benchmark's included), `encoding_now()`,
`devices_answer()`; `Service` answers `slots_of(id)`, `live_jobs()`.

Not done yet:

1. Parity of runBenchmark through the whole runtime (real clips, the
   isolated level services) against Node's: only runConverterBenchmark is
   compared (its events and results); the runtime's part is tested here.
   (pictureCheck has one Rust copy, `nodes::picture`, used by the converter.)
2. The node side is tested with a stand-in node (lanes, failover, Off,
   15 ahead, withdraw); an end-to-end run against a real `nodes` worker
   (nodes.test.js "a real remote encode") is not.

Proposed differences (need the owner's OK): a nested box literally named
`root` is serialized as a box (Node's writer would treat it as the tree
root); io error texts are Rust's where Node logs its own; Resume of a job
parked mid-replacement answers once that clip is settled (Node's answer
waits for the whole relaunched job); a job file holding a lone UTF-16
surrogate (never written from file names) is read as corrupt.

## Helper servers

Done (`src/nodes/`, library only; how to mount it: `src/nodes/README.md`):

- the main side (nodes.js): pairing (address rules, the 12-character code,
  8 nodes, the HMAC proofs over the certificate seen, the token's form, the
  authority kept only when it is a CA that issued the certificate seen),
  every connection pinned before a byte is sent (the fingerprint, or a
  certificate the pinned authority issued and valid now; the handshake's
  signatures checked), the token as Bearer, Node's timeouts (8 s info,
  10 s probe, 15 s pair and job status, 60 s uploads and downloads with
  30-minute deadlines, twice the idle timeout otherwise), at most 64 KiB of
  an answer, the same error texts and codes (NODE_TIMEOUT, NODE_UNREACHABLE
  with Node's errno names, NODE_CERT, NODE_CERT_CHANGED, NODE_PROTOCOL,
  NODE_BUSY, NODE_DEVICE_GONE, CANCELLED); list (a lane per GPU/CPU,
  `node:<id>@<device>`, or one per older node), overview (1.5 s wait, the
  keys JSON.stringify leaves out), power / power_rows, hardware, rename,
  Vehicles first, trust, forgetCar, remove, setSlots (a number or per device);
  the remote encode as Node runs it (info first, 5 minutes of busy waits,
  two uploads at once per node, the job id taken even after a cancel once
  all is sent, `queued=1`, only real progress counts, 30-minute queue
  limit, the output created new and never past twice the clip), devices kept
  with the node for when it is offline, the power notes for the stats engine;
- the worker (nodeWorker.js): one-time codes (10 minutes, 20 wrong tries, 3
  per address), the token kept as SHA-256, the bad-token throttle (20 in
  10 minutes), the settings in Node's key order, devices per GPU/CPU with
  their encoders (30 s cache, no probe while encoding), slots per device and
  the queue of 15 (64 held in all), the disk check, the MP4 check, ffmpeg
  built from fixed choices only (`-protocol_whitelist file -f mov`, `-fs`,
  `-t`), GPU decode then without, the stall watch, the sweeper (done 10
  minutes, orphans 5), every answer and status code of the 7 routes;
- the benchmark (nodeBenchmark.js), the picture check (pictureCheck.js:
  SSIM, the offsets, the three random stretches on long clips, GPU decode
  then CPU), the 12 `/api/nodes*` routes with their audit lines.

Checked: `cargo test --lib nodes` (26 tests; the end-to-end ones need
openssl and ffmpeg, the parity ones node too): ports of test/nodes.test.js
(addresses, settings, pairing with a changed certificate and tokens, a real
remote encode, an existing output, both cancels, a renewed certificate,
refused manifests, wrong codes per address, a node that never stops
sending, clips waiting on the node, GPU/CPU lanes and slots per device, an
older node, the benchmark on real clips, Encode with, device attempts, the
picture check on synthetic and real encodes, the GPU decode fallback, upload
slots), server.test.js "a change refused part way saves none of it; a
removed vehicle leaves every node list" (and the other refusals of the
routes), reportsHeartbeatNodes' nodes.hardware() after a restart. Parity
(`lean/parity/nodes.js`): the Rust main pairs with Node's worker, encodes
there, cancels and sets its slots; Node's main pairs with the Rust worker
and does the same; and 35 requests (pairing refusals, tokens, info, slots,
jobs, a real encode and its output, deletes, the throttle) get the same
status, content type and JSON from both workers.

Not done yet:

- the converter's part: node lanes in jobService (lanes, failover to this
  server's GPU, the picture check unless trusted, "15 ahead", the checks
  "a few at a time"), autoConvert's planLanes with the nodes' priorities
  (test/nodePriority.test.js), `WorkerRuntime` on the planner;
- core: `NodesCtx` on AppState, the routes mounted, `/node/v1/*` served from
  its HTTPS server with the served certificate (`WorkerRequest::served_cert`),
  `forget_vehicle` from DELETE /api/vehicles/:id, `power_rows` for
  `OpsCtx::node_powers`, `hardware()` for the heartbeat.

Proposed differences (need the owner's OK): TLS failures read "Could not
reach the node (EPROTO)." or rustls' text where Node names OpenSSL's code;
a name cut at 64 UTF-16 units never splits a surrogate pair; a request whose
upload is stopped on the worker (revoked, node mode off) is closed without
an answer (Node leaves it open until the main gives up).

## Supervisor

Done (`src/supervisor/`, binary `sentry-lean-supervisor`): supervisor.js
(folders and their owners, setpriv launch as PUID:PGID with GPU groups, the
app's environment, restart 5 s after a crash, SIGTERM/SIGINT forwarding and
exit code, `shutdown` without CAP_KILL, log forwarding with the early
buffer, RAPL readings, TLS export modes, `tls-hostnames`, ACME token
relaying, a `healthcheck` subcommand for Docker), mounter.js (local
mounter, per-vehicle queue, IPC mounter), mountSpec.js (same accepted and
refused input, same option string and credentials file), proc.js. The IPC
channel is JSON lines over a socketpair on fd 3 (`SENTRY_SUPERVISOR_FD`),
as Node's was; the messages are in `src/supervisor/README.md`.

Not done yet:

- core implements `supervisor::ctx::Tls` (tls.js TlsManager, exportForApp,
  parseHostnames, acme.js) and passes it in `src/supervisor/bin.rs`; until
  then the supervisor warns "HTTPS setup failed" and runs without TLS;
- the app (`sentry-lean`) does not use the link yet: core wires
  `ipc::take_from_env`, `Link` (shutdown on disconnect/`shutdown`, the
  `supervisor-log` lines, `rapl-reading`, `tls-updated`) and
  `link::drop_malloc_arena_max`; footage uses `IpcMounter`;
- lean/Dockerfile: run as root with the supervisor as CMD under tini, with
  setpriv, cifs-utils and tini installed.

Proposed difference (needs the owner's OK): file system error texts that are
only logged ("mount car: ...") read like Rust's, not Node's.

## Ops

Done (`src/ops/`, handlers over the `ops::ctx::OpsCtx` trait; routes in
`ops/routes.rs`, wired in `api.rs` before the slice's own routes, started
from `main.rs`; until core lands `ops/lean.rs` implements the trait on
`App` with its own connection to `DATA_PATH/manager.db`, same schema):

- notifications: db.js notify/resolve/resolveId/markRead/list (an unchanged
  repeat changes nothing and announces nothing), activity.js Notifications
  (muted kinds, share, read-only and space alerts with the 10-minute
  grace), the rules, all 5 routes. Node has no outbound channels (no e-mail
  or webhooks), so there are none here;
- health.js checks (same order, key order and texts), one run at a time,
  the banner, the startup self-check a minute after the start with its
  notifications and log line;
- snapshots.js (VACUUM INTO, 7 kept, restore at the next start through
  `snapshots::apply_pending_restore`, which core must call before it opens
  manager.db; ops/lean.rs does);
- powerPrice.js and savings.js exactly (local time, overnight rates,
  backfill, by month), PUT /api/settings/power, savings-by-month; savings
  recorded from the converter's job snapshots (`Ops::job_snapshot`) and the
  backfill run at the start from the jobs table (`ops::month_of_job`,
  db.jobByExternal);
- buildInfo.js, hostInfo.js, imageUpdates.js (registry token, multi-arch
  index, build numbers, sticky critical levels, the 12 h / 10 min checks,
  notifications);
- metrics: settings, enable, disable and `/metrics` with its token;
- reports: reportsConfig, reportsScrub, reportsProtocol (seal and open,
  sign, proof of work, schema, moved notices), reports.js (opt-in, outbox
  caps, backoff, 429/POW/TIME, the per-hour manual limit, crashes, daily,
  heartbeat and normalizeHeartbeat, install and anonymous keys kept in
  Node's PKCS#8 form). Only `https://reports.skittles.live` (or an https://
  REPORTS_URL; http only to localhost under NODE_ENV=test). The content:
  `ops/diag.rs` builds index.js reportDiagnostics, reportHeartbeat and
  reportIdentifiers (and storageTotals.js) from ops' own parts and the
  `OpsCtx` calls below; crash notes from 500s and panics through
  `Ops::note_server_error` / `Ops::note_crash`;
- /api/system, /api/support-bundle (zip, same scrubbing), /api/updates;
- the server monitor, all of server/stats/* (`ops/stats/`, one file per
  Node file): history, CPU (sockets, throttling, clock), memory, host (OS
  from the kernel, appVersion), the process table (reaped children, page
  size, the app's tree), GPUs (DRM cards, fdinfo engine use per client and
  per process, amdgpu/i915/xe sysfs and hwmon, runtime suspend, the held
  numbers, pci.ids names, the long-running nvidia-smi with its backoff,
  WSL's /dev/dxg), power (RAPL read here or the supervisor's `rapl-reading`
  through `Ops::rapl_reading`, the wrap-around, per socket, APUs), energy
  and costs per day and per job with baselines and peaks, data used per day
  (traffic.js: scopes, splits over midnight, restarts), disks, file systems
  and share answer times (mountinfo, SMB versions, not-mounted shares,
  hung checks), sensors (hwmon, thermal zones, fans, per socket), alerts
  with hysteresis as `server:` notifications, unlock hints, background
  reads (at most 4 at once, answers land between samples), sampling only
  while watched or busy, the once-a-day `tick()`, the RAPL keep-alive;
  nodePower.js (`ops/node_power.rs`: powerReport, cleanReport, combine) and
  GET /api/stats as index.js builds it (`Ops::stats_answer`: "All
  servers", peaks, price, the encoder block); server/gpu.js detectGpus,
  usableGpus, encodeGpuName (`ops/gpu.rs`, for the converter area to use).

Hooks other areas call (methods on `Ops`): `rapl_reading(msg)` (core's
supervisor link), `note_server_error(name, message, stack)` (core's error
path for a 500), `note_crash(...)` (a panic hook), `job_snapshot(&JobSnapshot)`
(converter: each job snapshot, and the jobs listed at the start),
`job_energy(id)` (core's Jobs keeps it with a finished conversion),
`meter_start()` / `meter_stop(token)` (the benchmark's power meter),
`node_power(id, at, w, encoding)` (nodes.js onPower).

`OpsCtx` calls added in round 2, all with defaults so they can be
implemented one area at a time: `encoder_block(snapshot, energy)` (now takes
the stats snapshot and energy), `node_powers()`, `active_encodes()`,
`job_progress(job)`, `stats_busy()`, `request_rapl()` (send
`{ type: 'rapl', on: true }` to the supervisor), `recent_jobs(limit)`,
`access_settings()`, `places_count()`, `sentry_usb_infos()`,
`can_status()`, `car_models()`, `clips_arrived(since)`, `driven_metres()`,
`heartbeat_hardware()` (convertStats.js; the default names the usable GPUs
and the CPU), `trust_proxy()`; `VehicleInfo` gained `footage_minutes` and
`bin_items`. `identifiers()` now only adds what other areas know (account,
place names, FOOTAGE_ROOT); `diagnostics()` / `heartbeat()` stay as test
hooks (null: ops builds them).

Tests: `cargo test` (114 ops unit tests): ports of notifyUnchanged,
powerPrice, savings, savingsByMonth, snapshots, imageUpdates, hostInfo,
healthGpu, reportsScrub, reportsProtocol, reportsClient, statsHistory, gpu,
nodePower, statsPower, statsSockets (cpuinfo, RAPL per socket),
statsTraffic, statsAlerts, statsShares, statsGpu (parsers, fdinfo,
nvidia-smi backoff), statsLifecycle and stats.test.js (the reaped ffmpeg,
garbage in every file, this machine, the hung sensor), and the hooks above.
The engine is replayed against Node: `node lean/parity/opsStats.js` runs the
Node engine on the fake machines of test/fixtures/stats/machines.js (Intel +
Arc, with and without pci.ids, a 25-sample alert run, AMD, NVIDIA through a
fake nvidia-smi, Raspberry Pi, a bare container, dual Xeon, a VM, WSL,
Unraid's bridge, a NAS that hangs, a share that comes back, RAPL from the
supervisor with a price and a job) and records each tree, phase by phase,
with Node's GET /api/stats body (`src/ops/stats/testdata/*.json.gz`, 116 KB);
`ops::stats::tests::the_same_answers_as_node_on_every_fake_machine` builds
the same trees on the same clock and compares every field of every sample:
all the same (15 scenarios, 101 recorded samples; `host.node` is null here). Also
`tests/reports_parity.rs` as before. Nothing goes anywhere but 127.0.0.1.

Same answers: `node lean/parity/opsCompare.js` records goldens of the ops
GET routes from the Node fixture and replays them against the lean server on
a copy of its data folder, and compares GET /api/stats and /api/health
field by field where the answer is the machine's and not the moment's
(the shape of every field; host, CPU, memory size, GPUs, power sources,
disks, shares, interfaces, sensor names, scopes, hints, alerts, price,
encoder; the checks' ids, labels and states): 13 of 17 the same, and the
stats fields differ only in `host.node`. The rest belongs to
other areas or to the machine: the encoder check and the `/api/system`
converter (converter area), `security.https` (core's TLS), the disk's free
space, which can change between the two runs (in notification titles and the
banner), and, in one run of two, the order the share's space alert and the
startup check's notification were made in (the share status comes from
footage/shares).

Not done yet:

- the encoder block itself (encoderStats.js, converter area, through
  `OpsCtx::encoder_block`) and heartbeatHardware/convertStats (converter);
- core wires the hooks above (the supervisor link's `rapl-reading` and the
  `rapl` request, the 500 path, a panic hook) and implements the new
  `OpsCtx` calls; the converter calls `job_snapshot` and the meter;
- the live-update hub (`announce`), the audit log, log search and sign-in
  are core's; on the stand-alone server they print to stderr, and the 🔑
  routes always ask for the password (no accounts yet);
- the share status (warning, read-only) comes from footage/shares;
  ops/lean.rs works out a local folder's.

Proposed differences (need the owner's OK): `host.node` in /api/stats is
null (there is no Node: Node puts process.version there); a share check's
answer that lands during the same sample shows from the next one, as in
Node, but a background read's answer now always waits for the sample to end
(Node's promises do the same; noted because Rust's threads could be faster).

## Viewer

Done (`src/viewer/`, handlers on the small `viewer::ctx::Ctx` trait;
`viewer/glue.rs` implements it on today's `App`):

- `/api/telemetry` (cache `DATA/telemetry/<sha1 "t2|path|size|mtime">.json`,
  ETag, 304, gzip, `telemetryReads` at once; the reader is `src/telemetry.rs`),
  `/api/scrub` (scrubFrames.js + scrubKeyframes.js: keyframes only for a clip
  with one every 1.1 s, else every frame; ffmpeg at nice 10, 60 s timeout;
  cache `DATA/scrub`, 6,000 kept, next clip prepared, scrubPrepare.js after
  every scan, `SCRUB_PREPARE_DAYS`);
- the speed index (speedIndex.js) in Node's own day files
  `DATA/speeds/<vid>/<day>.json`: passes newest day first, a queue per day,
  straight/short read modes measured, the full read as fallback, folder
  moves kept, older summaries upgraded in place, summaries, moments, near()
  with the Float32 packed cache, warm(), clipStats, clipsRead, progress,
  clip(); `/api/vehicles/:id/speeds`, `/moments`, `/driving`,
  `/api/speeds/status`, `POST /api/speeds/index`, `POST /api/telemetry/speeds`;
- backgroundPace.js (lag from a 20 ms sleeper thread instead of the event
  loop; `/api/media` holds the Viewer slot while it answers) and
  workLimits.js with `GET/PUT /api/settings/work-limits`;
- places.js and the places routes (`/api/places` CRUD, `/near`,
  `/suggestions`), event spots, `/api/vehicles/:id/event-map`, the place
  tags on recordings (recordingPlace.js, cameras' GPS and event.json);
- drives.js and driveData.js (streaming tokenizer, reduce, grouping, Park
  splits, Autopilot shares, tags, cache `DATA/drive-data/<vid>.json`),
  `/api/vehicles/:id/drives`;
- archiveGap.js analyze for cut-off drives, partial minutes, late clips and a
  quiet share, its `archive-gap:<vid>` state and notification keys,
  `/api/vehicles/:id/archive-gaps`;
- Studio: `/api/studio/context`, `settings` (GET/POST), `readDir`,
  `readFile`, `exists`, `stat`, `thumbnail` (clipThumbnails.js filmstrips,
  `DATA/clip-thumbnails`), `browse`, through a port of safePath.js
  createRealGuard (deny list included).

Checked: 52 viewer unit tests (ports of test/backgroundPace, workLimits,
speedIndex, telemetrySpeeds, scrubKeyframes, scrubFrames, driveData, drives,
places, recordingPlace, archiveGap). Against goldens recorded from
`tools/contract/fixture.js`: every viewer route answers the same except
`/api/speeds/status` `readMode` (which read mode measured faster on that
run). `lean/parity/compare.js` now also covers the viewer routes and a saved
place: 217 requests the same. The caches the two servers write
(speeds, telemetry, scrub grids) are byte for byte the same, and each reads
the other's.

Not done yet:

- CAN Bridge evidence everywhere it is used: recording place tags and drive
  ends from CAN GPS, `can` on drives, archive gaps' CAN driving/Sentry and
  time zone shifts (needs the CAN index);
- Sentry USB in archive gaps (status file, snapshots, car-files.tsv: carFilesPass,
  `carFiles` in the answer and the day cards' `archive`/`carFiles`);
- archive-gap notifications are only raised once `Ctx::raise_note` is
  implemented (ops); `forDays` for the day cards is not wired;
- arrival times: the lean scan keeps no birth time, so archive gaps use the
  change time (Node prefers the birth time);
- time zones other than UTC and the server's own `TZ` (driving's "this
  week", archive gaps' wall clock) need a zone table (core);
- `POST /api/studio/trashFolder` (Recycle Bin, footage area);
- admin-only routes call `Ctx::refuse_admin`, which core implements; the
  audit line names "local" until accounts exist; `announce` has no hub yet;
- the coordinator keeps one speed index: `app.rs` skips its SQLite index
  while the viewer runs, and the old `/api/speeds*` code in `api.rs` is
  shadowed by the viewer's routes.

## Footage

### Arrival checksums (`src/arrival/`, library only; mounting: `src/arrival/README.md`)

Done:

- `record.rs` (server/originalChecksums.js): `locate`, `line_for`,
  `parse_record`, `Recorder::record` (the share root's
  `.sentrymanager/original-checksums.sha256`, O_APPEND + fsync, folder fsync
  when new, a torn last line started anew, one writer per record file, only
  inside a vehicle's folder), the day marks sidecar
  `original-checksums.marks.json` and the 45-day pruning (temp, fsync,
  rename), the converter's before-replace hook (`before_replace_fn` for
  `RuntimeOptions.before_replace_original`; an Err keeps the original, with
  Node's log line).
- `engine.rs` + `index.rs` (server/arrivalChecksums.js): only shares with
  `.sentryusb/`, the same candidates (Tesla clip names in the four groups,
  no dot paths, no converter artifacts), the same order (fresh arrivals of
  48 h, then by clip time, then the backlog newest first), held / busy /
  settling / unchanged / encoded skips, the codec the inventory knows, the
  rate limit and idle pauses, the identity check after hashing, per-cycle
  cap and the next pass 30 s on, a kick ending a backlog pass, `converted()`
  for our own output, prune of gone clips, the index snapshot + journal
  (same files byte for byte: JS number and key order, v1 read, torn line,
  compaction thresholds), `view` (field for field, time zones via chrono-tz),
  `stats`, `forget`, `start` / `stop`.
- `holds.rs` (sentryUsb.js interpret / inRange / holds) on the status
  file's transfer fields, parsed as parseStatus does.
- `routes.rs`: the `record` field of GET `/api/vehicles/:id/sentry-usb`,
  POST `/api/vehicles/:id/sentry-usb/record` (400 text, setting, kick, audit
  line), the vehicle removal.

Tests: test/arrivalChecksums.test.js (all 17) and the record tests of
test/sentryUsb.test.js ported (`cargo test --lib arrival`), the transfer
range test, the before-replace hook (line written; error line and Err when
it cannot be). Parity (`cargo test --test arrival_parity`, needs node;
`lean/parity/arrival.js`): Node's module and the Rust one in turn on the
same generated archive (TeslaCam root, all four groups, backlog of 3 days to
3 years, H.265 / AV1 / H.264 MP4s, converter artifacts, dot folders, a held
clip, a converted clip, a vehicle id needing `_`), two passes (a clip gone,
a re-upload, a new clip): the record, marks and index files byte for byte
and the view and bytes read equal; then 60 days of record calls with
pruning, files byte for byte.

Left:

- wiring (README.md there): `ArrivalCtx` on core's state, the converter
  hook and onClipConverted, the scan kick, the three routes; the inventory
  must carry each file's birth time (`scanner::FileEntry` has none yet:
  until then 0, so ctime counts as the arrival, as on a filesystem without
  birth times);
- the Sentry USB status reader itself (can/ area) feeds `holds`;
- the rest of the footage area (vehicles, inventory, catalog, Recycle Bin,
  cleanup, protect, stars, integrity) is not started.

## Known differences

None accepted yet. Proposed (needs the owner's OK): `/api/speeds/status`
`readMode` follows this server's own timing, as Node's does; `/api/stats`
`host.node` is null (no Node runs; Node puts process.version there).

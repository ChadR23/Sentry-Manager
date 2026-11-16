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
| converter | file safety, telemetry, job store, job service, runtime and the 22 channels ported and tested (library, not mounted); lanes, auto, benchmark, helper servers still to do (see below) |
| ops | ported; the encoder block and the wiring are the converter's and core's, see below |
| viewer | ported except where it needs CAN, Sentry USB status, notifications or accounts; see below |
| footage: arrival checksums | ported and tested with parity (`src/arrival/`, library, not mounted); see "Footage" below |
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

### Mounting (for the integrator)

```rust
let conv = converter::runtime::Converter::open(converter::runtime::RuntimeOptions {
    data_path, temp_path, ffmpeg, ffprobe,
    before_replace_original: Some(/* Sentry USB checksum hook */),
    tools: None, tune: None, hooks: None,
})?;
conv.start()?;                       // recovers unfinished jobs
let bridge = converter::ipc::Bridge::new(
    Arc::new(conv.service.clone()), ctx /* Arc<dyn ConverterCtx> */,
    converter::ipc::capabilities(&conv.staging.capabilities()));
// POST /api/converter/invoke/:name  -> bridge.invoke(name, body (None if empty), client)  (blocking: spawn_blocking)
// GET  /api/converter/events?client= -> bridge.attach_events(client, sink); bridge.detach(client) on close
// on exit: conv.shutdown()
```
`ConverterCtx` (ctx.rs): data/temp paths, tool paths, the footage guard,
the Sentry USB hook, clip_converted (previews), log lines. `Service` also
answers `active_encodes()`, `slots_of(id)`, `live_jobs()` for stats/ops.

Not done yet, in order:

1. Lanes per GPU (`setLanes`, `devices`, resolveLanes, the device list):
   a job's lanes are kept and it runs with their total at once on the
   planner's encoder, as Node does when none of its GPUs is found; GPU
   decode tiers (zero-copy, GPU, CPU) are not used (CPU decode).
2. convertedIndex.js and mp4Header.js (discovery skips converted clips
   without opening them): today every clip is probed in a worker; the
   result is the same ('already-converted'), it is slower on big archives.
   pictureCheck.js (only for helper servers).
3. autoConvert.js (the auto channels answer AUTO_UNAVAILABLE), benchmark.js
   (runBenchmark answers BENCHMARK_UNAVAILABLE before checking its
   payload), encodeDevices.js, encoderStats.js (`OpsCtx::encoder_block`),
   convertStats.js (`OpsCtx::heartbeat_hardware`), holdDiscovered (Sentry
   USB copies in progress: `Options::skip_discovered` is there for it).
   server/gpu.js and stats/gpu.js are ported in ops (`ops::gpu`,
   `ops::stats::gpu`) for the converter to call.
4. Helper servers: server/nodes.js, nodeWorker.js, `/node/v1/*`, pinning,
   tokens, remote encodes.
5. The crash points inside a file copy (temp-created, temp-torn,
   temp-complete, temp-readback, writer, staging-copy) need an fs hook in
   staging; round 1's journal crash test covers those records, not a kill.
   The 'lowered' point (several at once, then one) is not run.
6. sweepEmptySnapshotFolders (empty verification folders removed while
   idle) and the converter lifecycle's start retries (converterHost).

Proposed differences (need the owner's OK): a nested box literally named
`root` is serialized as a box (Node's writer would treat it as the tree
root); io error texts are Rust's where Node logs its own; Resume of a job
parked mid-replacement answers once that clip is settled (Node's answer
waits for the whole relaunched job); a job file holding a lone UTF-16
surrogate (never written from file names) is read as corrupt.

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

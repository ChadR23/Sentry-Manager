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
| converter | the file-safety and telemetry core ported and tested; job store, job service, IPC and runtime still to do (see below) |
| ops | ported; the encoder block and the wiring are the converter's and core's, see below |
| viewer | ported except where it needs CAN, Sentry USB status, notifications or accounts; see below |
| everything else | not started |

## Converter

Done (`src/converter/`, library only: nothing is wired into `api.rs` yet,
so no route answers and nothing can touch footage from the lean server):

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

Not done yet, in order:

1. jobStore.js (manifest files, journal, validation, transitions) and the
   manifest folding of transaction snapshots; reading jobs Node wrote.
2. jobService.js (the pipeline: discover, stage, encode with progress
   parsing, telemetry, verify, size retry, save slot, recovery loop,
   pause/cancel, lanes), runtime.js composition (volume info, device list,
   lifecycle), scanner.js, convertedIndex.js, mp4Header.js, pictureCheck.js.
3. ipc.js (22 channels) behind `POST /api/converter/invoke/:name` and the
   `/api/converter/events` SSE (converterBridge.js: verify never Off, the
   path guard), converterHost.js.
4. autoConvert.js, benchmark.js, encodeDevices.js, encoderStats.js
   (`OpsCtx::encoder_block`), convertStats.js (`OpsCtx::heartbeat_hardware`).
   server/gpu.js and stats/gpu.js are ported in ops (`ops::gpu`,
   `ops::stats::gpu`) for the converter to call.
5. Helper servers: server/nodes.js, nodeWorker.js, `/node/v1/*`, pinning,
   tokens.
6. The Node crash suites (test/converterCrash*, replaceCrash, crashPoints)
   need the job service; port them with it.

Proposed differences (need the owner's OK): a nested box literally named
`root` is serialized as a box (Node's writer would treat it as the tree
root); io error texts are Rust's where Node logs its own.

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

## Known differences

None accepted yet. Proposed (needs the owner's OK): `/api/speeds/status`
`readMode` follows this server's own timing, as Node's does; `/api/stats`
`host.node` is null (no Node runs; Node puts process.version there).

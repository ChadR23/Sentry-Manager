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
4. autoConvert.js, benchmark.js, encodeDevices.js, server/gpu.js,
   stats/gpu.js, encoderStats.js, convertStats.js.
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

## Known differences

None accepted yet.

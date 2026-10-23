# Next update: how the parts fit together

Built on branch `release/next-update`. Read `docs/plans/server-monitor.md`
(the owner-approved plan) and `CLAUDE.md` first. The visual spec is the
approved mockup: `docs/plans/server-monitor-overview.png`,
`docs/plans/server-monitor-encoder.png` and its markup/CSS in
`docs/plans/server-monitor-mock.js`.

Rules for every part: Node 24 built-ins only (no npm packages), nothing
outside the container, no network calls, every number from the machine
itself. Code style: match the surrounding files (CommonJS on the server,
2-space indent, short comments that say why). Tests with `node:test` in
`test/`, runnable without root, without a GPU and without the internet, using
fake `/proc` and `/sys` trees under `test/fixtures/` where needed.

## 1. Stats engine: `server/stats/` (new folder)

`createStats(options)` in `server/stats/index.js` returns an object:

- `snapshot()` -> the `GET /api/stats` body below (synchronous, from the last
  sample; never blocks on I/O).
- `touch()` -> a page is watching; keep sampling for 15 s after the last
  touch. Sampling also runs while `options.isBusy()` returns true (a
  conversion runs). Otherwise no timers run at all.
- `history(range)` -> `{ step, series: { cpu, memory, gpuBusy, gpuVideo,
  powerW, rxBps, txBps, tempMax } }` for `range` in `'15m' | '24h'`: 2 s
  samples for 15 min, 1 min averages for 24 h (kept in memory and saved to
  `<dataDir>/stats-history.json` every 5 min and on stop, loaded on start).
- `csv(range)` -> text/csv of the same series with an ISO time column.
- `energy()` -> `{ todayWh, weekWh, byJob: { [jobId]: { wh, avgW, seconds } } }`
  (integrated from power samples; days in the server time zone; saved with
  the history).
- `markJob(jobId | null)` -> energy from now on is also counted for that job.
- `setRapl(reading)` -> the supervisor's latest `{ at, packages: [{ name, energyUj, maxEnergyUj }] }`.
- `stop()`.

Options: `{ procRoot = '/proc', sysRoot = '/sys', devRoot = '/dev', dataDir,
appPid = process.pid, now = Date.now, intervalMs = 2000, isBusy = () => false,
spawn = child_process.spawn, readShares = () => [], activeEncodes = () => [],
log }`. `readShares()` returns `[{ label, path }]` of the footage shares and the
data folder so their space can be shown (statfs) and their answer time
measured (a timed `stat` of the path, at most every 10 s).

Providers (each its own file, each `probe()` once to learn what exists,
then `sample()`; a provider that finds nothing returns nothing, never throws):

- `cpu.js`: `/proc/stat` (total and per core %), `/proc/cpuinfo` (model;
  ARM: `Hardware`/`Model`/`/sys/firmware/devicetree/base/model`), cores vs
  threads, `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq`,
  `/proc/loadavg`; this app's % from `/proc/<appPid>/stat` plus every
  descendant (`/proc/*/stat` ppid chain), ffmpeg's share and count.
- `memory.js`: `/proc/meminfo` (total, available, cached, swap); app memory
  = RSS of the app and its descendants (`/proc/<pid>/status` VmRSS).
- `disks.js`: `/proc/diskstats` read/write bytes per second for whole disks
  (skip loop, ram, dm partitions unless whole), model from
  `/sys/block/<d>/device/model`, temp from hwmon `drivetemp` / `nvme`.
- `network.js`: `/proc/net/dev` in the container; with `pid: host`
  (`/proc/1/net/dev` readable and different) the host's. Skip `lo`;
  link speed from `/sys/class/net/<if>/speed`.
- `sensors.js`: every `/sys/class/hwmon/hwmon*/temp*_input` (label from
  `temp*_label` or the chip `name`), `fan*_input`, plus
  `/sys/class/thermal/thermal_zone*/temp` when no hwmon CPU sensor. CPU temp
  = coretemp `Package id 0` / k10temp `Tctl`/`Tdie` / cpu-thermal zone.
- `gpu.js` (stats, not the existing `server/gpu.js`, which it may reuse):
  - AMD (`amdgpu` driver): `gpu_busy_percent`, `mem_info_vram_used/total`,
    hwmon `power1_average` (µW) or `power1_input`, `temp1_input`,
    `pp_dpm_sclk` current clock.
  - Intel (`i915`, `xe`): `gt_act_freq_mhz` / `gt/gt0/rps_act_freq_mhz` /
    `device/tile0/gt0/freq0/act_freq`; hwmon `energy1_input` (discrete Arc)
    -> W.
  - Intel and AMD per process: DRM fdinfo of the app's descendant
    processes (`/proc/<pid>/fdinfo/<fd>` with `drm-driver`, `drm-pdev`,
    `drm-engine-<name>: <ns>`, `drm-client-id`), busy % per engine class =
    delta ns / delta wall ns, summed per client id, mapped to the GPU by
    `drm-pdev`; "video" = engines named `video`, `video-enhance`, `vcs*`,
    `enc`, `dec`, `vcn*`.
  - NVIDIA: one long-running `nvidia-smi --query-gpu=index,name,driver_version,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr --format=csv,noheader,nounits -lms 2000`
    started only while sampling, restarted with backoff, killed on stop;
    fields it cannot report come back as `[N/A]` -> null.
  - Raspberry Pi / other: name from `/sys/class/drm/card*/device/uevent`
    `DRIVER=`; temps only.
- `power.js`: RAPL from `setRapl()` (supervisor) or, when readable directly
  (`/sys/class/powercap/intel-rapl:*/energy_uj`), read here; W from energy
  deltas with wrap-around (`max_energy_range_uj`). GPU W from the GPU provider.
- `alerts.js`: rules with hysteresis (raise above, clear 5 °C / 2 % below,
  must hold 30 s): CPU temp >= 90 °C or throttling (`/sys/devices/system/cpu/cpu*/thermal_throttle/*_count` rising),
  GPU temp >= 90 °C, disk temp >= 70 °C (NVMe) / 55 °C (HDD), filesystem >=
  90 % full, share answer time > 2 s or unreachable, memory available < 5 %.
  Raised alerts are returned in the snapshot and passed to
  `options.onAlert({ key, level, message })` once per raise (the server
  turns them into Notifications and log lines).

### `GET /api/stats` body (all fields may be null when unknown)

```js
{
  at, intervalMs,
  host: { hostname, os, kernel, arch, uptimeS, appUptimeS, version, node, ffmpeg },
  cpu: { model, cores, threads, usage, perCore: [n], freqMHz, tempC, load: [1, 5, 15],
         app: { usage, ffmpegUsage, ffmpegCount }, throttling: bool },
  memory: { totalB, usedB, availableB, cacheB, swapTotalB, swapUsedB, appB },
  gpus: [{ id, name, vendor: 'intel'|'amd'|'nvidia'|'other', driver, node, busy, video,
           vramUsedB, vramTotalB, clockMHz, tempC, powerW, clients }],
  power: { totalW, cpuW, gpuW, todayWh, weekWh, cpuSource: 'rapl'|null, gpuSource: 'hwmon'|'nvidia-smi'|null },
  disks: [{ name, model, readBps, writeBps, tempC, kind: 'nvme'|'ssd'|'hdd'|'other' }],
  filesystems: [{ label, path, totalB, usedB, latencyMs, reachable }],
  network: { scope: 'container'|'host', interfaces: [{ name, speedMbps, rxBps, txBps }] },
  sensors: [{ chip, label, kind: 'temp'|'fan', value }],
  processes: { scope: 'container'|'host', top: [{ pid, name, cpu, memB, gpuVideo }] },
  alerts: [{ key, level: 'warn'|'error', message }],
  unlock: [{ key: 'cpu-power'|'host-view', adds, compose }],
  sparks: { cpu: [n], gpuVideo: [n], rxBps: [n] }   // last 15 min, for the tiles
}
```

## 2. Converter: `src/main/converter/` (existing)

a) **Instant skip of converted clips.**
- A converted-clips index: `createConvertedIndex({ file, fs })` in
  `src/main/converter/convertedIndex.js`, a JSON-lines or JSON file in the
  converter's data folder, keyed by the clip's path and checked against
  size + mtimeMs (+ ino when available). `has(item)` -> codec or null,
  `add(item, codec)`, `flush()` (batched, atomic write via temp + rename).
  Written when a clip finishes converting (its new size/mtime) and when a
  probe finds H.265/AV1. Bounded (drop entries whose file was not seen for 30 days
  on save is fine; keep it simple and safe).
- Discovery marks a clip whose index entry matches as `skipped` /
  `already-converted` right away, without opening the file.
- Clips not in the index get a fast header check during discovery, with its
  own concurrency (8), separate from the encode slots: read the MP4 `moov`
  (it may be at the start or the end; read the box headers, then only
  `moov`, capped at 4 MB) and the first video `stsd` sample entry fourcc:
  `avc1`/`avc3` -> keep, `hvc1`/`hev1`/`av01` -> skip as already-converted
  (and add to the index), anything else or unreadable -> leave it for the
  normal path (ffprobe in the worker, as today). Network errors follow the
  existing retry/backoff rules.
- `waiting` and time remaining count only clips that will be encoded.
- Existing behaviour, tests and job-file compatibility stay intact.

b) **Live per-clip numbers.** `service.activeEncodes()` returns, for every
running ffmpeg: `{ jobId, itemId, relativePath, encoder (e.g. 'hevc_vaapi'),
hardware: bool, decode: 'gpu'|'cpu', device (render node or null), pid,
fps, speed (x realtime), bitrateKbps, frame, outTimeUs, durationUs, dropFrames,
dupFrames }`, from the `-progress` lines `runChild` already parses (add
`speed`, `bitrate`, `frame`, `drop_frames`, `dup_frames`, `total_size`) and the
item's probed duration. Also expose it through `runtime.activeEncodes()`.

c) **Benchmark energy hook.** `runConverterBenchmark` accepts an optional
`powerMeter` `{ start() -> token, stop(token) -> { wh, avgW } | null }` and
puts `wh`, `avgW` and `filesPerWh` on each level result; `best` stays the
fastest, and a new `efficient` is the level with the most files per Wh
(only when every ok level has energy). Runtime passes `options.powerMeter`
through.

## 3. Screens

a) **Overview "Server" section** (`web/app.js`, `web/shell.css`): as in the
mockup, under the existing Overview cards, behind a "Nerd stats" switch
(remembered per browser in localStorage, default on). Polls
`GET /api/stats` every 2 s while the Overview is shown and the tab is
visible (stop on navigation and `visibilitychange`); renders only tiles with
data; sparklines from `sparks`; per-core strip; alert banner; footer from
`unlock`. A "History" toggle on the CPU/GPU/Network tiles switches the
sparkline to `GET /api/stats/history?range=24h`; a "CSV" link downloads
`/api/stats/export.csv?range=24h`. Values formatted like the mockup (°C, W,
GB, MB/s, kWh, ≈ cost when a price is set).

b) **Encoder "Hardware" panel** (`src/renderer/encoder.html`, a new
`src/renderer/scripts/features/hardwarePanel.js`, `src/renderer/styles/encoderPage.css`):
inside Live run, under the heading, shown while a conversion runs (and a
compact idle line otherwise: encoder + device). Polls `GET /api/stats`
(same origin, cookies) every 2 s while visible; uses `encoder` below.
Chips (encoder · GPU · device, decode, N at once), tiles (video engine %,
CPU used by conversions, W, temps), bottleneck hint, efficiency row (kWh this
run, clips per kWh, GB saved per kWh, ≈ cost), one row per running clip
(name, progress bar, fps, speed, bitrate, dropped/duplicated frames).

`GET /api/stats` also carries, while a job exists:

```js
encoder: {
  jobId, running: bool, workers: [ /* service.activeEncodes() entries */ ],
  device: { encoder, hardware, gpuName, node, decode },
  run: { wh, avgW, clips, savedB, startedAt },
  bottleneck: { kind: 'gpu-video'|'cpu'|'source-read'|'destination-write'|'none', message }
}
```

c) **Settings > System**: "Electricity price", either one price or a
time-of-use plan (owner's request: multi-rate plans). Stored with
`PUT /api/settings/power`:
`{ currency, mode: 'flat'|'tou', pricePerKwh, defaultPrice, rates: [{ label, price, days: [0..6], from: 'HH:MM', to: 'HH:MM' }] }`
(up to 12 rates; a window may wrap midnight; the first matching rate wins,
else `defaultPrice`; days 0 = Sunday, server time zone). Costs are summed
per sample at the price of that moment by the stats engine
(`options.priceAt(ms)`), so a run across peak and off-peak hours costs what
it really cost: `power.todayCost`, `power.weekCost`, `power.priceNow`,
`encoder.run.cost`, jobs' `energy.cost`. Screens show cost only from these
fields (never kWh x one price). **Jobs page**: kWh and average W on finished
conversion jobs when known. **Benchmark dialog**: a W / files-per-kWh column
and "Most efficient" next to "Fastest" when energy is known.

## 4. Server wiring (done last, by the integrator)

`server/index.js`: `createStats`, `GET /api/stats` (calls `touch()`),
`GET /api/stats/history`, `GET /api/stats/export.csv`, `PUT /api/settings/power`,
alerts -> Notifications + log, `markJob` on converter job start/finish, energy
on jobs. `server/supervisor.js`: reads RAPL every 2 s while the app asks
(`{ type: 'rapl', on: bool }`) and sends `{ type: 'rapl-reading', ... }`;
only fixed paths under `/sys/class/powercap`, read-only. README +
docker-compose.yml comments for the optional lines (RAPL read-only bind,
`pid: host`).

## 5. Automatic conversion at off-peak (owner's request, integrator)

Automatic conversion's time window gains a choice: fixed hours (today) or
"Off-peak, from your electricity plan": the window is open while the
cheapest rate of the time-of-use plan is in force
(`server/powerPrice.js isCheapest()`, passed down to `autoConvert.js` as
`isCheapNow(ms) -> true|false|null`; null = no plan = any time). Stored as
`window: { follow: 'off-peak' }`. Pauses and resumes exactly like the fixed
window does. Settings UI in the automatic conversion section of the Encoder.

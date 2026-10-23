# Multi-GPU and multi-CPU servers: contract

Three changes for servers with more than one GPU or CPU socket. The owner asked for
all three; "spread" is **set by hand per GPU** (one GPU may handle more than another),
not split automatically.

1. Choose which GPU(s) encode, in the Encoder page (no compose remap needed).
2. How many conversions at once **per GPU** (plus an optional CPU row), live-changeable
   during a run like today's single number.
3. Server page: "2 × <CPU model>" and use / temperature / power per socket.
4. Benchmark: every GPU is tested, and each gets its own results. The verification
   comparison drops Off (Quick and Full only).

Hard rule: **a server with one GPU (or none) behaves and looks exactly as today.** No
`lanes` in its jobs, the single "Parallel conversions" select, the same ffmpeg
arguments. Everything below only switches on with two or more GPUs.

Standing rules (CLAUDE.md) apply: one container, no new services, Node built-ins only,
no model names in code or commits, `npm test` passes.

---

## 1. Encoding devices (`src/main/converter/encodeDevices.js`, new)

```js
createDeviceDiscovery({ fs, pathApi, platform, devRoot = '/dev', sysRoot = '/sys',
  runCommand, statRdev, nameOf, nvidiaDeadlineMs = 12_000 }) -> { list(): Promise<Device[]> }
```

```js
Device = {
  id: 'pci:0000:03:00.0' | 'cpu',      // stable across reboots and node renumbering
  kind: 'dri' | 'nvidia' | 'cpu',
  vendor: 'intel' | 'amd' | 'nvidia' | null,
  name: 'Intel Arc A380' | 'CPU (software encoder)',
  node: '/dev/dri/renderD129' | null,  // dri only: the path INSIDE the container
  index: 0 | null,                     // nvidia only: nvidia-smi / CUDA index
  pci: '0000:03:00.0' | null
}
```

- **DRI (Intel/AMD):** every `/dev/dri/renderD*` that exists in the container. Find
  its PCI device through its char device number, not its name, because the compose
  remap trick (`/dev/dri/renderD129:/dev/dri/renderD128`) renames nodes:
  `statRdev(node)` -> `{ major, minor }` -> realpath
  `${sysRoot}/dev/char/${major}:${minor}/device` -> PCI slot = basename, matching
  `/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i`. If `statRdev` is missing or
  fails, fall back to `${sysRoot}/class/drm/<basename>/device`. Vendor comes from
  `device/vendor` (0x8086 intel, 0x1002 amd), driver from the `device/driver` link.
  Skip driver `nvidia` (NVENC covers it), non-PCI devices (Pi V3D and other SoCs) and
  any vendor that is not intel/amd. Default `statRdev` uses `fs.statSync(p).rdev`
  with major = `(rdev >> 8) & 0xfff` and minor = `(rdev & 0xff) | ((rdev >> 12) & 0xfff00)`.
- **NVIDIA:** `nvidia-smi --query-gpu=index,pci.bus_id,name --format=csv,noheader`
  (10 s timeout; a missing binary or a non-zero exit means no NVIDIA devices).
  `00000000:01:00.0` normalises to `0000:01:00.0` (lower case, last 12 chars).
  The runner answers only once nvidia-smi has exited, which one stuck in a wedged
  driver never does: the list never waits past `nvidiaDeadlineMs` (12 s) and then
  has no NVIDIA devices, and no other nvidia-smi starts until the stuck one exits.
- **CPU:** always last: `{ id: 'cpu', kind: 'cpu', name: 'CPU (software encoder)' }`.
- Order: DRI by node name, then NVIDIA by index, then CPU. On a platform other than
  linux the list is just `[cpu]`.
- `nameOf({ pci, vendor, vendorId, deviceId, driver, sysDevice })` gives the display
  name. The server injects one built from the stats engine's naming. To make that
  possible, `server/stats/gpu.js` exports a standalone `gpuDisplayName(...)` (product
  name for amdgpu, pci.ids, the KNOWN table, then "Intel graphics" / "AMD graphics"),
  and `GpuProvider.nameOf` uses it too. NVIDIA names come from nvidia-smi. The default
  without `nameOf` is `Intel GPU (0000:03:00.0)`.
- A device id from the client is **only** looked up in this list; node paths and
  indexes never come from the client.

## 2. Per-device encoder choice (`encoderPlanner.js`)

`planner.selectFor(family, device)` -> frozen
`{ family, codec, hardware, device: { id, kind, node, index } }`.

- `kind 'cpu'` -> `selectCpuFallback(family)`, with `device: { id: 'cpu', kind: 'cpu' }`.
- Candidates per device on linux: intel DRI `[*_qsv, *_vaapi]`, amd DRI `[*_vaapi]`,
  nvidia `[*_nvenc]`. Each candidate is proven with a real probe encode **using that
  device's arguments**. Proofs are cached per `${family}:${codec}:${device.id}`, and
  as today a timeout is not cached.
- No hardware candidate works on that device -> it returns the CPU encoder
  (`hardware: false`) and logs one warning per device and family:
  `[CONVERTER] <name> cannot encode <H.265|AV1>; its conversions use the CPU encoder.`
- A candidate whose probe only timed out proves nothing: that call returns the CPU
  encoder with `timedOut: true`, caches nothing and logs no warning; the next call
  probes again.
- `selectFor(family, device, { probe: false })` only gives a choice made already
  (null otherwise), and `select(family, { probe: false })` likewise. They are for
  the device list while something converts: a probe a busy GPU fails (NVENC
  sessions used up) would otherwise rule it out until a restart.
- `planner.select(family)` (no device) stays exactly as it is today.

Device arguments. With a `device`, `buildEncodeArgs` and `decodeAccelArgs` take
`device` in place of the renderD128 default:

| encoder | encode args | decode (`gpu` tier) | zero-copy tier |
|---|---|---|---|
| `*_vaapi` | `-vaapi_device <node>` (today's shape) | `-hwaccel vaapi -hwaccel_device <node>` | – |
| `*_qsv` (linux) | `-init_hw_device qsv=qsvenc:hw_any,child_device=<node>` placed before `-c:v` | `-hwaccel vaapi -hwaccel_device <node>` | – |
| `*_nvenc` | `-gpu <index>` after `-c:v` | `-hwaccel cuda -hwaccel_device <index>` | `-hwaccel cuda -hwaccel_output_format cuda -hwaccel_device <index>` |

Without a device, all three produce exactly today's arguments (tests pin this).

The CUDA index must match nvidia-smi's order: the runtime spawns every process whose
arguments name an NVIDIA GPU by index (`-gpu N`, `-hwaccel_device N`) with
`CUDA_DEVICE_ORDER=PCI_BUS_ID`. Every other process keeps the server's environment
(CUDA's own "fastest first" order), so a job without lanes on a server with two
NVIDIA cards encodes on the card it always did. Nothing sets it for the whole
container.

## 3. Lanes in the job (`contracts.js`, `jobService.js`, `jobStore.js`)

`config.lanes` is optional: `[{ device: <id>, concurrency: <int 1..64> }]`.

- Ids match `DEVICE_ID = /^(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu)$/`.
  Ids are unique, there are 1–16 entries, and the sum is 1–64 (`CONCURRENCY.max`).
  Zero entries are removed before saving, and at least one entry must remain.
- When `lanes` is present, `config.concurrency` always equals the sum, so everything
  that reads `concurrency` keeps working.
- New helpers in contracts.js: `DEVICE_ID`, `LANES = { maxEntries: 16 }`,
  `normalizeLanes(value) -> lanes | null` (drops zeros, throws
  `INVALID_LANES`-coded error on a bad shape), `lanesTotal(lanes)`.
- Absent `lanes` -> today's behaviour exactly.
- A saved manifest whose `lanes` is malformed must still load: lanes are ignored and
  `concurrency` is used. Nothing may produce `INVALID_MANIFEST`.

jobService:

- A worker belongs to a lane: `work(runtime, lane)` where
  `lane = { id, device } | null` and null is the default (no-lanes) worker.
- Per-lane counters (`live`, `retiring`). The retire check compares against that lane's
  limit. With lanes, the limit is the lane's `concurrency`; a lane not in the config
  (or the null lane in a lanes job) has limit 0. Without lanes, the null lane's limit
  is `concurrencyOf(manifest)`.
- `consume()`: lanes are resolved through `deps.resolveDevice(id) -> Device | null`.
  - Each resolved lane gets `concurrency` workers.
  - An unresolved lane logs `[CONVERTER] Encoding device <id> is not in the container;
    its <n> conversions at once are not started.` and gets no workers.
  - If none resolve, the job runs as a no-lanes job with `config.concurrency` workers,
    so it never stalls.
- `setLanes(id, lanes)`: validate (`INVALID_LANES`), reject terminal jobs
  (`JOB_NOT_ACTIVE`), and save `{ lanes, concurrency: sum }`. Then start the missing
  workers per lane (resolving the devices). Workers on lanes that are now smaller or
  gone retire after their clip, as today. Calling it on a no-lanes job is allowed: the
  default workers retire and lane workers start.
- Switching between no lanes and lanes (setLanes on a job without lanes or on one
  whose lanes all fell back, or the reverse): the default lane's workers run on the
  device a job without lanes uses (`deps.defaultDevice(codec) -> id | null`, looked up
  once), so they count together with that device's lane. That GPU never runs more
  at once than it was set to: its lane's workers start as the old ones finish their
  clip (a worker that retires starts the missing ones). Another GPU's lane starts at
  once.
- `setConcurrency(id, n)` on a job **with** lanes (the page shows the single number
  when it lists fewer than two GPUs: one went away, or the list has not come yet):
  the job keeps its one GPU still found (`lanes: [{ device, concurrency: n }]`);
  otherwise (none found, or several) it drops its lanes and runs `n` without lanes.
  For an automatic job the saved settings follow what the job kept (`auto.setLanes`
  or `auto.setConcurrency`). On a no-lanes job it is unchanged.
- One device lookup serves all of a job's lanes: a lookup in progress is shared,
  and its answer is reused for 2 s after it arrives.
- processVideo uses `lane ? planner.selectFor(codec, lane.device) : planner.select(codec)`.
  The CPU fallback after a failed GPU encode, size retries and decode tiers work as
  today. The keys of `encodeDecodeBroken` and `verifyDecodeFallbacks` include the
  device id, so one GPU's broken decode does not disable another's. Verification
  decodes on the same device.
- `activeEncodes()` entries gain `deviceId` (lane id or null). `device` also understands
  `-gpu N` (-> `nvidia<N>`, which matches the stats engine's NVIDIA node) and
  `child_device=<node>`.
- The benchmark service jobs accept lanes too.

## 4. Runtime, IPC, auto, benchmark

- `runtime.devices()` -> `{ devices: [Device & { encoders: { h265?: codec|null, av1?: codec|null } | null }],
  defaultDevice: id|null, defaultDevices: { h265: id|null, av1: id|null } | null }`.
  - Fewer than two non-CPU devices: nothing is probed or logged (the page keeps its
    single number): every `encoders` is null, `defaultDevice` and `defaultDevices`
    are null.
  - `encoders` comes from `selectFor` per family. Probes are cached, so later calls are
    instant. A family the device can only do on the CPU fallback is `null`, except for
    the cpu device itself. A family not known yet (its probe timed out, or something
    is converting, when nothing is probed) is left out: not ruled out.
  - `defaultDevices[family]` is the device today's path uses for that codec:
    `planner.select(family)` -> qsv/vaapi/amf -> the DRI device whose node is
    `/dev/dri/renderD128`; CPU -> `'cpu'`; nvenc -> the one NVIDIA device that can
    encode the family (NVENC without `-gpu` takes the first that can in CUDA's own
    order, which the list cannot tell when several can: null then).
    `defaultDevice` is `defaultDevices.h265`.
  - Discovery runs again on each call (sysfs is cheap); a lookup in progress is shared.
- IPC (`ipc.js`, added to `CHANNELS` so the web bridge allows them):
  - `converter:devices` (no payload) -> the object above.
  - `converter:setLanes` `{ jobId, lanes }` -> sanitized snapshot. For an automatic job,
    the saved auto settings follow (`auto.setLanes`), as `setConcurrency` does today.
  - `converter:start` and `converter:setAuto` config accept optional `lanes`
    (validated with `normalizeLanes`, unknown device ids allowed, since a saved auto
    setting can outlive a GPU).
  - `converter:runBenchmark`'s payload is unchanged (no device field). With two or
    more GPUs it tests every GPU by itself (see Benchmark below).
  - `sanitizeSnapshot` passes `config.lanes` through.
- Start check: `converter:start` with lanes whose devices all resolve, but where a lane
  with concurrency > 0 has `encoders[codec] === null` (e.g. AV1 on a UHD 770), is
  rejected with `DEVICE_UNSUPPORTED` and `details: { device: <name>, codec }`. Auto
  jobs and resumed jobs never get this error; they take the CPU fallback per clip.
- autoConvert: `setLanes(lanes)` updates the saved config (lanes and concurrency).
  `start` passes lanes on.
- **Benchmark** (owner's request: every GPU is tested, each with its own results, and
  the verification comparison no longer includes Off):
  - Verification comparison: always `compareVerifyModes: ['quick', 'full']`, with one
  GPU too. Off is no longer timed. Off stays a normal setting for conversions.
  - Fewer than two non-CPU devices: exactly today's benchmark (`planner.select`, the
    result `{ codecs: [...] }`), apart from the comparison change above.
  - Two or more non-CPU devices:
    - Every GPU is benchmarked **by itself**, one after another, in device-list order,
      while the other GPUs stay idle, so each GPU's numbers are its own. For each GPU,
      the requested codecs run in turn.
    - A GPU's encoder is `selectFor(codec, gpu)`. If that returns the CPU encoder
      (the GPU can't encode the codec), that codec is reported as
      `{ codec, error: 'UNSUPPORTED' }` for the GPU and is **not** benchmarked on the
      CPU.
    - Each level runs as a service job with `lanes: [{ device: gpu.id, concurrency:
      level }]`.
    - The CPU device is not benchmarked. The same sample clips are used for every GPU.
    - Result: `{ devices: [{ device: { id, name }, codecs: [run, ...] }] }` with each
      `run` shaped exactly like today's entries of `codecs`
      (`{ codec, encoder, clips, results, best, efficient, verifyComparison, skipped }`,
      or `{ codec, error }`).
    - Progress events add `device: { id, name }`, `deviceIndex`, `deviceTotal`.
    - Cancelling stops the whole run, as today.
- Web shim (`web/electronApiShim.js`): `getConverterDevices()` -> invoke('devices');
  `setConverterLanes(jobId, lanes)` -> invoke('setLanes', { jobId, lanes }).
  `runConverterBenchmark` is unchanged.
- `server/encoderStats.js`: the encoder block gains
  `devices: [{ id, name, node, encoder, hardware, workers, video, busy }]`. For a job
  with lanes that is one entry per lane with running workers, grouped by `deviceId`,
  with the GPU matched by node as today. A job without lanes has one entry, however
  its clips decode (a clip decoded or redone on the CPU names no GPU). `device` (the
  first) stays. (The `bottleneck` / room-to-spare sentence planned here was
  removed later at the owner's request: it flipped between the two from one
  poll to the next. The block has no `bottleneck` field.)

## 5. Encoder page UI (`encoder.html`, `footageConverter.js`, `hardwarePanel.js`)

Lanes mode turns on when `getConverterDevices()` returns **two or more non-CPU
devices**. Otherwise nothing changes. The device call is asynchronous; the page renders
as today first and switches when the answer arrives.

- In the "Parallel conversions" fieldset, the single select (and its custom row) is
  hidden and `#converterLanes` is shown:

  ```html
  <div id="converterLanes" class="converter-lanes" hidden>
    <!-- one per device, built by JS -->
    <div class="converter-lane" data-device="pci:0000:03:00.0">
      <span class="converter-lane-name">Intel Arc A380<small>H.265: hevc_qsv · AV1: av1_qsv</small></span>
      <div class="converter-stepper" role="group" aria-label="Intel Arc A380: conversions at once">
        <button type="button" data-step="-1" aria-label="Fewer">−</button>
        <output>3</output>
        <button type="button" data-step="1" aria-label="More">+</button>
      </div>
    </div>
    <p id="converterLanesTotal" class="converter-disclosure">5 at once in total. Each GPU takes its next clip when it is free, so a faster one converts more of them.</p>
  </div>
  ```

  - Steppers go 0–64, and 0 shows "Off".
  - A device that cannot encode the selected codec (`encoders[codec] === null`) shows
    "Can't encode AV1", and its stepper is disabled at 0.
  - The CPU row is always present, defaults to 0, and has the hint "Uses the server's
    CPU cores; slower than a GPU".
  - Buttons are at least 40 px on phones, and nothing overflows at 360 px.
- The default GPU is per codec: `defaultDevices[codec]` (or `defaultDevice` from a
  server that sends only that).
- Defaults (first time): the selected codec's default GPU gets the stored concurrency
  (or 5); every other row gets 0. A default that can't encode the codec (or none)
  gives way to the first GPU that can. Until a row is set (or follows a job), a
  codec change moves the number to that codec's default. The rows are remembered in
  localStorage `converterLanes` (id -> count).
- Sent with start / auto settings: `lanes` (the non-zero rows) **only when** the set of
  rows above 0 is not exactly `{ default GPU of the selected codec }`. Otherwise send
  plain `concurrency` = that row's count. This keeps today's exact path for a
  multi-GPU owner who only ever uses the default GPU.
- Live during a run: the same chaining as `liveConcurrency`, through
  `setConverterLanes`. If the job has no lanes and only the default row changed, call
  `setConverterConcurrency`. Notice: `Now 3 on Intel Arc A380 and 1 on Intel UHD
  Graphics 770. Clips already converting finish first.` `syncConfig` updates the rows
  from `config.lanes` (or `concurrency` on the default row) unless a stepper has focus
  or a change is in flight.
- While a job is active the rows are for **its** codec, not the codec radios (which
  are for the next job), and a row the job converts on is never Off or disabled
  because the device list says it can't encode: nothing it runs is dropped from a
  live change.
- Start error `DEVICE_UNSUPPORTED` -> `{device} can't encode {codec}. Set it to Off or
  pick another codec.`
- Benchmark dialog:
  - **Verification comparison:** shows Quick and Full only, with one GPU too. The Off
    column is gone. The intro text says "(Quick, Full)", and in lanes mode "on each GPU
    in turn".
  - **One GPU:** a `{ codecs }` result renders exactly as today.
  - **A `{ devices }` result:**
    - The single tables, best line and two apply buttons are hidden.
    - `#converterBenchmarkDevices` (new, in the dialog) gets one
      `<section class="converter-benchmark-device">` per GPU. Each section has:
      - an `<h4>` with the GPU's name;
      - its own results table (same columns as today: At once | per codec Files/min,
        FPS, Saved, W, Files/kWh);
      - its own verification table (Quick | Full at that GPU's fastest setting);
      - its own best / efficient / skipped / unsupported lines, every line starting
        with the GPU's name;
      - its own "Use H.265 · 4 at once" / "Use AV1 · 3 at once" buttons. Applying
        one sets **that GPU's row** to the level and selects the codec. Other rows
        are unchanged.
    - Under the sections, when two or more GPUs have a best for a codec: a button
      `Use H.265 on every GPU (Arc A380: 4 · UHD 770: 2)`, likewise for AV1. It sets
      each GPU's row to its own best for that codec, sets CPU to 0, and selects the
      codec. Next to it, the note: `Each GPU was tested alone; together they share
      the CPU and drives, so the total can be a little lower.`
    - The tables scroll sideways inside their section on phones, as today's table
      does, and the page itself never does.
    - Progress line: `Intel Arc A380 (1 of 2) · H.265 (1 of 2): converting with 4 at
      once… (3 of 5)`.
- Hardware panel: with two or more `encoder.devices` entries that carry a lane id,
  one line per device: `Intel Arc A380 · hevc_qsv · 3 converting · video 72%`.
  Otherwise it is unchanged.

## 6. Server page per socket (`server/stats/*`, `web/app.js`)

`/api/stats` `cpu` gains:

- `sockets`: the number of physical packages (1 when unknown).
- `perSocket`: `[{ socket, cores, threads, usage, tempC, powerW }]` when `sockets > 1`,
  else `null`.
  - `socket` is the kernel's `physical id`.
  - `usage` comes from the per-CPU /proc/stat deltas of the CPUs in that socket.
  - `tempC` is the hottest reading on that socket: coretemp `Package id N`, or the
    k10temp chips in device-path order, one per socket. coretemp numbers its chips by
    the kernel's die number: they count only when there is one per socket (in the
    same order); with several dies per socket (Xeon 9200) the socket temperatures
    are null, and the Sensors tile keeps the dies' own numbers.
  - `powerW` is the RAPL `package-N` zone.

Fields that cannot be read are null. The rest of the snapshot is unchanged:

- `cpu.tempC` is the hottest across **all** CPU chips. Today only the first chip is
  read; this fixes a dual-Xeon reading one socket.
- `power.cpuW` is still the sum over all packages.

The CPU tile in `web/app.js`:

- The subtitle reads `2 × Intel Xeon Gold 6130 · 32 cores / 64 threads` when
  `sockets > 1`; the counts are totals.
- Under the per-core strip, one compact row per socket:
  `CPU 1  45%  61 °C  85 W` (numbered from 1; missing fields are left out). They wrap
  on phones.
- With one socket the tile is unchanged.

Fixtures: add `dualXeon` to `test/fixtures/stats/machines.js`. It has 2 × Xeon Gold 6130
(16 cores / 32 threads each), coretemp chips for package 0 and package 1, RAPL
`intel-rapl:0` and `intel-rapl:1`, an Intel Arc A380 and an NVIDIA T400. Also add
`test/fixtures/statsSample-dualxeon.json` (an `/api/stats` body) for the screenshot
and UI tests.

## 7. Docs and compose

- `docker-compose.yml`: replace the remap comment with: pass all of `/dev/dri`. With
  several GPUs, Encoder > Parallel conversions shows one row per GPU. The remap still
  works but is no longer needed.
- README: a short "Several GPUs or CPUs" section.

## 8. Tests (all builders)

Tests go in new files where possible, to keep merges simple:

- `test/encodeDevices.test.js`: the remap case, NVIDIA bus-id normalisation, skipping
  SoC and nvidia-driver DRI nodes, the non-linux list.
- `test/deviceArgs.test.js`: the table in section 2, plus unchanged arguments without
  a device.
- `test/lanes.test.js`:
  - normalizeLanes rules.
  - Workers per lane, live setLanes up and down, and setConcurrency on a lanes job (its
    one GPU kept, else no lanes).
  - Unresolved lanes fall back.
  - A malformed saved lanes value still loads.
  - Restart keeps lanes.
  - selectFor falls back to the CPU.
  - Broken-decode keys per device.
  - Benchmark: each GPU runs alone with its own lanes, in order. A codec a GPU can't
    encode is UNSUPPORTED and is not run on the CPU. Compare modes are only quick and
    full, and the one-GPU result shape is unchanged.
- `test/encoderLanesUi.test.js`: lanes mode only with ≥ 2 GPUs, default send rule,
  live chaining, the unsupported row. Benchmark: a section per GPU, per-GPU "Use"
  sets only that row, "every GPU" sets each row, and there is no Off column.
- `test/statsSockets.test.js`: dualXeon per-socket numbers, max temp across chips,
  the single-socket body unchanged.

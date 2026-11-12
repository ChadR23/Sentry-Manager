# Reports API (v1): feedback and diagnostics to the developers

[← Back to the README](../README.md)

Sentry Six Manager can send feedback and diagnostics to its developers.
**It is opt-in only**: nothing is sent unless an admin turns on *Share
diagnostics with the developers* (Settings → Help & feedback, or the same
box on the first-start page, unticked by default: `POST /api/auth/setup`
takes an optional `reports: { share, anonymous }`, both booleans) or presses
Send for one feedback message or one support report. Reports go only to the
developers' receiver, never to a third party. The receiver is the owner's
private service and is not part of this repository; this page is the wire
protocol the Manager speaks to it. What the user sees is in
[security.md](security.md#reports-to-the-developers-off-by-default).

| Piece | Where |
|---|---|
| The endpoint and the receiver's key | `server/reportsConfig.js` (the one place to change them) |
| The protocol (sealing, signing, proof of work, schema) | `server/reportsProtocol.js` (the receiver keeps its own copy; both change together) |
| The sender: outbox, retries, crash notes, daily summary, hourly heartbeat | `server/reports.js` |
| Secrets out, identifiers to ANON | `server/reportsScrub.js` |

## Endpoints

Base URL: `https://reports.skittles.live` (or `REPORTS_URL`).

### `GET /v1/config`

```json
{ "v": 1, "difficulty": 16, "maxBytes": 8388608, "kids": ["8d15510234d7647a"], "time": 1794422296868,
  "moved": { "url": "https://new.example.org", "at": 1794422296868, "sig": "<base64 Ed25519>" } }
```

- `difficulty`: the proof of work each report needs (leading zero bits).
- `kids`: the key ids the receiver opens (the current one first; older ones
  during a rotation).
- `time`: the receiver's clock; the Manager corrects its timestamps by it
  when its own clock is more than a minute off.
- `moved` (only when the receiver has moved): see [Changing the domain](#changing-the-domain).

The Manager caches it for 10 minutes and fetches it again when a report is
refused for its proof of work or its time.

### `POST /v1/report`

`Content-Type: application/json`, at most 8 MB:

```json
{ "v": 1, "kid": "<16 hex>", "epk": "<b64 32>", "iv": "<b64 12>", "ct": "<b64>", "tag": "<b64 16>",
  "ts": 1794422296868, "nonce": "<b64 16>", "ik": "<b64 32>", "sig": "<b64 64>", "pow": "<b64 8>", "bits": 16 }
```

Exactly these fields (anything else is refused). Answers:

| Status | Body | Meaning |
|---|---|---|
| 202 | `{ "ok": true, "id": "20261111T184019-…", "ref": "SR-7K2Q9F" }` | Kept. `ref` is the code people quote to support (every report gets one, anonymous ones too). |
| 400 | `{ "ok": false, "error": "…", "code": "…" }` | `BAD_BODY`, `TIME` (with `time`), `KID`, `POW` (with `difficulty`), `SIG`, `REPLAY`, `BAD_TAG`, `BAD_GZIP`, `BAD_JSON`, `SCHEMA` |
| 403 | `code` `KEY_MISMATCH` (or another refusal) | Refused for good, e.g. an install id already tied to another key |
| 413 | `code` `TOO_LARGE` | Over 8 MB, or it opens to over 100 MB |
| 429 | `code` `RATE`, `retryAfter`, `Retry-After` header | Over a rate limit |

Other paths answer 404.

## Sealing

1. `payload` (below) as JSON, gzipped.
2. An ephemeral X25519 key pair; ECDH with the receiver's static public key.
3. HKDF-SHA256: salt = ephemeral public key (32 raw bytes) ‖ receiver public
   key (32 raw bytes), info = `sentry-reports v1`, 32 bytes.
4. AES-256-GCM, random 12-byte IV, AAD = `sentry-reports v1|<kid>`.
5. `kid` = the first 16 hex characters of sha256(receiver public key, raw).

`epk`, `iv`, `ct`, `tag` are standard base64. Only the receiver's private key
opens it; anything on the way sees only ciphertext.

## Signing and proof of work

- **Envelope hash** `H` = sha256(`sentry-reports v1|1|<kid>|<epk>|<iv>|<ct>|<tag>`), the base64 strings as sent.
- **Signature**: Ed25519 over `sentry-reports v1 sig|<hex H>|<ts>|<nonce>`
  with the install's key (`ik` is its public key). Each install makes its key
  once (`data/reports/install-key.pem`, mode 600). Anonymous reports are
  signed with a second key made only for them (`anon-key.pem`), so the
  receiver cannot tie them to the install.
- **Proof of work**: `pow` (8 bytes) such that sha256(`H` ‖ nonce bytes ‖ pow
  bytes) has at least `bits` leading zero bits, and `bits` ≥ the receiver's
  difficulty. The Manager works it out in a worker thread. The default, 16
  bits, is about 1-2 s on a Raspberry Pi 4 and well under a second on a PC.
  The Manager does not go above 26 bits (it keeps the report and tries later).
- `ts` (milliseconds) must be within 10 minutes of the receiver's clock; a
  nonce, or an envelope, seen before is a replay.

## Payload (what is sealed)

```js
{
  kind: 'feedback' | 'support' | 'crash' | 'daily' | 'heartbeat',
  sentAt: '2026-11-11T18:40:19.475Z',
  install: '<32 hex: a random id made once per install>' | 'ANON',
  anonymous: true | false,          // true exactly when install is 'ANON'
  build: { build: 131 | null, sha: '<hex>' | null, builtAt: string | null, tag: string | null },
  ui: 'original' | '<interface pack id>',
  message: '…',   // feedback: required, 1-5000; support: the optional "what's wrong" note, up to 1000
  contact: '…',   // feedback only, never when anonymous, up to 200
  crash: { at, name, message, stack, source: 'crash' | 'error' },   // crash only
  diagnostics: { system, storage, counts, jobs, converter, settings, features, health, logs, crashes, can, sentryUsb, nodes, errors },
  heartbeat: { … }   // heartbeat only (and required there): see The heartbeat below
}
```

Exactly these fields, types and lengths (`validatePayload` in the protocol
module; the Manager checks its own reports with it before sealing, the
receiver checks them after opening). `diagnostics` is required for support,
crash and daily, optional for feedback; each part is free-form JSON within
bounds (10 levels, 60,000 fields, strings up to 40,000 characters, lists up
to 5,000). A heartbeat carries `heartbeat` and never `diagnostics`,
`message`, `contact` or `crash`.

What diagnostics hold: OS, kernel, architecture, CPU model and cores, memory,
container limits (cgroup), GPUs and encoders, the ffmpeg and Node versions,
uptime, free space for `/data` and each footage root; counts of vehicles,
recordings, jobs and recent job outcomes; the converter's state and settings;
settings with every secret removed; which features are on (CAN, Sentry USB
paired and its version, the interface pack, nodes, metrics, TLS mode); the
health checks; the last 200 warnings and errors of the past week; recent
crash stacks; the CAN index's status.

### The heartbeat

A few numbers, once an hour, while *Share diagnostics* is on. Besides the
common fields (`kind: 'heartbeat'`, `sentAt`, `install`, `anonymous`, `build`,
`ui`, all as above), exactly one more, `heartbeat`, with exactly these fields
(any other field, a missing required one or a wrong type is `SCHEMA`), and the
whole payload is at most 8 KB as JSON (about 1 KB in practice; it was 4 KB
before `nodes`, which at any useful length does not fit in 4 KB for eight
nodes). The fields
marked *optional* came later: a heartbeat without any of them is still right
(older Managers send none), and each one that is there is checked as strictly
as the others (exact keys inside it too). This Manager always sends all of
them except `platform` and `arch` when Node does not know them (it always
does).

**Text** in the optional fields is plain: printable ASCII (space to `~`)
without `"` and `\`, 1 character up to the field's limit, no space at either
end; control, format, private-use and non-ASCII characters are refused (the
Manager drops them, turns letters with accents into plain ones and runs of
spaces into one, and trims, before it checks). So a character is one byte as
JSON, and the worst case of every field at its limit (the common fields at
theirs, and eight nodes at theirs) is 8,062 bytes: under the 8 KB (without
`nodes`, 3,852). The list and length limits below are lower than first
planned for that reason, a node's shorter than this server's own
(`HEARTBEAT_LIMITS` in the protocol module).

**One name for a GPU.** `convert.device` is always exactly one of the strings
in `gpus` (the GPU the encode opened: its render node, `/dev/dri/renderD*`,
for VA-API, or QSV and AMF on a chosen GPU; its NVIDIA index, `-gpu N`, for
NVENC; without either, the one ffmpeg takes by default for that API:
renderD128, the first NVIDIA, Intel or AMD GPU, or the only GPU there is), or
exactly the `cpu` for a CPU encoder (`encodeGpuName` in `server/gpu.js`,
named the way `usableGpus` names `gpus`). Only when no GPU of `gpus` matches
is it a generic `'NVIDIA GPU'`, `'Intel GPU'`, `'AMD GPU'` or `'GPU'`. Each
node's `convert.device` is one of that node's `gpus` or its `cpu` the same
way (the node names its own devices).

| Field | Type and range | What it is |
|---|---|---|
| `uptimeSec` | integer, 0 to 3,153,600,000 | Seconds since the app started |
| `health.overall` | `'ok'` \| `'warn'` \| `'problem'` | `'problem'` when `problems` > 0, else `'warn'` when `warnings` > 0, else `'ok'` (must match the counts) |
| `health.warnings` | integer, 0 to 1,000 | Checks at *warn* in the last health check (the startup check, or the last run on the Health page) |
| `health.problems` | integer, 0 to 1,000 | Checks failing (*bad*) in it |
| `vehicles` | integer, 0 to 1,000 | Vehicles set up |
| `footageBytes` | integer, 0 to 2^53-1 | Footage, all vehicles together |
| `recordings` | integer, 0 to 1,000,000,000 | Recordings, all vehicles together |
| `spaceSavedBytes` | integer, 0 to 2^53-1 | "Space saved by conversions", all vehicles together (`server/savings.js`) |
| `distanceKm` | number, 0 to 10,000,000, in steps of 0.1 | Distance driven in all the footage (the speed index, as *Driving by week* adds it up), km to 0.1. A total only: never routes or places |
| `freeBytes` | integer, 0 to 2^53-1, or null | Free space on the footage storage, summed over the vehicles, each SMB share (server and share name) or local disk counted once; not more than `totalBytes` |
| `totalBytes` | integer, 0 to 2^53-1, or null | Size of the footage storage, summed the same way; null (with `freeBytes`) when no share has reported its size yet |
| `converting` | boolean | A conversion is running |
| `jobsQueued` | integer, 0 to 100,000 | Jobs not finished yet (running, or waiting their turn) |
| `features.can` | boolean | CAN data is on |
| `features.sentryUsbPaired` | boolean | A Sentry USB is paired |
| `features.gpu` | boolean | A GPU is available to the container (passed in, or NVIDIA) |
| `footageSeconds` | *optional*; integer, 0 to 1,000,000,000,000 | The length of all the footage, all vehicles together, in seconds: one minute per Tesla clip minute, as the Dash counts its "footage hours" (hours x 3600) |
| `platform` | *optional*; text, 1 to 32 | The OS Node runs on (`process.platform`), e.g. `'linux'` |
| `arch` | *optional*; text, 1 to 16 | The CPU architecture (`process.arch`), e.g. `'x64'`, `'arm64'` |
| `cpu` | *optional*; text, 1 to 120, or null | The CPU's model name (`os.cpus()[0].model`, trimmed); null when Node reports none |
| `gpus` | *optional*; a list of at most 4 texts, each 1 to 80 | The model names of the GPUs the container can use: the /dev/dri ones passed in (not Windows' WSL graphics bridge) and the NVIDIA ones, the set the Health check counts (`usableGpus` in `server/gpu.js`); `[]` when none |
| `cars` | *optional*; a list of at most 12 objects, exactly `{ model, firmware }` | One per vehicle (the first 12, in the vehicles' order); `[]` with none. Never a name, VIN or id |
| `cars[].model` | text, 1 to 16, or null | `'Model 3'`, `'Model Y'`, `'Model S'`, `'Model X'` or `'Cybertruck'` (the Manager sends nothing else): the vehicle's *Car model* setting, else what its CAN data's VIN says; null when neither is known |
| `cars[].firmware` | text, 1 to 24, or null | The Tesla software version (e.g. `'2025.14.3.1'`, maybe with its build hash). No source of it yet (the CAN data, Sentry USB and the clips' metadata carry none this Manager reads), so null for now; the Manager sends only a version of that shape |
| `clips24h` | *optional*; exactly `{ sentry, dashcam }`, each an integer, 0 to 1,000,000 | Clips (one per camera file) that reached the footage in the last 24 hours, from the inventory: `sentry` in SentryClips, `dashcam` everything else (RecentClips, SavedClips, ...). When a clip arrived is its birth time on the share, else its ctime, as the Sentry USB checksum record reads it |
| `convert` | *optional*; exactly `{ fps, encoder, device, api, codec }` | How this server's own conversions ran (a node's clips are counted in `nodes`, not here). The Manager always sends it: all five null when nothing has converted yet |
| `convert.fps` | number, 0 to 100,000, in steps of 0.1, or null | The average speed of the last 24 hours of converting (frames a second of all the clips encoding at once, sampled every 30 s); after a day without converting, the last average |
| `convert.encoder` | text, 1 to 40, or null | The ffmpeg encoder of the latest conversion, e.g. `'hevc_nvenc'`, `'libx265'` |
| `convert.device` | text, 1 to 120, or null | The GPU it ran on, exactly as that GPU is named in `gpus`, or exactly the `cpu` for a CPU encoder (see *One name for a GPU* above; a generic name only when no GPU matches); null when nothing has converted yet, or the CPU has no name |
| `convert.api` | text, 1 to 12, or null | `'nvenc'`, `'vaapi'`, `'qsv'`, `'amf'`, `'videotoolbox'` or `'cpu'` |
| `convert.codec` | text, 1 to 10, or null | `'h265'` or `'av1'` (`'h264'` if ever) |
| `crashes24h` | *optional*; integer, 0 to 10,000 | Crashes and unhandled errors the app noted in the last 24 hours (its crash notes keep the latest 20) |
| `host` | *optional*; exactly `{ os, docker }` | The kind of host the Manager runs on (`server/hostInfo.js`, worked out once at start). Only the word: never the kernel string, the host name or a version |
| `host.os` | `'truenas'` \| `'unraid'` \| `'synology'` \| `'qnap'` \| `'wsl'` \| `'macos'` \| `'raspberry-pi'` \| `'ubuntu'` \| `'debian'` \| `'fedora'` \| `'linux'`, or null (`HEARTBEAT_HOST_OS`; any other value is `SCHEMA`) | In a container, from the host's kernel string (`os.release()`, else `/proc/version`): `truenas` (`-production+truenas`), `unraid` (`-Unraid`), `wsl` (`microsoft-standard-WSL2`: Docker Desktop on Windows, WSL2), `linuxkit` is Docker Desktop's own VM and a guess: `macos` on arm64 (Apple Silicon), else `wsl` (Windows with the Hyper-V backend; an Intel Mac reads as `wsl` too), `raspberry-pi` (a Raspberry Pi device-tree model, or `rpi`/`raspi` in the kernel), `synology` (`synology` in the kernel or `/proc/version`, or DSM's `/proc/sys/kernel/syno_hw_version`), `qnap`, else `linux`. Outside a container, the same kernel and device-tree signs first (TrueNAS SCALE and Raspberry Pi OS call themselves Debian), then `/etc/os-release` `ID`, else the first known `ID_LIKE` (`raspbian` is `raspberry-pi`; Linux Mint is `ubuntu`, Rocky is `fedora`), else `linux`; `macos` on macOS; null on any other platform |
| `host.docker` | boolean | Runs in a container: `/.dockerenv` exists, or `/proc/1/cgroup` or `/proc/self/mountinfo` names docker, containerd, kubepods or libpod |
| `nodes` | *optional*; a list of at most 8 objects, exactly `{ cpu, gpus, convert }` | One per paired encoding node (Nodes), in the order they were paired; `[]` with none. Only its hardware and its conversions: never its name, host name, address, id or certificate. Each node reports its hardware itself (`hardware` in its `/node/v1/info`); a node of an older version, or one not heard from since this server started, is `{ cpu: null, gpus: [], convert: ... }` |
| `nodes[].cpu` | text, 1 to 60, or null | The node's CPU model, as its own heartbeat's `cpu` (cut to 60) |
| `nodes[].gpus` | a list of at most 4 texts, each 1 to 60 | The node's GPUs, as its own heartbeat's `gpus` (cut to 60) |
| `nodes[].convert` | exactly `{ fps, encoder, device, api, codec }` | How this server's clips ran on that node, as `convert` above: `fps` the average of the last 24 hours of the clips it encoded at once (its speed as this server saw it), `encoder`, `api` and `codec` of the latest, `device` (text, 1 to 60, or null) one of that node's `gpus` or its `cpu`; all five null when it has converted nothing for this server |

```json
{ "kind": "heartbeat", "sentAt": "2026-11-11T21:04:07.112Z", "install": "ANON", "anonymous": true,
  "build": { "build": 131, "sha": "9b50039", "builtAt": "2026-11-11T20:09:31Z", "tag": "latest" }, "ui": "horizon",
  "heartbeat": { "uptimeSec": 7210, "health": { "overall": "warn", "warnings": 1, "problems": 0 }, "vehicles": 2,
    "footageBytes": 812345678901, "recordings": 4210, "spaceSavedBytes": 301234567890, "distanceKm": 18234.7,
    "freeBytes": 1200000000000, "totalBytes": 4000000000000, "converting": false, "jobsQueued": 0,
    "features": { "can": true, "sentryUsbPaired": false, "gpu": true },
    "footageSeconds": 912345, "platform": "linux", "arch": "x64", "cpu": "AMD Ryzen 7 5800X 8-Core Processor",
    "gpus": ["NVIDIA GeForce RTX 4070"], "cars": [{ "model": "Model Y", "firmware": null }, { "model": null, "firmware": null }],
    "clips24h": { "sentry": 40, "dashcam": 1200 },
    "convert": { "fps": 412.3, "encoder": "hevc_nvenc", "device": "NVIDIA GeForce RTX 4070", "api": "nvenc", "codec": "h265" },
    "crashes24h": 0, "host": { "os": "truenas", "docker": true },
    "nodes": [
      { "cpu": "Intel(R) Core(TM) i5-12400", "gpus": ["Intel Arc A380"],
        "convert": { "fps": 180.5, "encoder": "hevc_qsv", "device": "Intel Arc A380", "api": "qsv", "codec": "h265" } },
      { "cpu": "AMD Ryzen 5 3600 6-Core Processor", "gpus": [],
        "convert": { "fps": 35.5, "encoder": "libx265", "device": "AMD Ryzen 5 3600 6-Core Processor", "api": "cpu", "codec": "h265" } }
    ] } }
```

Nothing in a heartbeat names anything (no names, paths, hosts, places or
VINs): numbers, yes/no, fixed words, and the models of the hardware and the
cars, which are not personal and stay in an anonymous one too. Its text goes
through the scrubber all the same, as an anonymous report's does, whether it
is anonymous or not (a host, path, address or vehicle name that turned up in a
CPU or GPU name would become `ANON`; the paired nodes' names and addresses are
among what it looks for), and a car's model is only ever one of the
names above. So it is the same anonymous or not, except `install`. *Show a heartbeat* in
Settings → Help & feedback shows the one it would send now.

**Never in a report**, anonymous or not: passwords, tokens, keys, cookies,
link keys, webhook URLs, share credentials, TLS private keys. Values under
such names become `[removed]`, and such things written inside text (PEM
blocks, `user:password@` in URLs, webhook URLs, Bearer headers, `password=`
pairs, session cookies, JWTs, GitHub tokens) are cut out.

**Anonymous** (*Send anonymously*): every identifier becomes `ANON` in every
string, log lines and stack traces included: the install id, host name, IPv4
and IPv6 addresses, MAC addresses, account names, vehicle names and ids,
share hosts, paths and user names, Sentry USB names and addresses, Wi-Fi
SSIDs, Tesla VINs, e-mail addresses, GPS coordinates and place names, local
host names (`.local`, `.lan`, …), and the host of any URL that is not a
well-known public one. No contact is sent.

## When reports are sent

| Kind | When | Needs |
|---|---|---|
| feedback | An admin presses Send (after the preview and the password) | Nothing else: pressing Send is the consent for that one message; at most 5 an hour |
| support | An admin presses *Send diagnostics to support* | The same; at most 5 an hour |
| crash | After a crash (noted locally as the process ends, sent after the restart) or an unhandled error in a request | *Share diagnostics* on; one report an hour for the same error, 6 a day |
| daily | Once a day | *Share diagnostics* on (the first a day after turning it on) |
| heartbeat | Right away when sharing is turned on; 10 to 60 seconds after a start (a restart or an update), at random, so many servers updating at once do not report in the same second; then every hour (56 to 64 minutes) | *Share diagnostics* on |

A report that cannot be delivered waits, sealed (never plaintext), in
`data/reports/outbox`: at most 20 reports and 50 MB, 7 days, retried with
backoff (from a minute, doubling, up to 6 hours, or the receiver's
`Retry-After`). A report refused for good (400 other than `POW`/`TIME`, 403,
413) is dropped. Turning *Share diagnostics* off drops the crash, daily and
heartbeat reports still waiting. At most one heartbeat ever waits (the next
replaces it), and a heartbeat never takes a real report's place: when the
outbox is full, the heartbeat goes first. Heartbeats carry the same proof of
work and signature as every other kind (the difficulty from `/v1/config`).

## What a sender can rely on

The receiver checks every report before it keeps it: exactly the envelope,
`ts` within 10 minutes, a `kid` it has, the proof of work, the signature, no
replayed nonce or envelope, the size caps, that it opens, and exactly the
payload; the answers are in the table above. It also limits how many reports
it takes per address, per key and per day (429 with `Retry-After`). An
install id is tied to the key that first signed for it: a report for that id
signed by any other key is refused (403 `KEY_MISMATCH`). Anonymous reports
are not tied to any install.

## What this does and doesn't guarantee

The Manager is open source, so the receiver's public key is public and anyone
can write a client. Fakes cannot be made impossible; they are made costly,
visible and unable to impersonate anyone:

- **Impersonating an existing install is not possible.** Its id is tied to
  the key that first signed for it; a report for that id signed by any other
  key is refused. The private key never leaves that install's `/data`.
- **Nothing is readable or changeable on the way.** Sealed to the receiver's
  key, authenticated (GCM), signed and timestamped; replays are refused.
- **Mass faking is expensive and rate-limited.** Every report costs a proof of
  work, and the receiver limits reports per address, per key and per day.
- **A determined person can still send a few fake reports** as a new install
  (or an anonymous one) with made-up contents and a real build number. The
  developers treat reports from a new install and anonymous ones as
  unverified claims.

## Changing the domain

Everything is in `server/reportsConfig.js`: `DEFAULT_ENDPOINT` and
`RECEIVER_KEYS`. For a single server, `REPORTS_URL` (https only) and
`REPORTS_PUBLIC_KEY` override them without a new build; a `REPORTS_URL` set
by hand is never moved.

When the receiver moves, installs already out there follow it without a new
build:

1. The receiver at the old address answers `GET /v1/config` with `moved`,
   signed by the receiver's long-term Ed25519 key: `sig` over
   `sentry-reports v1 moved|<url>|<at>`.
2. A Manager follows it only when the signature checks out against a
   `signingKey` in `RECEIVER_KEYS` (only to `https://`, and only to a newer
   `at` than one it already followed), so someone who takes over the old
   domain or its DNS cannot send reports elsewhere. It remembers the new
   address in its database.
3. The next build changes `DEFAULT_ENDPOINT`; the old address keeps answering
   for a while.

## Rotating the key

The sealing key (X25519) can be replaced; the signing key (Ed25519) stays.

1. The receiver gets a new sealing key and keeps opening reports sealed to
   the old one (it picks the key by `kid`; `GET /v1/config` lists both).
2. The new entry goes **first** in `RECEIVER_KEYS` and the old one stays after
   it. New builds seal to the new key; older installs keep using the old one.
3. The old key is dropped only when no install needs it any more.

## The receiver's key line

The developers publish the receiver's key as one line, and as the entry for
`RECEIVER_KEYS`:

```
line:  sr1:<base64 X25519 public key>:<base64 Ed25519 signing key>
entry: { kid: '<16 hex>', publicKey: '<base64, 32 bytes>', signingKey: '<base64, 32 bytes>' }
```

`kid` is the first 16 hex characters of sha256(the X25519 public key, raw).
The `line` goes into `REPORTS_PUBLIC_KEY`; the object goes into
`RECEIVER_KEYS`. Both hold only public halves.

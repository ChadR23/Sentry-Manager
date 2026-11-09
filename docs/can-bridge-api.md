# CAN Bridge upload API (Sentry Six Manager side)

How the Screenmate CAN Bridge app (repo `skittles-fivem/SMO`) sends its CAN
logs to Sentry Six Manager. The log format itself is defined by the app, in
`docs/sentry-manager-format.md` in SMO: `candump -L` lines, xz-compressed
(as text, or as columns: see Log formats), one file per minute, with a JSON
sidecar.

Sentry Six Manager keeps every log exactly as it arrives, including messages
nobody can decode yet, so a message identified later also works on old
drives. Decoding, syncing to the footage and the on-screen stats are built on
top of the stored logs.

## Turning it on

Off by default: while off, port 10000 is closed and every `/api/can/logs`
address on the web port answers `404`.

An admin turns it on in the hidden Nerd settings (Settings page: tap the
Version line seven times, then **>_ nerd**). Turning it on, or making a new
token, asks for the password and shows:

- the upload address, `https://<host>:10000/api/can/logs`;
- the token, once (only its SHA-256 is stored);
- the server certificate's SHA-256 fingerprint, for the app to pin.

## Tokens: one per car

Each token is for one car. The owner makes it for a car in the Nerd settings
(*New token for this car*); its first upload ties it to that car's CAN Bridge
key (`vehicleKey`, the first part of the file names), and from then on:

- it can upload only that key's files (`403 wrong_car` for another key);
- `status` answers only that key's names (another key's names come back as
  `"state": "forbidden"`, so a token cannot even see what another car sent);
- it can do nothing else: no footage, no settings, no deleting.

Several cars, several tokens (at most 20). A token can be revoked on its own
(the others keep working). Turning uploads off closes port 10000 and makes
every token unusable until they are turned on again; the tokens are kept.
`ping` answers the key a token is tied to (`"vehicleKey"`, or `null` before
its first upload).

## The port

The CAN Bridge uploads to its own port, **10000** (the server's `CAN_PORT`
setting). That port answers only the requests below; everything else there
is `404`. It is open only while CAN uploads are on: turning them off closes
it. In Docker it is published like the web port (`"10000:10000"`). The same
requests also work on the web port (9000), but the app should use 10000.

## Rules for every request

- **HTTPS only.** Over plain HTTP the answer is `403 https_only`. The
  certificate may be self-signed: pin it by its SHA-256 fingerprint.
- **Token:** `Authorization: Bearer <token>`, one per car (see Tokens). It
  is write-only: it can call the three requests below and nothing else (no
  footage, no settings).
- No cookies, no `X-Requested-With` header needed.
- Every answer is JSON. Errors are `{ "error": "<words>", "code": "<code>" }`,
  plus `"received"` when it says how far an upload got.

## 1. Check the connection

`GET /api/can/logs/ping`

`200 { "ok": true, "api": 1, "vehicleKey": "MY-car", "maxChunk": 16777216, "maxFile": 1073741824, "maxSidecar": 1048576, "formats": ["canbridge-candump-xz/1", "canbridge-columns-xz/2"] }`

Use it to test the address, token and pinned certificate, and read the limits.
`formats` lists the log formats this server reads (see Log formats). The
bridge writes `canbridge-columns-xz/2` only while it is listed, and goes back
to candump text if a later `ping` stops listing it (an older server, which
answers no `formats`, gets candump text).

## 2. Which files are already here

`POST /api/can/logs/status` with `Content-Type: application/json`:

```json
{ "names": ["MY-car_20261108T143000Z_1.log.xz", "MY-car_20261108T143000Z_1.log.xz.json"] }
```

Up to 2000 names per request. Answer `200`:

```json
{ "files": {
  "MY-car_20261108T143000Z_1.log.xz":      { "state": "partial",  "received": 4194304, "length": 17825792 },
  "MY-car_20261108T143000Z_1.log.xz.json": { "state": "missing",  "received": 0,       "length": null }
} }
```

- `complete`: here and checked; do not send again.
- `partial`: an upload was started; resume at `received`.
- `missing`: send it from offset 0.
- `invalid`: the name is not a CAN Bridge log name (see Names).

## 3. Upload a file (in chunks, resumable)

`POST /api/can/logs/<name>` with the raw bytes of one chunk as the body
(`Content-Type: application/octet-stream`) and these headers:

| Header | Value |
|---|---|
| `Upload-Offset` | where this chunk starts in the file (bytes); must equal what the server already has |
| `Upload-Length` | the whole file's size in bytes (the same on every chunk) |
| `Upload-SHA256` | the whole file's SHA-256 in hex (the same on every chunk) |

- A chunk is at most `maxChunk` (16 MiB). A one-minute log (about 1.7 MB as
  candump text, 0.7 MB as columns) takes one chunk; so does a sidecar.
- `200 { "received": n, "length": total, "complete": false }`: send the next
  chunk at offset `n`.
- `201 { "received": total, "length": total, "complete": true }`: the last
  chunk arrived and the SHA-256 matched; the file is kept.
- Sending a file that is already complete with the same size and hash
  answers `201` with `"already": true`, so a retry is harmless.
- The log and its sidecar are separate uploads with their own names
  (`<name>.log.xz` and `<name>.log.xz.json`), in either order. Upload a log
  only once it is finished (not while it is still `.part` in the app).

To resume after a lost connection, ask `status` (or read `received` from the
`409` answer) and continue from there.

## Names

`<vehicleKey>_<UTC yyyyMMddTHHmmssZ>_<seq>.log.xz` and the same plus `.json`
for the sidecar. `vehicleKey` is 1–64 letters, digits or `-`; `seq` is 1–6
digits. Anything else is refused with `400 bad_name`.

## Log formats

Both are one xz stream under the same names, with the same sidecar; the
sidecar's `format` says which, and Sentry Six Manager also tells them apart
by the first bytes after `xz -dc`:

| `format` | After `xz -dc` | Size |
|---|---|---|
| `canbridge-candump-xz/1` | candump text, starting `# canbridge v1` | about 1.7 MB a minute |
| `canbridge-columns-xz/2` | `CANBRIDGE-COLUMNS/2` and LF, then the same lines kept as columns (SMO, `docs/sentry-manager-format.md`, "Columns format") | about 0.7 MB a minute (2.4 times smaller), lossless |

A columns log decodes to exactly the candump text a `/1` log of the same
frames holds, in the same order; Sentry Six Manager decodes it with the
bridge's own decoder (`server/canColumns.js`, a copy of SMO's
`tools/columns-to-candump.js`), so the index, the raw view, the search and
the sync read the same lines either way. The stored file is never re-encoded:
the signature covers the `.log.xz` file's bytes, whichever format it holds.

A columns body is decoded whole (in a worker thread, so the server keeps
answering): one that unpacks to more than 64 MB (the bridge closes a compact
file at 48 MB in memory, sidecar `closed_because: "size"`), that says it
holds more than 8 million frames (a minute is about 230,000), is malformed or
cut off, or needs more than 512 MB of heap to decode, is refused: kept as it came,
listed, and reported once in the Nerd panel's Index line, like any log that
cannot be read. The indexer and the downloads each have one decoder of their
own, so a download never holds up indexing; a candump download that stops
taking data for a minute is ended.

The sidecar's `closed_because` is one of `rotate` (the minute was over),
`quiet`, `stop`, `size` (a compact file closed early at 48 MB in memory) and
`flush` (closed early, before an app update or shutdown); the Nerd list shows
it under the format.

## Signatures and pairing

Every finished log is signed on the Screenmate (ECDSA P-256, a key in the
Android keystore that cannot be copied off it). The signature travels in the
sidecar's `integrity` object (SMO, `docs/sentry-manager-format.md`,
"Integrity"). The signed bytes are these lines joined by LF with a trailing
LF:

```
canbridge-log-sig-v1
<vehicle_key>
<log file name>
<log sha256, lowercase hex>
<log length in bytes>
<index>
<prev_name>
<prev_sha256>
```

When a log and its sidecar have both arrived, Sentry Six Manager:

1. hashes the log as it is stored here (SHA-256 and length) and rebuilds the
   signed message from that, the file name and the sidecar's chain fields;
2. checks that the sidecar's `vehicle_key` is the file name's key, its
   `sha256` and `length` are the file's, `version` and `algorithm` are the
   ones above, the key is a P-256 key and `key_fingerprint` is that key's;
3. verifies the signature with `crypto.verify('sha256', message, key, signature)`;
4. compares the key with the one the car is paired with.

**Pairing.** The first signed log of a car key pairs it: its public key is
pinned (the fingerprint is the SHA-256 of the key's DER, hex in pairs with
colons, as the app shows under "Log signing key"; the Nerd settings show it
too, to compare). From then on only logs signed by that key are trusted. A
log signed by another key (a new Screenmate, the app reinstalled, or someone
else) is kept but not used, and the Nerd settings offer that key: the owner
checks its fingerprint in the app and trusts it, and the logs it signed are
checked again. *Forget the pairing* lets the next signed log pair again.

**What each log becomes** (shown in the Nerd list):

| Check | When | Used? |
|---|---|---|
| verified | signed by the paired key, and the file is exactly what was signed | yes |
| failed | changed after signing, signed for another car or by another key, a bad signature or fields, or not signed although the car is paired | no: kept and listed with the reason; the owner can *Use anyway*, and then the Viewer warns ("CAN data failed its check") wherever it shows that data |
| failed, "✗ not signed" (reason kind `bridge-could-not-sign`) | from a paired car, `"signed": false` with an `"error"`: the bridge says it could not sign it (SMO build 143 did this while its `chain.json` was damaged). Listed as `unsigned: the CAN Bridge could not sign it (<its error, at most 120 characters, control characters removed>)` | no, not tampering, but nothing proves it came from the paired Screenmate. *Use anyway* one by one, or all of a key's at once (below) |
| unsigned | no signature (`"signed": false`, with or without an `"error"`, or no `integrity`) from a car that is not paired | yes, with a quiet note ("unsigned") |
| waiting | the sidecar has not arrived (after 10 minutes without it, the log is judged as unsigned) | not yet |

Nothing is decoded for the Viewer, the sync or the search until its check
allows it. Only the log is signed, and everything that matters is in it
(frames, `# clock`, `# helper-clock`, `# dropped`, `# not recorded`); the
sidecar's other fields are an unsigned summary (shown, never trusted).

**Use all logs the bridge could not sign.** For a car key with such logs the
Nerd settings show *Use all logs the bridge could not sign (N)* and, once
some are used, *Stop using them (N)*: `POST /api/can/pairing/<key>/could-not-sign`
with `{ "use": true | false }`, after the password (as the other trust
changes; watch-only accounts may not). It sets the same per-log override as
*Use anyway* on exactly the logs of that key with the reason kind
`bridge-could-not-sign` (not on logs that are not what was signed, or signed
by another key), writes one audit line with the count and the first and last
name, and the index decodes them (or takes their data out again). Each can
still be stopped or used one by one. The answer is `{ changed, names, summary }`.

**Judged again after an update.** Each car key's `trust.json` and each record
carry the version of the rules they were judged by. At start (and every few
minutes) records of an older version are brought up to date without a new
upload: logs judged unsigned (or failed for it) are judged again from their
sidecar (so logs judged "not signed, but this car is paired" before move to
the new reason; an override set by hand stays), and signed logs only get
their sidecar's `chain_note`. The chain is worked out from the records each
time, so it follows at once.

**The chain.** `index` counts up by 1 per log of a key (from 0) and each log
names the previous one (`prev_name`, `prev_sha256`). Only signed logs are
links: a log the bridge could not sign is not part of the chain (the next
signed log names the last signed one as its previous, which is no break).
For the paired key's signed logs the Nerd settings report:

- a gap: indexes that never arrived (`log 41 is missing`);
- a mismatch: a log whose `prev_name`/`prev_sha256` is not the log stored
  here with the index before (swapped, changed or replaced);
- a duplicate index, or a later index that starts before an earlier one
  (reordered);
- a log of the chain that failed its check.

Logs received here and deleted later still count (their record is kept), and
the bridge deleting its own copies after upload is not a break. A new key
starts again at 0 (and is offered for trust, above).

**A restart.** If the bridge's `chain.json` is unusable and no signed log is
left on the Screenmate, it starts a new chain at 0 with the same key
(`prev_name` `-`, `prev_sha256` 64 zeros). A signed log like that after the
key's first one (or the first one, when two or more logs of the key are
older: a chain received from its middle) is reported as *the chain started
again at 0 with <name> (the bridge says: <its chain_note>)*, not as a
duplicate or mismatch: only the paired key can sign it. Each part is then
checked on its own (gaps, mismatches, reorders), and the summary says that
logs signed between the end of the part before and the restart cannot be
checked for gaps. `chain` in `/api/can/settings` has `restarts` and
`segments` (`[{ first, last, count }]`) for this.

**`chain_note`.** The bridge says in the integrity object's `chain_note`
(not signed; informational) how it repaired its chain, e.g. `chain.json was
64 zero bytes (likely a power cut); chain continued from <name> (index 198)`.
It is kept with the log (one line, control characters removed, at most 300
characters), listed in `/api/can/files` as `check.chainNote`, shown in the
Nerd list under the log's check (escaped, cut to 160 characters, all of it
on hover), and quoted in the chain summary for a restart, a duplicate or a
mismatch at that log. It never changes a log's check.

## Errors

| Status | `code` | Meaning, what the app does |
|---|---|---|
| 400 | `bad_name`, `bad_offset`, `bad_length`, `bad_sha256`, `past_end`, `bad_request` | The request is wrong; fix it, do not retry as is. |
| 401 | `bad_token` | No token, or a revoked one: ask the owner for a new token. |
| 403 | `https_only` | Plain HTTP was used. |
| 403 | `wrong_car` | This token is for another car key. |
| 400 | `mixed_cars` | A token not tied to a car yet asked about two cars' files at once. |
| 429 | `slow_down` | Too many wrong tokens from this address (20 in 10 minutes), or more than 1,200 requests in 10 minutes with one token: wait. A right token is never refused because of wrong ones. |
| 429 | `too_many_partial` | 16 unfinished uploads for this car already: finish or wait (unfinished uploads are dropped after two days). |
| 404 | `off` / `not_found` | Uploads are turned off, or an unknown address. Try again later (hours). |
| 409 | `offset_mismatch` | `Upload-Offset` is not what the server has: resume at `received`. |
| 409 | `length_changed` | A different `Upload-Length` than the upload already started. |
| 409 | `exists_different` | A different file with this name is complete here: rename (next `seq`) and report it. |
| 409 | `busy` | Another request is uploading the same file: wait and resume. |
| 413 | `too_large`, `chunk_too_large` | Over `maxFile`/`maxSidecar`, or a chunk over `maxChunk`. |
| 422 | `sha256_mismatch` | The finished file did not match its hash; it was discarded. Upload it again from offset 0. |
| 422 | `bad_sidecar` | The sidecar is not JSON; it was discarded. |
| 507 | `no_space` | The server is short of disk space (it keeps 2 GB free for everything else): try again later. |
| 507 | `car_full` | This car has 200,000 CAN logs here already (finished logs are counted, not sidecars): a safety net only (see "How long logs are kept"); the owner deletes old ones in the Nerd settings. |
| 500 | `server_error` | Try again later, with backoff. |

## What happens to the files

Kept under `<data>/can/<vehicleKey>/`, exactly as received; a finished file
cannot be replaced (`409 exists_different`), only added. The Nerd panel lists
them (start, car key, check, size, format and why it was closed, frames and
dropped from the sidecar, in a
box of its own height with a filter by car key, check and text), follows new
uploads, checks and the index live, and can delete one (with the password).

**How long logs are kept: with their footage.** A log is *paired* with the
footage of its car (the car its key is chosen for in the Nerd settings) that
covers its minute: Recent, Sentry and Saved clips, read from their names in the
car's time zone, a clip being about a minute. The Nerd list shows each log as
`paired`, `no footage`, or `—` (no car chosen for its key). With "Delete CAN
logs with their footage" (Nerd settings, *Keeping logs*; on by default):

- Footage deleted for good (the Recycle Bin emptied by hand, one item deleted
  forever, or the bin emptied after N days by a policy; policies and the size
  limit only move footage to the bin): its car's logs whose minute no longer
  has any footage are deleted with it. While the footage is only in the
  Recycle Bin its logs stay, and a restore keeps them.
- Protected footage keeps its logs (it cannot be moved to the bin).
- A log whose minute never had footage (an archive gap, Sentry off) stays
  while it is newer than the car's oldest footage (on the share or in the bin),
  and is deleted once it is more than an hour older than all of it: footage
  retention bounds the logs. Looked at every hour, and right after a delete.
- Never touched: keys not chosen for a car, a log whose sidecar is still
  uploading or that waits for its check, and every log of a car whose share is
  unreachable, whose scan is running, failed or could not read some folders,
  or that has no footage at all (a share outage must not look like "all
  footage deleted"). Minutes deleted while the share is away are remembered and
  acted on once it is back.
- At most 500 logs a run (the rest a minute later), each deleted as a delete in
  the Nerd settings is (the file and sidecar, its minutes in the index, the
  sync, its trust record kept as deleted for the chain), with one audit line a
  run ("CAN logs deleted (car …): N (… with their footage deleted, … older
  than the car's oldest footage, … not linked to footage after 7 days)").

**Logs not linked to footage.** "Delete logs not linked to footage after
[7] days" (*Keeping logs*, its own switch, on by default, 1 to 365 days): a
log that no footage of its car covers (on the share, in the Recycle Bin or
protected) is deleted once it is that many days old, counted from its minute
or from when it arrived when that was later (a bridge that uploads late gets
the full time). The archive had a week to bring the clips. Every rule above
about what is never touched applies to it too (unmapped keys, pending logs,
an unhealthy share, an incomplete scan, a car with no footage at all). The
audit line counts them ("… not linked to footage after 7 days").

**Deleting footage with its CAN data.** The footage delete confirmations offer
"Also delete its CAN data (N logs)" when a key is mapped to the car (unticked).
Ticked, `POST /api/vehicles/:id/trash` and `/trash-days` get `withCan: true`
and, once the footage has moved, the logs of the moved recordings' minutes are
deleted at once (with Delete through this date, `through: true`, every log of
the car ending before the end of that day in the car's time zone as well).
These do not come back on a restore. Minutes that footage still on the share
or protected footage covers keep their logs; pending logs stay; nothing
happens for an unmapped key or while the car's footage cannot be trusted.
The count comes from `POST /api/vehicles/:id/trash-preview` `{ ids }` and the
`trash-days` preview (`can: { logs, kept } | null`). One audit line ("CAN logs
deleted with footage moved to the Recycle Bin (car …)").

`POST /api/can/keep` takes any of `{ "withFootage": bool, "deleteUnlinked":
bool, "unlinkedDays": 1-365 }` (admins, with the password).

With both switches off, logs are kept until the owner deletes them, up to the
200,000 per car cap (`car_full`), which stays as a safety net either way.

**Downloads (Nerd panel, admin accounts only).** To work out what changed after
a Tesla software update. These use the web session; the upload token cannot
read anything, and watch-only accounts get 403.

| Route | What |
|---|---|
| `GET /api/can/files/<name>/download` | One log (`….log.xz`) or its sidecar (`….log.xz.json`), exactly as received (the signed bytes). |
| `GET /api/can/files/<name>/candump` | One log as candump text (`….log`, `text/plain`, streamed), whichever format it was stored in: for SavvyCAN, cantools and other tools that only read candump. A `/1` log is its `xz -dc`; a `/2` log is decoded on the fly. Not signed (check the `.log.xz`). A log that cannot be read (refused, or not xz at all) answers `422`; `503` while another download is being decoded; one cut off ends with a `# Sentry Six Manager: …` line saying so. |
| `GET /api/can/export/bundle?key=&from=&to=[&candump=1]` | A `.zip` (streamed) of that car key's logs and sidecars that start in the range (plus the one running at its start), and, after them, `ids.csv` (every CAN id seen: bus, id, DBC message or `unknown`, frames, Hz, first and last seen, minutes, from the index's frame counts) and `manifest.json` (each log's `format` and check). `candump=1` adds each log as candump text (`….log`) beside it (about 10 MB a minute; a log that cannot be read gets a one-line `#` note instead). At most 7 days, 12,600 logs (a week of a log a minute around the clock, with room to spare) and 4 GB. `check=1`: what it would hold, as JSON. |
| `GET /api/can/export/decoded?key=&from=&to=&signals=[&mode=changes\|every]` | The decoded signals as CSV (`timestamp_utc,signal,value,unit,value_name`), streamed, gzipped when the browser accepts it. `mode=changes` (the default without `signals`): a value when it changes, and once a minute while it stays the same. `mode=every` (the default with `signals`): every point the index keeps (a change, and once a second). At most 24 hours and 5,000,000 rows. `check=1`: `{ mode, minutes, estimatedRows, rowLimit, willStop }` before downloading. A cell that starts like a formula (`= + - @`) is written with a `'` first. |
| `GET /api/can/export/new-ids?key=&since=[&format=csv]` | CAN ids first seen on or after `since`, with the DBC message or `UNKNOWN`, from per-day id summaries the index keeps (always complete). |

**Decoding.** Each car with the DBC set of its model and year (below, "Car
models and years"). A Model 3 or Y (every year, and the default when nothing
is known): model3dbc's `Model3CAN.dbc`, then the messages it lacks from opendbc
that checked out on a Model Y (`server/dbc/model3y-opendbc.dbc`), and over them `server/dbc/override.dbc`:
the messages whose layout changed in newer Tesla firmware, checked against a
real car's logs (a message there with no signals has a layout not known yet and
is not decoded; it shows as `unknown`). A frame is decoded only on a bus the
sidecar's bus map (or the default: can0 vehicle, can1 chassis) names, with that
bus's message; the Screenmate's own buses (can2, can3: "screenmate-internal")
are kept and counted, not decoded, with one exception: the GPS position from
the Screenmate's own GPS receiver (0x04F at 10 a second: `GPSLatitude04F`,
`GPSLongitude04F`, `GPSAccuracy04F`, nothing else of that bus), checked on a
drive against the car's speed. The owner's Model Y sends no 0x04F on its own
buses. The rest of can3 is the receiver's and the CAN chip's own (0x3D9 a 0..3
fix status in byte 0, not GPS speed; 0x011 receiver diagnostics; 0x021 the
chip's frames a second per car bus; 0x001, 0x031, 0x041, 0x051 constant), and
is not decoded: no car data. It is decoded on an interface the
sidecar's bus map calls internal and stored under the same names as the chassis
bus's 0x04F, for the Footage place tags and Drives; where a car bus sends 0x04F
too, the car bus's wins. A signal name that two messages share has
the message id after it in the decoded data (`UI_cpuTemperature_353`). When the
decoding changes, every stored log is indexed again in the background, each
replacing its own part of its minutes; then whatever an older decoding wrote
for a log that cannot be read again (deleted, not usable) is taken out, and
the CAN-to-footage sync and the archive gap check work out their answers again.
(Index r3 added only the internal bus's position: what r2 decoded of the car's
buses stays, also for logs that are gone, and so do the sync's and the gap
check's answers.)

### Car models and years

Which DBC set reads a car's CAN data comes from the vehicle's **Car model** and
**Year** setting (Settings, the vehicle; admins), Automatic by default: the
car's own VIN, which it sends on the CAN bus (0x405 on a Model 3, Y and a 2021+
Model S or X; 0x508 on a Model S or X from before the 2021 refresh). The 4th
character is the model, the 10th the model year (L 2020, M 2021, N 2022, P
2023, R 2024, S 2025, T 2026, V 2027, ...); a Model S or X that sends 0x508 is
a legacy car whatever its year. Indexing a log keeps what its VIN says for the
car key (`<data>/can-index/<key>/car.json`); `GET /api/vehicles` gives each
vehicle `car`: `{ setting: { model, generation }, detected: { model, year,
plant, via, vin (without the serial number) } | null, model, year, generation,
generationLabel, profile, source: setting | vin | default }`, and the choices
as `carModels`. `PUT /api/vehicles/:id` takes `car: { model: "auto" | "3" |
"Y" | "S" | "X", generation: "auto" | "Y-2020" | ... }`. A sidecar may say the
VIN too (`vin`, or `car.vin`); the CAN Bridge sends none today.

| Model | Year (generation) | DBC set | Checked on a real car |
|---|---|---|---|
| Model 3 | 2017-2023; 2024 and later (Highland) | `tesla-3y` | No (the same set as the Model Y; the firmware overrides follow the software, which the 3 and Y share) |
| Model Y | 2020-2024; 2025 and later (Juniper) | `tesla-3y` | Yes: the owner's Model Y (VIN model year 2022, on 2026 firmware), parked |
| Model S | 2012-2014 (before Autopilot hardware); 2015-2020 | `tesla-sx-legacy` | No: community sources only |
| Model S | 2021 and later (refresh) | `tesla-3y` | No: no public DBC for it; its electrical system is close to the 3/Y's |
| Model X | 2016-2020 | `tesla-sx-legacy` | No: community sources only |
| Model X | 2021 and later (refresh) | `tesla-3y` | No (as the Model S refresh) |

The sets (`server/canDbc.js` PROFILES; files in `server/dbc/`, each source's
license beside it):

- `tesla-3y`: [model3dbc](https://github.com/joshwardell/model3dbc) `Model3CAN.dbc`
  (MIT, its latest commit c56c113, 2021: the bundled file is that one), then
  `model3y-opendbc.dbc` (from [opendbc](https://github.com/commaai/opendbc),
  MIT, commit 27fa1c5 of 2026-11-07: 0x370 `EPAS3S_sysStatus` and 0x488
  `DAS_steeringControl` on the chassis bus, 0x343 `VCRIGHT_status` on the
  vehicle bus; each frame's checksum right on the owner's car, the values
  sensible parked; what was left out and why is in the file), then
  `override.dbc` (the firmware overrides). Buses: can0 vehicle, can1 chassis.
- `tesla-sx-legacy`: opendbc's `tesla_can.dbc` (chassis bus) and
  `tesla_powertrain.dbc` (powertrain bus) as they are, then `sx-legacy.dbc`:
  the speed in km/h as every other model's, and the messages Open Vehicle
  Monitoring System's Model S module reads ([OVMS](https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3),
  MIT): pack voltage, state of charge, range, odometer, inverter and motor
  temperatures, charging power, tire pressures and the brick voltages and
  module temperatures. Buses: can0 powertrain, can1 chassis (the sidecar's bus
  map wins: "powertrain", "chassis", "vehicle").

A set's own name is in its logs' stamps and parts (`r4/tesla-sx-legacy`; the
Model 3/Y set leaves them as they were), so a car whose set changes (its VIN
seen for the first time, or the setting changed) has its logs decoded again
in the background, and what the other set wrote is taken out; a car that
stays on the Model 3/Y set (a Model 3 or Y whose VIN is seen) is not decoded
again for that. The Viewer's
popular stats take the first of their signals a car has, the Model 3/Y one
first, then the legacy S/X one (`SOCUI302` for Battery %, `DI_vehicleSpeed_116`
for Speed, ...). The CAN-to-footage sync and Drives read Model 3/Y signals
(speed, brake, GPS position): on a legacy Model S or X they find none yet.

Not usable here: onyx-m2-dbc (no license given), Tesla's own Roadster DBC
files (no license that allows copying them). Index r4 added the sets and the
three opendbc messages: every stored log is decoded again once for them, and
every signal r3 decoded comes out the same (test/canModels.test.js, also on
the owner's whole logs), so the sync's and the gap check's answers stay.

Times are ISO with a zone, or the car's own clock (`YYYY-MM-DD[THH:MM]`).
`check=1` on the bundle and decoded routes answers what they would hold
(JSON) without sending the file; with `candump=1`, `candumpBytes` is the
most candump text it holds: each log's share comes from its sidecar's
`frames` (64 bytes a frame, plus 64 KB), or from its size when it has no
sidecar, and a log whose text is longer is cut there after a whole line,
with a `# Sentry Six Manager: cut here: …` line (download it alone for all of it). The checks, the pairing and the chain
are kept in `<data>/can/<vehicleKey>/trust.json`.

**TLS.** Port 10000 takes TLS 1.3 (the bridge uses only 1.3) and 1.2; older
versions are refused. A client that sends its headers slower than 20 s, or
one request longer than 10 minutes, is cut off. One address may hold at most
6 connections at once (256 in all), and a connection that sends no request
within 15 s is closed.

**Reading a log.** Each log is unpacked once, line by line (a columns log is
decoded to those lines first, see Log formats): a line longer than 512 bytes
is skipped, and a candump text log that unpacks to more than 4 GB is stopped
there (what was read before is kept). A crafted file cannot use up the
server's memory. Deleting a log, or no longer using one that failed its
check, takes its data out of the Viewer, the search, the raw view and the
sync. Sync to the footage uses the sidecar's clock pairs and the
`# clock` lines, then refines the offset per drive by matching CAN signals
(brake, blinkers, accelerator, speed) with Tesla's per-frame video data,
aiming for under 20 ms on footage that carries that data.

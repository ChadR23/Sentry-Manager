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
| unsigned | no signature (`"signed": false`, or no `integrity`) from a car that is not paired | yes, with a quiet note ("unsigned") |
| waiting | the sidecar has not arrived (after 10 minutes without it, the log is judged as unsigned) | not yet |

Nothing is decoded for the Viewer, the sync or the search until its check
allows it. Only the log is signed, and everything that matters is in it
(frames, `# clock`, `# helper-clock`, `# dropped`, `# not recorded`); the
sidecar's other fields are an unsigned summary (shown, never trusted).

**The chain.** `index` counts up by 1 per log of a key (from 0) and each log
names the previous one (`prev_name`, `prev_sha256`). For the paired key's
logs the Nerd settings report:

- a gap: indexes that never arrived (`log 41 is missing`);
- a mismatch: a log whose `prev_name`/`prev_sha256` is not the log stored
  here with the index before (swapped, changed or replaced);
- a duplicate index, or a later index that starts before an earlier one
  (reordered);
- a log of the chain that failed its check.

Logs received here and deleted later still count (their record is kept), and
the bridge deleting its own copies after upload is not a break. A new key
starts again at 0.

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
| 507 | `car_full` | This car has 200,000 CAN logs here already (finished logs are counted, not sidecars): the owner deletes old ones in the Nerd settings. |
| 500 | `server_error` | Try again later, with backoff. |

## What happens to the files

Kept under `<data>/can/<vehicleKey>/`, exactly as received; a finished file
cannot be replaced (`409 exists_different`), only added. The Nerd panel lists
them (start, car key, check, size, format and why it was closed, frames and
dropped from the sidecar, in a
box of its own height with a filter by car key, check and text), follows new
uploads, checks and the index live, and can delete one (with the password).

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

**Decoding.** With model3dbc's `Model3CAN.dbc` and, over it, `server/dbc/override.dbc`:
the messages whose layout changed in newer Tesla firmware, checked against a
real car's logs (a message there with no signals has a layout not known yet and
is not decoded; it shows as `unknown`). A frame is decoded only on a bus the
sidecar's bus map (or the default: can0 vehicle, can1 chassis) names, with that
bus's message; the Screenmate's own buses (can2, can3: "screenmate-internal")
are kept and counted, not decoded. A signal name that two messages share has
the message id after it in the decoded data (`UI_cpuTemperature_353`). When the
decoding changes, every stored log is indexed again in the background, each
replacing its own part of its minutes; then whatever an older decoding wrote
for a log that cannot be read again (deleted, not usable) is taken out, and
the CAN-to-footage sync and the archive gap check work out their answers again.

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

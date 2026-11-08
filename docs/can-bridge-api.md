# CAN Bridge upload API (Sentry Six Manager side)

How the Screenmate CAN Bridge app (repo `skittles-fivem/SMO`) sends its CAN
logs to Sentry Six Manager. The log format itself is defined by the app, in
`docs/sentry-manager-format.md` in SMO: `candump -L` lines, xz-compressed,
one file per 10 minutes, with a JSON sidecar.

Sentry Six Manager keeps every log exactly as it arrives, including messages
nobody can decode yet, so a message identified later also works on old
drives. Decoding, syncing to the footage and the on-screen stats are built on
top of the stored logs.

## Turning it on

Off by default: while off, every `/api/can/logs` address answers `404`.

An admin turns it on in the hidden Nerd settings (Settings page: tap the
Version line seven times, then **>_ nerd**). Turning it on, or making a new
token, asks for the password and shows:

- the upload address, `https://<host>:<port>/api/can/logs`;
- the token, once (only its SHA-256 is stored; a new token replaces the old one);
- the server certificate's SHA-256 fingerprint, for the app to pin.

## Rules for every request

- **HTTPS only.** Over plain HTTP the answer is `403 https_only`. The
  certificate may be self-signed: pin it by its SHA-256 fingerprint.
- **Token:** `Authorization: Bearer <token>`. It is write-only: it can call
  the three requests below and nothing else (no footage, no settings).
- No cookies, no `X-Requested-With` header needed.
- Every answer is JSON. Errors are `{ "error": "<words>", "code": "<code>" }`,
  plus `"received"` when it says how far an upload got.

## 1. Check the connection

`GET /api/can/logs/ping`

`200 { "ok": true, "api": 1, "maxChunk": 16777216, "maxFile": 1073741824, "maxSidecar": 1048576 }`

Use it to test the address, token and pinned certificate, and read the limits.

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

- A chunk is at most `maxChunk` (16 MiB). A 10-minute log (about 17 MB)
  takes two chunks; a sidecar always fits in one.
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

## Errors

| Status | `code` | Meaning, what the app does |
|---|---|---|
| 400 | `bad_name`, `bad_offset`, `bad_length`, `bad_sha256`, `past_end`, `bad_request` | The request is wrong; fix it, do not retry as is. |
| 401 | `bad_token` | No token, or not the current one: ask the owner for the new token. |
| 403 | `https_only` | Plain HTTP was used. |
| 404 | `off` / `not_found` | Uploads are turned off, or an unknown address. Try again later (hours). |
| 409 | `offset_mismatch` | `Upload-Offset` is not what the server has: resume at `received`. |
| 409 | `length_changed` | A different `Upload-Length` than the upload already started. |
| 409 | `exists_different` | A different file with this name is complete here: rename (next `seq`) and report it. |
| 409 | `busy` | Another request is uploading the same file: wait and resume. |
| 413 | `too_large`, `chunk_too_large` | Over `maxFile`/`maxSidecar`, or a chunk over `maxChunk`. |
| 422 | `sha256_mismatch` | The finished file did not match its hash; it was discarded. Upload it again from offset 0. |
| 422 | `bad_sidecar` | The sidecar is not JSON; it was discarded. |
| 507 | `no_space` | The server is short of disk space: try again later. |
| 500 | `server_error` | Try again later, with backoff. |

## What happens to the files

Kept under `<data>/can/<vehicleKey>/`, exactly as received. The Nerd panel
lists them (start, car key, size, frames and dropped from the sidecar) and
can delete one. Sync to the footage uses the sidecar's clock pairs and the
`# clock` lines, then refines the offset per drive by matching CAN signals
(brake, blinkers, accelerator, speed) with Tesla's per-frame video data,
aiming for under 20 ms on footage that carries that data.

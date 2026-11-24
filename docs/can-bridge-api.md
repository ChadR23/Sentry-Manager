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

## Car data in the Viewer

The Viewer's car-data bar (the stat blocks under the cameras, the *Every
stat* List, with Move, Customize and Hide; `web/statDash.js`) is part of the
CAN Bridge, **only in the Horizon interface**, and **off by default** there.
Sentry Six, Aurora, Daylight and Flux never show it (each keeps its own
telemetry panel and on-video overlay). While off it is not made at all: no
bar, no List, no *Show car data* button, no room kept for it.

An admin turns it on with the **Car data in the Viewer** switch in the Nerd
settings (one click, no password). It is one setting for the whole server
(`viewerCarData` in the database), audit-logged, and goes to every account
with the bar's own dashboards: `GET /api/dashboards` answers
`carData: { "enabled": true | false }` (watch-only accounts read it too;
`POST /api/can/viewer-car-data` `{ "enabled": true | false }` changes it,
admins only). A Viewer that is open shows or drops the bar at once (the
`carData` topic of `/api/events`), else at the next Viewer. Each browser can
still hide the bar with its own *Hide* button, as before.

A server that had the bar before this setting: the first start with it turns
it **on** once when the server already has CAN data (a CAN Bridge log, a CAN
Bridge token) or a car-data dashboard saved by any account, so a bar in use
stays; otherwise it starts off. After that the choice is kept as set.

## Live stats for a Stream Deck

`GET /api/can/now` gives the car's newest CAN values, so a Stream Deck (or
anything else that reads a web address) can show them on its keys. It is on
the app's own address and port (9000), not the CAN Bridge's port: nothing new
to open. The values are the newest the CAN index has decoded, whether or not
the log is paired with footage yet, so they are as fresh as the CAN Bridge's
last upload (a log is about a minute).

**Off until an admin makes a link** in the CAN Nerd panel (*Stream Deck* →
*Make a link*). The link carries its own read-only token, shown once: it can
only read these values, not footage, logs or settings, and it works without
signing in. *New link* replaces it (the old one stops working) and *Turn off*
removes it; each is in the audit log. Only a fingerprint of the token is kept.

| Request | Answer |
|---|---|
| `GET /api/can/now/<stat>?token=…` | One stat as plain text, with its unit (`78%`, `62 mph`, `42 psi`, `D`); `—` when there is no value yet |
| `GET /api/can/now?token=…` | Every stat as JSON: `{ car, at, ageSec, stale, units, stats: { <stat>: { label, value, unit, text } } }` |

- `units=km` gives km/h, °C and bar (default `mi`: mph, °F and psi).
- `car=` a vehicle's name or id (or a CAN key) for one car; without it, the
  car with the newest data.
- The token can also go in an `Authorization: Bearer` header.
- `stale` is true when the newest value is more than 5 minutes old (the car
  is off or out of reach of the upload).
- Stats: `speed`, `battery`, `range`, `batteryPower`, `gear`,
  `batteryVoltage`, `batteryCurrent`, `batteryTemp`, `outsideTemp`,
  `cabinTemp`, `batteryInletTemp`, `powertrainInletTemp`, `rearMotorPower`, `frontMotorPower`, `rearMotorTemp`,
  `frontMotorTemp`, `lv12Current`, `lv12Power`, `lv12Voltage`, `lv12State`,
  `tire1` to `tire4`, `charging`, `chargingPower`, `chargeTimeLeft`,
  `energyRemaining`, `odometer`, `setSpeed`, `speedLimit`, `elevation`. Each
  is the Viewer's stat of the same name, from the first of its signals the
  car sends.
- Answers are worked out at most every 3 seconds.

**The Stream Deck plugin** (*Download the Stream Deck plugin* in the same
section; its source is `assets/streamdeck/`): open the downloaded
`Sentry Six CAN Stats.streamDeckPlugin` to install it, drag its **CAN stat**
action onto a key, paste the link into the key's settings, and pick the stat
for that key. The link, the units, an optional car and how often to ask
(5 seconds by default) are shared by every key; each key picks its own stat.
A key shows the stat's name, its value big, the unit and how old it is
(dimmed when stale); *Set up* until a link is pasted, and *!* with a short
reason when the server cannot be reached or the link is wrong. Pressing a key
asks again at once. All keys share one request.

The plugin runs on Stream Deck's own Node.js, so Sentry Six Manager's own
certificate needs nothing installed: the link carries a pin
(`pin=ca:<SHA-256>`, the server's local certificate authority; `pin=cert:` for
a certificate of your own; none with Let's Encrypt). The plugin fetches the
authority's certificate once from `/api/can/now/ca.crt` (public, no token;
only while a link is on), keeps it only when its fingerprint is the pin, and
checks every connection's certificate against it before the token is sent.
A key that cannot trust the server says *cert changed* (make a new link after
the certificate authority was replaced) or *cert?*.

Any other plugin that shows the text a web address returns works too, one
key per stat; for those, install the local certificate authority on that
computer first (Settings → Security & HTTPS).

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

## Limits

What port 10000 allows, and what it answers past each limit. A bridge can
rely on these numbers.

**Connections.** Every request carries the token, so a bridge may hold **up
to 32 connections at once from one address** (for example 16 uploads at once
over LTE). Without a valid token an address gets 6.

| Connections from one address | Served when |
|---|---|
| 1st to 6th open at once | every request, as usual (a wrong token gets `401 bad_token`) |
| 7th to 32nd | only a request with a valid token; one without (or with a wrong one) gets the 503 below |
| 33rd and more | every request gets the 503 below |

Which of an address's connections a connection is counts when it opens: one
opened as the 7th needs the token on every request, even after earlier ones
closed. A connection's place is given back when it closes, however it ends.
At most 256 connections are open on port 10000 in all; past that every
request gets the same 503.

The 503 is an answer, never a silent close: the TLS handshake completes, the
request's body is read and dropped (up to 17 MiB, for at most a minute), and
then (a request sent with `Expect: 100-continue` gets it at once instead, without
a `100 Continue` and without its body being read: see
[Expect: 100-continue](#expect-100-continue)):

```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
Connection: close
Content-Type: application/json

{ "error": "Too many connections from this address; try again in a few seconds.", "code": "too_many_connections" }
```

(Past the 256: `"Too many connections to this server; try again in a few
seconds."`.) Wait `Retry-After` seconds, then send the request again, on a new
connection. The server names the address in its log at most once a minute.
Only if 64 such refused connections are already waiting for their 503 is a
further one closed without an answer (also logged once a minute).

**Time limits.** These close the connection without an answer (the client
stopped sending, so there is nothing to answer):

| Limit | Value |
|---|---|
| First byte of a new connection | 15 s |
| TLS handshake | 15 s (TLS 1.3 and 1.2; older versions are refused) |
| A request's headers | 20 s |
| Idle between requests on a kept-alive connection | 20 s |

The body does get an answer: one that sends nothing for **2 minutes**, or is
not all there within **10 minutes**, gets `408 { "code": "timed_out" }` and
its connection is closed.

**Sizes and counts.**

| Limit | Value | Answer past it |
|---|---|---|
| A chunk (`maxChunk`, from `ping`) | 16 MiB | `413`, `code: "error"` (`"That file is too large."`) |
| A request body read at all | 17 MiB | `413`, `code: "error"` |
| A whole log (`maxFile`) / sidecar (`maxSidecar`) | 1 GiB / 1 MiB | `413 too_large` |
| A `status` body / names in it | 1 MiB / 2000 | `413`, `code: "error"` / `400 bad_request` |
| Requests on one file at once | 1 | `409 busy` (with `received`) |
| Unfinished uploads per car | 16 (sidecars count; checked when an upload starts at offset 0; dropped after 2 days) | `429 too_many_partial` |
| Logs per car | 200,000 | `507 car_full` |
| Free disk space to start a file (offset 0) | twice its `Upload-Length` plus 2 GiB | `507 no_space` |
| Requests with one token | 1,200 uploads in 10 minutes (every `POST /api/can/logs/<name>`; `ping` and `status` do not count; the window starts at the first) | `429 slow_down` with `Retry-After` |
| Wrong tokens from one address | 20 in 10 minutes (from the first wrong one); a right token is never refused because of them | `429 slow_down` with `Retry-After` (before that: `401 bad_token`) |

The 503 carries `Retry-After: 5`. A `429 slow_down` carries `Retry-After`
too: the seconds until its 10-minute window ends (up to 600). `429
too_many_partial` has none: finish or resume the unfinished uploads.

### Expect: 100-continue

An upload may be sent with `Expect: 100-continue` (the CAN Bridge sends every
upload that way, holding the body back until `100 Continue` or 3 s). The
server then decides everything the request's headers allow **before it reads
the body**, without reading or hashing any stored file (so a slow disk never
holds up the `100 Continue` past the bridge's 3 s wait):

- A request it serves gets `HTTP/1.1 100 Continue` as soon as those checks
  pass (they read only the request's headers, the upload's state and the
  folder's counts); the bridge sends the body and gets the usual answer.
- A request it refuses without needing the body gets its answer straight
  away, **without** a `100 Continue`, with `Connection: close`: the bridge never
  sends the piece, and opens a new connection for its next request. These are:
  the `503 too_many_connections` of every connection limit; `404 off`, `403
  https_only`, `401 bad_token`, `429 slow_down`, `403 wrong_car`; `400
  bad_name`, `bad_offset`, `bad_length`, `bad_sha256`, `past_end` (from
  `Content-Length`); `413` for a chunk over `maxChunk` or a body over 17 MiB
  (from `Content-Length`), `413 too_large`; `409 busy`, `length_changed`,
  `offset_mismatch`; `507 no_space`, `car_full`; `429 too_many_partial`.
- A request for a name whose file is **all here already** gets `100
  Continue` and its body is read: whether it is the same file (`201`
  `"already": true`), another copy (`409 exists_different`) or a new copy of
  a failed log (see "Replacing a failed log") needs the stored file's
  SHA-256, which is never worked out before the body.

`422 sha256_mismatch`, `422 bad_sidecar`, a swap refused at the last moment
(see "Replacing a failed log") and the answers for a file all here need the
body, so they come after it.
Every check is made again once the body is here, so nothing changes between
the two. Without `Expect` the body is read first, as before (a refused client
is then not reset while it is still sending).

**On the web port (9000).** The same requests work there, under the web
port's own limits: no limit per address (browsers share addresses), 1024
connections in all, and past that the same `503 too_many_connections` with
`Retry-After: 5` (64 waiting at most, as above). There the first byte and
the TLS handshake have 15 s each, and headers and idle time 120 s over
HTTP/1.1; the body limits and every answer above are the same. The bridge
should use port 10000.

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

`200 { "ok": true, "api": 1, "vehicleKey": "MY-car", "maxChunk": 16777216, "maxParallel": 8, "maxFile": 1073741824, "maxSidecar": 1048576, "formats": ["canbridge-candump-xz/1", "canbridge-columns-xz/2"] }`

Use it to test the address, token and pinned certificate, and read the limits.
`formats` lists the log formats this server reads (see Log formats). The
bridge writes `canbridge-columns-xz/2` only while it is listed, and goes back
to candump text if a later `ping` stops listing it (an older server, which
answers no `formats`, gets candump text).

`maxParallel` (8) is how many uploads the bridge should send at once. It is
half of the 16 unfinished uploads a car may have (`429 too_many_partial`), so
even 8 uploads cut off earlier and not resumed yet leave room for 8 new ones,
and 8 uploads with a `status` or `ping` beside them stay far under the 32
connections one address may hold with a token (see Connection limits). An
older server answers no `maxParallel`. A bridge that has no answer from
`ping` (for example a 503) should not send more than 8 at once either: with
up to 8 earlier uploads still unfinished, more than 8 new ones would get
`429 too_many_partial`. `ping` and `status` themselves need no share of
`maxParallel` (they never leave an unfinished upload behind).

### Connection limits

A recap of Limits above, for the bridge:

- **6** connections at once from one address without a valid token, **32**
  with one (every bridge request carries it), **256** on port 10000 in all
  (1024 on the web port, with no limit per address).
- Past a limit the request is answered, never dropped:
  `503 { "code": "too_many_connections" }` with `Retry-After: 5` and
  `Connection: close`. Wait 5 seconds, then send again on a new connection.
  With `Expect: 100-continue` the 503 comes before the body is sent (see
  [Expect: 100-continue](#expect-100-continue)).

## 2. Which files are already here

`POST /api/can/logs/status` with `Content-Type: application/json`:

```json
{ "names": ["MY-car_20261108T143000Z_1.log.xz", "MY-car_20261108T143000Z_1.log.xz.json"] }
```

Up to 2000 names per request (the app asks about up to 500). Answer `200`:

```json
{ "files": {
  "MY-car_20261108T143000Z_1.log.xz":      { "state": "complete", "received": 1834221, "length": 1834221, "size": 1834221, "check": "verified" },
  "MY-car_20261108T143000Z_1.log.xz.json": { "state": "complete", "received": 2310,    "length": 2310,    "size": 2310,    "check": "verified" },
  "MY-car_20261108T143100Z_2.log.xz":      { "state": "complete", "received": 1790112, "length": 1790112, "size": 1790112, "check": "failed", "check_reason": "mismatch" },
  "MY-car_20261108T143200Z_3.log.xz":      { "state": "partial",  "received": 4194304, "length": 17825792, "size": 17825792 },
  "MY-car_20261108T143200Z_3.log.xz.json": { "state": "missing",  "received": 0,       "length": null,     "size": 0 }
} }
```

- `complete`: all here, its SHA-256 matched; do not send again (but see
  `check`).
- `partial`: an upload was started; resume at `received`. A new copy of a
  failed log that is still arriving is `partial` too (see below).
- `missing`: send it from offset 0.
- `invalid`: the name is not a CAN Bridge log name (see Names).
- `forbidden`: another car key's file (a token is for one car). A token not
  tied to a car yet is tied by a `status` whose names are all one car key's;
  asked about two or more car keys' names at once, it stays untied and every
  valid name answers `forbidden` (the first upload ties it).

Every entry has `size`: the whole file's size in bytes once it is known (the
same as `length`: a `complete` file, or a `partial` one whose upload said its
`Upload-Length`), the bytes received so far for a `partial` upload whose
length is not known (`length` null), and `0` for a `missing`, `invalid` or
`forbidden` one.

**`check`** (only on `complete` files) says whether the log was received
intact and verified (see Signatures and pairing). A sidecar answers its log's
check.

| `check` | Meaning | `check_reason` |
|---|---|---|
| `verified` | the stored log's whole-file SHA-256 and length are the sidecar's, the ECDSA P-256 signature is valid for the car's paired key, and its chain link fits: `prev_name` `-` only at index 0 with `prev_sha256` 64 zeros, otherwise the log it names, when that is here, has that SHA-256 and the index before, by the same key | none |
| `failed` | any of those failed | `mismatch`: the stored log's SHA-256 or length is not what was signed; `bad_signature`: a bad signature, signed by a key this car is not paired with or for another car key, or unknown version, algorithm or key; `chain_break`: the chain link does not fit (or the chain fields are bad); `unsigned`: not signed (its sidecar is here and says `"signed": false`, or has no `integrity`), also from a car that is not paired yet |
| `pending` | not checked yet: its sidecar has not arrived (however long ago the log came: the server itself treats a log with no sidecar after 10 minutes as not signed, but tells the bridge `pending` until the sidecar is here), the check is still running (it starts as the log or its sidecar is complete), a new copy waits to be checked, or the log it names as its previous is here but not checked yet (or its sidecar has not arrived: unsigned logs are not part of the chain, so its link is checked once that sidecar is here). Ask again on the next round | none |

The check is made once, when the log or its sidecar is complete (and again
when the car's key is trusted, or a failed log is replaced), and kept in the
car's `trust.json`; `status` reads it, so asking about 500 names never hashes
a file. A previous log that is not here (not sent yet, or lost on the bridge)
or that failed its own check does not make the next one fail: the Nerd
settings report gaps, duplicates and reorders in the chain.

**A chain break from the previous log.** `chain_break` is also answered for
a log whose own copy is good (its SHA-256, length and signature check out)
when the log it names as its previous is here with another SHA-256 or index:
the fault may be the previous log's. That log is never replaced (resending it
answers `201` `"already": true` for the same bytes, `409 exists_different`
for others: the good copy is kept). Its `chain_break` clears once the
previous log here is replaced by the copy it names (or that previous log's
own check fails, which never makes the next one fail).

**Replacing a failed log.** A log whose check is `failed` stays on the car,
and the app's *Resend all* sends it (and its sidecar) again under the same
name. While the stored log's own check is failed (`mismatch`,
`bad_signature`, a `chain_break` from its own bad chain fields, or
`unsigned` with its sidecar here), a different copy of the log or of its
sidecar is taken in its place: it is uploaded as usual (offset 0, then
resumed; `status` answers `partial` meanwhile), the old copy stays until the
new one is all here and its SHA-256 matched, then the new one replaces it
(`201` with `"replaced": true`), its check is `pending` and it is checked
again. Until that check is made, only the other half of the pair (the
sidecar after its log, or the log after its sidecar, sent right after or at
the same time) is still taken in place of the old one, once, so send both
halves; the half already replaced answers `201` `"already": true` for the
same bytes and `409 exists_different` for any other copy. If the new copy
cannot be read when it is checked, its check stays `pending` and neither
half is taken until it is checked again: a different copy of either half
meanwhile gets `409 busy` (with `"received": 0`), not `exists_different`,
so send it again later from offset 0; once checked, the same rules apply
again. Whether the old copy may be replaced is decided again, at the moment
of the swap, from the stored check: if it was verified meanwhile (the owner
trusted the car's new key), the new copy is dropped and the answer is `409 exists_different`. The
log's data is taken out of the index first (it was only indexed if the owner
used it anyway; that choice is dropped with the old copy). A log whose check
is `verified`, `pending` for any other reason, or `failed` only by a
`chain_break` worked out from the previous log (above) is never replaced: a
different copy gets `409 exists_different`. Sending the same bytes again
answers `201` with `"already": true`, as before, for any check.

**Logs deleted here.** A log the server deleted on purpose (the owner's
delete in the Nerd settings, *Keeping logs*: with its footage deleted for
good, older than the car's oldest footage, not linked to footage after N
days, and "Also delete its CAN data" with footage moved to the Recycle Bin)
leaves a **tombstone** in its car's `trust.json`: its name, size, SHA-256,
its sidecar's size and SHA-256, the `check` it had (a log not checked yet is
checked before it is deleted), when and why it was deleted, and when it
ended (the sidecar's `end_wall_ms`, else ten minutes after its start, the
longest a log runs). A log that vanished without the server deleting it (a
crash, a lost or replaced disk, a file removed by hand) has none: it is
`missing`, and the bridge may send it again. That includes a log a rule
went to delete and found already gone (`404`): its record is kept for the
chain and marked `lost`, never tombstoned.

For a name with a tombstone and no file here, `status` answers:

- **deleted by the owner** (by name in the Nerd settings, or with its
  footage: "Also delete its CAN data"), or **by a rule whose reason holds
  for good** (*Keeping logs*: not linked to footage after N days, or with its
  footage deleted for good): never asked for again, whatever footage the car
  keeps: `complete`, with the size it had (`received`, `length` and `size`)
  and its `check`: `verified` counts as delivered (the bridge may delete its
  copy); `failed` with its `check_reason` (the bridge keeps it and lists it;
  only a *Resend all* sends it again, see below). A check that was never
  made answers `missing`. Its sidecar answers the same, with the sidecar's
  size (`missing` when its size is not known). (A log not linked to footage
  that was sent again would be kept, still linked to nothing, and deleted
  again by the same rule N days later, every time; footage deleted for good
  never comes back. Before this version these went by the footage kept, as
  below, and answered `missing` inside it);
- **deleted by a rule that goes by the footage kept** (*Keeping logs*:
  older than the car's oldest footage; and the tombstones worked out for
  logs deleted before this update, below, whose rule is not known): by the
  car's **oldest footage kept** (its clips on the share in the footage
  index, and its protected clips; not the Recycle Bin, which counts as
  deleted here; the car is the one the key is chosen for, or the only car):
  - the log ended **at least an hour before** the start of that oldest clip
    (the margin of the rule "older than the car's oldest footage": clip
    names are read in the car's time zone, which may be wrong or missing),
    or its car has no footage at all:
    `complete`, as above;
  - otherwise, **inside** the footage kept (footage of its time may be kept
    again, for example a clip restored from the Recycle Bin): `missing`, so
    the bridge may send it again. It is then stored and checked as a new
    log, and its tombstone goes;
  - while that cannot be told (the share away, a scan running or failed,
    the settings unreadable, or no car is the key's: not chosen with two or
    more cars, chosen for a car since removed, or no car to be seen at all,
    for example while the only car is removed to be added again): `complete`
    with `check: pending`; ask again.

**A deleted log sent again** that counts as delivered (above) is taken as
any upload (`201`, offsets and limits as usual), checked as any log (its
SHA-256, signature and chain link, once both halves are here), the result
kept on its tombstone (`verified`, or `failed` with its reason), and deleted
again: it is never indexed, listed or counted. A copy that fails answers
`failed` again, and a resend is checked again the same way. A sidecar sent
without its log is kept at least 10 minutes for the log, then dropped by
the next background pass (below; its size noted). **Another copy** under
the name (a log or sidecar of another size or SHA-256 than its tombstone
recorded) gets `409 exists_different` after its body, as for a file stored
here, and is dropped: the tombstone and the record the next log's chain
link goes by stay as they were. (A sidecar's size and SHA-256 are known for
logs deleted since this version; for older ones once a sidecar was sent
again.)

**Logs from before tombstones and checks.** On the first start after this
update the server works out, once per car key (`tombstonesV` in
`trust.json`), tombstones for logs it deleted before: only from records
`trust.json` marked deleted of logs received complete and checked (their
SHA-256 and length), whose file is not here. An older server marked a
record deleted in the purposeful deletes above, after deleting the files,
and also when its rule found the file already gone (`404`); those two cannot
be told apart in its records, so such a log is tombstoned too (a rule had
decided to delete it anyway). Every other record of a log that is gone gets
none, so that log stays `missing` and may be sent again. These records hold
no sidecar size (and the bridge's `chain.json` is not here), so the
sidecar of such a tombstone answers `missing`, never a guessed size: a
bridge that still has it sends it once, and it is noted and dropped. Until
this has run for a car key (just after a start), a name whose record says
deleted answers `complete` with `check: pending` (its record's length, 0 for
its sidecar), never `missing`. The log says how many were tombstoned and
how many were left missing. Logs here without a check (from before the
checks, or still waiting), and copies here whose record still says deleted,
are checked in the background from 15 s after start (4 at a time, with a
pause between), never holding up the start or the uploads; `status` answers
them `pending` until then.

**Failed for good until the owner acts.** A *Resend all* changes nothing for
a log whose stored copy is the bridge's own (the same bytes answer `201`
`"already": true`) when its check failed for a reason the copy cannot fix:
`unsigned` (the car is not paired, or the sidecar says `"signed": false`),
`bad_signature` for a key this car is not paired with (an app reinstalled
with a new key), or a `chain_break` from the previous log. Its check stays
`failed` until the owner trusts the key or pairs the car in the Nerd
settings. A bridge that keeps failed logs until they are verified keeps
these until then, even past its own retention limit.

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
  here with the index before (swapped, changed or replaced), nor any other
  copy of that index here;
- a duplicate index, or a later index that starts before an earlier one
  (reordered);
- a log of the chain that failed its check.

Logs received here and deleted later still count (their record is kept, and
their tombstone, see "Logs deleted here"), and
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

**A chain continued from an older sidecar.** When the bridge goes on from the
newest signed sidecar it still has, but newer logs already reached the server
(for example logs 10 to 12 went up from RAM, then RAM and `chain.json` were
lost and it went on from log 9), the new logs repeat those indexes under new
names. Each repeated index is reported once as a duplicate; the log after
them, which names the new copy of its previous index, is not a mismatch.

## Errors

| Status | `code` | Meaning, what the app does |
|---|---|---|
| 400 | `bad_name`, `bad_offset`, `bad_length`, `bad_sha256`, `past_end`, `bad_request` | The request is wrong; fix it, do not retry as is. |
| 401 | `bad_token` | No token, or a revoked one: ask the owner for a new token. |
| 403 | `https_only` | Plain HTTP was used. |
| 403 | `wrong_car` | This token is for another car key. |
| 429 | `slow_down` | Too many wrong tokens from this address (20 in 10 minutes), or more than 1,200 uploads in 10 minutes with one token (`ping` and `status` do not count): wait `Retry-After` seconds (the rest of the 10 minutes). A right token is never refused because of wrong ones. |
| 429 | `too_many_partial` | 16 unfinished uploads for this car already (sidecars count; checked when an upload starts at offset 0): finish or wait (unfinished uploads are dropped after two days). |
| 408 | `timed_out` | The body sent nothing for 2 minutes, or was not all there within 10 minutes; the connection is closed. Resume (ask `status`). |
| 503 | `too_many_connections` | Too many connections from this address (6 without a valid token, 32 with one) or to the server (256). Comes with `Retry-After: 5` and `Connection: close`: wait that long, then send again on a new connection. |
| 404 | `off` / `not_found` | Uploads are turned off, or an unknown address. Try again later (hours). |
| 409 | `offset_mismatch` | `Upload-Offset` is not what the server has: resume at `received`. |
| 409 | `length_changed` | A different `Upload-Length` than the upload already started. |
| 409 | `exists_different` | A different file with this name is complete here and its stored check did not fail (a failed log is replaced instead; see "Which files are already here"; a `chain_break` from the previous log is not this log's failure): rename (next `seq`) and report it. |
| 409 | `busy` | Another request is uploading the same file, or a replaced log is waiting to be checked again: wait and resume at `received` (`0` for the latter: start again). |
| 413 | `too_large` | Over `maxFile`/`maxSidecar`. |
| 413 | `error` | A chunk over `maxChunk` (16 MiB), a body over 17 MiB, or a `status` body over 1 MiB. Send smaller chunks. |
| 422 | `sha256_mismatch` | The finished file did not match its hash; it was discarded. Upload it again from offset 0. |
| 422 | `bad_sidecar` | The sidecar is not JSON; it was discarded. |
| 507 | `no_space` | The server is short of disk space: starting a file (offset 0) needs twice its `Upload-Length` plus 2 GiB free. Try again later. |
| 507 | `car_full` | This car has 200,000 CAN logs here already (finished logs are counted, not sidecars): a safety net only (see "How long logs are kept"); the owner deletes old ones in the Nerd settings. |
| 500 | `server_error`, `error` | Try again later, with backoff (`error` when the server's database failed). |

## What happens to the files

Kept under `<data>/can/<vehicleKey>/`, exactly as received; a finished file
cannot be replaced (`409 exists_different`), only added, but for a log whose
check failed, which a resent copy replaces (see "Which files are already here"). The Nerd panel lists
them (start, car key, check, size, format and why it was closed, frames and
dropped from the sidecar, in a
box of its own height with a filter by car key, check and text), follows new
uploads, checks and the index live, and can delete one (with the password; it leaves a tombstone, and the bridge is never asked for it again, see "Logs deleted here").

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
  sync, its trust record kept as deleted for the chain, and a tombstone so
  the bridge is not asked for it again (a log not linked to footage or with
  its footage deleted for good: never; one older than the footage: while it
  is older than the footage kept): see "Logs deleted here"; a log already gone gets none), with one audit line a
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
These do not come back on a restore, and leave tombstones: the bridge is
never asked for them again (see "Logs deleted here"). Minutes that footage still on the share
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
| `GET /api/can/export/bundle?key=&from=&to=[&candump=1]` | A `.zip` (streamed) of that car key's logs and sidecars that start in the range (plus the one running at its start), and, after them, `ids.csv` (every CAN id seen: bus, id, DBC message or `unknown`, frames, Hz, first and last seen, minutes, from the index's frame counts) and `manifest.json` (each log's `format` and check). `candump=1` adds each log as candump text (`….log`) beside it (about 10 MB a minute; a log that cannot be read gets a one-line `#` note instead). Any time range, any number of logs and any size: past 4 GB or 65,535 files it is a Zip64 archive, which Windows File Explorer, macOS Archive Utility, 7-Zip and `unzip` open. `check=1`: what it would hold, as JSON. |
| `GET /api/can/export/decoded?key=&from=&to=&signals=[&mode=changes\|every]` | The decoded signals as CSV (`timestamp_utc,signal,value,unit,value_name`), streamed, gzipped when the browser accepts it. `mode=changes` (the default without `signals`): a value when it changes, and once a minute while it stays the same. `mode=every` (the default with `signals`): every point the index keeps (a change, and once a second). At most 24 hours and 5,000,000 rows. `check=1`: `{ mode, minutes, estimatedRows, rowLimit, willStop }` before downloading. A cell that starts like a formula (`= + - @`) is written with a `'` first. |
| `GET /api/can/export/new-ids?key=&since=[&format=csv]` | CAN ids first seen on or after `since`, with the DBC message or `UNKNOWN`, from per-day id summaries the index keeps (always complete). |

**Decoding.** Each car with the DBC set of its model and year (below, "Car
models and years"). A Model 3 or Y (every year, and the default when nothing
is known): model3dbc's `Model3CAN.dbc`, then the messages it lacks from opendbc
that checked out on a Model Y (`dbc/model3y-opendbc.dbc`), and over them `dbc/override.dbc`:
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

The sets (`server/canDbc.js` PROFILES; files in `dbc/`, each source's
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
Index r5 added the DC-DC converter's 0x2B4 in the Model 3/Y set (its layout
changed: read as model3dbc says, the 12 V bus was 22 V and the current jumped
between 1.5 and 360 A): `PCS_dcdcLvOutputCurrent` (0.1 A, bits 32-43), the
current the 12 V system takes, 72-92 A on a Model Y driving and 20-50 A parked
with the cabin warm; `PCS_dcdcLvBusVolt` (0.01 V, bits 0-11) and
`PCS_dcdcHvBusVolt` (0.1 V, bits 16-27). It only adds signals, so the logs are
decoded again once and what r4 wrote stays. The Viewer shows the first as
"12V system current" (and "12V system power", its volts x amps); the 12 V
battery's own current (`v12vBattCurrent261`, near 0 A while the DC-DC supplies
the car) is "12V battery charge/discharge current". A dashboard saved before
with "12V Battery Current" (that battery's own) shows the 12 V system's current
in its place.

Times are ISO with a zone, or the car's own clock (`YYYY-MM-DD[THH:MM]`).
`check=1` on the bundle and decoded routes answers what they would hold
(JSON) without sending the file; with `candump=1`, `candumpBytes` is the
most candump text it holds: each log's share comes from its sidecar's
`frames` (64 bytes a frame, plus 64 KB), or from its size when it has no
sidecar, and a log whose text is longer is cut there after a whole line,
with a `# Sentry Six Manager: cut here: …` line (download it alone for all of it). The checks, the pairing and the chain
are kept in `<data>/can/<vehicleKey>/trust.json`.

**TLS.** Port 10000 takes TLS 1.3 (the bridge uses only 1.3) and 1.2; older
versions are refused. Its connection and time limits are under
[Limits](#limits): up to 32 connections from one address with a valid token
(6 without), and past that `503 too_many_connections` with `Retry-After: 5`,
never a silent close.

Port 10000 can be opened to the internet on its own (for a bridge that
uploads over LTE; the web port, 9000, only as described in
[Opening Sentry Six Manager to the internet](security.md#opening-sentry-six-manager-to-the-internet)): it serves only this API,
and with Sentry Manager's own HTTPS (the default) every upload is encrypted
by it. With `TLS_MODE=off`, a forwarded `X-Forwarded-Proto: https` on port
10000 counts only from an address on the local network (a reverse proxy
there, with `TRUST_PROXY=true`), never from an internet address.

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

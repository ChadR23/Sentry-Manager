# API contract tools

The tools prove that another server answers the same API: a faster build, a
`manager-fix-N` container or a new backend. They need no packages, only Node.

| File | What it does |
| --- | --- |
| `routes.js` | Reads the source and writes [`docs/api-contract.json`](../../docs/api-contract.json) and [`.md`](../../docs/api-contract.md). They list every route the server defines (method, path, who may call it, file:line), every API call the pages make (`web/`, the Studio pages and the bundled interface packs), the live-update streams with their event names and topics, and the mismatches between them. `--check` exits 1 when the files are out of date. `--print` prints the totals. |
| `fixture.js` | Starts a local server with its own HTTPS on a small, made-up TeslaCam archive. The clips are real H.264 made with ffmpeg, with Tesla telemetry, speed and GPS, and Sentry and Saved events. |
| `record.js` | Asks a running server every read-only GET route and keeps each answer as a golden file. A golden holds the status, the headers that matter and the normalised body. |
| `compare.js` | Asks another server the same questions and prints the differences route by route. It exits 1 when any answer differs. |
| `spec.js` | Says, route by route, what is asked and which fields are normalised. |
| `lib.js` | Shared code: the client, the normalisers and the diff. |

## Record, then compare

```bash
# two servers on the same archive (or the owner's server and a candidate)
node tools/contract/fixture.js --dir /tmp/sm-a --port 18443 &
node tools/contract/fixture.js --dir /tmp/sm-b --port 18444 &   # each waits 75 s to settle, then prints its address

export SM_PASSWORD='contract fixture password'
node tools/contract/record.js  --base https://127.0.0.1:18443 --ca /tmp/sm-a/data/tls/ca.crt --out /tmp/goldens
node tools/contract/compare.js --base https://127.0.0.1:18444 --ca /tmp/sm-b/data/tls/ca.crt --goldens /tmp/goldens
```

- **Passwords go only over `https://`.** The password is read from an
  environment variable (`--password-env`, default `SM_PASSWORD`), never from
  the command line. You can pass a browser's session cookie instead with
  `--cookie-env NAME`; an account with two-step sign-in needs this.
- **Certificates:** `--ca` takes the server's certificate authority (Settings →
  Security → Download certificate authority, or `<data>/tls/ca.crt`). The
  certificate is then checked. `--insecure-self-signed` accepts any
  certificate; use it only for a server on this machine. Nothing is accepted
  silently.
- **Nothing is changed:** only GET routes are called. A route that changes
  something is called only when an `--allow` file lists it, and compare
  replays those only with `--allow-mutating`. Example:
  `[{ "method": "POST", "path": "/api/vehicles/contract-car/scan", "body": {} }]`
  (rescan after changing footage).
- **Coverage:** `record.js` fails when a GET route with parameters is neither
  recorded nor skipped in `spec.js`. A new route therefore cannot slip past
  the gate.

## What is compared and what is normalised

The following are compared exactly:

- clip and recording counts, days, cameras, codecs and sizes;
- per-second speed samples, moments and drives;
- the telemetry frames of every front clip;
- the bytes of every clip (`/api/media`, as a digest) and a Range request;
- error answers (unknown ids, paths outside the shares);
- the settings and catalog answers.

Some values change by themselves, and these are normalised instead:

- **The server's own times.** A time-like key (`at`, `…At`, `…Ms`, …) or an
  ISO stamp in text is replaced only when it is within 30 days of now. The
  car's own times (2024-05-01T08:00:00) stay and are compared. On a real
  archive, footage from the last month is not compared by time.
- **Process figures and per-instance names:** uptimes and session ids, plus
  each server's footage and data folders. The folders become
  `{root:<vehicle>}` and `{data}`, in keys too.
- **The machine itself:** `/api/stats` and the CPU and disk series are
  compared by their names only. The certificate details are compared by their
  shape. Disk free space is replaced.
- **The bodies of a few answers:** downloads such as the certificate
  authority, the interface zip, the support bundle and the logs, and the
  generated images (thumbnails, scrub grids). Their status and headers are
  still compared.

A server also does some things by itself a minute after it starts: the health
self-check, the first database snapshot and the CAN index. Record and compare
only once both servers have done them. `fixture.js` waits for this
(`--settle`).

## Checked here

Each step below was run against two fixture servers, with separate data and
footage folders, ports and certificates:

1. A server compared against its own goldens: 117 of 117 answers the same.
2. A second server compared against the first server's goldens: 117 of 117 the same.
3. The second server's footage was changed: one camera file was removed, one
   front clip was remade with other speeds, and it was rescanned with an
   allow-listed POST. Compare then exited 1: 12 of 77 routes differed. The
   differences covered clip counts, bytes, the media digest, telemetry
   frames, speed samples, moments and drive distance.

A rewritten clip with the same size and file time is not noticed by the
server: speeds and telemetry are cached by size and time. Only its bytes
(`/api/media`) differ until the time changes.

`test/contractTools.test.js` covers the normalisers, the diff, the
extraction and a record/compare round trip against a fake server. It needs
about a second. `test/fixtures/contract/` holds a small sample of goldens
from the fixture.

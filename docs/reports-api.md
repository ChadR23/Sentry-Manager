# Reports API (v1): feedback and diagnostics to the developers

[← Back to the README](../README.md)

Sentry Six Manager can send feedback and diagnostics to its developers.
**It is opt-in only**: nothing is sent unless an admin turns on *Share
diagnostics with the developers* (Settings → Help & feedback) or presses
Send for one feedback message or one support report. Reports go only to the
developers' receiver, never to a third party. The receiver is the owner's
private service and is not part of this repository; this page is the wire
protocol the Manager speaks to it. What the user sees is in
[security.md](security.md#reports-to-the-developers-off-by-default).

| Piece | Where |
|---|---|
| The endpoint and the receiver's key | `server/reportsConfig.js` (the one place to change them) |
| The protocol (sealing, signing, proof of work, schema) | `server/reportsProtocol.js` (the receiver keeps its own copy; both change together) |
| The sender: outbox, retries, crash notes, daily summary | `server/reports.js` |
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
  kind: 'feedback' | 'support' | 'crash' | 'daily',
  sentAt: '2026-11-11T18:40:19.475Z',
  install: '<32 hex: a random id made once per install>' | 'ANON',
  anonymous: true | false,          // true exactly when install is 'ANON'
  build: { build: 131 | null, sha: '<hex>' | null, builtAt: string | null, tag: string | null },
  ui: 'original' | '<interface pack id>',
  message: '…',   // feedback: required, 1-5000; support: the optional "what's wrong" note, up to 1000
  contact: '…',   // feedback only, never when anonymous, up to 200
  crash: { at, name, message, stack, source: 'crash' | 'error' },   // crash only
  diagnostics: { system, storage, counts, jobs, converter, settings, features, health, logs, crashes, can, sentryUsb, nodes, errors }
}
```

Exactly these fields, types and lengths (`validatePayload` in the protocol
module; the Manager checks its own reports with it before sealing, the
receiver checks them after opening). `diagnostics` is required for support,
crash and daily, optional for feedback; each part is free-form JSON within
bounds (10 levels, 60,000 fields, strings up to 40,000 characters, lists up
to 5,000).

What diagnostics hold: OS, kernel, architecture, CPU model and cores, memory,
container limits (cgroup), GPUs and encoders, the ffmpeg and Node versions,
uptime, free space for `/data` and each footage root; counts of vehicles,
recordings, jobs and recent job outcomes; the converter's state and settings;
settings with every secret removed; which features are on (CAN, Sentry USB
paired and its version, the interface pack, nodes, metrics, TLS mode); the
health checks; the last 200 warnings and errors of the past week; recent
crash stacks; the CAN index's status.

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

A report that cannot be delivered waits, sealed (never plaintext), in
`data/reports/outbox`: at most 20 reports and 50 MB, 7 days, retried with
backoff (from a minute, doubling, up to 6 hours, or the receiver's
`Retry-After`). A report refused for good (400 other than `POW`/`TIME`, 403,
413) is dropped. Turning *Share diagnostics* off drops the crash and daily
reports still waiting.

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

# Privacy: what Sentry Six Manager collects

[← Back to the README](../README.md)

*Last updated: 12 November 2026.*

Sentry Six Manager runs on your own hardware. Your footage, maps, vehicles,
accounts and settings stay there. This page lists everything that leaves
your server: what goes out without being asked, and what goes to the
developers only when an admin opts in.

## In short

- **Nothing goes to the developers unless an admin opts in.** Sharing is off
  by default. Pressing **Send** on one message or one support report is
  consent for that one report only.
- **Without opting in**, Sentry Six Manager makes only these outside
  connections: an update check, and the map tiles your browser loads when you
  open a map. Neither one carries your footage, settings or anything about
  your cars.
- **Never sent, in any report:** your footage, video frames, thumbnails,
  passwords, tokens, keys, cookies, share credentials, webhook URLs or TLS
  private keys.
- **Anonymous mode** replaces every identifier with `ANON`. Anonymous reports
  are signed with a separate key, so they can't be tied to your install.

## 1. Without opting in

These happen with sharing off. None of them send anything to the developers.

| What | Where it goes | What it reveals | How to stop it |
|---|---|---|---|
| **Update check**, twice a day | GitHub's container registry (`ghcr.io`) | It asks which image versions exist. Like any web request, it reveals your IP address. The request names the app (`sentry-six-manager`). | Set `UPDATE_CHECK=off` |
| **Map tiles**, when you open a map in your browser | OpenFreeMap (`tiles.openfreemap.org`), and Google for satellite view | Your browser's IP address and the map area you're looking at. Your server sends nothing. | Don't open map views |
| **HTTPS certificate**, only if you choose automatic HTTPS | Let's Encrypt | Your domain name | Use another TLS mode |

Encoding nodes and Sentry USB talk to your server directly on your own
network.

## 2. When an admin opts in

Opting in happens in **Settings → Help & feedback**, which only admins can
use. **What will be sent** shows the exact report before it goes. Sending
asks for your password, and every change to these settings is recorded in
the audit log.

### a. You press Send (one report each time)

| Report | What it contains |
|---|---|
| **Feedback** | Your message (up to 5,000 characters). Optionally your contact details, never in anonymous mode. Optionally diagnostics (below), if you tick the box. |
| **Support report** | Your optional "what's wrong" note (up to 1,000 characters) and diagnostics (below). You get a reference code like `SR-7K2Q9F`. |

At most 5 of each an hour.

### b. "Share diagnostics with the developers" is on

The switch is off until an admin turns it on, either here or on the
first-start page. It sends:

| Report | When | What it contains |
|---|---|---|
| **Heartbeat** | When sharing is turned on, 10–60 s after each start, then about hourly | The short list in [The heartbeat](#the-heartbeat) |
| **Daily summary** | Once a day | Diagnostics (below) |
| **Crash report** | After a crash or an unhandled error | The error's name, message and stack trace, plus diagnostics. At most one an hour for the same error, and 6 a day. |

Turning the switch off stops these and deletes any still waiting to be sent.

### Every report also carries

- **A random install id**, made once per install. Anonymous reports say
  `ANON` instead.
- **The build:** its number, commit, build date and tag.
- **The interface** you use.
- **When it was sent.**
- **A signature** from a key made on your server, which never leaves it.

### Diagnostics

Diagnostics are part of support, daily and crash reports. They hold:

- **The system:** OS, kernel, CPU model and cores, memory, container limits,
  GPUs and encoders, the ffmpeg and Node versions, and uptime.
- **Free space** for `/data` and each footage location.
- **Counts:** vehicles, recordings and jobs, with how recent jobs ended.
- **The converter's** state and settings.
- **Your settings**, with every secret removed.
- **Which features are on:** CAN, a paired Sentry USB and its version, the
  interface pack, nodes, metrics and the TLS mode.
- **The health checks** and the CAN index's status.
- **The last 200 warnings and errors** from the past week, and recent crash
  stack traces.

Log lines and settings can contain names, such as your server's host name,
share paths or vehicle names. **Send anonymously** replaces these with `ANON`
everywhere, including inside log lines and stack traces: the install id, host
names, IP and MAC addresses, account names, vehicle names and ids, share hosts,
paths and user names, Sentry USB names and addresses, Wi-Fi names, VINs,
e-mail addresses, GPS coordinates, place names, and the hosts of private URLs.

### The heartbeat

The heartbeat is a short list of numbers, yes/no values and fixed words. It
never contains names, paths, addresses, places or VINs, even when sharing
isn't anonymous. **Show a heartbeat** in Settings shows the one your server
would send now.

- **Uptime:** how long the app has been running.
- **Health:** ok, warning or problem, with the number of warnings and
  problems.
- **Vehicles:** how many vehicles are set up.
- **Footage:** its total size, how many recordings, its total length in
  hours, and the space saved by conversions.
- **Distance driven:** one total across all your footage. No routes or
  places.
- **Storage:** free and total size.
- **Converting:** whether a conversion is running, and how many jobs are
  waiting.
- **Features:** CAN on or off, Sentry USB paired or not, GPU available or not.
- **Clips:** how many arrived in the last 24 hours, Sentry and dashcam
  counted separately.
- **Crashes:** how many in the last 24 hours.
- **Conversion speed:** frames per second, with the encoder, API, codec and
  device used.
- **Hardware:** the CPU model, the GPU models, the OS type (`linux`) and the
  architecture (for example `x64`).
- **Host type:** one word, such as TrueNAS, Unraid, Synology, Ubuntu or
  Raspberry Pi, and whether the app runs in Docker. Never a host name or
  version.
- **Car models:** one of Model 3, Model Y, Model S, Model X or Cybertruck for
  each car, or empty if unknown.
- **Encoding nodes:** for each paired node, only its CPU and GPU models and
  its conversion speed. Never its name or address.

## Never sent

These are never in any report, anonymous or not:

- footage, video frames and thumbnails;
- passwords, tokens, API keys, cookies, link keys and webhook URLs;
- share credentials and TLS private keys.

Values stored under such names become `[removed]`. Secrets written inside
text are cut out too: PEM blocks, `user:password@` in URLs, Bearer headers,
`password=` pairs, session cookies and tokens.

## Where reports go, and who sees them

Each report is encrypted on your server for the developers' receiver
(`reports.skittles.live`) before it leaves (X25519 + AES-256-GCM). It is sent
over HTTPS. Reports go to these places:

- **Cloudflare**, the receiver's network provider, carries the connection. It
  sees your IP address but only encrypted data.
- **The developers' receiver**, a private server run by the developers, opens
  and stores the reports. The developers and their support staff can read
  them on a private page reached only over their own network.
  - Your IP address is never stored as is: only a keyed hash, used for rate
    limits and blocking abuse.
  - Stored reports are encrypted.
- **A private staff channel on Discord.** For each feedback, support, crash
  and daily report, a short notice goes to this channel: the kind, build,
  reference code, the first 8 characters of the install id (or `ANON`) and
  the start of the message. For a **support report**, the whole report goes
  to the channel as a file, with secrets stripped a second time. Heartbeats
  are never posted to Discord.
- **Anthropic (Claude).** A support assistant built on Claude, Anthropic's
  AI, reads support reports in that staff channel. It writes a first triage
  for staff: what the evidence shows, and what to ask you. Keys and passwords
  are removed before Claude sees anything.
- **GitHub issues (public).** If a support report reveals a bug, the
  assistant can draft a GitHub issue. Staff decide whether to file it. An
  issue holds only the relevant, scrubbed evidence, never the whole report.
  Issues in the project's repository are public.

Reports are not sold, not used for advertising, and not given to anyone else.

## How long it's kept

| What | Kept for |
|---|---|
| Reports | Until removed by the developers, or until 20,000 newer reports have arrived |
| Heartbeat history per server | Hourly samples for 7 days, daily samples for 120 days |
| A server's latest heartbeat | Until the server has been silent for 400 days |
| Reports waiting on your server to be sent | At most 7 days (20 reports, 50 MB), encrypted |
| Discord messages | Until deleted by the developers |

## Your choices

- **Turn sharing off** at any time in Settings → Help & feedback. Nothing more
  is sent, and anything still waiting is deleted.
- **Send anonymously** so that reports can't be tied to your install.
- **Check before sending:** **What will be sent** and **Show a heartbeat**
  show the exact JSON.
- **Ask for deletion.** Settings → Help & feedback → **Your data** shows
  this install's **install code** (8 characters, with a Copy button) and the
  reference codes (`SR-…`) of the reports it sent. Quote either one, and the
  developers will remove that install's reports and heartbeat history.
  Heartbeats have no reference code, so for a server that only shares
  heartbeats the install code is the way. Anonymous reports and heartbeats
  can't be tied to an install: an anonymous report can only be found by its
  own reference code.

The full technical description is in [reports-api.md](reports-api.md), and
the settings are explained in
[security.md](security.md#reports-to-the-developers-off-by-default).

# Sentry Six Manager

Watch, convert and look after your Tesla's dashcam archive from any browser.
Sentry Six Manager runs on your NAS or home server in Docker. It brings the
[Sentry Studio](https://github.com/ChadR23/Sentry-Six) viewer and converter to
the web, and adds what an always-on archive needs: vehicles on SMB shares, a
Recycle Bin, retention policies, jobs and notifications.

![The Viewer: six cameras with the telemetry dashboard](docs/images/viewer.png)

*Screenshots use generated demo footage.*

- **Viewer.** All six cameras in sync, with the telemetry dashboard (speed,
  gear, Autopilot, blinkers, steering, G-force) and the map. The cameras
  stream over one HTTP/2 connection and keep pace with each other (a camera
  that falls behind on a slow network catches up), and the server reads the
  telemetry from the share, so the browser never downloads a clip twice.
  It picks the HW3 (four cameras) or HW4 (six cameras) layout from the
  footage itself, so there is nothing to set.
- **Encoder.** Converts footage to H.265 or AV1 on the GPU (NVIDIA, AMD
  including APUs, Intel) or the CPU. Tesla's per-frame telemetry is copied
  into every converted file and verified, and nothing is converted twice.
- **Footage.** Every recording per vehicle, by day, with a blue badge for
  what is already encoded, filtered by category and date, with Play, Protect
  and Move to trash.
- **Recycle Bin and policies.** Old recordings move to the Recycle Bin on a
  schedule. Nothing is ever deleted unless you empty it yourself.
- **Secure by default.** HTTPS only, with its own certificate (nothing to
  install on your devices), SMB 3 shares that are always signed and
  encrypted, and a web app that never runs as root.
- **Phones and tablets.** iPhone 14 and newer, Galaxy S22 and newer, and
  iPads from 2022 on.

## Install

You need Docker with the Compose plugin.

```bash
mkdir sentry-six-manager && cd sentry-six-manager
curl -fsSLO https://raw.githubusercontent.com/skittles-fivem/Sentry-Manager/main/docker-compose.yml
docker compose up -d
docker logs sentry-six-manager
```

The log shows two things you need once:

- the **setup code**. Open `http://<server>:9000` (or `https://`), enter the
  code and choose your user name and password. Without the code nobody can
  create the account, not even someone who reaches the page before you.
- the **certificate fingerprint**. Everything goes over HTTPS with Sentry
  Six Manager's own certificate, so the first time on each phone, tablet or
  computer the browser shows a warning: continue past it once (the page at
  `http://<server>:9000` shows how for each browser), and compare the
  fingerprint if you want to be sure it is your server. Nothing needs to be
  installed on the devices (see [Security](#security)).

Then go to **Settings → Add vehicle**. Everything else is set up in the web
page; an optional `.env` file (see [`.env.example`](.env.example)) can create
the account or a first vehicle up front, and set the time zone.

To use a GPU, uncomment its block in `docker-compose.yml` (see [GPU](#gpu)).

## Overview and Footage

![Overview](docs/images/overview.png)

The overview shows each vehicle's archive, the free space on its share and
the Recycle Bin.

**Server** (under the vehicle cards, behind the *Nerd stats* switch) shows
what the machine is doing, live, so you don't need Glances or another tool:

- **CPU**: model, cores, total and per-core use, clock, temperature, load,
  and how much of it this app and its conversions use.
- **GPU** (Intel, AMD and NVIDIA, one tile each): busy and video-engine use,
  memory, clock, temperature, watts.
- **Power**: CPU and GPU watts, kWh today and this week, and the cost when
  you enter your electricity price in Settings → System.
- **Memory, storage** (each disk's reads, writes and temperature; space and
  answer time of the data volume and every footage share), **network** and
  every **sensor** and fan the server reports.
- **Alerts** for a hot CPU, GPU or disk, a disk almost full, a slow or
  unreachable share, and low memory; they also go to Notifications.
- **History**: the last 24 hours, and a CSV download.

It only measures while a page shows it or a conversion runs, and every
number stays on the server. A tile appears only when the server provides its
numbers. CPU watts come from the CPU's energy counters, which
`docker-compose.yml` passes in read-only by default
(`- /sys/devices/virtual/powercap:/host/powercap:ro`; an older compose file
needs that line added, and a Raspberry Pi has no such counters, so delete
the line there if Docker says the path does not exist). One optional line
adds the whole server's processes and network (`pid: host`); it also lets
the container see and signal the server's processes, so use it only with a
PUID/PGID of its own.

![Footage](docs/images/footage.png)

**Footage** shows one card per day, newest first, with the newest day
open: a thumbnail (the day's first Sentry or Saved event, else its first
drive), its drives and events, how long and how big it is, and a blue
**Encoded** badge once its recordings are converted to H.265 or AV1
(*Encoded 1/4* while only some are; the codec is read from each clip's MP4
header). For the whole day:

- **Play day** opens the Viewer on that day.
- **Delete this day** and **Delete through this date** (that day and every
  older one) move its recordings to the Recycle Bin. You see how many and
  how big first; protected recordings stay, and nothing is deleted for good
  until you empty the Recycle Bin.

Open a day to see its recordings: play one, show its files, protect it, or
move it to the Recycle Bin. The checkbox on a day selects all of its
recordings.

## Encoder

![Encoder](docs/images/encoder.png)

The Encoder is Sentry Studio's converter. It converts the
selected vehicle's footage straight on its share to save space, so more
fits before old recordings have to go: by default each original is replaced
by its verified H.265 or AV1 version (when the share supports a safe
replacement; see below). Keeping the originals and writing the converted
copies somewhere else is a choice you make in the Output section.

- **Telemetry is always kept.** Tesla stores speed, GPS, gear, Autopilot and
  more in every video frame. The converter copies that into the H.265 or AV1
  file and checks it before it saves anything. Verification cannot be turned
  off.
- **Never converted twice, and skipped at once.** The app remembers every
  clip it converted (name, size and date in the data folder), and checks
  other clips' MP4 header while it scans the folders, so clips that are
  already H.265 or AV1 are skipped right away and never wait for a
  conversion slot. Waiting and time remaining count only clips that will be
  converted.
- **Hardware panel.** While a conversion runs, Live run shows the encoder
  and GPU in use, video-engine and CPU load, watts and temperatures, each
  clip's speed and progress, the energy used so far (kWh, clips and GB saved
  per kWh, cost) and what limits the speed (the GPU, the CPU or the share).
- **Benchmark.** Runs the real converter on copies of a few of your clips
  at 1, 2, 4, 6 and 8 at once, on the server, and suggests the lightest
  setting within 5% of the fastest, and, when the server reports its power,
  the most efficient one (files per kWh). Your footage is only read.
- **Safe replacement.** In replace mode an original is only removed after its
  converted copy is verified, and only if it is still exactly the file that
  was converted (device, inode, size and SHA-256 are checked). The copy is
  moved in with a no-replace rename, which also holds on SMB.
- **Separate destination**, if you pick it: the originals stay and the
  converted copies go to a folder you choose (under `/data/converted` or a
  vehicle's share). If the share cannot guarantee a safe replacement, this
  is the only option offered.
- **Time remaining covers every clip.** The scan finds the whole archive
  (up to 50,000 clips per job) while the first clips convert; until it
  reaches the end, Discovered shows a `+` and the time remaining reads
  "at least".
- **Long runs don't stall.** A clip that is moved or deleted while a job
  runs (the Recycle Bin, a policy, the car) fails as `source-missing` and
  the job goes on. A share that stops answering pauses the job until it is
  back. An encode that reports no progress for 10 minutes (a stuck GPU or
  share) is stopped and redone the slower way, or fails. The automatic
  window resumes its job even when the pause had not taken effect yet.

### GPU

The converter uses the first GPU encoder that passes a real test encode,
in this order: NVIDIA (NVENC), Intel (QSV), AMD (AMF), then VA-API. Without
a working GPU encoder it encodes on the CPU (libx265 for H.265, SVT-AV1 for
AV1), and a clip the GPU fails on is redone on the CPU. With a GPU, the
original is decoded on the GPU too. In `docker-compose.yml`, uncomment:

| GPU | Encoders | What to uncomment |
| --- | --- | --- |
| NVIDIA | `hevc_nvenc`, `av1_nvenc` | the `deploy:` block (needs the NVIDIA Container Toolkit) |
| AMD card or APU | `hevc_vaapi`, `av1_vaapi` | `devices: - /dev/dri:/dev/dri` |
| Intel iGPU or Arc | `hevc_qsv`, `av1_qsv`, VA-API | `devices: - /dev/dri:/dev/dri` |
| none | `libx265`, `libsvtav1` | nothing |

ffmpeg is [jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg),
which the Jellyfin team keeps on the current FFmpeg release with its own
VA-API drivers. AMD's AMF encoder needs AMD's proprietary driver, which
containers don't have, so AMD cards and APUs use VA-API; AV1 needs RDNA3 or
newer. **Settings → System** lists the GPUs the container can see.

### Several GPUs or CPUs

Pass the whole of `/dev/dri` (and, for NVIDIA, every GPU in the `deploy:`
block). With two or more GPUs, **Parallel conversions** in the Encoder shows
one row per GPU plus a CPU row: set how many clips each one converts at
once, 0 for Off. Each GPU takes the next clip whenever it is free, so a
faster card simply converts more of them, and the numbers can be changed
while a job runs. A GPU that cannot encode the chosen codec (AV1 on an
Intel UHD 770, say) shows "Can't encode AV1". With one GPU nothing changes.

The benchmark tests every GPU on its own, one after another, and shows each
GPU's results separately, with a button to use each GPU's best setting at
once. GPUs are told apart by their PCI slot, so a reboot that numbers them
differently changes nothing; the old trick of mapping one GPU to
`/dev/dri/renderD128` still works but is no longer needed.

Several CPUs: on a server with two or more CPU sockets, **Overview → Server**
shows "2 × <CPU model>" and each socket's use, temperature and package power
(CPU 1, CPU 2, …); the CPU temperature is the hottest socket.

## Recycle Bin and policies

![Recycle Bin](docs/images/recycle-bin.png)

**Move to trash** moves a recording into `.sentry-recycle-bin` on the same
share. That is a rename, so it is instant. From the Recycle Bin you restore a
recording to exactly where it was, or delete it for good, which always asks
you to confirm (and for your password, unless you entered it in the last 10
minutes). Protected recordings, and recordings the converter is working on,
can't be trashed.

![Policies](docs/images/policies.png)

A **policy** keeps a number of days per category (Recent, Sentry, Saved,
Other) and moves older recordings to the Recycle Bin once a day. It previews
what the next run would move. Protected recordings are always skipped, and a
policy never deletes anything.

## Vehicles and SMB shares

Each vehicle has one footage source:

- an **SMB share** (`//nas/TeslaCam`, user name and password), which Sentry
  Six Manager mounts itself, or
- a **folder** you mount into the container yourself, below `/footage` (for
  example `- /volume1/TeslaCam:/footage/car`).

Shares are protected against anyone on your network, with no settings that
can weaken it:

- **SMB 3 only** (3.1.1 by default, or 3.02 / 3.0 for older NAS). SMB 1 and 2
  are refused.
- **Signed always, encrypted by default.** Nobody without the password can
  change the footage or pose as your NAS. If your NAS can't encrypt, you can
  turn encryption off for that vehicle; signing stays on.
- **A real account.** Guest access is not allowed. Use a NAS user that can
  only reach the TeslaCam share.
- **Nothing on a share can run.** Shares are mounted `nosuid,nodev,noexec`,
  and symlinks never lead out of a share.
- **No password on a command line.** For mounting, it goes in a file only
  root can read, and the web page never shows a saved password.

The manager checks each share every 30 seconds, remounts it if the NAS drops
out, tests that it can still write, and explains mount errors (wrong
password, no SMB 3 encryption on the NAS, and so on).

To turn on SMB 3 encryption: Synology *Control Panel → File Services → SMB →
Advanced* (minimum SMB 3, encryption on); Samba, TrueNAS and Unraid
`server min protocol = SMB3` and `server smb encrypt = desired`; Windows
`Set-SmbServerConfiguration -EncryptData $true`. The Docker host needs the
CIFS kernel module (`sudo modprobe cifs`); Synology, Unraid, TrueNAS and most
Linux distributions have it.

### Footage on the same machine

If the footage is on the server that runs Sentry Six Manager, no SMB share
is needed: mount the folder into the container and add it as a **folder**
vehicle. The Viewer, Footage, the Encoder (replacing originals included),
the Recycle Bin and policies work the same as with a share.

1. Add the folder (the one that holds `TeslaCam`, or `RecentClips` /
   `SentryClips` / `SavedClips` directly) to `volumes:` in
   `docker-compose.yml`, below `/footage`, and recreate the container with
   `docker compose up -d`:

   ```yaml
       volumes:
         - ./data:/data
         - /mnt/tesla:/footage/my-car
   ```

2. In **Settings → Add vehicle**, choose **Folder in the container** and
   enter `/footage/my-car`. Or, for the first vehicle, put
   `FOOTAGE_PATH=/footage/my-car` and `VEHICLE_NAME=My Car` in `.env`.

Two things to check:

- **Permissions.** The web app runs as user `1000:1000`. If the footage
  belongs to another user on the server, set `PUID` and `PGID` in `.env` to
  that user's numbers (`id <user>` shows them). Otherwise the vehicle shows
  as read-only and nothing can be converted or moved to the Recycle Bin.
- **Replacing originals** needs a filesystem that can rename a file without
  ever overwriting another one. Local disks with ext4, XFS or Btrfs can.
  Sentry Six Manager tests this when it opens the folder; where it can't
  (for example Unraid's pooled `/mnt/user` shares), *Replace originals* is
  greyed out and only a separate destination is offered. On Unraid, use the
  disk or cache path (`/mnt/disk1/...`, `/mnt/cache/...`) instead.

Keep `/data` in its own folder, not inside the footage folder.

## Phones and tablets

![On an iPhone: Overview, Footage and Settings](docs/images/phones.png)

Works in Safari on iPhone 14 and newer (iOS 16 or later) and on iPads from
2022 on (iPad 10th gen, Air 5, Pro M2, mini 6 and newer), and in Chrome or
Samsung Internet 22+ on Galaxy S22 and newer phones, Folds and Tabs, in
portrait and landscape.

![The Viewer on an iPad in landscape](docs/images/ipad-viewer.png)

- The dashboard and map panels move with a finger; the timeline is a normal
  slider. On phones the Viewer is shrunk to fit, so turn the phone sideways
  for a bigger picture.
- The Viewer pauses when you switch to another page, so it doesn't drain
  your battery in the background.
- H.264 (the car's own recordings) and H.265 play everywhere. AV1 plays in
  Safari only on iPhone 15 Pro and newer and on iPads with an M3, M4 or A17
  Pro chip. If you watch on older iPhones or iPads, convert to H.265.

## Updates

```bash
docker compose pull && docker compose up -d
```

Your account, settings, footage and Recycle Bin stay as they are. Updating
in the middle of a conversion is fine: the converter stops cleanly (Docker
gives it a minute, `stop_grace_period` in `docker-compose.yml`) and carries
on by itself after the update. Finished clips stay finished; a clip that was
being encoded starts over, and one that was being swapped in is completed
or put back from its backup. If the stop came at the very moment a clip
took its original's place, the job waits paused afterwards: press Resume
and it finishes that clip and carries on. **Settings → Updates** shows the
version you run and checks twice a day
whether a newer image is out. It only tells you and never installs anything
(`UPDATE_CHECK=off` turns the check off). For automatic updates, use a tool
such as [Watchtower](https://containrrr.dev/watchtower/).

Images are built by GitHub Actions for amd64 and arm64
([`image.yml`](.github/workflows/image.yml)) and published to
`ghcr.io/skittles-fivem/sentry-manager`. `latest` follows `main`, every
commit also gets a `sha-<commit>` tag you can pin with `SENTRY_TAG`, and
every image is rebuilt weekly so Debian, Node and ffmpeg security fixes
arrive without a code change.

## Security

![Settings → Security](docs/images/security.png)

**HTTPS only.** Port 9000 speaks HTTPS (HTTP/2), so nobody on your network
can read your password or footage, or change the page. Plain HTTP on the
same port never shows the app: a browser gets a short page explaining the
one-time certificate warning (it moves on by itself on devices that already
trust the certificate), anything else is redirected.

Sentry Six Manager makes its own certificate, so browsers don't know it:

- **Continue once per device.** The first time, each phone, tablet and
  computer shows a warning; continue past it (Chrome, Edge, Samsung
  Internet: Advanced, Proceed; Safari: Show Details, visit this website;
  Firefox: Accept the Risk) and the device remembers it (Chrome may ask
  again after a while). The certificate stays the same for over two years,
  so devices are not asked again on every update.
- **Check it is your server.** The certificate's SHA-256 fingerprint is in
  `docker logs sentry-six-manager`, on the sign-in page and in
  **Settings → Security**; compare it with the browser's certificate
  details. If a device that continued before warns again and you changed
  nothing, don't continue.
- **No warning at all (optional):** install Sentry Six Manager's
  certificate authority on a device. Download it in **Settings → Security**
  (or copy `data/tls/ca.crt`), compare its fingerprint with the log, and
  install it (the steps for iPhone, Android, Windows, macOS and Firefox are
  on that page). For those devices, add the address you type in the
  browser under **Settings → Security** so the certificate covers it;
  saving new names makes a new certificate, so devices that only continued
  past the warning are asked once more.

The certificate authority can only vouch for local names (`.local`, `.lan`,
...), private IP addresses and names you add, so even a stolen key could not
be used against other websites. Its key never leaves the root-only folder
`data/tls`. Behind your own reverse proxy, set `TLS_MODE=off` and
`TRUST_PROXY=true`, or bring your own certificate with `TLS_CERT_FILE` and
`TLS_KEY_FILE`.

**Signing in.** The first account needs the one-time setup code. Repeated
wrong passwords slow down further attempts. Cookies are HttpOnly,
SameSite=Strict, Secure and `__Host-` prefixed, every change must come from
the page itself, and every page runs under a strict Content-Security-Policy.

**Your password again** is needed for changes that could hand someone your
shares or the server: adding a vehicle or changing its footage source, the
certificate names, and deleting from the Recycle Bin for good.

**No root for the web app.** Only a small supervisor runs as root, to mount
shares and keep the certificate authority, and it never loads anything from
`/data`. The web app and ffmpeg run as `PUID:PGID` with no capabilities and
`no_new_privs`. The image has no setuid programs, and the compose file drops
every capability except the few the supervisor needs. A bug in the web app or
a malicious video on a share cannot become root or read the certificate
authority's key.

**An audit trail.** Sign-ins, password confirmations, vehicle changes,
certificate names and permanent deletions are logged with who did them and
from which address, never with a password. Look for `[audit]` in
`docker logs sentry-six-manager` or in Settings > Logs.

**Logs in the app.** Settings > Logs lists the warnings and errors from the
server, the converter (a clip that fails verification, with what was
measured) and the container's mount helper, newest first, with a Download
button. They are kept in the data folder (`logs/manager.log`, at most about
10 MB with the previous file), survive restarts, and anything that looks like
a password is masked. No shell on the server is needed.

## Settings

All optional; put them in `.env` next to `docker-compose.yml`.

| Variable | Default | |
| --- | --- | --- |
| `TZ` | `UTC` | Server time zone (logs, policy run times) |
| `UI_USERNAME` / `UI_PASSWORD` | | Create the account on first start instead of with the setup code |
| `VEHICLE_NAME`, `SMB_SHARE`, `SMB_USERNAME`, `SMB_PASSWORD`, `SMB_DOMAIN`, `SMB_VERSION`, `SMB_ENCRYPT`, `SMB_PORT` | | Create a first SMB vehicle on first start |
| `FOOTAGE_PATH` | | Create a first folder vehicle instead |
| `FOLDER_ROOTS` | | More folders (`:`-separated) folder vehicles may be in, besides `/footage` |
| `PUID` / `PGID` | `1000` | The user the web app runs as; it owns `/data` and the files on the shares |
| `TLS_HOSTNAMES` | | Names and IP addresses the certificate covers (more in Settings → Security) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | | Your own certificate instead of the built-in certificate authority |
| `TLS_MODE` | `auto` | `off` = plain HTTP, only behind a reverse proxy that does HTTPS |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-Proto` / `-Host` from that reverse proxy |
| `TRUSTED_HOSTS` | | If set, refuse requests for any other host name |
| `SENTRY_TAG` | `latest` | Which image to follow |
| `UPDATE_CHECK` | `on` | `off` = don't check for newer images |
| `EXTRA_ROOTS` | | More container folders the converter may write to (`:`-separated) |
| `SCAN_INTERVAL_MINUTES` | `15` | How often every vehicle is re-scanned |
| `PORT`, `DATA_PATH`, `LOG_LEVEL` | `9000`, `/data`, `info` | |

`./data` holds the account, settings, job history, thumbnails, the
converter's work folder and the certificate authority. Keep it on a local
disk, not on a share.

## Not in the web version (yet)

- Export, clip sharing and the SentryUSB drive tools from the desktop app;
  the Viewer leaves them out.
- Desktop-only converter options (keep running when closed, start with
  Windows).

## Development

Node.js 22.13 or newer (the server uses only Node's built-in modules,
including `node:sqlite`) and ffmpeg.

```bash
mkdir -p build && gcc -O2 -o build/noreplace-rename native/noreplace-rename.c
npm test
DATA_PATH=./data FOOTAGE_PATH=/path/to/TeslaCam SENTRY_NOREPLACE_RENAME=build/noreplace-rename npm start
docker build -t ghcr.io/skittles-fivem/sentry-manager:latest .
```

| Folder | |
| --- | --- |
| `server/` | The web server, the root supervisor, shares, Recycle Bin, policies, jobs |
| `web/` | The web pages, and the shim that runs Sentry Studio in the browser |
| `src/` | Sentry Studio's viewer (`renderer`, `shared`) and converter (`main/converter`); the few web-version changes are commented where they are (telemetry from the server, keeping the cameras together, the HW3 / HW4 layout, the benchmark's levels) |
| `native/` | The no-replace rename helper for safe replacement |
| `test/` | Tests (`node --test`), including real conversions with telemetry checks |

## Credits and license

The viewer and converter are [Sentry Studio](https://github.com/ChadR23/Sentry-Six)
by Chad and Scott Vandereems. Released under the [MIT License](LICENSE).

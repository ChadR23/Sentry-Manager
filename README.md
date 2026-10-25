# Sentry Six Manager

[![Downloads](docs/badges/downloads.svg)](https://github.com/skittles-fivem/Sentry-Manager/pkgs/container/sentry-manager)

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
- **Support.** Chat with the Sentry Six team from its own tab, with
  pictures and optional diagnostics.
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

### TrueNAS

On TrueNAS SCALE 24.10 or newer, install it as a custom app with
[`truenas/sentry-six-manager.yaml`](truenas/sentry-six-manager.yaml):

1. **Datasets.** In *Datasets*, create one for Sentry Six Manager's own data
   (for example `tank/apps/sentry-six-manager`, preset *Apps*). The footage
   can stay in the dataset it is already in. The app runs as TrueNAS's `apps`
   user (568), which must be able to write to the footage dataset: give
   `apps` *Modify* in the dataset's permissions, or the vehicle shows as
   read-only and nothing can be converted or moved to the Recycle Bin.
2. **Install.** *Apps → Discover Apps →* the three dots at the top right *→
   Install via YAML*. Name it `sentry-six-manager` and paste the file. Change
   the `/data` path to your data dataset, and uncomment the `/footage` line
   with your footage dataset's path (the folder that holds `TeslaCam`, or
   `RecentClips` / `SentryClips` / `SavedClips`). Save.
3. **Set up.** *Apps → Installed → sentry-six-manager → Workloads →* the log
   icon shows the setup code and the certificate fingerprint. Open
   `https://<truenas>:9000`, create the account, then *Settings → Add
   vehicle → Folder in the container* and enter `/footage/my-car`.

Footage on another NAS can be added as an SMB share instead, as anywhere
else. For a GPU, uncomment its block in the file (*Apps → Installed →
sentry-six-manager → Edit*): AMD and Intel pass `/dev/dri`; NVIDIA first
needs *Apps → Configuration → Settings → Install NVIDIA Drivers*. Another
app already on port 9000 (MinIO uses it): change the left number of
`9000:9000`. *Replace originals* works on ZFS datasets (the app tests it when
it opens the folder).

To update (**Settings → Updates** says when a newer image is out): TrueNAS
often keeps the copy of `latest` it already has, so fetch the new one in
*System → Shell* and restart the app:

```bash
docker pull ghcr.io/skittles-fivem/sentry-manager:latest
```

then *Apps → Installed → sentry-six-manager → Stop*, then *Start*. The version
on **Overview → Server** shows the update took; if it didn't, *Edit* the app
and *Save* to have TrueNAS recreate it. Your settings stay in the `/data`
dataset.

## Overview and Footage

![Overview](docs/images/overview.png)

The overview is one window, **Server**. At its top, the selected vehicle's
archive (its size, how many recordings, when it was last scanned, with
*Refresh inventory*) and the free space on its share (capacity, how full it
is, what the Recycle Bin holds, with *Vehicle settings*). A chip shows only
when the share has a problem: *Read-only share* or *Share unavailable*.

Under them, behind the *Nerd stats* switch, what the machine is doing, live,
so you don't need Glances or another tool:

- **CPU**: model, cores, total and per-core use, clock, temperature, load,
  and how much of it this app and its conversions use.
- **GPU** (Intel, AMD and NVIDIA, one tile each): busy and video-engine use,
  memory, clock, temperature, watts.
- **Power**: CPU and GPU watts, the energy used today and this week (in Wh
  below 1 kWh), and the cost when you enter your electricity price in
  Settings → System. A built-in GPU (an APU such as the Ryzen 8700G's
  Radeon 780M) is part of the CPU chip, so the CPU and that GPU show as one
  figure, *whole chip*; a graphics card besides it gets its own bar.
- **Memory, storage** (each disk's reads, writes and temperature; space and
  answer time of the data volume and every footage share, checked every 10 s,
  with when it was last checked; a share that is offline shows *not
  connected* and when it last answered, kept across restarts), **network** (live
  speed, and the data used today, this week and this month) and every
  **sensor** and fan the server reports.
- **Top processes**: up to 40, eight at a time (scroll the list for the
  rest). Busy ones come first; the others keep their places, so the list
  does not reshuffle with every update.
- The numbers update every 2 seconds without moving the page, and wait while
  you highlight text in them, so it can be copied.
- **Alerts** for a hot CPU, GPU or disk, a disk almost full, a slow or
  unreachable share, and low memory; they also go to Notifications.
- **History**: the last 24 hours, and a CSV download.
- **Logs** at the bottom, with Nerd stats on or off: the warnings and errors
  the server keeps (see [Security](#security)); an alert's *Logs* link goes
  there.

It only measures while a page shows it or a conversion runs (and reads the
network's byte counters once a day, so the data used lands on the right
day), and every number stays on the server. A tile appears only when the server provides its
numbers. CPU watts come from the CPU's energy counters: remove the `#` from
the `powercap` line in `docker-compose.yml`
(`- /sys/devices/virtual/powercap:/host/powercap:ro`) on a server that has
them (`ls /sys/devices/virtual/powercap` shows a folder; most Intel and AMD
PCs and NAS boxes do). It is off by default because Docker refuses to start
the container where that folder does not exist (a Raspberry Pi, some mini
PCs and VMs, Windows/WSL); Overview → Server says when it is worth turning
on. One optional line
adds the whole server's processes and network (`pid: host`); it also lets
the container see and signal the server's processes, so use it only with a
PUID/PGID of its own.

![Footage](docs/images/footage.png)

**Footage** shows one card per day, newest first, all closed until you open
one: a thumbnail (the day's first Sentry or Saved event, else its first
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
move it to the Recycle Bin. A day stays open until you close it, and picking
a date in the filter opens that day. The checkbox on a day selects all of
its recordings.

**Show files** lists a recording's clips with each one's codec (H.264, H.265
or AV1), says how many are not encoded yet, and *Not encoded only* hides the
rest, so a clip the Encoder skipped or could not convert is easy to find.

## Encoder

![Encoder](docs/images/encoder.png)

The Encoder is Sentry Studio's converter. It converts the
selected vehicle's footage straight on its share to save space, so more
fits before old recordings have to go: by default each original is replaced
by its verified H.265 or AV1 version (when the share supports a safe
replacement; see below). Keeping the originals and writing the converted
copies somewhere else is a choice you make in the Output section.

**Automatic conversion is per vehicle.** Pick a vehicle at the top of the
Encoder, choose its settings, and tick *Convert this source's new clips
automatically*: that vehicle's new clips are converted on the schedule with
those settings (codec, profile, output, parallel conversions), saved for it
alone. Vehicles you leave unticked are never converted by themselves. The
list under the checkbox shows which vehicles convert automatically and with
what. The schedule, the time window and off-peak are shared: each check goes
through the automatic vehicles one after another, one conversion at a time,
and a vehicle whose share is down doesn't hold up the others. Settings are
changed while nothing is converting (the vehicle picker is locked during a
conversion).

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
  and GPU in use, video-engine and CPU load, watts and temperatures, and the
  energy used so far (Wh or kWh, clips and GB saved per kWh, cost), beside
  the run's progress (current file, waiting, time remaining and the other
  counters), so how many are left shows without scrolling on a computer; on
  a phone the progress comes first and the panel under it. The clips being
  converted are not listed one by one (they come and go every few seconds).
  Clips and GB per kWh count only what was converted while the energy was
  measured, so they start at 0 and count up as clips finish: until 10 Wh
  have been measured they are divided by 10 Wh, so a clip or two never reads
  as a huge number (a job that was already running when measuring began, for
  example before a restart, is not divided by a few minutes of energy
  either). When the server reports the GPU's power but not the CPU's, they
  count the GPU alone and say *GPU only* (not with a built-in GPU, whose
  reading is the whole chip's).
- **Benchmark.** Runs the real converter on copies of a few of your clips
  at 1, 2, 4, 6 and 8 at once, on the server, and suggests the lightest
  setting within 5% of the fastest, and, when the server reports its power,
  the most efficient one (files per kWh). Your footage is only read. It
  needs original (H.264) clips and looks for them, newest first, through the
  whole source folder, so an archive that is mostly converted works too.
- **Safe replacement.** In replace mode an original is only removed after its
  converted copy is verified, and only if it is still exactly the file that
  was converted (device, inode, size and SHA-256 are checked). The copy is
  moved in with a no-replace rename, which also holds on SMB. Clips copy
  their conversions to the share at the same time; only the renames that
  swap a clip in go one clip at a time. Each copy is read back in full right
  after it is written; in the swap the original gets a full check right
  before it is moved aside, and the copy and the moved original are then
  checked by device, inode, size and modification time (fully again if any
  of those changed). On the Encoder page, "Save / replace" includes the copy
  and "Wait to save" is the wait for those renames.
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
- **Unusual Tesla clips convert too.** Some clips start partway into a
  group of frames, or have a frame Tesla's encoder skipped; both convert
  with every frame at its original time and the telemetry intact, and are
  verified like any other clip.
- **Every clip ends up in one codec.** With *Constant quality* or a custom
  bitrate, a clip that does not come out smaller (busy repeater footage,
  night, rain) is encoded again at 85% of its original bitrate, then 60%,
  instead of staying H.264. Only if even that is not smaller is the
  original kept.
- **Gave up is not forever.** The automatic window stops retrying a clip
  after it fails three times, or when converting it would not save space.
  When an update changes the converter, those clips are tried again once.
- **After a restart** the Encoder page shows the job that is running now,
  even if the page was left open while the server restarted.

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

### Nodes: other servers that encode

Another computer running Sentry Six Manager (a gaming PC with a better GPU,
say) can encode clips for this one. It becomes one more row under
**Parallel conversions**, next to this server's GPUs and CPU.

1. On the other computer, open **Nodes → Let another server use this one →
   Show pairing code** (asks for its password). The code works once, for 10
   minutes.
2. Here, open **Nodes → Add node** and enter that computer's address and the
   code (asks for this server's password).
3. Under **Encoder → Parallel conversions**, set how many clips the node
   converts at once.

**Rename** gives a node a name of your own here (shown on the Nodes page and
under Parallel conversions); the node keeps its own name. On the node,
**Encode with** chooses how it encodes: its **GPU** (the default; the CPU only
on a computer without one), **GPU, then CPU if it fails**, or **CPU only**. A clip the node can't encode comes back here.

**Benchmark a node** from here: **Nodes → Benchmark** (or **Benchmark AV1**)
lends the node a few sample clips from your footage and converts them at 1,
2, 4, 6 and 8 at once, timing each level. The node needs no footage of its
own; the encoded files are deleted and the footage is only read. It lends
original (H.264) clips, newest first, from anywhere in your footage; when the
Encoder has converted them all, it lends converted ones and says so. **Use N
at once** then sets the node to the lightest setting within 5% of the
fastest, and its row under Parallel conversions too.

This server reads each clip from the share, sends it to the node over HTTPS,
gets the encoded file back, and then writes the telemetry, verifies it and
saves it exactly as it does for its own GPUs. Each node is sent **15 clips
ahead** of what it converts at once: they wait on the node, so it starts the
next one the moment a slot is free instead of waiting for this server to read
and send it (the Nodes page shows how many are converting and waiting). This
takes up to 15 clips' worth of disk on the node, about 1 GB, and on this
server while they wait. A clip that waits more than 30 minutes is encoded
here instead. If a node is offline or fails
a clip, that clip is encoded here instead, on this server's GPU when it has
one (the CPU otherwise).

Security:

- **Nodes never touch your footage.** They get one clip at a time and send
  one file back. They never see share passwords and cannot delete or replace
  anything; only this server writes to the share.
- **Pairing can't be intercepted.** Each side proves it knows the code with
  a signature over the certificate it actually saw, so a machine in between
  cannot pair. A few wrong codes from one address and that address is
  refused; the code stays valid for the right main.
- **Pinned certificates.** From then on this server only talks to the node's
  own certificate, or one renewed by the node's own certificate authority.
  Anything else is refused before a byte is sent. A node that was reset has
  to be paired again.
- **Tokens, not passwords.** Every request carries a random token. The node
  keeps only its hash, and **Revoke** on the node (or **Remove** here) ends
  it at once.
- **Fixed settings only.** A node accepts the codec, a bitrate or quality
  level and nothing else. It builds its own ffmpeg command and runs it as
  its unprivileged app user.
- **Nothing is trusted on the way back.** Every file a node returns is
  compared picture by picture with the original here (black, blurred or
  swapped footage is caught and the clip is encoded here instead; both are
  decoded on this server's GPU when it has one), then
  verified like any other (frames, timing, telemetry) before an original is
  replaced. A node can never send back more than twice the clip's size, and
  one that stalls or misbehaves cannot hold up this server.
- **A main can't misuse a node either.** The node reads each upload strictly
  as an MP4 from its own work folder (so it can't be pointed at other files
  or addresses), caps the output's size and length, and keeps a limited
  number of clips at a time.
- Only pair computers you own: a picture comparison catches swapped or
  blanked footage, not a small change to part of the picture.

A node needs its own HTTPS (the default; not `TLS_MODE=off`). It uses the
same port as its web page, so there is nothing to add to `docker-compose.yml`.

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

## Jobs

**Jobs** lists what Sentry Six Manager did and is doing for the selected
vehicle: inventory scans, conversions (with the energy they used), moves to
and from the Recycle Bin and policy runs, newest first, with how long each
took. A job that a restart stopped (a scan, a move) shows as *interrupted*;
a conversion carries on where it was.

**Clear jobs** takes the finished ones (done, failed, cancelled and
interrupted) off the list after you confirm how many, so what shows up next
is what happened since. Running, waiting and paused jobs stay. Only the list
is cleared: footage, converted files and what the Encoder needs to resume a
conversion are not touched.

## Support

![Support](docs/images/support.png)

**Support** in the side bar is a chat with the Sentry Six team. The first
message opens a ticket, and the team's replies show up on the same tab.
Pictures, videos and log files (up to 50 MB) can be attached, and the
team's pictures open in a popup over the chat. *Include diagnostics* adds
the version, OS, CPU and GPU and the recent warnings, with addresses, share
names, footage paths and email addresses removed.

This is the one thing Sentry Six Manager talks to outside your network: the
server relays the chat to `api.sentry-six.com` (and fetches pictures the
team sends from Discord's file server). The ticket's key stays on the
server, the browser only ever talks to your own server, and nothing is sent
until you send a message.

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
or put back from its backup. The same holds when the stop is not clean (a
power cut, `docker kill`): whatever moment it came at, the job carries on by
itself after the restart, with nothing to press. Only files that something
else changed in the meantime make it wait for you. **Settings → Updates** shows the
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
certificate names, permanent deletions, Clear jobs and clearing the logs
are logged with who did them and from which address, never with a password.
Look for `[audit]` in
`docker logs sentry-six-manager` or in the Overview's Logs (tick
*Everything*).

**Logs in the app.** The Overview's **Logs**, the last part of its Server
window, list the warnings and errors from the server, the converter (a clip
that fails verification, with what was measured) and the container's mount
helper, newest first, with *Everything* for all activity, *Refresh* and a
*Download* button. The lines load after the page has shown, and a refresh
never moves the page or takes away text you are highlighting. They are kept
in the data folder (`logs/manager.log`, at most about 10 MB with the
previous file), survive restarts, and anything that looks like a password is
masked. No shell on the server is needed. (Old links to Settings > Logs,
`#/settings/logs`, open them there.)

**Clear** starts the list afresh without deleting anything: the earlier
lines move to `logs/archive/` in the data folder, and *Cleared logs* under
the list downloads them again.

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

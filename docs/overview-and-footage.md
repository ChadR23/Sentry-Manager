# Overview and Footage

[← Back to the README](../README.md)

![Overview](images/overview.png)

The overview is one window, **Server**. At its top, the selected vehicle's
archive (its size, how many recordings, when it was last scanned, with
*Refresh inventory*) and the free space on its share (capacity, how full it
is, what the Recycle Bin holds, with *Vehicle settings*). A chip shows only
when the share has a problem: *Read-only share* or *Share unavailable*.
**Full in** says when the share runs out of room at the rate footage has
come in over the last 14 days (by the car's dates, at the files' size now,
so converted footage counts smaller). With a policy that deletes every kind
of footage after some days, it says the policies keep it from filling.

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
  the server keeps (see [Security](security.md)); an alert's *Logs* link goes
  there.

**Saved by converting**, on every main page with each car: the space
conversions won back in each of the last 12 months, as bars, with this
month's and the total. Savings from before this chart are put in the month
their conversion finished (from the job history).

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
on. On Docker Desktop for Windows (WSL2) and inside other virtual machines
CPU watts cannot be read at all, so the power tile says so instead of
suggesting the line; GPU watts still show when the card reports them (NVIDIA
does). One optional line
adds the whole server's processes and network (`pid: host`); it also lets
the container see and signal the server's processes, so use it only with a
PUID/PGID of its own.

![Footage](images/footage.png)

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

Moving the mouse across a recording's or day's picture flips through it,
start to end, from the Viewer's timeline previews (made the first time a
clip is shown, then kept).

**Show files** lists a recording's clips with each one's codec (H.264, H.265
or AV1), says how many are not encoded yet, and *Not encoded only* hides the
rest, so a clip the Encoder skipped or could not convert is easy to find.

## In the Viewer

- **Timeline preview**: hovering the timeline with a mouse (no click) shows
  the frame and time under the pointer above the bar; on a phone it shows
  while your finger drags. The frame is the exact second a click goes to:
  a clip with a keyframe every second (Tesla's own) is previewed from its
  keyframes, a converted clip (fewer keyframes) from every frame.
- **Moments**: the day's hard braking (at least 0.4 g of slowing in a
  second), swerves and sharp turns (at least 0.4 g sideways) and the three
  fastest stretches, strongest first. Picking one plays it from three
  seconds before. They come from the speed index, which reads a few KB of
  each front-camera clip in the background (speed, position and the car's
  measured acceleration); footage it has not read yet says so.
- **The day in numbers**, above the moments: how far the car drove (from
  its speed each second), how long it was moving and its top speed.
- **Star this moment**: marks where the video is, with a note if you like
  ("pothole", "near miss"). Starring also protects the recording, so
  policies and *Delete through this date* leave it alone. The vehicle's
  starred moments from every day are listed under the moments, in every
  interface; picking one opens it, and × removes the star (the recording
  stays protected until you unprotect it).
- **Pop out** (picture in picture): the main camera keeps playing in its own
  small window while you use other pages or apps.
- **Pick up where you left off**: the Viewer remembers, in this browser,
  where you were in each car's footage for 14 days and offers to go back
  there when you open it (Daylight: the *Continue* card goes to that second).
- **Zoom a still**: while paused, scroll (mouse) or pinch (touch) over a
  camera to zoom in up to 6×, and drag to look around, to read a number
  plate. Playing or a double-click resets it.
- **Frame by frame on phones**: while paused, large ‹ › buttons on the main
  camera step one frame back or forward.
- **Find clips at a place** (the pin on the map, every interface pack):
  tap a spot and every clip recorded within 150 m of it is listed, any day
  and any vehicle, newest first; picking one opens it at that moment. Only
  clips with GPS that the speed index has read are found.

## Drives

A tab in every interface (next to the Viewer), like Sentry Studio's Drives
tab, for the footage on the server: the selected car's trips, newest first
and grouped by day. Clips back to back are one drive; a gap of more than 5
minutes (or 2, 10, 15 or 30, picked on the page and remembered in the
browser) starts the next. Only the car's own recording counts: Sentry and
Saved events are not drives. Where the speed index has read the clips, a
drive starts at the first second the car moves and ends at the last, and
recording while parked is left out;
clips not read yet count as a minute of driving each.

Each drive shows its start and end time, how long it took (in days, hours
and minutes: "1 h 25 min"), the distance, top speed, hard braking and
swerves, a CAN tag when CAN Bridge data covers it, and where it started and
ended: a saved place (Home, Work), else the street and town of a Sentry or
Saved event there (from Tesla's event.json; nothing is looked up online),
else the coordinates. Picking one plays it from its start in that
interface's Viewer. Older drives load 40 at a time ("Show older drives").
The same list is `GET /api/vehicles/:id/drives` (`limit`, `before`, `gap`),
readable by watch-only accounts.

### Sentry USB's drive data

When the car's share has Sentry USB's `drive-data.json` (Sentry USB writes
it next to RecentClips/ after each archive that found new drives; Sentry
Studio's Drives tab reads the same file), the drives come from it instead,
grouped the way Sentry USB and Studio group them: a clip starting more than
the gap after the one before starts a new drive, and Park for 2 seconds or
more ends a drive even inside a clip (by the gear data Sentry USB read from
the clips). Each drive then also shows how much of it was driven on Full
Self-Driving or Autopilot (Autosteer and Traffic-Aware Cruise Control), as a
share of the distance like Sentry USB and Studio show it, its drive tags,
and a small drawing of the route. Drives whose clips are no longer on the
share are listed too ("no footage here") but have nothing to play. Hard
braking, swerves, CAN tags and place names still come from Manager's own
data. The page says which source it shows: "From Sentry USB's drive data,
updated …" or "From your clips".

The file can be over a gigabyte, so it is read in the background a piece at
a time (slower while a conversion runs), boiled down to a few numbers per
clip and kept under the data folder (`drive-data/`), and read again only
when its size or time changes. A file changed in the last seconds is left
to settle first; a read that fails (a copy cut short, not JSON) keeps the
last good one and the page says so. Until a first read is done the drives
come from the clips. Manager never writes to the file. In the API the
response has `source` (`"sentry-usb"` or `"clips"`), `driveData` (`file`,
`updatedAt`, `readAt`, `routes`, `reading`, `progress`, `error`, or null
without a file) and `reading`; a Sentry USB drive adds `autopilot`
(`percent`, `fsd`, `autosteer`, `tacc` in % of the distance, seconds and
metres), `tags`, `route` (up to 96 `[lat, lon]`) and `footage` (clips of it
here); `open` is null when none is.

## Driving

A page of its own in every interface: the selected car's driving week by
week for the last 12 weeks, from the driving data in the footage: distance
(as bars), time moving, days driven, hard braking and swerves (about 0.4 g
or more) and top speed, with this week against the last. Miles or
kilometres, remembered in the browser.

## Health

Also a page in every interface:

- **Checks**, each with what to do when it fails: the data folder (writable,
  free space, cache folders, database intact, daily snapshot), each car's
  share (readable, writable, free space), ffmpeg, the GPU encoder (a real
  test encode; not while converting) and HTTPS. They also run by themselves
  a minute after every start (after an update, say): what fails there is a
  notification and an amber bar at the top of every page, with a link here.
- **Database snapshots**: once a day the database (accounts, vehicles,
  settings, policies, starred moments, job history) is copied to
  `data/snapshots`, keeping the newest 7. *Restore…* asks for your password,
  then the app restarts on that copy; the one it replaced stays as
  `data/manager.db.before-restore`. Footage is never touched.
- **Logs**: search between two dates (archived logs too), for some text and
  level, and download what matches.
- **Support bundle**: a .zip with the last 7 days of logs, the checks and
  the set-up, for someone helping you. Passwords are masked, and footage
  paths, share and vehicle names, IP addresses and e-mail addresses are
  replaced with placeholders.

**A share that drops** (a NAS restarting, a Wi-Fi blip) is retried quietly,
waiting longer between tries; the *share is offline* alert only comes when it
is still down after 10 minutes. **Disk errors**: when a disk the server can
see reports read or write errors while the app runs, an alert says which
disk. Full SMART health needs root and raw access to the disks, which the
container does not have; your NAS (TrueNAS) checks SMART itself.

## Map

A page in every interface: every Sentry and Saved event of the car as a pin
where it happened (red Sentry, green Saved, from the event.json the car
writes), the newest listed with why the car saved it (*Something moved near
the car*, *Saved with the horn*…) and the street. Tap one to play it.

**Tagged by place**: a Sentry or Saved event within 200 m of a saved place
gets its name (*at Home*, *at Work*) on the Footage cards and on the Map,
where *Where:* shows only the events at one place, or elsewhere. Footage
search finds them by the place's name too (the interface packs).

**Saved places**: after a place search on the Viewer's map, *Save place*
names the spot (Home, Work). Saved places show on the maps with their names,
the pin button offers them so a search is one tap, and the Map page renames
or removes them.

## More in the Viewer

- **Layouts** (the interface packs): three slots for how the cameras are laid
  out. Tap a slot to use it; hold it (or Shift-click) to save the current
  layout there. The built-in Viewer keeps Studio's own layout picker.

## Footage check

On the Health page: finds clips that will not play (cut off when the car
lost power or the USB drive was pulled, empty, or not video), per car. Only a
few bytes of each file are read. Results are kept: a check a restart cuts
short goes on by itself, and files that have not changed are not read again
(the speed index, the timeline previews and conversions also go on where they
were after a restart).

## Archive gaps (footage not on the share yet)

A Sentry USB (or another USB drive that copies itself to the NAS over Wi-Fi)
archives the car's clips some time after the car records them, and recycles
old clips to make room. Footage it has not copied by then is lost, and Sentry
Six Manager can only show what is on the share. So after every scan the last
seven days of each car are checked for footage that looks recorded but not
copied:

- **CAN Bridge, driving:** the car's CAN logs show it driving (gear D or R,
  or moving) in minutes with no footage at all. Only for cars with CAN Bridge
  logs; "awake" alone does not count (a car wakes to charge or for climate
  without recording), and a speed of "not available" is not moving.
- **Parked time never counts**, Sentry Mode included: a parked car does not
  record Recent clips continuously (Sentry events go to SentryClips) and can
  leave its USB drive untouched for hours, so minutes with the car in Park
  and not moving are not missing footage.
- **A drive cut off:** the footage stops while the car is moving (from the
  speed index) and the next footage comes minutes later.
- **Minutes short a camera:** two or more minutes with only some of the
  cameras the minutes either side have (a copy cut off part way).

A minute counts once it is 3 hours old and footage the car recorded later is
on the share (the archive got past it). Otherwise it waits 24 hours, and also
until nothing new has reached the share for 2 hours: an archive catching up
after days away from Wi-Fi gets a grey **Still arriving** tag, not a warning,
until it stops. A parked, sleeping car never warns. A car whose archive leaves
RecentClips out (its Sentry and Saved clips go on arriving long after its last
Recent clip) is not checked for missing drives; one whose archive stopped
altogether is. CAN logs that line up with the footage a whole number of hours
away (the car's time zone set wrongly in Sentry Six Manager, a road trip into
another zone) are not taken as missing footage; check the car's time zone. A
CAN Bridge key not mapped to a car counts for the only car once some of its
drives have matched that car's footage.

The day gets an amber **Partly archived?** tag on the Footage page; open the
day (tap the tag in the built-in interface) to read what looks missing and
what to check. A warning notification names the car, the day, about how many
minutes look missing and why, and what to check on the Sentry USB: its Logs
page, its archive settings and its Wi-Fi to the NAS. The notification updates
as more is found, clears itself when the footage arrives (or when the evidence
has been gone for some hours), and once dismissed only comes back if the gap
grows a good deal. A warning still open when its day is more than a week old
is cleared: the day is no longer checked. Turn it off in Settings → Health →
Notification rules ("Footage the car recorded that has not reached the
share").

When the share has a Sentry USB that lists its snapshots (see
[Sentry USB](sentry-usb.md#missed-snapshots)), missing minutes that fall
where the Pi took no snapshot for longer than the car keeps its footage get
the tag **Pi missed snapshots** instead, and the day's text says which
snapshots were missed, for example "Sentry USB took no snapshot between
9:56 AM and 12:50 PM (2 h 54 min; it should take one every 58 min), and the
car keeps only about an hour, so the footage from 9:56 to about 11:50 AM was
overwritten before it was copied." The minutes still count as missing.

A day whose clips are still reaching the share hours after they were recorded
also gets the grey **Still arriving** tag (no notification): the archive is
behind, but working. This needs a share that reports when a file arrived (its
creation or change time); a share copied or restored on the NAS is ignored.

A day whose clips were still being sent when the car drove off gets a
grey-blue **Waiting for Sentry USB** tag instead: nothing is lost, the clips
stay on the Pi and arrive with the next archive. See [Sentry USB](sentry-usb.md)
for the Sentry USB line at the top of the Footage page.

The findings per day are at `GET /api/vehicles/:id/archive-gaps`.

# Sentry Six Manager: step-by-step install guide

**What this is:** a web app for your **Tesla dashcam footage** (TeslaCam:
RecentClips, SentryClips, SavedClips). It runs in Docker on a NAS or home
server, and you use it from any browser to watch, convert and clean up the
footage. (It has nothing to do with FiveM or GTA, whatever the GitHub
account's name suggests.)

Follow the steps in order. After each step it says **what you should see**,
and **if not**, what to do. Commands go in a terminal on the server (SSH, or
the server's own shell); copy them exactly.

- [1. Before you start](#1-before-you-start)
- [2. Install](#2-install): [Linux / most NAS](#linux-or-most-nas), [Synology](#synology), [Unraid](#unraid), [TrueNAS SCALE](#truenas-scale), [Windows (Docker Desktop)](#windows-docker-desktop)
- [3. First sign-in](#3-first-sign-in)
- [4. Add your car's footage](#4-add-your-cars-footage): [SMB share](#a-footage-on-an-smb-share-another-nas-or-pc) or [folder on this server](#b-footage-on-this-same-server-a-folder)
- [5. Updating](#5-updating)
- [6. Optional settings (.env) and their traps](#6-optional-settings-env-and-their-traps)
- [7. When something goes wrong](#7-when-something-goes-wrong)

---

## 1. Before you start

You need:

1. **A server that runs Docker** (Linux PC, Synology, Unraid, TrueNAS SCALE
   24.10+, or a Windows PC with Docker Desktop), on the same network as the
   devices you'll watch from.
2. **Docker Compose 2.24 or newer.** Check it:

   ```bash
   docker compose version
   ```

   **You should see** something like `Docker Compose version v2.29.1`. The
   number after `v2.` must be **24 or higher**.

   **If not:**
   - `docker: 'compose' is not a docker command` or `unknown command`: the
     Compose plugin is missing. Install Docker's Compose plugin for your
     system, or follow your NAS section below.
   - A version below 2.24: update Docker. If you can't, see
     [Old Compose](#old-compose-below-224) in the troubleshooting section.
3. **Port 9000 free** on the server. If another app already uses 9000 (MinIO
   does, for example), you'll change one number later; see
   [Port 9000 is taken](#port-9000-is-taken).
4. **Where your footage is.** Either:
   - on **another machine's shared folder** (an SMB share, such as a NAS
     folder or the TeslaUSB / Sentry USB share), with a user name and password;
     or
   - in a **folder on this same server**.

   Write down which, and the path or share address.

---

## 2. Install

Do **one** of these sections, the one for your system.

### Linux or most NAS

```bash
mkdir sentry-six-manager
cd sentry-six-manager
curl -fsSLO https://raw.githubusercontent.com/skittles-fivem/Sentry-Manager/main/docker-compose.yml
docker compose up -d
```

**You should see** lines ending in `Started` (or `Running`) for
`sentry-six-manager`. The first time it also downloads the image, which takes
a few minutes.

**If not:**
- `permission denied ... docker.sock`: put `sudo` in front of the `docker`
  commands (`sudo docker compose up -d`), or add your user to the `docker`
  group and log in again.
- `curl: command not found`: install curl, or download
  [`docker-compose.yml`](../docker-compose.yml) in a browser and put it in
  the `sentry-six-manager` folder.
- An error about `env_file` or `path`: your Compose is older than 2.24, see
  [Old Compose](#old-compose-below-224).
- `port is already allocated`: see [Port 9000 is taken](#port-9000-is-taken).

Check that it runs:

```bash
docker ps --filter name=sentry-six-manager
```

**You should see** one line with `sentry-six-manager` and a `STATUS` of `Up`.
Go to [3. First sign-in](#3-first-sign-in).

### Synology

Use SSH, which gives you exactly the commands above:

1. In DSM, install **Container Manager** from Package Center (this is
   Synology's Docker).
2. Turn on SSH: **Control Panel → Terminal & SNMP → Enable SSH service**.
3. From your computer: `ssh <your-dsm-user>@<synology-ip>`.
4. Make a folder for the app on a volume (`/volume1/docker` is common):

   ```bash
   mkdir -p /volume1/docker/sentry-six-manager
   cd /volume1/docker/sentry-six-manager
   sudo docker compose version
   ```

   Check that the version is 2.24 or newer (see [1. Before you start](#1-before-you-start)).
5. Then follow [Linux or most NAS](#linux-or-most-nas) from the `curl` line on,
   with `sudo` in front of every `docker` command.

Synology notes:
- Synology's Container Manager can come with a Compose **older than 2.24**.
  If `sudo docker compose version` shows that, use the
  [Old Compose](#old-compose-below-224) fix before `docker compose up -d`.
- On Synology every `docker` command needs `sudo`, including
  `sudo docker logs sentry-six-manager` in the next section.
- Synology users usually have a user ID of 1026 or higher, not 1000. If your
  footage is in a folder on the Synology itself, read
  [Permissions](#permissions-read-only-vehicle).
- For footage on another machine, Synology has the SMB support the app needs
  built in.

### Unraid

Unraid has Docker, but **not Docker Compose** out of the box. Install a Compose
plugin first (Docker Compose Manager, from the *Apps* tab), or install Compose
another way, then:

1. Open a terminal (the **>_** icon at the top right of the Unraid web page).
2. Use a folder on the cache (or a disk, `/mnt/disk1/...`, if you have no
   cache), **not** `/mnt/user`:

   ```bash
   mkdir -p /mnt/cache/appdata/sentry-six-manager
   cd /mnt/cache/appdata/sentry-six-manager
   docker compose version
   ```

3. Follow [Linux or most NAS](#linux-or-most-nas) from the `curl` line on.

Unraid notes:
- For footage on the Unraid box itself, mount it from `/mnt/disk1/...` or
  `/mnt/cache/...`, **not** `/mnt/user/...`. On `/mnt/user` the app can't
  safely replace originals with converted copies, so it greys that option
  out.

### TrueNAS SCALE

TrueNAS SCALE **24.10 or newer** (its apps run on Docker). The repo has a
ready-made file: [`truenas/sentry-six-manager.yaml`](../truenas/sentry-six-manager.yaml).

1. **Datasets.** In *Datasets*, create one for the app's own data, for
   example `tank/apps/sentry-six-manager`, with the *Apps* preset. Your footage
   can stay where it is.
2. **Footage permissions** (only if the footage is on this TrueNAS): the app
   runs as TrueNAS's `apps` user (568). In the footage dataset's permissions,
   give `apps` **Modify**. Without it the vehicle is read-only.
3. **Install.** *Apps → Discover Apps →* the three dots at the top right
   *→ Install via YAML*. Name it `sentry-six-manager` and paste the file.
   Then edit two lines:
   - the `/data` line: put your new dataset's path on the left
     (`/mnt/tank/apps/sentry-six-manager:/data`);
   - for footage on this TrueNAS: delete the `#` in front of the `/footage`
     line and put your footage dataset's path on the left
     (`- /mnt/tank/TeslaCam:/footage/my-car`). Delete only the `#`, nothing
     else on the line.

   Save.
4. **You should see** the app become *Running* under *Apps → Installed*.

**If not:** open *Apps → Installed → sentry-six-manager → Workloads →* the
log icon and look at the last lines (see [7. When something goes wrong](#7-when-something-goes-wrong)).
If it says the port is in use, change the left `9000` in the `ports:` line
(for example `9010:9000`) and use that number everywhere this guide says 9000.

On TrueNAS you see the log in that same **log icon** wherever this guide says
`docker logs sentry-six-manager`.

### Windows (Docker Desktop)

The project is built and tested on Linux. Windows with Docker Desktop is
**not tested by the project**. If you can, run it on a NAS or Linux box
instead. If you try it:

1. Install **Docker Desktop for Windows** and start it, until it says Docker
   is running.
2. Open **PowerShell** and run (note `curl.exe`, not `curl`):

   ```powershell
   mkdir $HOME\sentry-six-manager
   cd $HOME\sentry-six-manager
   docker compose version
   curl.exe -fsSLO https://raw.githubusercontent.com/skittles-fivem/Sentry-Manager/main/docker-compose.yml
   docker compose up -d
   ```

3. Prefer an **SMB share** vehicle (footage on a NAS or shared folder, see
   [4a](#a-footage-on-an-smb-share-another-nas-or-pc)). For a folder on the
   PC, the left side of the volume line is a Windows path written with
   forward slashes, for example `- C:/TeslaCam:/footage/my-car`.

On Windows, open the app at `https://localhost:9000` on the PC itself.

---

## 3. First sign-in

1. Get the **setup code** from the log:

   ```bash
   docker logs sentry-six-manager
   ```

   **You should see** a line like:

   ```
   No account yet. To create it, open the web UI and enter the setup code ABCDE-FGHJK-LMNPQ
   ```

   and the certificate's **fingerprint** (a long string of letters and
   numbers with colons).

   Important:
   - **Use the newest code.** Every restart before you've created the
     account prints a **new** code; older ones stop working. Use the
     **last** one in the log.
   - The same code is also in the file `data/setup-code.txt` (in the folder
     where you ran `docker compose up -d`). Only the app's user may read it,
     so use `sudo cat data/setup-code.txt`.

   **If you see no code:** an account already exists (for example from
   `UI_PASSWORD` in `.env`). Sign in with that account instead.

2. In a browser on any device on your network, open:

   ```
   https://<server-ip>:9000
   ```

   (for example `https://192.168.1.20:9000`). Type the **`https://`** part.

3. **You should see a security warning.** That's expected: the app makes its
   own certificate, which your browser doesn't know yet. Continue past it:
   - Chrome, Edge, Samsung Internet: **Advanced → Proceed**
   - Safari: **Show Details → visit this website**
   - Firefox: **Accept the Risk and Continue**

   Each device asks once. To be sure it's your server, compare the
   fingerprint in the browser's certificate details with the one in the log.

4. **You should see** the first-start page asking for a **User name**, a
   **Password**, **Confirm password** and the **Setup code**. Enter a user
   name (letters, numbers and `. _ @ -`), a password of **at least 8
   characters** twice, and the code (dashes and small letters are fine).
   Write the user name and password down: there is no "forgot password"
   (the only way back in is [Start over](#start-over-completely), which
   resets the account and settings).

**If not:**
- The page doesn't load at all: check the address and port, that the
  container is `Up` (`docker ps`), and that no firewall on the server blocks
  port 9000 (for example `sudo ufw allow 9000/tcp` on Ubuntu).
- A short page about a certificate instead of the app: you typed
  `http://`. Type `https://`.
- *The passwords do not match*: type the same password in both fields.
- *That setup code is not right*: you used an old code. Run
  `docker logs sentry-six-manager` again and use the **last** code.

---

## 4. Add your car's footage

Each car (vehicle) has one footage source: **(a)** an SMB share the app
connects to itself, or **(b)** a folder on this server that you give the
container.

### (a) Footage on an SMB share (another NAS or PC)

What the share needs:

- **SMB 3.** SMB 1 and 2 are refused.
- **A real user account** with a password. Guest access is refused. A NAS
  user that can only reach the TeslaCam share is best.
- **Encryption** is on by default and recommended. If your NAS can't
  encrypt, you can untick it for that vehicle (the connection stays signed).
- **Write access** for that account, if you want to convert footage or use
  the Recycle Bin.

Steps:

1. In the app: **Settings → Vehicles → Add vehicle**.
2. Name: anything (`Daily Driver`). Time zone: your car's time zone.
3. Footage source: **SMB share**.
4. Share: `//<nas-ip>/<share-name>`, for example `//192.168.1.50/TeslaCam`.
   Two forward slashes, the IP address (not a name, to rule out name
   problems), then the share name.
5. User name and password of the NAS account. Leave *Domain* empty unless
   your NAS uses one.
6. SMB version: leave **SMB 3.1.1 (recommended)**; pick 3.0 only if the test
   says so.
7. Press **Test connection** and wait.

   **You should see** *Connected: the user name and password work.* and
   *Tesla footage found*. **If not**, it tells you why; see
   [SMB errors](#smb-errors). Two messages that are not errors:
   - *No TeslaCam folder found yet*: the share is empty, or the footage is
     more than 3 folders deep. Point the share at a folder closer to it
     (`//192.168.1.50/share/folder` works).
   - *Read-only for this account*: it will work, but to convert footage or
     use the Recycle Bin, give that NAS account write access.
8. Press **Add vehicle**. It asks for **your password again** (adding a
   vehicle is a protected change).

**You should see** the vehicle in the list, and after its first scan the
footage under **Footage**.

### (b) Footage on this same server (a folder)

The default `docker-compose.yml` gives the container **no** footage folder, so
you add one:

1. Open `docker-compose.yml` (in the folder where you installed) in a text
   editor, for example `nano docker-compose.yml`.
2. Find these lines:

   ```yaml
       volumes:
         # accounts, settings, journals, thumbnails and converter staging
         # (keep it on a local disk, not on a share)
         - ./data:/data
   ```

   and add **one line** under `- ./data:/data`, lined up the same way:

   ```yaml
         - /mnt/tesla:/footage/my-car
   ```

   Replace `/mnt/tesla` with **your** folder: the one that holds `TeslaCam`,
   or the one that holds `RecentClips` / `SentryClips` / `SavedClips`. Leave
   the right side as `/footage/my-car`.

   **Always mount *below* `/footage`** (`/footage/my-car`), **never at
   `/footage` itself.** The app takes over `/footage` for its own mounts and
   makes it belong to root on every start; your folder there would get that
   too.
3. Save, then apply it (the container is recreated, your settings stay):

   ```bash
   docker compose up -d
   ```

4. In the app: **Settings → Vehicles → Add vehicle**, Footage source:
   **Folder in the container**, Folder: `/footage/my-car` (the **container**
   path, the right side of the line, **not** the server path). Press **Add
   vehicle** and enter your password again.

**You should see** the vehicle, and its footage under **Footage**.

**If not:**
- *Folder vehicles must be inside /footage*: you typed the server path.
  Type `/footage/my-car`.
- The vehicle shows **read-only**: see [Permissions](#permissions-read-only-vehicle).
- No footage: check that the folder on the left really holds `TeslaCam`, or
  `RecentClips` / `SentryClips` / `SavedClips`.

#### Permissions (read-only vehicle)

The app runs as user `1000`, group `1000`. If your footage belongs to a
different user on the server, the vehicle is read-only (nothing can be
converted or moved to the Recycle Bin). Fix it:

1. Find the footage owner's numbers: `ls -ln /mnt/tesla` shows them (the
   two numbers after the permissions), or `id <username>`.
2. In the install folder, create or edit a file named `.env` with those
   numbers:

   ```
   PUID=1026
   PGID=100
   ```

3. `docker compose up -d`.

(On TrueNAS the app uses `568`, the `apps` user. Give `apps` Modify on the
dataset instead.)

---

## 5. Updating

**Settings → Updates** shows when a new version is out. It never installs
anything itself. A new version only appears when the project releases one.

Linux, Synology (with `sudo`), Unraid and Windows, in the install folder:

```bash
docker compose pull
docker compose up -d
```

**You should see** the image downloaded and the container *Recreated*/*Started*.
Your account, settings, footage and Recycle Bin stay. Updating during a
conversion is fine: it carries on by itself afterwards.

TrueNAS: in *System → Shell* run

```bash
docker pull ghcr.io/skittles-fivem/sentry-manager:latest
```

then *Apps → Installed → sentry-six-manager → Stop*, then *Start*. If
**Overview → Server** still shows the old version, *Edit* the app and *Save*
without changes.

---

## 6. Optional settings (.env) and their traps

Everything is optional; the web page does all the setup. If you do use a
`.env` file (in the install folder, next to `docker-compose.yml`; see
[`.env.example`](../.env.example)), know these traps:

- **Passwords with `$`.** Docker Compose treats `$` in `.env` as the start
  of a variable. Put such a value in **single quotes**:
  `SMB_PASSWORD='pa$$word'`. (This is Compose's own documented behaviour.)
- **`UI_PASSWORD` must be at least 8 characters**, and `UI_USERNAME` may
  only use letters, numbers and `. _ @ -`. Otherwise the app **does not
  start**: it keeps restarting, and the log says *Use a password of at least
  8 characters* or *User names may use letters, numbers and . _ @ -*. Fix
  the value and run `docker compose up -d`.
- **`VEHICLE_NAME`, `SMB_SHARE`, `FOOTAGE_PATH` only work on the very first
  start**, when there is no vehicle yet. Changing them later does nothing;
  edit the vehicle in **Settings** instead.
- **`FOOTAGE_PATH` is skipped without a word** if that folder doesn't exist
  in the container. It must be the **container** path (`/footage/my-car`),
  and the volume line from [4b](#b-footage-on-this-same-server-a-folder) must
  be there.
- **`PUID` and `PGID` must not be `0`** (root): the app is built to run
  as an ordinary user.
- **`TZ`** sets the server's time zone (log times, when policies run), for
  example `TZ=America/Chicago`. Without it the server uses UTC.
- **Don't set `PORT`** in `.env`. The compose file always maps port 9000; to
  use another port, change the **left** number in `docker-compose.yml`
  (`"9010:9000"`), not `PORT`.
- After any change to `.env`: `docker compose up -d`.

---

## 7. When something goes wrong

Always start with the log: the last 50 lines usually say what's wrong.

```bash
docker logs --tail 50 sentry-six-manager
```

(TrueNAS: the log icon under *Apps → Installed → sentry-six-manager →
Workloads*.)

### Old Compose (below 2.24)

The compose file uses a newer `env_file` form. Best: update Docker. If you
can't, in `docker-compose.yml` replace

```yaml
    env_file:
      - path: .env
        required: false
```

with

```yaml
    env_file: .env
```

and create an empty `.env` file next to it (`touch .env`). Then
`docker compose up -d`.

### "no configuration file provided" or "no such service"

You ran `docker compose` in the wrong folder. `cd` into the folder that holds
`docker-compose.yml` (for example `cd ~/sentry-six-manager`) and try again.

### "yaml: line …" after editing docker-compose.yml

The file's indentation is off. Use **spaces, never tabs**, and line the new
line up exactly with the one above it (`- ./data:/data`). When unsure,
download the file again and redo the edit.

### "The container name ... is already in use"

An old container with the same name is left over (from an earlier try, or a
TrueNAS or Portainer install). Remove only the container (your `data` folder
stays): `docker rm -f sentry-six-manager`, then `docker compose up -d`.

### "no matching manifest" / "exec format error"

Images exist for 64-bit Intel/AMD (`amd64`) and 64-bit ARM (`arm64`). A
Raspberry Pi needs a **64-bit** OS; 32-bit systems can't run it.

### Port 9000 is taken

In `docker-compose.yml`, change `"9000:9000"` to, for example,
`"9010:9000"` (only the **left** number), run `docker compose up -d`, and open
`https://<server-ip>:9010`.

### The page warns "not secure" every time

Each device asks once. If one that already continued warns again and you
changed nothing on the server, **don't continue**: compare the fingerprint
with `docker logs sentry-six-manager`. To get rid of the warning for good on
a device, install the app's certificate authority from **Settings →
Security**; that page has the steps for each device.

### SMB errors

The **Test connection** button explains the problem. What each one means:

| Message / mount error | What to do |
|---|---|
| *no CIFS support* | On the server (not in the container): `sudo modprobe cifs`, and install `cifs-utils`. Synology, Unraid, TrueNAS and most Linux systems have it. |
| error **13**, *Permission denied* | Wrong user name or password (or Domain). Check them on the NAS. On Ubuntu, the compose file's `apparmor:unconfined` line must still be there. |
| error **95** or **5**, *refused an encrypted SMB 3 session* | Turn on SMB 3 encryption on the NAS (Synology: *Control Panel → File Services → SMB → Advanced*; Samba: `server smb encrypt = desired`), or pick SMB 3.0, or as a last resort untick *Encrypt the connection* for this vehicle. |
| error **22**, *rejected a mount option* | The NAS doesn't do SMB 3.1.1: choose **SMB 3.0** for this vehicle. |
| error **112**, *unreachable, or it does not speak SMB 3* | Check the IP address; on the NAS set the minimum SMB version to SMB 3. |
| error **2**, *share was not found* | The share name is wrong. It must look like `//192.168.1.50/TeslaCam`. |
| *Could not reach the SMB server* | Wrong IP, NAS off, or port 445 blocked between the server and the NAS. |
| *Could not resolve the server name* | Use the NAS's IP address instead of its name. |
| *not allowed to mount* | The `cap_add` lines in `docker-compose.yml` were removed. Download the file again. |

### Fedora, RHEL and other SELinux systems

If mounts or the `data` folder fail with *permission denied* although the
permissions look right, delete the `#` in front of `- label=disable` under
`security_opt:` in `docker-compose.yml`, then `docker compose up -d`.

### Keep `data` on a local disk

The `data` folder (account, settings, journals, converter work) must be on
a local disk of the server, not on an SMB or NFS share. Only the footage may
live on a share.

### Watching from outside your home

Don't forward port 9000 on your router. Use a VPN to your home network (your
router's, or one like WireGuard or Tailscale) and open the same
`https://<server-ip>:9000` address.

### The container keeps restarting

`docker logs --tail 50 sentry-six-manager` shows the reason, often a
`.env` value (see [6](#6-optional-settings-env-and-their-traps)). Fix it,
then `docker compose up -d`.

### Start over completely

This **deletes the account and settings** (not your footage):

```bash
docker compose down
sudo rm -rf data
docker compose up -d
```

(`sudo` because the app's files in `data` belong to the app's user, not
yours.)

Then go back to [3. First sign-in](#3-first-sign-in).

### Still stuck

Open an issue on [GitHub](https://github.com/skittles-fivem/Sentry-Manager/issues)
with your system (Synology, Unraid, TrueNAS, Linux, Windows), the output of
`docker compose version`, and the last 50 log lines. Leave out passwords.

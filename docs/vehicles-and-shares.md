# Vehicles and SMB shares

[← Back to the README](../README.md)

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

## Footage on the same machine

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

# TrueNAS

[← Back to the README](../README.md)

On TrueNAS SCALE 24.10 or newer, install it as a custom app with
[`truenas/sentry-six-manager.yaml`](../truenas/sentry-six-manager.yaml):

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

**Sentry USB and the CAN Bridge.** Keep port `10000` in the file: the Sentry
USB (the Pi in the car) and the Screenmate CAN Bridge connect to TrueNAS on it.
Nothing listens there until one of them is set up. To pair a Sentry USB, see
[Sentry USB → Managing it from here](sentry-usb.md#managing-it-from-here); the
address you give the Pi is `<truenas>:10000`.

**A certificate for a public name (optional).** For Let's Encrypt, point a DNS
record at TrueNAS, forward ports 80 and 443 on your router, and turn on the
`80:9000` / `443:9000` lines and `TLS_ACME_DOMAIN` / `TLS_ACME_EMAIL` in the
file (*Edit*, *Save*). TrueNAS's own web UI uses 80 and 443 by default: move it
first (*System → General → GUI*) or leave this off. More in
[Security](security.md).

## Updating

**Settings → Updates** says when a newer image is out. TrueNAS often keeps the
copy of `latest` it already has, so fetch the new one in *System → Shell*. The
shell is not root, so it needs `sudo` (it asks for your TrueNAS password):

```bash
sudo docker pull ghcr.io/skittles-fivem/sentry-manager:latest
```

Then *Apps → Installed → sentry-six-manager → Stop*, then *Start*. The version
on **Overview → Server** shows the update took; if it didn't, *Edit* the app
and *Save* to have TrueNAS recreate it. Your settings stay in the `/data`
dataset. To have updates installed for you, see
[Automatic updates](auto-updates.md#truenas-scale).

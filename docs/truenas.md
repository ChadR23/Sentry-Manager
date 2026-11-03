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

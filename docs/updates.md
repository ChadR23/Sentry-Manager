# Updates

[← Back to the README](../README.md)

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

## Critical updates

[`CRITICAL_UPDATE.txt`](../CRITICAL_UPDATE.txt) holds a `level` (0 = no
critical release yet) and a `reason`. To make the next release critical (a
security or data-loss fix everyone must install), raise `level` by one, write
the reason on the `reason:` line (one short line, for example
`reason: Fixes a bug that can delete footage`) and push to `main`. Every
server running an older image then shows a red **Critical update: install
now** bar with that reason and the update command at the top of every page,
in every interface, and raises a notification.

Leave the file as it is for the releases after it: every image carries the
last critical level, so a server that skips releases still sees the bar
until it installs that release or any later one. A server also remembers the
highest level it has seen, so even an image that lost the labels does not
hide it. Only change the file for the next critical release.

Images are built by GitHub Actions for amd64 and arm64
([`image.yml`](../.github/workflows/image.yml)) and published to
`ghcr.io/skittles-fivem/sentry-manager`. `latest` follows `main`, every
commit also gets a `sha-<commit>` tag you can pin with `SENTRY_TAG`.
Images are only built for a release (nothing is rebuilt on a timer), so
"update available" always means there is a new release; each build takes
the latest Debian, Node and ffmpeg security fixes.

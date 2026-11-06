# Automatic updates (Watchtower)

[← Back to the README](../README.md) · [Updates](updates.md)

Sentry Six Manager never installs an update by itself. **Settings → Updates**
only tells you when a new version is out. To have updates installed for you,
run [Watchtower](https://github.com/nicholas-fedor/watchtower) next to it: a
small container that checks once a day for a new image and, when there is
one, restarts Sentry Six Manager on it.

The original Watchtower (`containrrr/watchtower`) is no longer maintained
(archived in December 2025). This guide uses the maintained continuation,
`nickfedor/watchtower`, which works the same way.

## Before you start: what Watchtower can do

Watchtower needs Docker's socket (`/var/run/docker.sock`) to restart
containers. Whatever has that socket can control **every** container on the
machine, as root. That is why Sentry Six Manager does not do this itself and
its web app never runs as root. Add Watchtower only if you are fine with
that, and keep it to the one container as shown below.

What it does not change:

- Your account, settings, footage and Recycle Bin stay, as with any update.
- A conversion that is running stops cleanly and carries on after the
  update. Watchtower waits the minute set in Sentry Six Manager's
  `stop_grace_period`.
- New images are only published for a release, never on a timer, so
  Watchtower only restarts the app when there really is a new version.

## Docker Compose (Linux, Synology, Unraid with Compose)

In the folder with Sentry Six Manager's `docker-compose.yml`, create a second
file, `watchtower.yml`:

```yaml
services:
  watchtower:
    image: nickfedor/watchtower:1.24
    container_name: watchtower
    restart: unless-stopped
    environment:
      TZ: America/Chicago          # your time zone
      WATCHTOWER_SCHEDULE: "0 17 4 * * *"   # every day at 4:17 AM
      WATCHTOWER_CLEANUP: "true"   # delete the old image after updating
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: sentry-six-manager    # only this container, nothing else
```

Change `TZ` to [your time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
and the time if 4:17 AM doesn't suit you (the fields are seconds, minutes,
hours). Then start it:

```bash
docker compose -f watchtower.yml up -d
```

Check that it found the app:

```bash
docker logs watchtower
```

You should see it start and name its next check. It must not list any other
container: if it does, the `command:` line is missing.

## TrueNAS SCALE

*Apps → Discover Apps →* the three dots at the top right *→ Install via
YAML*. Name it `watchtower` and paste:

```yaml
services:
  watchtower:
    image: nickfedor/watchtower:1.24
    container_name: watchtower
    restart: unless-stopped
    environment:
      TZ: America/Chicago
      WATCHTOWER_SCHEDULE: "0 17 4 * * *"
      WATCHTOWER_CLEANUP: "true"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: sentry-six-manager
```

Sentry Six Manager's TrueNAS file already names its container
`sentry-six-manager`, so this finds it. TrueNAS does not know Watchtower
restarted the app: after an update, *Installed* may still show the app as it
was until you open it. **Overview → Server** in Sentry Six Manager always
shows the version that is really running. If the app ever looks stuck on an
old version, use the manual steps in [TrueNAS](truenas.md).

## Check it now instead of waiting

To make Watchtower check once right away, without changing anything about
its schedule:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock nickfedor/watchtower:1.24 --run-once --cleanup sentry-six-manager
```

## Turning it off

Compose:

```bash
docker compose -f watchtower.yml down
```

TrueNAS: *Apps → Installed → watchtower → Delete*.

Sentry Six Manager is not affected either way; you update by hand again as
in [Updates](updates.md).

## If you pin a version

If `.env` has `SENTRY_TAG=sha-…` to stay on one release, Watchtower keeps you
on exactly that image and never moves you to a newer one. Remove the line
(or set it to `latest`) to get updates.

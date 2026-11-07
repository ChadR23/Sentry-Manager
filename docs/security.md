# Security

[← Back to the README](../README.md)

![Settings → Security](images/security.png)

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

## Accounts and roles

**Account** (a page in every interface) lists the accounts for admins, who can
add more: **Admin** can do everything; **Watch only** can watch footage, use
the Viewer and the maps, export videos and star moments, but cannot delete,
convert or change settings, and cannot read the logs, snapshots or support
bundle. There is always at least one admin. Adding, changing or removing an
account asks for your password again.

## Two-step sign-in

Turned on per account on the Account page: an authenticator app on your phone
(Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden, Aegis…)
gets a setup key (typed in, or opened in the app with the link on a phone),
and from then on signing in asks for its 6-digit code after the password, on
a page every interface uses. Each code works once. Ten one-time recovery
codes are shown when it is turned on: keep them, for when the phone is lost.
Nothing is sent anywhere: the app makes the codes itself from the key.

## Signed-in devices

The Account page lists where your account is signed in (browser and system,
address, when it was last used), and signs out one of them, or everywhere
but here.

## Metrics (off by default)

For your own monitoring (Prometheus, Grafana, Home Assistant): Health →
*Metrics* turns on `/metrics` on the same address and port (no new port is
opened) and makes a token, shown once. Without the token it answers 401; while
off, 404. It gives numbers only (free space, footage size, shares up or down,
the Recycle Bin, conversions, open alerts), no paths or names. *Turn off*
ends it and the token.

## Which alerts you get

Health → *Which alerts you get*: turn off a kind of notification (shares,
space, server hardware, startup checks, conversions, new versions); it is
still written to the logs. The critical-update bar always shows.

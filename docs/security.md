# Security

[← Back to the README](../README.md)

![Settings → Security](images/security.png)

**HTTPS only.** Port 9000 speaks HTTPS (HTTP/2), so nobody on your network
can read your password or footage, or change the page. Plain HTTP on the
same port never shows the app: every request is redirected straight to the
HTTPS address. Manager sends no HSTS header: with its own certificate it
would remove the browser's "continue" button on some devices, and force
HTTPS on every other port of the NAS's address.

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
wrong passwords slow down further attempts, and an address that keeps
failing is banned for a while (see [Bans](#bans-after-failed-sign-ins)). Cookies are HttpOnly,
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

## Opening Sentry Six Manager to the internet

The safest way to reach it from away is not to open it at all: a VPN
(**Tailscale** or **WireGuard**, both run on TrueNAS and on the router of
many homes) puts your phone on the home network wherever it is, and nothing
is reachable from the internet. If you do open it:

1. **Never without a trusted certificate.** The built-in certificate
   authority only covers local names and private addresses, and a warning
   you click past on a public network is exactly what an attacker in the
   middle would show you. Use a real certificate from Let's Encrypt (free):
   - Get a domain name that points at your home (a domain of your own, or a
     free dynamic DNS name such as DuckDNS, kept up to date by the router or
     a DDNS client when your home address changes).
   - **A reverse proxy in front (recommended):** Caddy or Nginx Proxy Manager
     (both are TrueNAS apps) gets and renews the certificate by itself. Point
     it at `http://<nas>:9000` and run Sentry Six Manager with
     `TLS_MODE=off` and `TRUST_PROXY=true`. Then forward only port **443** on
     the router to the proxy. Port 9000 stays closed to the internet (with
     `TLS_MODE=off` it speaks plain HTTP: never forward it then).
   - **Or the certificate files themselves:** certbot (or the proxy) writes
     `fullchain.pem` and `privkey.pem`; mount them read-only and set
     `TLS_CERT_FILE` and `TLS_KEY_FILE`. Then forward port 9000 (or 443 to
     9000) straight to Sentry Six Manager. The files are read again once a
     day, so a renewal is picked up within a day (or at once by restarting
     the container).
2. **Turn on the rules in Settings → Security** (they are off until you do;
   see below): two-step sign-in for every account that signs in from
   outside, "Admin changes only from the home network" (or the stricter
   "Settings and the other admin pages only from the home network"), and
   leave the bans on.
3. **Turn on two-step sign-in** for your own account first (Account), and
   keep the recovery codes.
4. **Check the address** Settings → Security shows for a phone on mobile
   data: it must say *outside the home network*. If it says home network,
   the proxy (or the router) hides the real address, and the rules would
   treat the whole internet as home; fix that before relying on them.

Port **10000**, the CAN Bridge's uploads, is separate: it serves only the
upload API with its own tokens, and can be opened on its own
([CAN Bridge upload API](can-bridge-api.md#the-port)). Opening 9000 is not
needed for the bridge.

### Which address a request comes from

Every rule here, the bans, the sign-in slow-down and the audit log use one
address per request:

- **Without `TRUST_PROXY`:** the connection's own address (an IPv4 address
  written `::ffff:1.2.3.4` counts as `1.2.3.4`). `X-Forwarded-For` is
  ignored: anyone can send it.
- **With `TRUST_PROXY=true`:** the same, unless the connection itself comes
  from a trusted proxy: an address on the local network, or one in
  `TRUSTED_PROXIES` when that is set. Only then is `X-Forwarded-For` read,
  from the right: the client is the rightmost address in it that is not a
  trusted proxy. What a client puts in the header itself ends up on the
  left, so someone on the internet sending `X-Forwarded-For: 192.168.1.5` is
  still seen by their real address. The same goes for `X-Forwarded-Proto`
  and `X-Forwarded-Host`: believed only from a trusted proxy.
- A proxy reached over Tailscale (`100.x.y.z`) is not on the local network:
  list it in `TRUSTED_PROXIES`.

**The home network** is loopback, the private ranges `10.0.0.0/8`,
`172.16.0.0/12` and `192.168.0.0/16`, link-local `169.254.0.0/16` and
`fe80::/10`, and IPv6 unique local addresses `fc00::/7`. Tailscale's range
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) counts only when *Count Tailscale
as the home network* is ticked: `100.64.0.0/10` is also what mobile
carriers use for shared addresses (CGNAT). Admins can add more addresses
and ranges (at most 32, no wider than /8 or /32 for IPv6), for example the
fixed address of an office.

### Bans after failed sign-ins

On by default. Wrong passwords (for any user name, existing or not), wrong
two-step codes, wrong password confirmations or current passwords, and
wrong setup codes all count against the address they came from (an IPv6
address by its /64, which is one home or one server). **10 within 60
minutes** ban it for **1 hour**; each further ban within a week doubles, up
to **24 hours**. All four numbers can be changed. A banned address gets
*429* with the same short message on every sign-in step, whatever it tried,
so it learns nothing about accounts. A device already signed in from that
address keeps working (it needed the password), except a session whose own
wrong password confirmations brought the ban: it is signed out. Bans are
kept in the database (at most 2,000) and survive restarts.

**Addresses on the home network are never banned** while *Never ban
addresses on the home network* is ticked (the default), so you cannot lock
yourself out at home. The slow-down after a few wrong passwords (it doubles
from 30 s up to 15 minutes, per address and per account from that address)
stays in front of the bans.

Settings → Security lists the banned addresses with when, why and until
when, and **Unban** lets one in again. Every ban and unban is an `[audit]`
line.

### Two-step sign-in rules

Both off by default:

- **Require two-step sign-in for sign-ins from outside the home network.**
  An account without it can sign in only at home, and is told so (with how
  to set it up) when it tries from outside. A device of such an account
  that is already signed in is signed out on its next request from outside,
  so a session made at home cannot be taken outside. Accounts with
  two-step sign-in use their code, or a recovery code, as always.
- **Require two-step sign-in for every account, everywhere.** An account
  without it can sign in only at home, and then only to set it up (a page
  of its own, the same in every interface); nothing else opens until it is
  on. From outside it cannot sign in. Your own account needs two-step
  sign-in before this can be turned on.

### Admin work only from the home network

Both off by default:

- **Admin changes only from the home network.** From outside, admins can
  still look at everything, but every change that needs an admin
  (settings, vehicles and shares, accounts, deleting footage or the Recycle
  Bin, the CAN Bridge's tokens and pairing, interfaces, updates, nodes) is
  refused with a message saying so. What any account may do (exports,
  starred moments, your own password and two-step sign-in, signing out
  devices) still works. Turning the rule off again also needs the home
  network.
- **Settings and the other admin pages only from the home network.**
  Stricter: from outside, admin accounts are watch-only (footage, the
  Viewer, maps, exports, starred moments), as if they were a watch-only
  account.

Changing any of these rules needs your password again, and is an `[audit]`
line with what changed.

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

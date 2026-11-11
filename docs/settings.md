# Settings (.env)

[← Back to the README](../README.md)

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
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `-Proto` / `-Host` from that reverse proxy (only from a connection that comes from it: see [Security](security.md#which-address-a-request-comes-from)) |
| `TRUSTED_PROXIES` | | With `TRUST_PROXY`: the reverse proxy's addresses or ranges (`172.18.0.5`, `10.0.0.0/8`), when it is not on the local network (a proxy reached over Tailscale, `100.64.0.0/10`) or to trust only it; default: any address on the local network |
| `TRUSTED_HOSTS` | | If set, refuse requests for any other host name |
| `SENTRY_TAG` | `latest` | Which image to follow; `build-128` (or `sha-<commit>`) stays on that build ([Updates](updates.md#how-images-are-built)) |
| `UPDATE_CHECK` | `on` | `off` = don't check for newer images |
| `EXPORT_ENCODER` | `auto` | `cpu` = render exports on the CPU even when a GPU could |
| `CPU_ENCODER_PRESET` | `medium` | `fast` or `faster` = quicker conversions on the CPU, a little less detail ([Encoder](encoder.md#gpu)) |
| `SCRUB_PREPARE_DAYS` | `2` | Days of the newest footage whose timeline previews are made ahead; `0` = only when opened |
| `EXTRA_ROOTS` | | More container folders the converter may write to (`:`-separated) |
| `SCAN_INTERVAL_MINUTES` | `15` | How often every vehicle is re-scanned |
| `PORT`, `DATA_PATH`, `LOG_LEVEL` | `9000`, `/data`, `info` | |
| `CAN_PORT` | `10000` | The device port: the Screenmate CAN Bridge's uploads and the Sentry USB management link ([sentry-usb-link.md](sentry-usb-link.md)); open only while CAN uploads are on or a Sentry USB is paired or pairing |
| `REPORTS_URL` / `REPORTS_PUBLIC_KEY` | (built in) | Another receiver for the opt-in feedback and diagnostics reports (Settings → Help & feedback), and its key line; https only ([reports-api.md](reports-api.md)) |
| `REPORTS` | (on) | `off`: no feedback or diagnostics reports from this server at all; Help & feedback says reporting is turned off |

`./data` holds the account, settings, job history, thumbnails, the
converter's work folder and the certificate authority. Keep it on a local
disk, not on a share. `data/scrub` holds the Viewer's timeline previews
(about 1 MB per minute of footage, six cameras), made ahead for the newest
two days in the background (not while converting) and otherwise when a clip
is first opened; it keeps at most about 1 GB and drops the least recently used first.
Deleting it is safe: previews are made again when needed.

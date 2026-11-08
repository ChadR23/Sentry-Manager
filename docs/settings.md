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
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-Proto` / `-Host` from that reverse proxy |
| `TRUSTED_HOSTS` | | If set, refuse requests for any other host name |
| `SENTRY_TAG` | `latest` | Which image to follow |
| `UPDATE_CHECK` | `on` | `off` = don't check for newer images |
| `EXPORT_ENCODER` | `auto` | `cpu` = render exports on the CPU even when a GPU could |
| `CPU_ENCODER_PRESET` | `medium` | `fast` or `faster` = quicker conversions on the CPU, a little less detail ([Encoder](encoder.md#gpu)) |
| `SCRUB_PREPARE_DAYS` | `2` | Days of the newest footage whose timeline previews are made ahead; `0` = only when opened |
| `EXTRA_ROOTS` | | More container folders the converter may write to (`:`-separated) |
| `SCAN_INTERVAL_MINUTES` | `15` | How often every vehicle is re-scanned |
| `PORT`, `DATA_PATH`, `LOG_LEVEL` | `9000`, `/data`, `info` | |
| `CAN_PORT` | `10000` | The Screenmate CAN Bridge's uploads (only the CAN upload API, and only while CAN uploads are on) |

`./data` holds the account, settings, job history, thumbnails, the
converter's work folder and the certificate authority. Keep it on a local
disk, not on a share. `data/scrub` holds the Viewer's timeline previews
(about 1 MB per minute of footage, six cameras), made ahead for the newest
two days in the background (not while converting) and otherwise when a clip
is first opened; it keeps at most about 1 GB and drops the least recently used first.
Deleting it is safe: previews are made again when needed.

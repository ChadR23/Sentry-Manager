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
| `DEFAULT_UI` | `sentry-six` | The main interface, used until an admin chooses another in Settings → Interface: `sentry-six`, or another built-in pack's id (`horizon`, `aurora`, `daylight`, `flux`). `original` brings back the classic interface as the main one (it is otherwise only the `/original` fallback) |
| `UPDATE_CHECK` | `on` | `off` = don't check for newer images |
| `EXPORT_ENCODER` | `auto` | `cpu` = render exports on the CPU even when a GPU could |
| `CPU_ENCODER_PRESET` | `medium` | `fast` or `faster` = quicker conversions on the CPU, a little less detail ([Encoder](encoder.md#gpu)) |
| `SCRUB_PREPARE_DAYS` | `2` | Days of the newest footage whose timeline previews are made ahead; `0` = only when opened |
| `EXTRA_ROOTS` | | More container folders the converter may write to (`:`-separated) |
| `SCAN_INTERVAL_MINUTES` | `15` | How often every vehicle is re-scanned |
| `PORT`, `DATA_PATH`, `LOG_LEVEL` | `9000`, `/data`, `info` | |
| `CAN_PORT` | `10000` | The device port: the Screenmate CAN Bridge's uploads; open only while CAN uploads are on |
| `REPORTS_URL` / `REPORTS_PUBLIC_KEY` | (built in) | Another receiver for the opt-in feedback and diagnostics reports (Settings → Help & feedback), and its key line; https only ([reports-api.md](reports-api.md)) |
| `REPORTS` | (on) | `off`: no feedback or diagnostics reports from this server at all; Help & feedback says reporting is turned off |

`./data` holds the account, settings, job history, thumbnails, the
converter's work folder and the certificate authority. Keep it on a local
disk, not on a share. `data/scrub` holds the Viewer's timeline previews
(about 1 MB per minute of footage, six cameras), made ahead for the newest
two days in the background (not while converting) and otherwise when a clip
is first opened; it keeps at most about 1 GB and drops the least recently used first.
Deleting it is safe: previews are made again when needed.

## Background work (Settings → System or Advanced)

How many clips the background jobs handle at once is picked from the memory
and CPUs the container really has: a Docker or Kubernetes limit
(`--memory`, `--cpus`; cgroup v2 `memory.max` / `cpu.max`, or v1
`memory.limit_in_bytes` / `cpu.cfs_quota_us`) counts, not only what the
host has. The server takes the smaller of its memory size and its CPU size:

| | Memory | CPUs | Speed index (at most) | Codec checks | Scrub previews | Car data reads | Thumbnails |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Small | under 3 GB | 1–2 | 1 | 2 | 1 | 1 | 1 |
| Mid-size | 3–7 GB | 3 | 2 | 4 | 2 | 1 | 2 |
| Full-size | 7 GB or more | 4 or more | 4 | 8 | 3 | 2 | 2 |

A full-size server gets the numbers every server had before. The
Background work card shows the numbers in use and the memory and CPUs they were picked from; an
admin can type any of them (an empty box stays automatic) and they apply at
once, without a restart. The start-up log has the same line
(`Background work: ...`).

Where the card is, in every interface (admins only; a watch-only account
does not see it):

| Interface | Where |
| --- | --- |
| Original | Settings → System |
| Sentry Six | Settings → Advanced |
| Aurora | Settings → System |
| Daylight | Settings → System & power |
| Flux | Settings → System |
| Horizon | Settings → System |

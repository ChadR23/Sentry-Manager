# supervisor: the root supervisor, mounts, and the channel to the app

A port of `server/supervisor.js`, `server/mounter.js`, `server/mountSpec.js`
and `server/proc.js`. The Node code is the specification.

## Binaries

- `sentry-lean-supervisor` (`bin.rs`): the container's entrypoint, root,
  under tini. It starts **`sentry-lean` from the same folder** (never a
  program inside `DATA_PATH`) as PUID:PGID, restarts it, serves its mount
  requests. The image runs:

  ```dockerfile
  ENTRYPOINT ["/usr/bin/tini", "--"]
  CMD ["/usr/local/bin/sentry-lean-supervisor"]
  HEALTHCHECK CMD ["/usr/local/bin/sentry-lean-supervisor", "healthcheck"]
  ```

  `sentry-lean-supervisor healthcheck` is Docker's health check without Node:
  `GET http://127.0.0.1:$PORT/healthz`, exit 0 on a 2xx answer.

  The image still needs `util-linux` (setpriv), `cifs-utils` (mount.cifs)
  and `tini`; docker-compose.yml keeps its capabilities (SYS_ADMIN,
  DAC_READ_SEARCH, DAC_OVERRIDE, SETUID, SETGID, SETPCAP, CHOWN, KILL, the
  rest dropped) and `no-new-privileges:true`.

## Files

| File | Port of | What |
| --- | --- | --- |
| `mod.rs` | supervisor.js | `Config` (env), `Supervisor::run`: folders, TLS export, launch, restart after 5 s, signals, log forwarding, RAPL, TLS name requests |
| `dirs.rs` | supervisor.js | `prepareDirs`, `ensureRootDir`, `chownTree`, `safeWrite`, `readNoFollow`, `isPlainDir`, the TLS file modes |
| `launch.rs` | supervisor.js | the setpriv command line, the app's environment, GPU device groups, `canDropBoundingSet` |
| `rapl.rs` | supervisor.js | `readRapl` and the 30 s / 2 s reading loop |
| `spec.rs` | mountSpec.js | `parseShare`, `normalizeSmb`, `credentialsText`, `mountArgs`, `securitySummary`, `VERSIONS` |
| `js.rs` | (JavaScript) | `String()`, `Number()`, truthiness, `trim()`, `\s`, UTF-16 lengths: what the spec's checks depend on |
| `mounter.rs` | mounter.js | `LocalMounter`, `checkId`, `serve_mount_request` (one queue per vehicle), the `Mounter` trait |
| `link.rs` | index.js, mounter.js, tls.js | the app's side: `Link`, `IpcMounter`, `tls_hostnames`, `rapl_on`, `drop_malloc_arena_max` |
| `ipc.rs` | Node's IPC channel | socketpair, JSON lines, fd 3 |
| `proc.rs` | proc.js | `run` (no shell, timeout with SIGKILL, 4 MiB output cap), `tail`, `head` |
| `ctx.rs` | | the `Tls` trait the supervisor needs from core |
| `tests.rs` | test/security, share, server tests | see "Tests" |

## The channel (IPC)

Node's child IPC channel was newline-delimited JSON over a Unix socketpair on
an inherited descriptor (`NODE_CHANNEL_FD`). The Rust channel is the same:

- The supervisor makes an `AF_UNIX` `SOCK_STREAM` socketpair (close-on-exec)
  and puts one end at **descriptor 3** in the app (`dup2` between fork and
  exec; setpriv passes it on). The app's environment has
  **`SENTRY_SUPERVISOR_FD=3`** and, when it runs as its own user,
  **`SENTRY_SUPERVISED=1`** (only then is it "supervised", as in Node).
- One message per line: a JSON object, UTF-8, ended by `\n`. Lines over
  1 MiB and lines that are not JSON are dropped.
- End of file means the other side is gone. For the app that is Node's
  `'disconnect'`: shut down ("supervisor gone").

### In the app (core, footage)

```rust
// first thing in main, before threads:
sentry_lean::supervisor::link::drop_malloc_arena_max();   // index.js line 6
let fd = sentry_lean::supervisor::ipc::take_from_env();   // takes fd 3, close-on-exec, removes the variable
// inside the runtime:
let link = Link::from_fd(fd).map(Arc::new);               // None unless SENTRY_SUPERVISED=1
if let Some(link) = &link {
    let mounter = IpcMounter::new(link.clone(), "/footage"); // implements Mounter, like LocalMounter
    let mut rx = link.subscribe();                           // every message (process.on('message'))
    // link.disconnected().await  -> shutdown('supervisor gone')
    // link.rapl_on()             -> { type: 'rapl', on: true }, every 10 s while sampling
    // link.tls_hostnames(&names) -> Ok(caReplaced) | Err((Some(400), msg)); then read SENTRY_TLS_DIR
}
```

Without a link the app uses `LocalMounter::new(footage_root, run_dir, 0, 0)`
itself, as `index.js` does with `createLocalMounter`.

### Messages, app to supervisor

| type | fields | answer |
| --- | --- | --- |
| `mount-request` | `requestId` (string, at most 64), `op` (`mount` / `unmount` / `forget`), `id`, `smb` (share, username, password, domain, version, encrypt, port: nothing else is read), `lazy` (only `true` counts) | `mount-result` `{ requestId, result }`; `result` is `{ code, timedOut, notFound, output }` for mount, `{ code, output }` for unmount, `{ code: 0 }` for forget, `{ code: -1, output }` for a refusal ('Invalid vehicle id.', 'Unknown request.', the SMB message, or 'The mount request was refused.'). The app waits 90 s, then `{ code: -1, timedOut: true, output: 'The supervisor did not answer.' }` |
| `rapl` | `on: true` | `rapl-reading` every 2 s for 30 s |
| `tls-hostnames` | `requestId`, `hostnames` (first 20) | `tls-result` `{ requestId, caReplaced }` or `{ requestId, error }`; the app waits 120 s |

Requests for one vehicle run one after another in arrival order; different
vehicles run side by side. Only a root supervisor answers.

### Messages, supervisor to app

| type | fields |
| --- | --- |
| `supervisor-log` | `level` (`info` / `warn`), `message` (at most 4000 characters). Lines from before the app started (up to 100) are sent when it starts. The app writes them to its log under `supervisor` without echoing them. |
| `rapl-reading` | `at` (ms), `packages: [{ name, energyUj, maxEnergyUj }]` |
| `mount-result`, `tls-result` | above |
| `tls-updated` | reload the certificate from SENTRY_TLS_DIR |
| `acme-challenge` | `token`, `keyAuthorization` (also every pending one when the app (re)starts) |
| `acme-challenge-done` | `token` |
| `shutdown` | sent when the supervisor may not signal the app (no CAP_KILL) |

## Life of the supervisor

1. Prepare folders (`dirs::prepare_dirs`). A failure is a warning ("could not
   prepare folders: ..."), not the end.
2. HTTPS (TLS_MODE not `off`, app separate): build the TLS manager through
   `ctx::TlsFactory`, export the app's copy to SENTRY_APP_TLS_DIR (root:PGID,
   0640 key, 0644 the rest), re-export every 24 h and send `tls-updated`.
3. Start the app: `setpriv --reuid --regid --groups=<GPU groups>|--clear-groups
   --inh-caps=-all --ambient-caps=-all [--bounding-set=-all] --no-new-privs --
   sentry-lean`, or plain setuid with a warning when setpriv is missing, or as
   root with a warning when PUID is 0. Environment: the supervisor's, plus
   APP_ROOT, HOME=DATA_PATH, SENTRY_TLS_DIR (when TLS), minus
   UI_PASSWORD_FILE, LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, TLS_KEY_FILE,
   TLS_CERT_FILE. MALLOC_ARENA_MAX is passed on; the app drops it itself.
   stdin is /dev/null, stdout and stderr are the supervisor's, cwd `/`.
4. Let's Encrypt starts after the first launch.
5. The app exits: "server exited (<code or signal>); restarting in 5 s", and
   it starts again 5 s later (no growing backoff, as in Node).
6. SIGTERM / SIGINT: the same signal to the app (or `shutdown` over the
   channel); the supervisor exits with the app's code (0 after a signal).
   With no app running (waiting to restart) it exits 0 at once.

## Tests

`cargo test --lib supervisor`. The root-only tests skip themselves when not
root. Nothing real is mounted: `mount` is a recording fake (a runner or a
script).

- the spec: every accepted and refused input of security.test.js, exact
  option strings and error texts, JavaScript coercions;
- the mounter: options, a 0600 credentials file, the password never on the
  command line, a fake `mount` program and its exact command line, a missing
  mount.cifs, a symlinked mount point refused, unmount/forget;
- serving requests: refusals, ignored messages, extra fields dropped, one
  vehicle at a time in order;
- the channel: JSON lines both ways, overlong and broken lines, the IPC
  mounter end to end, its timeout and "No connection" answers;
- the launch plan, PUID/PGID parsing, GPU device groups (root);
- prepare_dirs (root): /data root:PGID 01770, root folders 0700, a swapped
  tls folder set aside, planted links not followed, the one-time chown;
- the whole supervisor (root + setpriv): a fake app (shell script) checks it
  runs as 1000:1000 with no capabilities and no_new_privs, gets the pending
  ACME token, asks for a mount (root runs the fake mount with the fixed
  options), RAPL readings, a TLS name change, cannot read the credentials;
  it then crashes, is restarted, sees the crash in its log lines, and its
  exit code on SIGTERM is the supervisor's;
- signals while no app runs, and a program inside DATA_PATH never runs.

## What is left

- **TLS and Let's Encrypt** belong to core (`server/tls.js`, `acme.js`):
  core implements `ctx::Tls` and passes a `TlsFactory` in `bin.rs` (now
  `None`, which logs "HTTPS setup failed: the certificate authority is not
  part of this build yet" and runs the app without SENTRY_TLS_DIR).
- The app side (`sentry-lean`) does not use the link yet: core wires
  `take_from_env`, `Link`, shutdown on `disconnect`/`shutdown`, the log
  lines, `rapl-reading` and `tls-updated`; footage uses `IpcMounter`.
- Error texts that are only logged (file system errors in
  "mount car: ...") read like Rust's, not like Node's
  (`EEXIST: file already exists, mkdir ...`). Answers to the app are the same.
- lean/Dockerfile is still the sketch: it needs the CMD above, setpriv,
  cifs-utils and tini, and to run as root.

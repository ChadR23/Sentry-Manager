'use strict';

// Nodes, the worker side: another Sentry Six Manager (the main server) sends
// this one clips to encode and takes the encoded files back. Only the encode
// runs here; the main reads the share, writes the telemetry, verifies and
// saves. This server never sees share passwords and never touches footage.
//
// Pairing: Nodes > Let a main server use this one shows a one-time code (10
// minutes, one use, 5 wrong tries). The main proves it knows the code with an
// HMAC over the fingerprint of the certificate it saw on this connection, so
// a machine in between (with its own certificate) cannot pair; this server
// answers with a random token and an HMAC proving it knows the code too. The
// main pins this server's certificate from then on (server/nodes.js) and
// sends the token with every request. Only the token's SHA-256 is kept here.
//
// Requests (HTTPS, /node/v1, the token as "Authorization: Bearer"):
//   GET    /info                  name, encoders, slots, and `devices`: this
//                                  server's own GPUs and its CPU, each with its
//                                  encoders and clips at once
//   POST   /jobs                  the clip as the body, settings in X-Node-Job
//                                  (with `device`: encoded on that GPU or CPU)
//   POST   /slots                 clips at once: { slots: n } (older mains, the
//                                  default device), or { slots: { device: n } }
//   GET    /jobs/:id              progress
//   GET    /jobs/:id/output       the encoded file, once done
//   DELETE /jobs/:id              stop it and delete its files
// Settings are fixed choices (codec, bitrate or quality level, held lead-in
// frames, one of this server's device ids); ffmpeg's arguments are built
// here, never taken from the request. The main picks the devices and how many
// clips each converts at once (its Encoder page); this server keeps no such
// choice of its own beyond what an older main set.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');
const { buildEncodeArgs, decodeAccelArgs } = require('../src/main/converter/encoderPlanner');
const { QUALITY_LEVELS, LOCAL_DEVICE_ID } = require('../src/main/converter/contracts');
const { diskSpace } = require('../src/main/converter/fsSpace');
const { cudaOrderOptions } = require('../src/main/converter/runtime');

const SETTINGS_KEY = 'nodeWorker';
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_TRIES = 20; // wrong codes in all before the code is cancelled
const PAIR_TRIES_PER_ADDRESS = 3; // and from one address (it is refused then)
const MAX_CLIP_BYTES = 1024 * 1024 * 1024;
const MAX_SLOTS = 8;
const DEFAULT_SLOTS = 2;
const DONE_TTL_MS = 10 * 60_000;
const STALL_MS = 10 * 60_000;
// a job its main stopped asking about (the main crashed or lost the id)
const ORPHAN_MS = 5 * 60_000;
// Encode with: the GPU (the CPU only without one), the GPU and the CPU for
// clips the GPU fails, or the CPU only
const USES = ['gpu', 'gpu-cpu', 'cpu'];
// Clips a main may send ahead, past the slots: uploaded and waiting here, so
// the next one starts the moment a slot is free, however busy the main is.
const QUEUE = 15;
// clips held here at once, every device together (each device has its own
// slots + QUEUE): a bound for disk and memory whatever a main sets
const MAX_HELD = 64;
// devices listed at once, and how long a listing (and its encoders) is reused
const MAX_DEVICES = 16;
const DEVICES_TTL_MS = 30_000;
// the pool of clips sent without a device (older mains): the default device
const DEFAULT_POOL = '*';
// disk a node keeps free for itself (accounts, settings, logs)
const DISK_SPARE = 2 * 1024 ** 3;
const BAD_TOKEN_LIMIT = 20;
const BAD_TOKEN_WINDOW_MS = 10 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

// a peer's name, safe for the log and the page: no control characters
const cleanName = (value) => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && /^[0-9a-f]+$/.test(a) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** The text each side signs while pairing (also used by server/nodes.js). */
const pairText = {
  main: (fingerprint, name) => `sentry-six-node|v1|pair|${fingerprint}|${name}`,
  worker: (fingerprint, token) => `sentry-six-node|v1|paired|${fingerprint}|${token}`
};

/** SHA-256 of a certificate's DER bytes, lowercase hex without colons. */
const certFingerprint = (raw) => (Buffer.isBuffer(raw) && raw.length > 0 ? sha256(raw) : null);

/** "ABCD-EFGH-JKLM": 60 bits, typed by hand, case and dashes ignored. */
function newPairingCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The encode settings a main may ask for, or null. */
function parseJobSettings(raw) {
  let value;
  try { value = JSON.parse(String(raw || '')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => !['codec', 'bitrate', 'quality', 'holdFrames', 'durationUs', 'device'].includes(k))) return null;
  if (value.codec !== 'h265' && value.codec !== 'av1') return null;
  const hasBitrate = value.bitrate !== undefined && value.bitrate !== null;
  const hasQuality = value.quality !== undefined && value.quality !== null;
  if (hasBitrate === hasQuality) return null;
  if (hasBitrate && !(Number.isSafeInteger(value.bitrate) && value.bitrate >= 50_000 && value.bitrate <= 200_000_000)) return null;
  if (hasQuality && !QUALITY_LEVELS.includes(value.quality)) return null;
  const holdFrames = value.holdFrames ?? 0;
  if (!Number.isSafeInteger(holdFrames) || holdFrames < 0 || holdFrames > 600) return null;
  const durationUs = value.durationUs ?? null;
  if (durationUs !== null && !(Number.isSafeInteger(durationUs) && durationUs > 0 && durationUs < 24 * 3600e6)) return null;
  // one of this server's devices (checked against its list when the clip
  // arrives); without it, the default device as before
  const device = value.device ?? null;
  if (device !== null && !(typeof device === 'string' && LOCAL_DEVICE_ID.test(device))) return null;
  return { codec: value.codec, bitrate: hasBitrate ? value.bitrate : null, quality: hasQuality ? value.quality : null, holdFrames, durationUs, ...(device ? { device } : {}) };
}

/**
 * deps: { db, log, audit, authority: () => this server's CA certificate (PEM)
 * or null, workDir, ffmpegPath, spawn, runtime: () => converter runtime
 * (selectEncoder, cpuEncoder), name, now }
 */
function createNodeWorker({ db, log, audit = log, authority = () => null, workDir, ffmpegPath = 'ffmpeg', spawn = require('child_process').spawn, runtime, name = os.hostname(), platform = process.platform, now = Date.now }) {
  let pairing = null; // { code, expiresAt, tries, byAddress }
  const jobs = new Map(); // id -> job
  const waiting = []; // uploaded jobs waiting for a slot, oldest first
  const badTokens = new Map(); // address -> [times]

  const settings = () => {
    const s = db.get(SETTINGS_KEY, null) || {};
    return {
      enabled: s.enabled === true,
      slots: Number.isSafeInteger(s.slots) && s.slots >= 1 && s.slots <= MAX_SLOTS ? s.slots : DEFAULT_SLOTS,
      use: USES.includes(s.use) ? s.use : 'gpu',
      // clips at once per device, as the main set them (device id -> 0..8)
      deviceSlots: s.deviceSlots && typeof s.deviceSlots === 'object' && !Array.isArray(s.deviceSlots)
        ? Object.fromEntries(Object.entries(s.deviceSlots).filter(([id, n]) => LOCAL_DEVICE_ID.test(id) && Number.isSafeInteger(n) && n >= 0 && n <= MAX_SLOTS))
        : {},
      mains: Array.isArray(s.mains) ? s.mains.filter((m) => m && typeof m.tokenHash === 'string') : []
    };
  };
  const save = (next) => db.set(SETTINGS_KEY, next);

  // a fresh work folder on every start: files left by a restart are gone
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });

  // ---- what the Nodes page shows and changes (signed in)

  function status() {
    const s = settings();
    const live = pairing && pairing.expiresAt > now() ? pairing : null;
    return {
      enabled: s.enabled,
      slots: s.slots,
      use: s.use,
      busy: running().length,
      pairing: live ? { code: live.code, expiresAt: live.expiresAt } : null,
      mains: s.mains.map((m) => ({ id: m.id, name: m.name, address: m.address || null, pairedAt: m.pairedAt, lastSeenAt: m.lastSeenAt || null }))
    };
  }

  function setEnabled(enabled, slots, use) {
    const s = settings();
    const next = { ...s, enabled: enabled === true };
    if (use !== undefined) {
      if (!USES.includes(use)) throw Object.assign(new Error('Encode with: gpu, gpu-cpu or cpu.'), { status: 400 });
      next.use = use;
    }
    if (slots !== undefined) {
      if (!Number.isSafeInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw Object.assign(new Error(`Clips at once: 1 to ${MAX_SLOTS}.`), { status: 400 });
      next.slots = slots;
    }
    if (!next.enabled) {
      pairing = null;
      for (const job of jobs.values()) stopJob(job);
    }
    save(next);
    pump(); // more slots: waiting clips start
    return status();
  }

  /** A new one-time code (replaces any earlier one). Worker mode turns on. */
  function startPairing() {
    const s = settings();
    if (!s.enabled) save({ ...s, enabled: true });
    pairing = { code: newPairingCode(), expiresAt: now() + PAIR_TTL_MS, tries: 0, byAddress: new Map() };
    return status();
  }

  function cancelPairing() {
    pairing = null;
    return status();
  }

  function revoke(id) {
    const s = settings();
    const main = s.mains.find((m) => m.id === id);
    if (!main) return false;
    save({ ...s, mains: s.mains.filter((m) => m.id !== id) });
    for (const job of jobs.values()) if (job.mainId === id) stopJob(job);
    return main;
  }

  // ---- requests from a main server

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  async function readJsonBody(req, limit = 4096) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw Object.assign(new Error('Bad JSON.'), { status: 400 }); }
  }

  /** The certificate this connection was served with (what the main saw). */
  function servedFingerprint(req) {
    try {
      const socket = req.socket;
      const cert = typeof socket?.getCertificate === 'function' ? socket.getCertificate() : null;
      return certFingerprint(cert?.raw);
    } catch { return null; }
  }

  function throttled(address) {
    const since = now() - BAD_TOKEN_WINDOW_MS;
    const list = (badTokens.get(address) || []).filter((t) => t > since);
    badTokens.set(address, list);
    return list.length >= BAD_TOKEN_LIMIT;
  }
  function noteBadToken(address) {
    const list = badTokens.get(address) || [];
    list.push(now());
    badTokens.set(address, list.slice(-BAD_TOKEN_LIMIT));
    if (badTokens.size > 1000) badTokens.clear();
  }

  function authenticate(req, address) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return null;
    const hash = sha256(match[1]);
    return settings().mains.find((m) => sameHex(m.tokenHash, hash)) || null;
  }

  async function pair(req, res, address) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
    if (!settings().enabled || !pairing || pairing.expiresAt <= now()) {
      pairing = null;
      return send(res, 403, { error: 'This server is not waiting to be paired. Show a pairing code under Nodes first.' });
    }
    // one address cannot use up the code for everyone: after a few wrong
    // tries it is refused, while the right main can still pair
    if ((pairing.byAddress.get(address) || 0) >= PAIR_TRIES_PER_ADDRESS) return send(res, 429, { error: 'Too many wrong pairing codes from this address.' });
    const body = await readJsonBody(req);
    const mainName = typeof body?.name === 'string' ? cleanName(body.name) : '';
    const fingerprint = servedFingerprint(req);
    if (!mainName || !fingerprint || typeof body?.proof !== 'string') return send(res, 400, { error: 'Bad pairing request.' });
    const code = normalizeCode(pairing.code);
    if (!sameHex(body.proof, hmac(code, pairText.main(fingerprint, mainName)))) {
      pairing.tries += 1;
      pairing.byAddress.set(address, (pairing.byAddress.get(address) || 0) + 1);
      audit.warn(`Node pairing refused (wrong code or a different certificate) from ${address}`);
      if (pairing.tries >= PAIR_TRIES) pairing = null;
      return send(res, 403, { error: 'Wrong pairing code.' });
    }
    pairing = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const s = settings();
    const main = { id: crypto.randomBytes(6).toString('hex'), name: mainName, address, tokenHash: sha256(token), pairedAt: now() };
    save({ ...s, enabled: true, mains: [...s.mains, main].slice(-16) });
    audit.info(`Paired with main server "${mainName}" at ${address}`);
    let ca = null;
    try { ca = authority() || null; } catch { ca = null; }
    return send(res, 200, { name, token, proof: hmac(code, pairText.worker(fingerprint, token)), authority: ca ? String(ca) : null });
  }

  // ---- this server's own devices (its GPUs and its CPU, never its nodes)

  // [{ id, kind, name, device (the runtime's), encoders: { h265, av1 } }],
  // the converter's own device list with the encoder each device proved for
  // each codec (null: it cannot; the CPU's is the software encoder). Reused
  // for DEVICES_TTL_MS; one listing at a time.
  let deviceCache = null; // { at, list } | { pending }
  const knownEncoders = new Map(); // `${device}:${family}` -> codec | null
  async function listDevices() {
    const rt = runtime();
    if (!rt || typeof rt.localDevices !== 'function') return null;
    let found;
    try { found = await rt.localDevices(); } catch { found = null; }
    const list = (Array.isArray(found) ? found : []).filter((d) => d && typeof d.id === 'string' && LOCAL_DEVICE_ID.test(d.id)).slice(0, MAX_DEVICES);
    if (!list.some((d) => d.id === 'cpu')) list.push({ id: 'cpu', kind: 'cpu', name: 'CPU (software encoder)' });
    // a GPU is not test-encoded while it converts (it could fail for being busy)
    const probe = encoding() === 0 && !(typeof rt.encodingNow === 'function' && rt.encodingNow());
    return Promise.all(list.map(async (device) => {
      const encoders = {};
      for (const family of ['h265', 'av1']) {
        const key = `${device.id}:${family}`;
        try {
          let chosen;
          if (device.id === 'cpu') chosen = await rt.cpuEncoder(family);
          else if (typeof rt.selectEncoderFor === 'function') chosen = await rt.selectEncoderFor(family, device, { probe });
          if (chosen && chosen.timedOut !== true) knownEncoders.set(key, device.id === 'cpu' || chosen.hardware === true ? chosen.codec || null : null);
        } catch { knownEncoders.set(key, null); }
        encoders[family] = knownEncoders.get(key) ?? null;
      }
      return { id: device.id, kind: device.id === 'cpu' ? 'cpu' : cleanName(device.kind) || 'gpu', name: cleanName(device.name) || device.id, device, encoders };
    }));
  }
  function devices() {
    if (deviceCache?.list && now() - deviceCache.at < DEVICES_TTL_MS) return Promise.resolve(deviceCache.list);
    if (deviceCache?.pending) return deviceCache.pending;
    const previous = deviceCache?.list || null;
    const pending = listDevices().then((list) => {
      deviceCache = { at: now(), list };
      return list;
    }, () => {
      deviceCache = previous ? { at: now(), list: previous } : null;
      return previous;
    });
    deviceCache = { pending, list: previous, at: deviceCache?.at || 0 };
    return pending;
  }
  // the device clips without a device go to: the first GPU, else the CPU
  const defaultDeviceOf = (list) => (list || []).find((d) => d.id !== 'cpu')?.id || 'cpu';

  // Clips at once per device, as the main set them; a device it never set:
  // the default device has the old single number, the others are off.
  function slotsFor(pool, s = settings(), list = deviceCache?.list) {
    if (pool === DEFAULT_POOL) return s.slots;
    if (Number.isSafeInteger(s.deviceSlots[pool])) return s.deviceSlots[pool];
    return pool === defaultDeviceOf(list) ? s.slots : 0;
  }
  const poolOf = (job) => job.settingsUsed?.device || job.device || DEFAULT_POOL;

  async function info() {
    const rt = runtime();
    const s = settings();
    const encoders = {};
    for (const family of ['h265', 'av1']) {
      try {
        const chosen = !rt ? null : s.use === 'cpu' ? await rt.cpuEncoder(family) : await rt.selectEncoder(family);
        encoders[family] = chosen?.codec || null;
      } catch { encoders[family] = null; }
    }
    const list = await devices();
    const out = { name, encoders, slots: s.slots, use: s.use, busy: running().length, encoding: encoding(), capacity: s.slots + QUEUE };
    if (list) {
      const fallback = defaultDeviceOf(list);
      out.defaultDevice = fallback;
      out.devices = list.map((d) => {
        const slots = slotsFor(d.id, s, list);
        return {
          id: d.id, kind: d.kind, name: d.name, encoders: d.encoders, slots,
          busy: running(d.id).length, encoding: encoding(d.id), capacity: slots + QUEUE
        };
      });
    }
    return out;
  }

  // every clip held for a main: arriving, waiting for a slot or encoding
  // (with a device: that device's)
  const running = (pool = null) => [...jobs.values()].filter((job) => (job.state === 'receiving' || job.state === 'queued' || job.state === 'encoding') && (pool === null || poolOf(job) === pool));
  const encoding = (pool = null) => [...jobs.values()].filter((job) => job.state === 'encoding' && (pool === null || poolOf(job) === pool)).length;

  // Starts waiting clips while their device has a free slot, oldest first; a
  // clip whose device is full lets the next one for another device start (a
  // main's benchmark measures up to the maximum, past the setting).
  function pump() {
    const s = settings();
    for (let at = 0; at < waiting.length;) {
      const next = waiting[at];
      if (next.stopped) { waiting.splice(at, 1); continue; }
      const pool = poolOf(next);
      if (encoding(pool) >= (next.benchmark ? MAX_SLOTS : slotsFor(pool, s))) { at += 1; continue; }
      waiting.splice(at, 1);
      void encode(next, next.settingsUsed).finally(pump);
    }
  }

  function publicJob(job) {
    return { id: job.id, state: job.state, outTimeUs: job.outTimeUs, fps: job.fps, speed: job.speed, encoder: job.encoder, error: job.error || null, outputBytes: job.outputBytes || null };
  }

  // an MP4 starts with its ftyp box
  async function isMp4(file) {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const head = Buffer.alloc(8);
      const { bytesRead } = await handle.read(head, 0, 8, 0);
      return bytesRead === 8 && head.toString('latin1', 4, 8) === 'ftyp' && head.readUInt32BE(0) >= 8;
    } catch { return false; } finally { await handle?.close().catch(() => {}); }
  }

  async function removeFiles(job) {
    await fsp.rm(job.input, { force: true }).catch(() => {});
    await fsp.rm(job.output, { force: true }).catch(() => {});
  }

  function stopJob(job) {
    if (job.stopped) return Promise.resolve();
    job.stopped = true;
    const at = waiting.indexOf(job);
    if (at >= 0) waiting.splice(at, 1);
    try { job.child?.kill('SIGKILL'); } catch { /* gone */ }
    job.upload?.destroy?.();
    jobs.delete(job.id);
    return removeFiles(job);
  }

  // finished or failed jobs the main never collected
  const sweeper = setInterval(() => {
    for (const job of jobs.values()) {
      if ((job.state === 'done' || job.state === 'failed') && now() - job.endedAt > DONE_TTL_MS) stopJob(job);
      else if ((job.state === 'encoding' || job.state === 'queued') && now() - job.seenAt > ORPHAN_MS) stopJob(job);
    }
  }, 60_000);
  sweeper.unref?.();

  /**
   * Encode attempts, fastest first. With a device (what the main picked):
   * on that GPU, GPU decode + encode, then GPU encode; on 'cpu', the CPU
   * encoder. Without one (older mains), as Encode with says: GPU encode +
   * decode, then GPU encode; the CPU only when set to, or when there is no
   * GPU. A clip that fails here goes back to the main, which encodes it itself.
   */
  async function attemptsFor(codec, holdFrames, deviceId = null) {
    const rt = runtime();
    if (!rt) throw Object.assign(new Error('The converter is starting.'), { status: 503 });
    if (deviceId) return deviceAttempts(rt, codec, deviceId).then((list) => list.map((a) => ({ ...a, holdFrames })));
    const { use } = settings();
    const list = [];
    let selected = null;
    if (use !== 'cpu') {
      try { selected = await rt.selectEncoder(codec); } catch { selected = null; }
    }
    const gpu = selected?.hardware === true;
    if (gpu) {
      const device = selected.device || null;
      const accel = decodeAccelArgs(selected.codec, { platform, ...(device ? { device } : {}) });
      if (accel) list.push({ encoder: selected.codec, device, decode: accel });
      list.push({ encoder: selected.codec, device, decode: [] });
    }
    if (!gpu || use === 'gpu-cpu') {
      const cpu = await rt.cpuEncoder(codec);
      list.push({ encoder: cpu.codec, device: null, decode: [] });
    }
    // held lead-in frames need system-memory frames: no GPU frame output
    return list.map((a) => ({ ...a, holdFrames }));
  }

  async function deviceAttempts(rt, codec, deviceId) {
    if (deviceId === 'cpu') {
      const cpu = await rt.cpuEncoder(codec);
      return [{ encoder: cpu.codec, device: null, decode: [] }];
    }
    const listed = (await devices() || []).find((d) => d.id === deviceId);
    if (!listed || typeof rt.selectEncoderFor !== 'function') throw Object.assign(new Error('No such device here.'), { status: 400 });
    const selected = await rt.selectEncoderFor(codec, listed.device);
    // a GPU that cannot encode this codec: the clip goes back to the main
    if (selected?.hardware !== true) throw new Error(`${listed.name} cannot encode ${codec}`);
    const device = selected.device || null;
    const list = [];
    const accel = decodeAccelArgs(selected.codec, { platform, ...(device ? { device } : {}) });
    if (accel) list.push({ encoder: selected.codec, device, decode: accel });
    list.push({ encoder: selected.codec, device, decode: [] });
    return list;
  }

  function runFfmpeg(job, attempt, settingsUsed) {
    return new Promise((resolve) => {
      if (job.stopped) return resolve(false);
      const encodeArgs = buildEncodeArgs({
        codec: settingsUsed.codec, encoder: attempt.encoder, bitrate: settingsUsed.bitrate, quality: settingsUsed.quality,
        ...(attempt.device ? { device: attempt.device } : {}), ...(attempt.holdFrames > 0 ? { holdFrames: attempt.holdFrames } : {})
      });
      // The upload is read as MP4 and nothing else, from this one local file:
      // a playlist or manifest could otherwise make ffmpeg open other files
      // here or URLs on this network. The output and its length are capped,
      // so a clip cannot fill this server's disk.
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        ...attempt.decode, '-protocol_whitelist', 'file', '-f', 'mov', '-i', job.input,
        ...encodeArgs, '-an', '-sn', '-dn',
        ...(settingsUsed.durationUs ? ['-t', String(Math.ceil(settingsUsed.durationUs / 1e6) + 5)] : []),
        '-fs', String(job.inputBytes * 2 + 1024 * 1024),
        '-progress', 'pipe:1', '-nostats', '-f', 'mp4', job.output];
      let child;
      try {
        // (NVIDIA GPUs by their PCI order, as nvidia-smi numbers them)
        child = spawn(ffmpegPath, args, { ...cudaOrderOptions(args), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve(false);
        return;
      }
      job.child = child;
      job.encoder = attempt.encoder;
      let stall;
      const watch = () => {
        clearTimeout(stall);
        stall = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, STALL_MS);
        stall.unref?.();
      };
      watch();
      let buffered = '';
      child.stdout.on('data', (chunk) => {
        watch();
        buffered = `${buffered}${chunk}`.slice(-8192);
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()];
          if (key === 'out_time_us' || key === 'out_time_ms') {
            const n = Number(value);
            if (Number.isSafeInteger(n) && n >= 0) job.outTimeUs = n;
          } else if (key === 'fps') {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) job.fps = n;
          } else if (key === 'speed') {
            const n = Number.parseFloat(value);
            job.speed = Number.isFinite(n) ? n : null;
          }
        }
      });
      let errors = '';
      child.stderr.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-400); });
      child.once('error', () => { clearTimeout(stall); resolve(false); });
      child.once('close', (code) => {
        clearTimeout(stall);
        job.child = null;
        if (code !== 0 && !job.stopped) {
          const why = errors.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(-200) || `exit ${code}`;
          log.warn(`Node: ${attempt.encoder}${attempt.decode.length ? ' (GPU decode)' : ''} could not encode a clip from ${job.mainName}: ${why}`);
        }
        resolve(code === 0);
      });
    });
  }

  async function encode(job, settingsUsed) {
    job.state = 'encoding';
    try {
      for (const attempt of await attemptsFor(settingsUsed.codec, settingsUsed.holdFrames, settingsUsed.device || null)) {
        if (job.stopped) return;
        await fsp.rm(job.output, { force: true }).catch(() => {});
        if (job.stopped) return;
        if (await runFfmpeg(job, attempt, settingsUsed)) {
          const { size } = await fsp.stat(job.output);
          job.outputBytes = size;
          job.state = 'done';
          job.endedAt = now();
          await fsp.rm(job.input, { force: true }).catch(() => {});
          return;
        }
      }
      throw new Error('every encoder failed');
    } catch (err) {
      if (job.stopped) return;
      job.state = 'failed';
      job.error = 'encode-failed';
      job.endedAt = now();
      log.warn(`Node: a clip from ${job.mainName} could not be encoded (${err.message})`);
      void removeFiles(job);
    }
  }

  async function receive(req, res, main) {
    const settingsUsed = parseJobSettings(req.headers['x-node-job']);
    if (!settingsUsed) return send(res, 400, { error: 'Bad encode settings.' });
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length <= 0) return send(res, 411, { error: 'The clip size is needed.' });
    if (length > MAX_CLIP_BYTES) return send(res, 413, { error: 'Clip too large.' });
    // the slots plus the clips sent ahead; running and finished-but-not-
    // collected jobs both hold disk space; a main's benchmark may measure up
    // to the maximum, past the setting
    const benchmark = req.headers['x-node-benchmark'] === '1';
    // with a device: one of this server's own, which has its own slots and queue
    if (settingsUsed.device && !(await devices() || []).some((d) => d.id === settingsUsed.device)) return send(res, 400, { error: 'No such device on this node.' });
    const pool = settingsUsed.device || DEFAULT_POOL;
    const slots = benchmark ? MAX_SLOTS : slotsFor(pool);
    if (slots === 0) return send(res, 503, { error: 'That device is set to Off on this node.' });
    const limit = benchmark ? MAX_SLOTS : slots + QUEUE;
    // (finished clips not yet collected count too: at most one per slot)
    const held = [...jobs.values()].filter((job) => poolOf(job) === pool).length;
    if (running(pool).length >= limit || held >= limit + slots || jobs.size >= MAX_HELD) return send(res, 503, { error: 'All of this node\'s slots are busy.' });
    // room for the clip and its encode, and some to spare for this server
    try {
      const disk = await diskSpace(fsp, workDir);
      if (disk.free < length * 3 + DISK_SPARE) return send(res, 507, { error: 'This node is short of disk space.' });
    } catch { /* the work folder is made below */ }
    const id = crypto.randomBytes(16).toString('hex');
    const job = {
      id, mainId: main.id, mainName: main.name, state: 'receiving',
      input: path.join(workDir, `${id}-in.mp4`), output: path.join(workDir, `${id}-out.mp4`),
      outTimeUs: null, fps: null, speed: null, encoder: null, startedAt: now(), seenAt: now(), inputBytes: length,
      device: settingsUsed.device || null
    };
    jobs.set(id, job);
    // The main cancelled before the job's id reached it (the upload was
    // whole, the answer was not): it can never ask for or delete this job.
    res.once('close', () => {
      if (!res.writableFinished) stopJob(job);
    });
    let received = 0;
    const file = fs.createWriteStream(job.input, { flags: 'wx', mode: 0o600 });
    job.upload = file;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > length) req.destroy();
    });
    pipeline(req, file, (err) => {
      job.upload = null;
      if (job.stopped) return;
      if (err || received !== length) {
        stopJob(job);
        if (!res.headersSent) send(res, 400, { error: 'The clip did not arrive whole.' });
        return;
      }
      isMp4(job.input).then((ok) => {
        if (job.stopped) return;
        if (!ok) {
          stopJob(job);
          send(res, 415, { error: 'Not an MP4 clip.' });
          return;
        }
        send(res, 200, { id });
        job.settingsUsed = settingsUsed;
        job.benchmark = benchmark;
        job.state = 'queued';
        waiting.push(job);
        pump();
      });
    });
    return undefined;
  }

  /**
   * Handles /node/v1/... Returns false when the path is not a node path.
   * `address` is the client's address (for the audit log and the throttle).
   */
  async function handle(req, res, p, address) {
    if (!p.startsWith('/node/v1/')) return false;
    try {
      if (!settings().enabled) return send(res, 404, { error: 'Not found' }), true;
      if (p === '/node/v1/pair') return await pair(req, res, address), true;
      if (throttled(address)) return send(res, 429, { error: 'Too many refused requests.' }), true;
      const main = authenticate(req, address);
      if (!main) {
        noteBadToken(address);
        return send(res, 401, { error: 'Not paired.' }), true;
      }
      if (now() - (main.lastSeenAt || 0) > 60_000) {
        const s = settings();
        save({ ...s, mains: s.mains.map((m) => (m.id === main.id ? { ...m, lastSeenAt: now(), address } : m)) });
      }
      if (p === '/node/v1/info' && req.method === 'GET') return send(res, 200, await info()), true;
      if (p === '/node/v1/jobs' && req.method === 'POST') return await receive(req, res, main), true;
      if (p === '/node/v1/slots' && req.method === 'POST') {
        // How many clips at once: per device, from the main's Encoder rows
        // ({ slots: { "<device>": 0..8 } }, merged with the ones it left out),
        // or one number (1 to MAX_SLOTS) from an older main.
        const body = await readJsonBody(req);
        if (body?.slots && typeof body.slots === 'object' && !Array.isArray(body.slots)) {
          const list = await devices() || [];
          const entries = Object.entries(body.slots);
          if (entries.length === 0 || entries.length > MAX_DEVICES || entries.some(([id, n]) => !list.some((d) => d.id === id) || !Number.isSafeInteger(n) || n < 0 || n > MAX_SLOTS)) {
            return send(res, 400, { error: `Clips at once per device of this node: 0 to ${MAX_SLOTS}.` }), true;
          }
          const s = settings();
          const deviceSlots = { ...s.deviceSlots, ...Object.fromEntries(entries) };
          save({ ...s, deviceSlots });
          pump();
          audit.info(`Main server "${main.name}" set this node's clips at once: ${entries.map(([id, n]) => `${list.find((d) => d.id === id).name} ${n}`).join(', ')}`);
          return send(res, 200, { slots: deviceSlots }), true;
        }
        if (!Number.isSafeInteger(body?.slots) || body.slots < 1 || body.slots > MAX_SLOTS) return send(res, 400, { error: `Clips at once: 1 to ${MAX_SLOTS}.` }), true;
        save({ ...settings(), slots: body.slots });
        pump();
        audit.info(`Main server "${main.name}" set this node to ${body.slots} clips at once`);
        return send(res, 200, { slots: body.slots }), true;
      }
      const m = /^\/node\/v1\/jobs\/([0-9a-f]{32})(\/output)?$/.exec(p);
      const job = m ? jobs.get(m[1]) : null;
      if (!job || job.mainId !== main.id) return send(res, 404, { error: 'No such job.' }), true;
      job.seenAt = now();
      if (!m[2] && req.method === 'GET') return send(res, 200, publicJob(job)), true;
      if (!m[2] && req.method === 'DELETE') {
        await stopJob(job);
        return send(res, 200, { ok: true }), true;
      }
      if (m[2] && req.method === 'GET') {
        if (job.state !== 'done') return send(res, 409, { error: 'Not encoded yet.' }), true;
        const st = await fsp.stat(job.output);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
        pipeline(fs.createReadStream(job.output), res, () => {});
        return true;
      }
      return send(res, 405, { error: 'Not allowed.' }), true;
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Node error.' });
      return true;
    }
  }

  function close() {
    clearInterval(sweeper);
    for (const job of jobs.values()) stopJob(job);
  }

  // attempts: the encoders a clip is tried with, in order (its device, or Encode with)
  return { handle, status, setEnabled, startPairing, cancelPairing, revoke, close, attempts: attemptsFor, devices };
}

module.exports = { createNodeWorker, parseJobSettings, pairText, certFingerprint, newPairingCode, normalizeCode, hmac, sameHex };

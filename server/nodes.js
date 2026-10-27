'use strict';

// Nodes, the main side: other Sentry Six Managers paired here encode clips
// for this one. Each GPU of a node, and its CPU, is a lane in the Encoder
// (device "node:<id>@<its device>"; "node:<id>" for a node of an older
// version, which lists no devices): this server reads the clip from the
// share, sends it over HTTPS with the device to encode it on, takes the
// encoded file back and then writes the telemetry, verifies and saves it as
// it does for its own GPUs. Nodes never get share passwords and never touch
// footage. Trust, Vehicles first, uploads and the benchmark stay per node.
//
// Every connection to a node is checked before a byte is sent: the node must
// present the certificate it had when it was paired, or one issued by the
// certificate authority it had then (its own, which renews the certificate).
// Then the node's token goes along as "Authorization: Bearer".

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const tls = require('tls');
const { EventEmitter } = require('events');
const { pipeline } = require('stream');
const { pairText, certFingerprint, normalizeCode, hmac, sameHex } = require('./nodeWorker');
const { LOCAL_DEVICE_ID, nodeKeyOf, nodeDeviceOf } = require('../src/main/converter/contracts');

const SETTINGS_KEY = 'nodes';
const MAX_NODES = 8;
const INFO_TTL_MS = 30_000;
const POLL_MS = 1000;
const BUSY_WAIT_MS = 5 * 60_000;
const BUSY_POLL_MS = 3000;
// Clips uploaded to one node at once. The clips sent ahead (15) were all
// read from the share and sent at the same moment, on the same hard disks
// as the clips being saved; a couple at a time fill the node's queue as fast.
const UPLOADS_AT_ONCE = 2;
const uploadSlots = new Map(); // node id -> { busy, waiters }
async function takeUploadSlot(nodeId, signal) {
  if (!uploadSlots.has(nodeId)) uploadSlots.set(nodeId, { busy: 0, waiters: [] });
  const slots = uploadSlots.get(nodeId);
  while (slots.busy >= UPLOADS_AT_ONCE) {
    if (signal.aborted) return null;
    await new Promise((resolve) => {
      // (an aborted waiter leaves the line: a turn handed to it was lost,
      // and another job waiting for this slot never woke)
      const done = () => {
        signal.removeEventListener('abort', done);
        const at = slots.waiters.indexOf(done);
        if (at >= 0) slots.waiters.splice(at, 1);
        resolve();
      };
      slots.waiters.push(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  if (signal.aborted) return null;
  slots.busy += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.busy -= 1;
    slots.waiters.shift()?.();
  };
}
// how long a clip sent ahead may wait on the node for a slot
const QUEUE_WAIT_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

const nodeError = (message, status = 400, code = 'NODE_ERROR') => Object.assign(new Error(message), { status, code });
// the devices a node may list (its GPUs and its CPU)
const MAX_NODE_DEVICES = 16;
const MAX_SLOTS = 8;
// text a node sent (its name, an error): safe for the log and the page
const peerText = (value, max = 160) => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max);

/** "192.168.1.20", "nas.local:9000", "[fd00::5]:9443" -> { host, port }. */
function parseAddress(text) {
  const value = String(text || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  let host;
  let port = 9000;
  const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(value);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
    if (!m) return null;
    host = m[1];
    if (m[2]) port = Number(m[2]);
  }
  if (!(port >= 1 && port <= 65535)) return null;
  if (!net.isIP(host) && !HOST_RE.test(host)) return null;
  return { host, port };
}

/**
 * A TLS connection that is used only if the node's certificate matches the
 * pin: the same certificate (fingerprint), or one issued by the pinned
 * certificate authority and valid now. With pin null (pairing), whatever is
 * presented is accepted and reported.
 */
function connectPinned({ host, port, pin = null, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host, port, servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2'
    });
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(nodeError('The node did not answer.', 504, 'NODE_TIMEOUT')));
    socket.once('error', (err) => reject(nodeError(`Could not reach the node (${err.code || err.message}).`, 502, 'NODE_UNREACHABLE')));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true);
      const fingerprint = certFingerprint(peer?.raw);
      if (!fingerprint) return fail(nodeError('The node presented no certificate.', 502, 'NODE_CERT'));
      if (pin && !pinMatches(pin, peer.raw, fingerprint)) {
        return fail(nodeError('The node presented a different certificate than when it was paired. If you reset it, remove and pair it again.', 502, 'NODE_CERT_CHANGED'));
      }
      socket.setTimeout(0);
      resolve({ socket, fingerprint, raw: peer.raw });
    });
  });
}

function pinMatches(pin, raw, fingerprint) {
  if (pin.fingerprint && sameHex(pin.fingerprint, fingerprint)) return true;
  if (!pin.authority) return false;
  try {
    const ca = new crypto.X509Certificate(pin.authority);
    const leaf = new crypto.X509Certificate(raw);
    const t = Date.now();
    return leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && Date.parse(leaf.validFrom) <= t && t <= Date.parse(leaf.validTo);
  } catch { return false; }
}

/**
 * One HTTP/1.1 request over a checked connection. body: Buffer, stream or
 * null. It always settles: an overall deadline (deadlineMs, default twice the
 * idle timeout) destroys the connection, so a node that trickles bytes or
 * sends too much can never leave it, or anything waiting on it, hanging.
 */
async function request(node, { method = 'GET', path, headers = {}, body = null, pin = node.pin, timeoutMs = REQUEST_TIMEOUT_MS, deadlineMs = timeoutMs * 2, onResponse = null, signal = null }) {
  if (signal?.aborted) throw nodeError('Cancelled.', 499, 'CANCELLED');
  const { socket, fingerprint } = await connectPinned({ host: node.host, port: node.port, pin, timeoutMs });
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let deadline = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (err) {
        req?.destroy();
        socket.destroy();
        reject(err.status ? err : nodeError(`The node connection failed (${err.code || err.message}).`, 502, 'NODE_UNREACHABLE'));
      } else {
        resolve(value);
      }
    };
    const abort = () => finish(nodeError('Cancelled.', 499, 'CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => finish(nodeError('The node took too long.', 504, 'NODE_TIMEOUT')), deadlineMs);
    deadline.unref?.();
    req = http.request({
      // the connection checked above, never a new one (no agent: with
      // agent: false Node would open its own)
      createConnection: () => socket, method, path,
      headers: {
        Connection: 'close',
        Host: net.isIP(node.host) === 6 ? `[${node.host}]:${node.port}` : `${node.host}:${node.port}`,
        ...(node.token ? { Authorization: `Bearer ${node.token}` } : {}),
        ...headers
      }
    });
    req.setTimeout(timeoutMs, () => finish(nodeError('The node did not answer.', 504, 'NODE_TIMEOUT')));
    req.once('error', (err) => finish(err));
    // closed before it answered; afterwards the answer's own end/error decide
    let answered = false;
    socket.once('close', () => { if (!answered) finish(nodeError('The node closed the connection.', 502, 'NODE_UNREACHABLE')); });
    req.once('response', (res) => {
      answered = true;
      res.once('error', (err) => finish(err));
      if (onResponse && res.statusCode === 200) {
        onResponse(res).then((value) => finish(null, { status: 200, value, fingerprint }), (err) => finish(err));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) finish(nodeError('The node sent too much.', 502, 'NODE_PROTOCOL'));
        else chunks.push(c);
      });
      res.once('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        finish(null, { status: res.statusCode, json, fingerprint });
      });
    });
    if (body && typeof body.pipe === 'function') pipeline(body, req, (err) => { if (err) finish(err); });
    else req.end(body || undefined);
  });
}

/**
 * deps: { db, log, audit, name }. list() gives the nodes as converter devices;
 * encode() is the converter's remoteEncode.
 */
function createNodes({ db, log, audit = log, name = os.hostname(), pollMs = POLL_MS }) {
  const info = new Map(); // id -> { at, online, encoders, slots, busy, name, error }
  // when each node last moved any clip forward: a clip waiting on a node
  // that keeps working waits on, one waiting on a node that stopped does not
  const lastMoved = new Map(); // id -> ms

  const stored = () => (db.get(SETTINGS_KEY, []) || []).filter((n) => n && typeof n.id === 'string' && typeof n.token === 'string');
  const save = (list) => db.set(SETTINGS_KEY, list);
  const byId = (id) => stored().find((n) => n.id === id) || null;

  const cleanEncoder = (v) => (typeof v === 'string' && /^[a-z0-9_-]{2,32}$/.test(v) ? v : null);
  const count = (v, max = 10_000) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);

  // A node's own devices as it lists them (null: a node of an older version
  // that lists none). Ids are its device ids ('pci:...' or 'cpu'), checked
  // like this server's own; everything else is text for the page.
  function parseDevices(value) {
    if (!Array.isArray(value)) return null;
    const list = [];
    for (const d of value.slice(0, MAX_NODE_DEVICES)) {
      if (!d || typeof d.id !== 'string' || !LOCAL_DEVICE_ID.test(d.id) || list.some((x) => x.id === d.id)) continue;
      const enc = d.encoders || {};
      list.push({
        id: d.id,
        kind: d.id === 'cpu' ? 'cpu' : (typeof d.kind === 'string' && /^[a-z]{2,16}$/.test(d.kind) ? d.kind : 'gpu'),
        name: peerText(d.name, 64) || (d.id === 'cpu' ? 'CPU' : d.id),
        encoders: { h265: cleanEncoder(enc.h265), av1: cleanEncoder(enc.av1) },
        // (a node never runs more than 8 at once on a device: a larger claim is not believed)
        slots: count(d.slots, MAX_SLOTS),
        busy: count(d.busy), encoding: count(d.encoding), capacity: count(d.capacity)
      });
    }
    return list.length ? list : null;
  }
  // the device a whole-node lane, a plain number and the benchmark use: its
  // first GPU, else its CPU
  const defaultDeviceOf = (devices) => (devices || []).find((d) => d.id !== 'cpu')?.id || (devices?.length ? 'cpu' : null);
  // what a node listed last (kept with the node: an offline node keeps its rows)
  const listedOf = (devices) => (devices || []).map((d) => ({ id: d.id, kind: d.kind, name: d.name }));

  async function refresh(node) {
    const before = info.get(node.id);
    try {
      const r = await request(node, { path: '/node/v1/info', timeoutMs: 8000 });
      if (r.status !== 200 || !r.json) throw nodeError(peerText(r.json?.error) || `HTTP ${r.status}`, 502);
      const enc = r.json.encoders || {};
      const devices = parseDevices(r.json.devices);
      info.set(node.id, {
        at: Date.now(), online: true, error: null,
        name: typeof r.json.name === 'string' ? peerText(r.json.name, 64) : node.name,
        encoders: { h265: cleanEncoder(enc.h265), av1: cleanEncoder(enc.av1) },
        // (a node never runs more than 8 at once: a larger claim is not believed)
        slots: Number.isSafeInteger(r.json.slots) ? Math.min(Math.max(r.json.slots, 1), MAX_SLOTS) : null,
        busy: Number.isSafeInteger(r.json.busy) ? r.json.busy : null,
        encoding: Number.isSafeInteger(r.json.encoding) ? r.json.encoding : null,
        devices
      });
      // remembered with the node when they change, for when it does not answer
      const current = byId(node.id);
      if (current && JSON.stringify(current.devices || null) !== JSON.stringify(devices ? listedOf(devices) : null)) {
        save(stored().map((n) => {
          if (n.id !== node.id) return n;
          const { devices: _old, ...rest } = n;
          return devices ? { ...rest, devices: listedOf(devices) } : rest;
        }));
      }
    } catch (err) {
      // offline: its devices as last known, so their lanes stay
      const known = before?.devices || (Array.isArray(byId(node.id)?.devices) ? byId(node.id).devices.map((d) => ({ ...d, encoders: { h265: null, av1: null }, slots: null })) : null);
      info.set(node.id, { at: Date.now(), online: false, error: err.message, encoders: {}, slots: null, busy: null, devices: known });
    }
    return info.get(node.id);
  }

  const fresh = (node) => {
    const known = info.get(node.id);
    if (known && Date.now() - known.at < INFO_TTL_MS) return known;
    const pending = refresh(node);
    return known || pending;
  };

  /**
   * The paired nodes as encoding devices for the converter's lanes: one per
   * GPU of a node and one for its CPU (a node that lists no devices, one for
   * the whole node). nodeId/nodeName say whose it is; isDefault marks the
   * device a whole-node lane ('node:<id>', saved before) now stands for.
   */
  async function list() {
    const nodes = stored();
    const all = await Promise.all(nodes.map(async (node) => {
      const i = await fresh(node);
      const online = i.online === true;
      const devices = i.devices || null;
      if (!devices) {
        return [{
          id: `node:${node.id}`, kind: 'node', nodeId: node.id, nodeName: node.name, deviceName: null, name: `${node.name} (node)`,
          node: null, index: null, pci: null, slots: i.slots ?? null,
          online, encoders: online ? i.encoders : { h265: null, av1: null }
        }];
      }
      const fallback = defaultDeviceOf(devices);
      return devices.map((d) => ({
        id: `node:${node.id}@${d.id}`, kind: 'node', nodeId: node.id, nodeName: node.name,
        deviceId: d.id, deviceKind: d.kind, deviceName: d.name, name: `${node.name} · ${d.name}`,
        isDefault: d.id === fallback,
        node: null, index: null, pci: null, slots: d.slots ?? null,
        online, encoders: online ? d.encoders : { h265: null, av1: null }
      }));
    }));
    return all.flat();
  }

  /** What the Nodes page shows. */
  async function overview() {
    const nodes = stored();
    // a node slow to answer (up to 8 s) does not hold the page: after 1.5 s
    // its last known numbers are shown, and its answer updates them later
    await Promise.all(nodes.map((node) => Promise.race([refresh(node), new Promise((r) => setTimeout(r, 1500).unref?.())])));
    return nodes.map((node) => {
      const i = info.get(node.id) || {};
      const devices = i.devices || null;
      const fallback = defaultDeviceOf(devices);
      // with devices: what the main set on each (the ones it uses), in all
      const slots = devices ? devices.reduce((sum, d) => sum + (d.slots || 0), 0) : i.slots ?? null;
      return {
        id: node.id, name: node.name, address: node.port === 9000 ? node.host : `${node.host}:${node.port}`,
        pairedAt: node.pairedAt, online: i.online === true, error: i.online ? null : i.error || null,
        encoders: i.encoders || {}, slots, busy: i.busy ?? null, encoding: i.encoding ?? null,
        devices: devices ? devices.map((d) => ({ id: d.id, lane: `node:${node.id}@${d.id}`, kind: d.kind, name: d.name, encoders: d.encoders, slots: d.slots ?? null, isDefault: d.id === fallback })) : null,
        // the lane a whole-node number (benchmark > Use) sets
        defaultLane: devices ? `node:${node.id}@${fallback}` : `node:${node.id}`,
        defaultDeviceName: devices ? devices.find((d) => d.id === fallback)?.name || null : null,
        fingerprint: node.pin?.fingerprint || null,
        cars: Array.isArray(node.cars) ? node.cars : [],
        trusted: node.trusted === true
      };
    });
  }

  /** Pairs with a node that is showing a pairing code. */
  async function add({ address, code }) {
    const target = parseAddress(address);
    if (!target) throw nodeError('Enter the node\'s address, like 192.168.1.30 or nas.local:9000.');
    const key = normalizeCode(code);
    if (key.length !== 12) throw nodeError('Enter the 12-character pairing code shown on the node.');
    const nodes = stored();
    if (nodes.length >= MAX_NODES) throw nodeError(`At most ${MAX_NODES} nodes.`);
    if (nodes.some((n) => n.host === target.host && n.port === target.port)) throw nodeError('That node is already paired.');
    // pairing: no pin yet; the code proves both sides saw the same certificate
    const draft = { ...target, token: null };
    const probe = await connectPinned({ ...target, pin: null, timeoutMs: 10_000 });
    probe.socket.destroy();
    const proof = hmac(key, pairText.main(probe.fingerprint, name.slice(0, 64)));
    const r = await request(draft, {
      method: 'POST', path: '/node/v1/pair', pin: { fingerprint: probe.fingerprint },
      headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ name: name.slice(0, 64), proof })),
      timeoutMs: 15_000
    });
    if (r.status === 404) throw nodeError('That server is not set up as a node: on its Nodes page, show a pairing code first.', 409);
    if (r.status !== 200) throw nodeError(peerText(r.json?.error) || `The node refused (${r.status}).`, r.status === 403 ? 403 : 502);
    const token = r.json?.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !sameHex(r.json.proof, hmac(key, pairText.worker(probe.fingerprint, token)))) {
      throw nodeError('The node\'s answer could not be verified, so it was not paired.', 502);
    }
    // its certificate authority, when it has one and it issued the certificate
    // seen now: certificates it renews later are then accepted too
    let authority = null;
    if (typeof r.json.authority === 'string' && r.json.authority.length < 16_384) {
      try {
        const ca = new crypto.X509Certificate(r.json.authority);
        const leaf = new crypto.X509Certificate(probe.raw);
        if (ca.ca && leaf.checkIssued(ca) && leaf.verify(ca.publicKey)) authority = ca.toString();
      } catch { /* pinned by fingerprint only */ }
    }
    const node = {
      id: crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12),
      name: peerText(r.json.name, 64) || target.host,
      host: target.host, port: target.port, token,
      pin: { fingerprint: probe.fingerprint, authority },
      pairedAt: Date.now()
    };
    save([...stored(), node]);
    await refresh(node);
    return node;
  }

  /** A name of your own for the node (the node keeps its own). */
  function rename(id, newName) {
    const node = byId(id);
    if (!node) return null;
    if (typeof newName !== 'string') throw nodeError('Enter a name.');
    const clean = peerText(newName, 64);
    if (!clean) throw nodeError('Enter a name.');
    save(stored().map((n) => (n.id === id ? { ...n, name: clean } : n)));
    return { previous: node.name, name: clean };
  }

  /**
   * The vehicles a node converts for first, in order (automatic conversion):
   * vehicle ids, at most 64. When none of them has clips to convert, the
   * node helps the others.
   */
  function setCars(id, cars) {
    const node = byId(id);
    if (!node) return null;
    if (!Array.isArray(cars) || cars.length > 64 || cars.some((car) => typeof car !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(car))) {
      throw nodeError('A list of vehicles, at most 64.');
    }
    const list = [...new Set(cars)];
    save(stored().map((n) => (n.id === id ? { ...n, cars: list } : n)));
    return list;
  }

  /**
   * Trusted (the owner's own computer, say): its encodes skip the picture
   * check here (pictureCheck.js); verification of streams, length, frames
   * and telemetry still runs. Off by default.
   */
  function setTrusted(id, trusted) {
    if (!byId(id)) return null;
    save(stored().map((n) => (n.id === id ? { ...n, trusted: trusted === true } : n)));
    return trusted === true;
  }
  // (any lane of the node: trust is per node)
  const nodeIdOf = (id) => {
    const text = String(id || '');
    const key = nodeKeyOf(text);
    return key ? key.slice('node:'.length) : text.replace(/@.*$/, '');
  };
  const trusted = (id) => byId(nodeIdOf(id))?.trusted === true;

  /** A vehicle removed: out of every node's Vehicles first list. */
  function forgetCar(car) {
    const all = stored();
    if (!all.some((n) => Array.isArray(n.cars) && n.cars.includes(car))) return;
    save(all.map((n) => (Array.isArray(n.cars) && n.cars.includes(car) ? { ...n, cars: n.cars.filter((id) => id !== car) } : n)));
  }

  /** { 'node:<id>': [vehicle id, ...] } for the nodes that have a list. */
  const carLists = () => Object.fromEntries(stored().filter((n) => Array.isArray(n.cars) && n.cars.length).map((n) => [`node:${n.id}`, n.cars]));

  function remove(id) {
    const node = byId(id);
    if (!node) return null;
    save(stored().filter((n) => n.id !== id));
    info.delete(id);
    return node;
  }

  /**
   * The converter's remoteEncode: sends `source` to the node, follows its
   * progress and writes the encoded file to `target` (created new, like
   * ffmpeg's -n). Returns an object that behaves like ffmpeg's process.
   */
  function encode({ device, source, target, codec, bitrate, quality, holdFrames = 0, durationUs = null, benchmark = false }) {
    const node = byId(nodeIdOf(device?.id));
    if (!node) throw nodeError('No such node.', 404);
    // the node's device to encode on: the lane's, or for a whole-node lane
    // (saved before, or the benchmark) its default device once it lists them
    const known = info.get(node.id)?.devices || (Array.isArray(node.devices) ? node.devices : null);
    const onDevice = nodeDeviceOf(device?.id) || (known ? defaultDeviceOf(known) : null);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined;
    const controller = new AbortController();
    let upload = null; // the clip on its way up, until the node answers
    let jobId = null;
    let closed = false;
    const close = (code, signal = null) => {
      if (closed) return;
      closed = true;
      setImmediate(() => child.emit('close', code, signal));
    };
    // the node deletes the clip and its encoded file
    const forget = () => {
      if (!jobId) return Promise.resolve();
      const id = jobId;
      jobId = null;
      return request(node, { method: 'DELETE', path: `/node/v1/jobs/${id}`, timeoutMs: 10_000 }).catch(() => {});
    };
    child.kill = (signal = 'SIGTERM') => {
      controller.abort();
      // A clip that is all sent is let through: the node's answer holds the
      // job's id, and without it the job could not be deleted there.
      if (upload && !upload.sent) upload.controller.abort();
      forget();
      close(null, signal);
      return true;
    };

    (async () => {
      const { size } = await fsp.stat(source);
      const settings = { codec, holdFrames, ...(quality ? { quality } : { bitrate }), ...(durationUs ? { durationUs } : {}), ...(onDevice ? { device: onDevice } : {}) };
      // A lane set to more clips than the node takes at once: the extra clip
      // waits for a free slot (up to BUSY_WAIT_MS) instead of failing over.
      const waitUntil = Date.now() + BUSY_WAIT_MS;
      let sent;
      for (;;) {
        const free = await request(node, { path: '/node/v1/info', signal: controller.signal, timeoutMs: 10_000 }).catch((err) => {
          if (err?.code === 'CANCELLED') throw err;
          return null;
        });
        // unreachable: fail over at once (only a node that answers "busy" is waited for)
        if (!free || free.status !== 200) throw nodeError(peerText(free?.json?.error) || 'Could not reach the node.', 502, 'NODE_UNREACHABLE');
        // full: its slots and the clips it takes ahead (a node from before
        // the queue reports only slots; with a device, that device's own); a
        // benchmark measures up to the node's maximum, past its setting
        let state = free.json || {};
        if (onDevice) {
          const listed = Array.isArray(state.devices) ? state.devices.find((d) => d?.id === onDevice) : null;
          if (!listed) throw nodeError('The node no longer has that device.', 502, 'NODE_DEVICE_GONE');
          state = listed;
        }
        const capacity = Number.isSafeInteger(state.capacity) ? state.capacity : state.slots;
        const busy = !benchmark && Number.isSafeInteger(capacity) && Number.isSafeInteger(state.busy) && state.busy >= capacity;
        if (!busy) {
          if (controller.signal.aborted) return;
          const releaseUpload = await takeUploadSlot(node.id, controller.signal);
          if (!releaseUpload) return;
          try {
            upload = { controller: new AbortController(), sent: false };
            const body = fs.createReadStream(source);
            const current = upload;
            body.once('end', () => { current.sent = true; });
            sent = await request(node, {
              method: 'POST', path: '/node/v1/jobs', signal: upload.controller.signal, timeoutMs: 60_000, deadlineMs: 30 * 60_000,
              headers: { 'Content-Type': 'video/mp4', 'Content-Length': size, 'X-Node-Job': JSON.stringify(settings), ...(benchmark ? { 'X-Node-Benchmark': '1' } : {}) },
              body
            }).catch((err) => (err?.code === 'CANCELLED' ? Promise.reject(err) : { status: 0, error: err }));
          } finally {
            releaseUpload();
            upload = null;
          }
          if (controller.signal.aborted) {
            // cancelled while the node answered: delete what it accepted
            if (sent.status === 200 && /^[0-9a-f]{32}$/.test(sent.json?.id || '')) {
              jobId = sent.json.id;
              await forget();
            }
            return;
          }
          if (sent.status !== 503 && sent.status !== 0) break;
          if (sent.status === 0 && Date.now() >= waitUntil) throw sent.error;
        }
        if (Date.now() >= waitUntil) throw nodeError('All of the node\'s slots stayed busy.', 503, 'NODE_BUSY');
        await new Promise((r) => setTimeout(r, BUSY_POLL_MS));
        if (controller.signal.aborted) return;
      }
      if (sent.status !== 200 || !/^[0-9a-f]{32}$/.test(sent.json?.id || '')) throw nodeError(peerText(sent.json?.error) || `The node refused the clip (${sent.status}).`, 502);
      jobId = sent.json.id;
      let lastOutTimeUs = -1;
      const queuedSince = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (controller.signal.aborted) return;
        const s = await request(node, { path: `/node/v1/jobs/${jobId}`, signal: controller.signal, timeoutMs: 15_000 });
        if (s.status !== 200 || !s.json) throw nodeError(peerText(s.json?.error) || `The node lost the clip (${s.status}).`, 502);
        // Only real progress counts: the converter stops an encode that shows
        // none for a while, so a node answering "encoding" forever without
        // moving cannot hold this lane.
        const moved = Number.isSafeInteger(s.json.outTimeUs) && s.json.outTimeUs > lastOutTimeUs;
        if (moved || s.json.state === 'done') {
          lastMoved.set(node.id, Date.now());
          if (moved) lastOutTimeUs = s.json.outTimeUs;
          const lines = [`out_time_us=${Math.max(lastOutTimeUs, 0)}`];
          if (Number.isFinite(s.json.fps)) lines.push(`fps=${s.json.fps}`);
          if (Number.isFinite(s.json.speed)) lines.push(`speed=${s.json.speed}x`);
          lines.push(`progress=${s.json.state === 'done' ? 'end' : 'continue'}`);
          child.stdout.emit('data', `${lines.join('\n')}\n`);
        }
        if (s.json.state === 'queued') {
          // waiting on the node for a free slot: still alive (no progress
          // yet), but not forever
          if (Date.now() - Math.max(queuedSince, lastMoved.get(node.id) || 0) > QUEUE_WAIT_MS) throw nodeError('The node stopped converting the clips waiting on it.', 503, 'NODE_BUSY');
          child.stdout.emit('data', 'queued=1\n');
          continue;
        }
        if (s.json.state === 'failed') throw nodeError('The node could not encode the clip.', 502);
        if (s.json.state === 'done') break;
      }
      // the encoded file, written new (never over an existing file)
      await request(node, {
        path: `/node/v1/jobs/${jobId}/output`, signal: controller.signal, timeoutMs: 60_000, deadlineMs: 30 * 60_000,
        onResponse: (res) => new Promise((resolve, reject) => {
          const expected = Number(res.headers['content-length']);
          // a node cannot fill this server's disk: an encode is never
          // allowed past twice the original (it must come out smaller anyway)
          const limit = size * 2 + 1024 * 1024;
          if (Number.isSafeInteger(expected) && expected > limit) return reject(nodeError('The node sent back a file far larger than the clip.', 502));
          let written = 0;
          res.on('data', (c) => {
            written += c.length;
            if (written > limit) res.destroy(nodeError('The node sent back a file far larger than the clip.', 502));
          });
          const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
          pipeline(res, out, (err) => {
            if (err) return reject(err);
            if (Number.isSafeInteger(expected) && written !== expected) return reject(nodeError('The encoded file did not arrive whole.', 502));
            resolve(written);
          });
        })
      });
      await forget();
      close(0);
    })().catch((err) => {
      if (closed) return;
      if (err?.code !== 'CANCELLED') log.warn(`Node ${node.name}: ${err.message}`);
      forget();
      close(1);
    });
    return child;
  }

  /**
   * Sets how many clips the node converts at once: a number (Nodes >
   * Benchmark > Use: its default device, or the whole node of an older
   * version), or { lane or device id: 0..8 } for its devices, all in one
   * request (Encoder rows).
   */
  async function setSlots(id, slots) {
    const node = byId(nodeIdOf(id));
    if (!node) throw nodeError('No such node.', 404);
    let body;
    if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
      const entries = Object.entries(slots).map(([key, n]) => [nodeDeviceOf(key) || key, n]);
      if (entries.length === 0 || entries.length > MAX_NODE_DEVICES
        || entries.some(([key, n]) => !LOCAL_DEVICE_ID.test(key) || !Number.isSafeInteger(n) || n < 0 || n > MAX_SLOTS)) throw nodeError('Clips at once per device: 0 to 8.');
      body = { slots: Object.fromEntries(entries) };
    } else {
      if (!Number.isSafeInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw nodeError('Clips at once: 1 to 8.');
      const known = info.get(node.id)?.devices || (Array.isArray(node.devices) ? node.devices : null);
      const on = nodeDeviceOf(id) || (known ? defaultDeviceOf(known) : null);
      body = { slots: on ? { [on]: slots } : slots };
    }
    const r = await request(node, { method: 'POST', path: '/node/v1/slots', headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), timeoutMs: 10_000 });
    if (r.status !== 200) throw nodeError(peerText(r.json?.error) || `The node refused (${r.status}).`, 502);
    await refresh(node);
    return info.get(node.id);
  }

  return { list, overview, add, rename, setCars, forgetCar, setTrusted, trusted, carLists, remove, encode, setSlots, has: (id) => Boolean(byId(id)), refresh: (id) => (byId(id) ? refresh(byId(id)) : null) };
}

module.exports = { createNodes, parseAddress, connectPinned, pinMatches, takeUploadSlot };

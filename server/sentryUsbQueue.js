'use strict';

// Queued actions for a Sentry USB that is away (docs/sentry-usb-link.md, 6a):
// an admin queues an update, a reboot, a sync, diagnostics, a backup or
// settings changes; they run over the link, one at a time and in order, once
// the Pi is back and has pushed its first status. Only allowlisted routes are
// used: the Pi needs nothing new.
//
// Each action runs at most once: it is marked running (and saved) before its
// first request is sent, and one found running at start-up (Manager stopped
// in the middle) is reported as interrupted, never sent again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SETTABLE, secretsNeeded, isSecretKey } = require('./sentryUsbLink');

const KINDS = {
  settings: 'Apply settings changes',
  sync: 'Sync now',
  diagnostics: 'Fetch diagnostics',
  backup: 'Create a backup', // on the archive share: backups never leave the Pi over the link
  update: 'Install update',
  reboot: 'Reboot'
};
const LAST = ['update', 'reboot']; // always last in a batch, in this order
const WAITS_FOR_IDLE = new Set(['update', 'reboot']);
const DAY = 86_400_000;
const KEEP_FILES = 5;
const KEEP_RESULTS = 100;
const MAX_QUEUED = 50;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** True when the Pi's status says an archive or upload is running. */
function archiveBusy(status) {
  if (!status || typeof status !== 'object') return false;
  const on = (v) => v === true || v === 'yes' || v === 'true' || v === 1;
  return ['archiving', 'archive_running', 'archive_work_running', 'uploading', 'upload_running'].some((k) => on(status[k]))
    || (typeof status.archive === 'object' && status.archive !== null && (on(status.archive.running) || on(status.archive.active)));
}

/**
 * @param {object} o
 * @param {{ get: Function, set: Function }} o.db
 * @param {object} o.link  createSentryUsbLink(): request, online, status, name, has
 * @param {string} o.dir  where fetched files go (the data folder)
 * @param {{ info: Function, warn: Function }} o.log
 * @param {(n: object) => void} [o.notify]  a batch finished
 */
function createSentryUsbQueue({ db, link, dir, log, notify = () => {}, onResult = () => {}, now = () => Date.now(), idleWaitMs = 2 * 3600_000, idlePollMs = 30_000, onChange = () => {} }) {
  const KEY = 'sentryusb-queue';
  const load = () => {
    const d = db.get(KEY, null);
    return { items: Array.isArray(d?.items) ? d.items : [] };
  };
  let store = load();
  const save = () => db.set(KEY, store);
  const changed = () => { try { onChange(); } catch { /* the caller's */ } };
  const running = new Map(); // device id -> its batch under way

  // Manager stopped in the middle of an action: reported, never sent again
  let fixed = false;
  for (const it of store.items) {
    if (it.state === 'running') {
      Object.assign(it, { state: 'interrupted', finishedAt: now(), result: { message: 'Sentry Manager restarted while this ran, so it is not known whether it finished. It is not run again.' } });
      fixed = true;
    }
  }
  if (fixed) save();

  const finished = (it) => !['queued', 'running'].includes(it.state);
  const fileDir = (deviceId) => path.join(dir, deviceId.replace(/[^A-Za-z0-9_-]/g, '_'));

  function list(deviceId) {
    expire();
    const mine = store.items.filter((it) => it.deviceId === deviceId);
    const pub = (it) => ({ id: it.id, kind: it.kind, label: KINDS[it.kind], state: it.state, createdAt: it.createdAt, expiresAt: it.expiresAt, by: it.by, startedAt: it.startedAt || null, finishedAt: it.finishedAt || null, note: it.note || null, result: it.result || null, params: publicParams(it) });
    return {
      queued: mine.filter((it) => !finished(it)).sort(order).map(pub),
      results: mine.filter(finished).sort((a, b) => ((b.finishedAt || 0) - (a.finishedAt || 0)) || ((b.seq || 0) - (a.seq || 0))).map(pub),
      files: files(deviceId)
    };
  }
  // settings changes: the field names and whether a value is set, never the values
  // (a change can carry a password)
  function publicParams(it) {
    if (it.kind !== 'settings') return null;
    return { apply: Boolean(it.params?.apply), fields: Object.keys(it.params?.changes || {}) };
  }

  // the order a batch runs in: queued order, then update, then reboot
  const order = (a, b) => (LAST.indexOf(a.kind) - LAST.indexOf(b.kind)) || (a.seq - b.seq);

  function add(deviceId, { kind, params = null, expiresInDays = 14 } = {}, by = null) {
    if (!link.has(deviceId)) throw Object.assign(new Error('No such Sentry USB.'), { status: 404 });
    if (!KINDS[kind]) throw Object.assign(new Error('That cannot be queued.'), { status: 400 });
    const days = Math.round(Number(expiresInDays));
    if (!(days >= 1 && days <= 90)) throw Object.assign(new Error('Keep it for 1 to 90 days.'), { status: 400 });
    if (store.items.filter((it) => it.deviceId === deviceId && !finished(it)).length >= MAX_QUEUED) throw Object.assign(new Error(`${MAX_QUEUED} actions wait already.`), { status: 400 });
    let p = null;
    if (kind === 'settings') p = settingsParams(params);
    // one of each simple action is enough: queueing a second reboot adds nothing
    if (kind !== 'settings') {
      const same = store.items.find((it) => it.deviceId === deviceId && it.kind === kind && it.state === 'queued');
      if (same) return same.id;
    }
    const seq = (store.items.reduce((m, it) => Math.max(m, it.seq || 0), 0)) + 1;
    const it = { id: crypto.randomBytes(8).toString('hex'), seq, deviceId, kind, params: p, state: 'queued', createdAt: now(), expiresAt: now() + days * DAY, by: by || null };
    store.items.push(it);
    trim();
    save();
    changed();
    // already home: runs now
    if (link.online(deviceId) && link.status(deviceId)) kick(deviceId);
    return it.id;
  }

  // { changes: { KEY: { from: string|null, to: string|null, secret?: bool } }, apply }
  // (null: the line is commented out, "not set")
  function settingsParams(params) {
    const changes = {};
    const given = params?.changes;
    if (!given || typeof given !== 'object') throw Object.assign(new Error('No changes.'), { status: 400 });
    for (const [k, c] of Object.entries(given)) {
      if (!KEY_RE.test(k) || !c || typeof c !== 'object') throw Object.assign(new Error(`Bad setting ${k.slice(0, 64)}.`), { status: 400 });
      // the Pi's own rule, checked here too so a queued change cannot fail later for it
      if (!SETTABLE.has(k)) throw Object.assign(new Error(`${k} cannot be changed from Sentry Manager: change it on the Sentry USB.`), { status: 400, code: 'READ_ONLY', key: k });
      const val = (v) => (v === null ? null : typeof v === 'string' && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined); // no control characters, as the proxy
      const from = val(c.from ?? null);
      const to = val(c.to ?? null);
      if (from === undefined || to === undefined) throw Object.assign(new Error(`Bad value for ${k}.`), { status: 400 });
      changes[k] = { from, to, secret: Boolean(c.secret) || isSecretKey(k) };
    }
    // a stored secret cannot follow a changed destination (a share password to another server)
    const missing = secretsNeeded(new Set(Object.keys(changes).filter((k) => !changes[k].secret)), (sec) => typeof changes[sec]?.to === 'string' && changes[sec].to !== '');
    if (missing.length) {
      const [sec, hit] = missing[0];
      throw Object.assign(new Error(`Changing ${hit.join(', ')} needs ${sec} entered again.`), { status: 400, code: 'SECRET_NEEDED', key: sec });
    }
    if (!Object.keys(changes).length) throw Object.assign(new Error('No changes.'), { status: 400 });
    if (Object.keys(changes).length > 200) throw Object.assign(new Error('Too many changes.'), { status: 400 });
    return { changes, apply: Boolean(params.apply) };
  }

  function cancel(deviceId, id) {
    const it = store.items.find((x) => x.id === id && x.deviceId === deviceId);
    if (!it) return null;
    if (it.state !== 'queued') throw Object.assign(new Error('Only a waiting action can be cancelled.'), { status: 409 });
    Object.assign(it, { state: 'cancelled', finishedAt: now(), params: forget(it), result: { message: 'Cancelled.' } });
    save();
    changed();
    return true;
  }
  // a finished settings change keeps its field names, not its values
  const forget = (it) => (it.kind === 'settings' ? { apply: it.params?.apply, changes: Object.fromEntries(Object.keys(it.params?.changes || {}).map((k) => [k, {}])) } : it.params);

  function expire() {
    let any = false;
    for (const it of store.items) {
      if (it.state === 'queued' && it.expiresAt <= now()) {
        Object.assign(it, { state: 'expired', finishedAt: now(), params: forget(it), result: { message: 'Expired: the Sentry USB did not come home in time.' } });
        any = true;
      }
    }
    if (any) { save(); changed(); }
  }

  function trim() {
    const byDevice = new Map();
    for (const it of store.items) if (finished(it)) byDevice.set(it.deviceId, [...(byDevice.get(it.deviceId) || []), it]);
    const drop = new Set();
    for (const list of byDevice.values()) list.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(KEEP_RESULTS).forEach((it) => drop.add(it));
    if (drop.size) store.items = store.items.filter((it) => !drop.has(it));
  }

  // ---- fetched files: the newest KEEP_FILES per Pi
  function files(deviceId) {
    let names = [];
    try { names = fs.readdirSync(fileDir(deviceId)).filter((n) => /^[A-Za-z0-9_.-]+$/.test(n) && !n.startsWith('.')); } catch { return []; }
    return names.map((name) => {
      let st = null;
      try { st = fs.statSync(path.join(fileDir(deviceId), name)); } catch { /* gone */ }
      return st ? { name, bytes: st.size, at: st.mtimeMs } : null;
    }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  function file(deviceId, name) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}$/.test(String(name)) || String(name).includes('..')) return null;
    const f = path.join(fileDir(deviceId), name);
    return fs.existsSync(f) ? f : null;
  }
  function keepFile(deviceId, name, buf) {
    const d = fileDir(deviceId);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const tmp = path.join(d, `.${name}.tmp`);
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, path.join(d, name));
    for (const old of files(deviceId).slice(KEEP_FILES)) {
      try { fs.unlinkSync(path.join(d, old.name)); } catch { /* gone */ }
    }
  }
  function removeFiles(deviceId) {
    fs.rmSync(fileDir(deviceId), { recursive: true, force: true });
  }
  const stamp = () => new Date(now()).toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z');

  // ---- running
  const call = async (deviceId, method, p, body = null, query = '') => {
    const r = await link.request(deviceId, { method, path: p, query, body });
    if (r.error || r.status >= 400) {
      const why = r.error || (r.body && typeof r.body === 'object' && typeof r.body.error === 'string' ? r.body.error : `HTTP ${r.status}`);
      throw Object.assign(new Error(String(why).slice(0, 300)), { status: r.status, offline: r.status === 503 || r.status === 502 });
    }
    return r;
  };
  const text = (r) => (r.buf ? r.buf.toString('utf8') : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null));

  const STEPS = {
    async sync(d) {
      try {
        await call(d, 'POST', '/api/system/trigger-sync');
        return { message: 'Sync started.' };
      } catch (err) {
        if (err.status === 409) return { message: 'An archive was already running.' };
        throw err;
      }
    },
    async reboot(d) {
      await call(d, 'POST', '/api/system/reboot');
      return { message: 'Rebooting.' };
    },
    async update(d) {
      const check = (await call(d, 'POST', '/api/system/check-update')).body || {};
      if (check.error) throw new Error(String(check.error).slice(0, 300));
      if (!check.update_available) return { message: `Already up to date (${String(check.current_version || 'unknown').slice(0, 40)}).` };
      await call(d, 'POST', '/api/system/update');
      return { message: `Update to ${String(check.latest_version || 'the latest version').slice(0, 40)} started.` };
    },
    async diagnostics(d) {
      await call(d, 'POST', '/api/diagnostics/refresh');
      const r = await call(d, 'GET', '/api/diagnostics');
      const name = `diagnostics-${stamp()}.txt`;
      keepFile(d, name, Buffer.from(text(r), 'utf8'));
      return { message: 'Diagnostics fetched.', file: name };
    },
    // made on the Pi and written to the archive share; it holds every secret, so it is never fetched
    async backup(d) {
      const made = (await call(d, 'POST', '/api/system/backup')).body || {};
      if (made.skipped) return { message: 'No changes since the last backup.' };
      const date = typeof made.date === 'string' ? made.date.slice(0, 40) : '';
      return { message: `Backup ${date ? `${date} ` : ''}made${made.location === 'archive' ? ' on the archive share' : made.location === 'ssd' ? ' on the Sentry USB' : ''}.` };
    },
    async settings(d, it) {
      const cur = (await call(d, 'GET', '/api/setup/config')).body;
      if (!cur || typeof cur !== 'object') throw new Error('The Sentry USB sent no settings.');
      // what the Pi has now, per field: its value, or null when not set (commented out)
      const isSet = (k) => cur[`${k}__set`] === true || cur[`${k}__set`]?.value === true || cur[k]?.set === true || cur[k]?.__set === true;
      const valueOf = (k) => (cur[k] && typeof cur[k] === 'object' && cur[k].active ? String(cur[k].value ?? '') : null);
      const out = {};
      // every active line as it is (a secret comes back empty: empty keeps it)
      for (const [k, v] of Object.entries(cur)) if (KEY_RE.test(k) && v && typeof v === 'object' && v.active) out[k] = String(v.value ?? '');
      const applied = [];
      const skipped = [];
      for (const [k, c] of Object.entries(it.params.changes)) {
        const now0 = valueOf(k);
        // a secret reads back empty, so it cannot be compared: it is set as asked
        const comparable = !(c.secret || isSet(k));
        if (comparable && now0 !== c.from && now0 !== c.to) { skipped.push(k); continue; }
        if (c.to === null) delete out[k];
        else out[k] = c.to;
        applied.push(k);
      }
      if (!applied.length) return { message: `Nothing applied: ${skipped.join(', ')} changed on the Sentry USB too.`, skipped };
      await call(d, 'PUT', '/api/setup/config', out);
      let ran = false;
      if (it.params.apply) {
        await call(d, 'POST', '/api/setup/run');
        ran = true;
      }
      return { message: `Saved ${applied.length} setting${applied.length === 1 ? '' : 's'}${ran ? ' and started setup' : ''}.${skipped.length ? ` Skipped ${skipped.join(', ')}: changed on the Sentry USB too.` : ''}`, applied, skipped };
    }
  };

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

  /** The Pi is home and has pushed its status: run what waits for it. */
  function kick(deviceId) {
    if (running.has(deviceId)) return running.get(deviceId);
    expire();
    if (!store.items.some((it) => it.deviceId === deviceId && it.state === 'queued')) return null;
    const batch = runBatch(deviceId).catch((err) => log.warn(`Sentry USB queue: ${err.message}`)).finally(() => running.delete(deviceId));
    running.set(deviceId, batch);
    return batch;
  }

  async function runBatch(deviceId) {
    const batch = store.items.filter((it) => it.deviceId === deviceId && it.state === 'queued').sort(order);
    const done = [];
    for (const it of batch) {
      if (it.state !== 'queued' || !link.online(deviceId)) break;
      if (it.expiresAt <= now()) { expire(); continue; }
      if (WAITS_FOR_IDLE.has(it.kind)) {
        const started = now();
        let waited = false;
        while (archiveBusy(link.status(deviceId)) && link.online(deviceId) && now() - started < idleWaitMs && it.state === 'queued') {
          if (!waited) { it.note = 'Waiting for the archive to finish.'; save(); changed(); waited = true; }
          await sleep(idlePollMs);
        }
        if (it.state !== 'queued' || !link.online(deviceId)) break;
        if (archiveBusy(link.status(deviceId))) {
          it.note = 'Waited too long for the archive to finish: still queued.';
          save();
          changed();
          done.push({ it, ok: false, waiting: true });
          continue;
        }
        it.note = null;
      }
      // marked running and saved before anything is sent: run at most once
      Object.assign(it, { state: 'running', startedAt: now() });
      save();
      changed();
      let result;
      let ok = true;
      try {
        result = await STEPS[it.kind](deviceId, it);
      } catch (err) {
        ok = false;
        result = { message: err.message || 'Failed.' };
      }
      Object.assign(it, { state: ok ? 'done' : 'failed', finishedAt: now(), result, params: forget(it) });
      done.push({ it, ok });
      try { onResult({ deviceId, kind: it.kind, label: KINDS[it.kind], by: it.by, ok, message: result?.message || '' }); } catch { /* the log's */ }
      log.info(`Sentry USB "${link.name(deviceId) || deviceId}": queued ${KINDS[it.kind].toLowerCase()} ${ok ? 'done' : `failed: ${result.message}`}`);
      trim();
      save();
      changed();
      if (it.kind === 'reboot' && ok) break; // the link goes; the rest waits for the next connection
    }
    const ran = done.filter((x) => !x.waiting);
    if (ran.length) {
      const failed = ran.filter((x) => !x.ok).length;
      notify({
        kind: 'sentryusb', level: failed ? 'warning' : 'info', dedupeKey: `sentryusb-queue:${deviceId}:${now()}`,
        title: `${link.name(deviceId) || 'Sentry USB'}: ${ran.length} queued action${ran.length === 1 ? '' : 's'} ran${failed ? `, ${failed} failed` : ''}`,
        message: ran.map((x) => `${KINDS[x.it.kind]}: ${x.ok ? 'done' : 'failed'}${x.it.result?.message ? ` (${x.it.result.message})` : ''}`).join('; ').slice(0, 1000)
      });
    }
  }

  // queued actions of an unpaired Pi go with it
  function forgetDevice(deviceId) {
    store.items = store.items.filter((it) => it.deviceId !== deviceId);
    save();
    removeFiles(deviceId);
    changed();
  }

  return { list, add, cancel, kick, expire, file, files, forgetDevice, busy: (id) => running.has(id), KINDS };
}

module.exports = { createSentryUsbQueue, archiveBusy, QUEUE_KINDS: KINDS };

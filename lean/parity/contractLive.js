'use strict';

// The routes record.js / compare.js cannot replay from goldens, compared live:
// the same scripted requests go to the Node server and to lean, each answer is
// normalised where it is random or the moment's (tokens, codes, the session's
// own ids, times), and the two are compared. Used by contractAll.js.
//
//   the live streams: GET /api/events (the `changed` topics each scripted
//     action brings, action by action) and GET /api/converter/events (hello,
//     then the live updates of a real conversion of one event folder to the
//     converted folder: the job's states in order, and its last snapshot);
//   the token routes: GET /metrics (metrics turned on, its token), GET
//     /api/can/logs/ping (CAN Bridge turned on, its token), GET /node/v1/info,
//     /node/v1/jobs/:id and /node/v1/jobs/:id/output (node mode on, paired by
//     Node's own main side, server/nodes.js, with the code each server shows);
//   the answers that are random or end the session: two-step set-up, sign-out
//     (a fresh session of its own), metrics on, a database snapshot, the
//     update check, CAN Bridge on and a token, node mode, the speed index kick.
//
// Footage is never touched: the conversion writes a copy to DATA/converted.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const lib = require(path.join(REPO, 'tools', 'contract', 'lib'));
const { createNodes } = require(path.join(REPO, 'server', 'nodes'));

const quiet = { info() {}, warn() {}, error() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server event stream (SSE) with this client's cookie: every event as { event, data }. */
function stream(base, ca, cookie, p) {
  const events = [];
  let req;
  const opened = new Promise((resolve, reject) => {
    req = https.request(new URL(p, base), { method: 'GET', ca: fs.readFileSync(ca), headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue; // a ping
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data += line.slice(6);
          }
          try { ev.data = JSON.parse(ev.data); } catch { /* text */ }
          events.push(ev);
        }
      });
      resolve({ status: res.statusCode, type: res.headers['content-type'] || null });
    });
    req.on('error', reject);
    req.end();
  });
  return { events, opened, close: () => req.destroy() };
}

const json = (res) => lib.parseJson(res.body);
const snap = (res, normalise = [], extra = {}) => lib.snapshot(res, { normalise, ...extra }, { now: Date.now() });

/** The scripted requests on one server; each result is [route, label, value]. */
async function script(server, password, clip) {
  const out = [];
  const note = (route, label, value) => out.push([route, label, value]);
  const fresh = async () => {
    const c = lib.createClient({ base: server.base, ca: server.ca });
    await c.login('admin', password);
    return c;
  };
  const c = await fresh();
  const confirm = () => c.request('POST', '/api/auth/confirm', { body: { password } });
  const context = json(await c.request('GET', '/api/studio/context'));
  const vehicle = context.vehicles[0];
  const data = context.outputRoots[0].replace(/[\\/]converted$/, '');
  const folders = [[vehicle.root, '{root}'], [data, '{data}']];
  const strings = folders.map(([from, to]) => [from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), to]);

  // ---- the live-update stream: the topics each action brings
  const ev = stream(server.base, server.ca, c.cookie(), '/api/events');
  const opened = await ev.opened;
  await sleep(1500);
  const hello = ev.events.slice();
  note('GET /api/events', 'open', { ...opened, first: hello[0] || null });
  const topicsOf = (list) => [...new Set(list.flatMap((e) => (e.event === 'changed' ? e.data.topics || [] : [`<${e.event}>`])))].sort();
  // what comes by itself (the shares' health checks every 30 s, the cleanup tick's 'bin' every
  // minute): those topics are
  // compared here, and left out of what each action brings (they land in any window)
  const quietFrom = ev.events.length;
  await sleep(62_000);
  const background = topicsOf(ev.events.slice(quietFrom));
  note('GET /api/events', 'background (62 s)', background);
  const topicsAfter = async (label, fn, until = null) => {
    const from = ev.events.length;
    const res = await fn();
    if (until) await until(res);
    await sleep(1500);
    const topics = topicsOf(ev.events.slice(from)).filter((t) => !background.includes(t));
    note('GET /api/events', label, { status: res.status, topics });
    return res;
  };
  await topicsAfter('appearance', () => c.request('PUT', '/api/settings/appearance', { body: { clock24: true } }));
  await topicsAfter('appearance back', () => c.request('PUT', '/api/settings/appearance', { body: { clock24: false } }));
  const place = json(await topicsAfter('place added', () => c.request('POST', '/api/places', { body: { name: 'Live check', lat: 30.2672, lon: -97.7431, radius: 150 } })));
  if (place?.id || place?.place?.id) await topicsAfter('place removed', () => c.request('DELETE', `/api/places/${encodeURIComponent(place.id || place.place.id)}`));
  await topicsAfter('dashboards', () => c.request('PUT', '/api/dashboards', { body: { boards: [] } }));
  await topicsAfter('notifications read', () => c.request('POST', '/api/notifications/read', { body: { ids: [] } }));
  await topicsAfter('work limits', () => c.request('PUT', '/api/settings/work-limits', { body: {} }));
  await topicsAfter('notification rules', () => c.request('PUT', '/api/notification-rules', { body: { rules: {} } }));

  // ---- the converter's stream: a real conversion of one event folder, copied to the converted folder
  const client = `live-${crypto.randomBytes(4).toString('hex')}`;
  const cev = stream(server.base, server.ca, c.cookie(), `/api/converter/events?client=${client}`);
  const copened = await cev.opened;
  await sleep(500);
  note('GET /api/converter/events', 'open', { ...copened, first: cev.events[0] || null });
  const invoke = (name, body) => c.request('POST', `/api/converter/invoke/${name}`, { body, headers: { 'X-Client-Id': client } });
  note('GET /api/converter/events', 'subscribe', snap(await invoke('subscribeProgress')));
  let last = null;
  const ended = async () => {
    for (let i = 0; i < 600; i++) {
      const done = cev.events.filter((e) => e.event === 'converter:progress' && e.data?.snapshot?.state && !['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing'].includes(e.data.snapshot.state));
      if (done.length) { last = done[done.length - 1]; break; }
      await sleep(200);
    }
  };
  // (the topics from the start to the job's end)
  const started = json(await topicsAfter('conversion', () => invoke('start', {
    sourceRoot: path.join(vehicle.root, 'TeslaCam', 'SavedClips'), destinationRoot: path.join(data, 'converted', 'live-check'),
    codec: 'h265', profileId: 'balanced', networkMode: 'auto', outputMode: 'separate', includedGroups: ['SavedClips'], replacementConfirmed: false
  }), ended));
  note('GET /api/converter/events', 'start', { ok: started?.ok, error: started?.error || null, jobId: typeof started?.value?.jobId });
  const progress = cev.events.filter((e) => e.event === 'converter:progress');
  const states = [];
  for (const e of progress) {
    const st = e.data?.snapshot?.state;
    if (st && states[states.length - 1] !== st) states.push(st);
  }
  // (which passing states a snapshot shows depends on timing: the service sends a state change
  // at once only to or from an idle state, others with the next timed snapshot)
  note('GET /api/converter/events', 'job states', { events: [...new Set(cev.events.map((e) => e.event))].sort(), encoded: states.includes('encoding'), ended: last ? last.data.snapshot.state : null, idle: states.filter((x) => ['paused', 'paused_network', 'completed', 'skipped', 'failed', 'cancelled'].includes(x)) });
  if (last) {
    const s = last.data.snapshot;
    note('GET /api/converter/events', 'last snapshot', {
      keys: Object.keys(s).sort(),
      items: (s.items || []).map((x) => ({ kind: x.kind, state: x.state, relativePath: x.relativePath, reason: x.reason ?? null })).sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath))),
      config: lib.normalise(s.config, [{ strings }]),
      counters: Object.fromEntries(Object.entries(s.counters || {}).map(([k, v]) => [k, /Bytes$/.test(k) ? typeof v : v]))
    });
  }
  // the Activity row it made, and the topics of its end
  const jobs = json(await c.request('GET', '/api/jobs?limit=5'))?.jobs || [];
  const row = jobs.find((j) => j.type === 'conversion');
  note('GET /api/converter/events', 'activity row', row ? { title: row.title, status: row.status, detail: String(row.detail || '').replace(/ · .* saved$/, ' · <saved>') } : null);
  if (started?.value?.jobId) await invoke('dismissSummary', { jobId: started.value.jobId });
  cev.close();

  // ---- random answers and session ends
  await confirm();
  note('POST /api/auth/2fa/start', 'start', snap(await c.request('POST', '/api/auth/2fa/start', { body: {} }), [{ path: 'secret', as: 'id' }, { strings: [['secret=[A-Z2-7]+', 'secret=<secret>']] }]));
  {
    const other = await fresh();
    const res = await other.request('POST', '/api/auth/logout', { body: {} });
    note('POST /api/auth/logout', 'logout', { ...snap(res), cookie: [].concat(res.headers['set-cookie'] || []).map((x) => x.replace(/=[^;]*/, '=<value>')) });
    note('POST /api/auth/logout', 'after', snap(await other.request('GET', '/api/auth/me')));
    note('POST /api/auth/logout', 'others stay', (await c.request('GET', '/api/auth/me')).status);
  }
  // metrics: on, the token's page, off
  await confirm();
  const metrics = await c.request('POST', '/api/metrics/enable', { body: {} });
  note('POST /api/metrics/enable', 'enable', snap(metrics, [{ path: 'token', as: 'id' }]));
  const token = json(metrics)?.token;
  const bare = (p, headers) => new Promise((resolve) => {
    const req = https.request(new URL(p, server.base), { method: 'GET', ca: fs.readFileSync(server.ca), headers }, (res) => {
      const chunks = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: Buffer.from(String(err.code || err.message)) }));
    req.end();
  });
  const metricLines = (res) => ({
    status: res.status, type: res.headers['content-type'] || null,
    // each metric by its name and labels; the values are the moment's
    lines: res.body.toString('utf8').split('\n').filter(Boolean).map((l) => (l.startsWith('#') ? l : l.replace(/ [-+0-9.eE]+$|NaN$/, ' <value>')))
  });
  note('GET /metrics', 'with token', metricLines(await bare('/metrics', { Authorization: `Bearer ${token}` })));
  note('GET /metrics', 'wrong token', snap(await bare('/metrics', { Authorization: 'Bearer nottheone' })));
  note('GET /metrics', 'no token', snap(await bare('/metrics', {})));
  await confirm();
  await c.request('POST', '/api/metrics/disable', { body: {} });
  note('GET /metrics', 'turned off', snap(await bare('/metrics', { Authorization: `Bearer ${token}` })));

  // a database snapshot (named by the moment)
  const snapRules = [{ path: 'snapshots.*.name', as: 'id' }, { path: 'snapshots.*.bytes', as: 'bytes' }, { path: 'snapshots.*.size', as: 'bytes' }, { strings: [['manager-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z?\\.db', 'manager-<stamp>.db']] }];
  note('POST /api/snapshots', 'take', snap(await c.request('POST', '/api/snapshots', { body: {} }), snapRules));
  // the update check (this machine has no way to the registry, or it has: the same either way)
  note('POST /api/updates/check', 'check', snap(await c.request('POST', '/api/updates/check', { body: {} }), [{ path: 'checkedAt', as: 'time' }, { path: 'latest', as: 'shape' }, { path: 'current', as: 'shape' }]));

  // CAN Bridge on, a token, its ping, off
  await confirm();
  const can = await c.request('POST', '/api/can/enable', { body: {} });
  note('POST /api/can/enable', 'enable', snap(can, [{ path: 'token', as: 'id' }, { path: 'tokenId', as: 'id' }, { path: 'fingerprint', as: 'id' }, { path: 'port', as: 'number' }]));
  await confirm();
  const made = await c.request('POST', '/api/can/tokens', { body: { label: 'live check' } });
  note('POST /api/can/tokens', 'token', snap(made, [{ path: 'token', as: 'id' }, { path: 'id', as: 'id' }, { path: 'fingerprint', as: 'id' }, { path: 'port', as: 'number' }]));
  const canToken = json(made)?.token;
  note('GET /api/can/logs/ping', 'with token', snap(await bare('/api/can/logs/ping', { Authorization: `Bearer ${canToken}` }), [{ path: 'fingerprint', as: 'id' }, { path: 'port', as: 'number' }]));
  note('GET /api/can/logs/ping', 'wrong token', snap(await bare('/api/can/logs/ping', { Authorization: 'Bearer nottheone' })));
  await c.request('POST', '/api/can/disable', { body: {} });
  note('GET /api/can/logs/ping', 'turned off', snap(await bare('/api/can/logs/ping', { Authorization: `Bearer ${canToken}` })));

  // the speed index kick
  note('POST /api/speeds/index', 'kick', snap(await c.request('POST', '/api/speeds/index', { body: {} }), [{ path: 'readMode', as: 'drop' }]));

  // node mode, a pairing with Node's main side, the token routes
  const nodeRules = [{ path: 'pairing.code', as: 'id' }, { path: 'mains.*.id', as: 'id' }];
  note('POST /api/nodes/worker', 'on', snap(await c.request('POST', '/api/nodes/worker', { body: { enabled: true } }), nodeRules));
  await confirm();
  const code = json(await c.request('POST', '/api/nodes/worker/pair', { body: {} }))?.pairing?.code;
  const nodes = createNodes({ db: memDb(), log: quiet, audit: quiet, name: 'live-main', pollMs: 100 });
  let node = null;
  try {
    node = await nodes.add({ address: new URL(server.base).host, code });
  } catch (err) {
    note('GET /node/v1/info', 'paired', { error: err.message });
  }
  if (node) {
    const nodeCall = (p, method = 'GET') => new Promise((resolve) => {
      const req = https.request(new URL(p, server.base), { method, rejectUnauthorized: false, headers: { Authorization: `Bearer ${node.token}` } }, (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', (err) => resolve({ status: 0, headers: {}, body: Buffer.from(String(err.code || err.message)) }));
      req.end();
    });
    note('GET /node/v1/info', 'paired', { name: node.name === json(await c.request('GET', '/api/nodes'))?.worker?.name ? 'this server' : node.name });
    note('GET /node/v1/info', 'info', snap(await nodeCall('/node/v1/info'), [{ path: 'name', as: 'id' }, { path: 'version', as: 'shape' }, { path: 'power', as: 'shape' }, { path: 'free', as: 'bytes' }, { path: 'freeBytes', as: 'bytes' }, { path: 'hardware.cpu', as: 'id' }]));
    note('GET /node/v1/jobs/:id', 'unknown job', snap(await nodeCall('/node/v1/jobs/0123456789abcdef0123456789abcdef')));
    note('GET /node/v1/jobs/:id', 'bad id', snap(await nodeCall('/node/v1/jobs/zz')));
    note('GET /node/v1/jobs/:id/output', 'unknown job', snap(await nodeCall('/node/v1/jobs/0123456789abcdef0123456789abcdef/output')));
    note('GET /node/v1/info', 'nodes page', snap(await c.request('GET', '/api/nodes'), [{ path: 'worker.name', as: 'id' }, { path: 'worker.mains.*.id', as: 'id' }, { path: 'worker.mains.*.address', as: 'id' }]));
  }
  nodes.close?.();
  note('POST /api/nodes/worker', 'off', snap(await c.request('POST', '/api/nodes/worker', { body: { enabled: false } }), nodeRules));
  if (node) {
    const off = await new Promise((resolve) => {
      const req = https.request(new URL('/node/v1/info', server.base), { method: 'GET', rejectUnauthorized: false, headers: { Authorization: `Bearer ${node.token}` } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.end();
    });
    note('GET /node/v1/info', 'node mode off', off);
  }
  ev.close();
  c.close();
  void clip;
  return out;
}

/**
 * Both servers, one after the other (each is the only one asked while it runs);
 * returns { byRoute: { route: { same, different, answers: [{ label, diffs }] } } }.
 */
async function live({ node, lean, password }) {
  const a = await script(node, password);
  const b = await script(lean, password);
  const byRoute = {};
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const [route, label, golden] = a[i] || b[i];
    const actual = b[i] && b[i][0] === route && b[i][1] === label ? b[i][2] : '<missing>';
    const diffs = lib.diff(golden, actual);
    const r = (byRoute[route] ||= { same: 0, different: 0, answers: [] });
    if (diffs.length) { r.different++; r.answers.push({ label: `${route} ${label}`, diffs }); } else r.same++;
  }
  return { byRoute, node: a, lean: b };
}

module.exports = { live, script };

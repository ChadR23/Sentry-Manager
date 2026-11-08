'use strict';

// CAN logs the bridge could not sign, through the real server (SMO build 143:
// a damaged chain.json made the bridge send logs with "signed": false and an
// "error"; build 144 repaired the chain and says so in "chain_note"). For a
// paired car they get a reason of their own, are not used and are outside
// the chain; the next signed log follows the last signed one with no break;
// the chain note is listed; the owner can use them all at once (password,
// audited, only those logs, the index picks them up) and stop again; a
// watch-only account may not; judgements stored by the older version are
// judged again at start.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { signedMessage } = require('../server/canTrust');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** The server on `dir`; `jar` keeps the session cookie across restarts. */
async function startServer(dir, jar) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'info', TLS_MODE: 'off', TRUST_PROXY: 'true', UPDATE_CHECK: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const https = { 'X-Forwarded-Proto': 'https' };
  const call = async (method, p, body, c = jar) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...https, 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) c.cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const put = (token, name, data) => fetch(`${base}/api/can/logs/${encodeURIComponent(name)}`, {
    method: 'POST', body: data,
    headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(data.length), 'Upload-SHA256': crypto.createHash('sha256').update(data).digest('hex') }
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { base, https, call, put, stop, output: () => output };
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('logs the bridge could not sign: their own reason, not used, outside the chain, the chain note listed, used all at once and stopped, re-judged after an update', { skip, timeout: 180000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cannotsign-'));
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  const KEY = 'SIGN-car';
  // a minute of one signal per log (log m starts at 15:0m UTC)
  const t0 = Date.UTC(2026, 10, 8, 15, 0, 0) / 1000;
  const nameOf = (m) => `${KEY}_20261108T150${m}00Z_${m + 1}.log.xz`;
  const minuteFile = (m) => path.join(dir, 'data', 'can-index', KEY, `20261108T150${m}.json.gz`);
  const logOf = (m) => {
    const lines = [];
    for (let i = 0; i < 300; i++) {
      const b = Buffer.alloc(8);
      b.writeUInt16LE(Math.round((380 + m) / 0.01), 0);
      lines.push(`(${(t0 + m * 60 + i / 5).toFixed(6)}) can0 132#${b.toString('hex').toUpperCase()}`);
    }
    return execFileSync('xz', ['-6', '-c'], { input: `${lines.join('\n')}\n` });
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  let index = 0;
  let prev = { name: '-', sha256: '0'.repeat(64) };
  const signed = (name, body, note) => {
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const msg = signedMessage({ vehicleKey: KEY, name, sha256: sha, length: body.length, index, prevName: prev.name, prevSha256: prev.sha256 });
    const integrity = { signed: true, version: 'canbridge-log-sig-v1', algorithm: 'ECDSA-P256-SHA256', public_key: der.toString('base64'), vehicle_key: KEY, sha256: sha, length: body.length, index, prev_name: prev.name, prev_sha256: prev.sha256, signature: crypto.sign('sha256', Buffer.from(msg), privateKey).toString('base64'), ...(note ? { chain_note: note } : {}) };
    prev = { name, sha256: sha };
    index++;
    return Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 300, integrity }));
  };
  const unsigned = (error) => Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 300, integrity: { signed: false, error } }));
  const ERR = 'JSONException: Value <script>alert(1)</script> of type java.lang.String cannot be converted to JSONObject';
  const NOTE = `chain.json was 64 zero bytes (likely a power cut); chain continued from ${nameOf(1)} (index 1)`;
  const jar = { cookie: '' };
  let s = await startServer(dir, jar);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const token = (await s.call('POST', '/api/can/enable', {})).data.token;
    // 0 and 1 signed; 2 and 3 the bridge could not sign; 4 signed again, after 1, with the bridge's note
    for (const m of [0, 1, 2, 3, 4]) {
      const body = logOf(m);
      assert.equal((await s.put(token, nameOf(m), body)).status, 201);
      assert.equal((await s.put(token, `${nameOf(m)}.json`, m === 2 || m === 3 ? unsigned(ERR) : signed(nameOf(m), body, m === 4 ? NOTE : null))).status, 201);
      if (m === 0) await waitFor(async () => (await s.call('GET', '/api/can/files')).data.logs?.find((l) => l.name === nameOf(0))?.check.status === 'verified');
    }
    const files = async () => Object.fromEntries((await s.call('GET', '/api/can/files')).data.logs.map((l) => [l.name, l]));
    await waitFor(async () => { const f = await files(); return [0, 1, 2, 3, 4].every((m) => f[nameOf(m)] && f[nameOf(m)].check.status !== 'waiting'); });
    let f = await files();
    assert.deepEqual([f[nameOf(2)].check.status, f[nameOf(2)].check.kind, f[nameOf(2)].check.override], ['failed', 'bridge-could-not-sign', false]);
    assert.equal(f[nameOf(2)].check.reason, `unsigned: the CAN Bridge could not sign it (${ERR})`, 'kept as text (the panel escapes it)');
    assert.equal(f[nameOf(4)].check.status, 'verified');
    assert.equal(f[nameOf(4)].check.chainNote, NOTE, 'the chain note listed with its log');
    assert.equal(f[nameOf(0)].check.chainNote, null);
    let trust = (await s.call('GET', '/api/can/settings')).data.trust.find((x) => x.key === KEY);
    assert.deepEqual(trust.chain.issues, [], 'no gap, no mismatch, no failed link');
    assert.deepEqual([trust.chain.first, trust.chain.last, trust.chain.count], [0, 2, 3]);
    assert.deepEqual(trust.couldNotSign, { count: 2, used: 0 });
    // not used: their minutes are not indexed (the signed ones are)
    await waitFor(async () => fs.existsSync(minuteFile(4)));
    assert.equal(fs.existsSync(minuteFile(2)) || fs.existsSync(minuteFile(3)), false);

    // a watch-only account may not use them
    assert.equal((await s.call('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const kid = { cookie: '' };
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'kid', password: 'watching only' }, kid)).status, 200);
    assert.equal((await s.call('POST', `/api/can/pairing/${KEY}/could-not-sign`, { use: true }, kid)).status, 403);
    assert.equal((await s.call('GET', '/api/can/settings', undefined, kid)).status, 403);
    assert.deepEqual((await s.call('GET', '/api/can/settings')).data.trust.find((x) => x.key === KEY).couldNotSign, { count: 2, used: 0 });

    // the old judgement as the version before this one stored it: judged again at the next start
    await s.stop();
    const tfile = path.join(dir, 'data', 'can', KEY, 'trust.json');
    const tj = JSON.parse(await fsp.readFile(tfile, 'utf8'));
    delete tj.v;
    for (const r of Object.values(tj.logs)) { delete r.v; delete r.kind; delete r.chainNote; }
    for (const m of [2, 3]) tj.logs[nameOf(m)].reason = `not signed: ${ERR}, but this car is paired with a key`;
    await fsp.writeFile(tfile, JSON.stringify(tj));
    s = await startServer(dir, jar);
    // (the first look at pending logs is 15 s after start)
    await waitFor(async () => (await files())[nameOf(3)]?.check.kind === 'bridge-could-not-sign', 60000);
    f = await files();
    assert.equal(f[nameOf(2)].check.reason, `unsigned: the CAN Bridge could not sign it (${ERR})`);
    assert.equal(f[nameOf(4)].check.chainNote, NOTE, 'the note read from the sidecar of a log judged before');
    assert.equal(JSON.parse(await fsp.readFile(tfile, 'utf8')).v, 2);

    // all at once: the password first (a session from before the restart is not "just confirmed")
    const refused = await s.call('POST', `/api/can/pairing/${KEY}/could-not-sign`, { use: true });
    assert.deepEqual([refused.status, refused.data.code], [403, 'CONFIRM_PASSWORD']);
    assert.equal((await s.call('POST', '/api/auth/confirm', { password: 'correct horse' })).status, 200);
    assert.equal((await s.call('POST', `/api/can/pairing/${KEY}/could-not-sign`, { use: 'yes' })).status, 400);
    const on = await s.call('POST', `/api/can/pairing/${KEY}/could-not-sign`, { use: true });
    assert.equal(on.status, 200);
    assert.deepEqual([on.data.changed, on.data.names], [2, [nameOf(2), nameOf(3)]]);
    assert.deepEqual(on.data.summary.couldNotSign, { count: 2, used: 2 });
    f = await files();
    assert.deepEqual([f[nameOf(2)].check.override, f[nameOf(3)].check.override, f[nameOf(4)].check.override], [true, true, false]);
    // the index picks them up, as after "Use anyway"
    await waitFor(async () => fs.existsSync(minuteFile(2)) && fs.existsSync(minuteFile(3)));
    await waitFor(async () => /\[audit\] CAN Bridge SIGN-car: 2 logs the bridge could not sign used anyway \(SIGN-car_20261108T150200Z_3\.log\.xz to SIGN-car_20261108T150300Z_4\.log\.xz\): admin/.test(s.output()), 5000);
    // one stopped by hand, then the rest at once
    assert.equal((await s.call('POST', `/api/can/files/${nameOf(3)}/use`, { use: false })).status, 200);
    assert.deepEqual((await s.call('GET', '/api/can/settings')).data.trust.find((x) => x.key === KEY).couldNotSign, { count: 2, used: 1 });
    const off = await s.call('POST', `/api/can/pairing/${KEY}/could-not-sign`, { use: false });
    assert.deepEqual([off.data.changed, off.data.names], [1, [nameOf(2)]]);
    await waitFor(async () => !fs.existsSync(minuteFile(2)) && !fs.existsSync(minuteFile(3)), 10000);
    assert.ok(fs.existsSync(minuteFile(4)), 'the signed logs stay');
    trust = (await s.call('GET', '/api/can/settings')).data.trust.find((x) => x.key === KEY);
    assert.deepEqual([trust.couldNotSign, trust.chain.issues], [{ count: 2, used: 0 }, []]);
    assert.equal(s.output().includes('TypeError'), false);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

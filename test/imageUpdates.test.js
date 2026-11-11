'use strict';

// Settings > Updates: asks the registry whether a newer image is out, the way
// GHCR answers (anonymous token, multi-arch index, config labels).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ImageUpdates, parseChallenge, cleanCritical, criticalFromFile } = require('../server/imageUpdates');

const IMAGE = 'ghcr.io/owner/sentry-six-manager';
const SHA = 'b'.repeat(40);
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch] || process.arch;
const digest = (c) => `sha256:${c.repeat(64)}`;

function fakeDb() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
}

function fakeNotes() {
  const open = new Map();
  return { open, raise: (n) => open.set(n.dedupeKey, n), resolve: (k) => open.delete(k) };
}

/** A registry that wants a token first and serves one tag for two architectures. */
function fakeRegistry({ revision = 'c'.repeat(40), created = '2026-10-20T04:00:00Z', version, critical, level, tokenStatus = 200, realm = 'https://ghcr.io/token' } = {}) {
  const calls = [];
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    const authed = opts.headers?.Authorization === 'Bearer t0k3n';
    const u = new URL(url);
    if (u.origin + u.pathname === realm) {
      assert.equal(u.searchParams.get('scope'), 'repository:owner/sentry-six-manager:pull');
      return json(tokenStatus, tokenStatus === 200 ? { token: 't0k3n' } : { errors: [{ code: 'DENIED' }] });
    }
    if (!authed) return json(401, {}, { 'www-authenticate': `Bearer realm="${realm}",service="ghcr.io",scope="repository:owner/sentry-six-manager:pull"` });
    if (u.pathname === '/v2/owner/sentry-six-manager/manifests/latest') {
      return json(200, { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
        { digest: digest('1'), platform: { os: 'linux', architecture: 'amd64' } },
        { digest: digest('2'), platform: { os: 'linux', architecture: 'arm64' } },
        { digest: digest('3'), platform: { os: 'unknown', architecture: 'unknown' } }
      ] }, { 'docker-content-digest': digest('9') });
    }
    if (u.pathname === `/v2/owner/sentry-six-manager/manifests/${digest(ARCH === 'amd64' ? '1' : '2')}`) {
      return json(200, { config: { digest: digest('c') } });
    }
    if (u.pathname === `/v2/owner/sentry-six-manager/blobs/${digest('c')}`) {
      return json(200, { created, config: { Labels: { 'org.opencontainers.image.revision': revision, 'org.opencontainers.image.created': created, ...(version !== undefined ? { 'org.opencontainers.image.version': version } : {}), ...(critical !== undefined ? { 'io.sentry-six.critical': critical } : {}), ...(level !== undefined ? { 'io.sentry-six.critical-level': String(level) } : {}) } } });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

const build = (over = {}) => ({ sha: SHA, builtAt: '2026-10-13T04:00:00Z', image: IMAGE, tag: 'latest', ...over });

test('a newer commit on the tag is an update, and the notification says how to install it', async () => {
  const notes = fakeNotes();
  const reg = fakeRegistry();
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build(), fetchImpl: reg.fetchImpl });
  const st = await u.check();
  assert.equal(st.error, null);
  assert.equal(st.updateAvailable, true);
  assert.equal(st.latest.revision, 'c'.repeat(40));
  assert.equal(st.latest.digest, digest(ARCH === 'amd64' ? '1' : '2'));
  assert.match(notes.open.get('image-update').message, /docker compose pull && docker compose up -d/);
});

test('the weekly rebuild of the same commit (security fixes) is an update too', async () => {
  const reg = fakeRegistry({ revision: SHA, created: '2026-10-20T04:00:00Z' });
  const u = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: reg.fetchImpl });
  assert.equal((await u.check()).updateAvailable, true);
});

test('the running image itself is not an update, and an old notice is cleared', async () => {
  const notes = fakeNotes();
  notes.raise({ dedupeKey: 'image-update', title: 'old' });
  const reg = fakeRegistry({ revision: SHA, created: '2026-10-13T04:00:00Z' });
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build(), fetchImpl: reg.fetchImpl });
  assert.equal((await u.check()).updateAvailable, false);
  assert.equal(notes.open.size, 0);
});

test('a build without an image, or with a strange one, never contacts anything', async () => {
  for (const over of [{ image: '', tag: '' }, { image: 'http://evil/x' }, { tag: '../../x' }, { image: 'ghcr.io/Owner/X' }]) {
    const reg = fakeRegistry();
    const u = new ImageUpdates({ db: fakeDb(), buildInfo: build(over), fetchImpl: reg.fetchImpl });
    const st = await u.check();
    assert.equal(st.enabled, false, JSON.stringify(over));
    assert.equal(reg.calls.length, 0);
  }
  const off = new ImageUpdates({ db: fakeDb(), buildInfo: build(), enabled: false, fetchImpl: fakeRegistry().fetchImpl });
  assert.equal((await off.check()).enabled, false);
});

test('registry problems are reported, never shown as an update', async () => {
  const priv = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: fakeRegistry({ tokenStatus: 403 }).fetchImpl });
  const st = await priv.check();
  assert.match(st.error, /is the image public/);
  assert.equal(st.updateAvailable, false);

  const plain = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: fakeRegistry({ realm: 'http://ghcr.io/token' }).fetchImpl });
  assert.match((await plain.check()).error, /without HTTPS/);

  const missing = new ImageUpdates({ db: fakeDb(), buildInfo: build({ tag: 'nope' }), fetchImpl: fakeRegistry().fetchImpl });
  assert.match((await missing.check()).error, /no image tagged nope/);
});

test('checks are spaced out, and the result survives a restart', async () => {
  const db = fakeDb();
  const reg = fakeRegistry();
  const u = new ImageUpdates({ db, buildInfo: build(), fetchImpl: reg.fetchImpl });
  await u.check();
  const n = reg.calls.length;
  await u.check(); // a second click right away does not ask again
  assert.equal(reg.calls.length, n);
  const after = new ImageUpdates({ db, buildInfo: build(), fetchImpl: reg.fetchImpl });
  assert.equal(after.status().updateAvailable, true);
  await after.tick(); // checked less than 12 hours ago
  assert.equal(reg.calls.length, n);
});

test('build numbers: the label tells how many builds behind, and the notice names the build', async () => {
  const notes = fakeNotes();
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build({ build: 128 }), fetchImpl: fakeRegistry({ version: 'build-131' }).fetchImpl });
  const st = await u.check();
  assert.deepEqual(st.current, { sha: SHA, build: 128, builtAt: '2026-10-13T04:00:00Z' });
  assert.equal(st.latest.build, 131);
  assert.equal(st.buildsBehind, 3);
  assert.equal(st.updateAvailable, true);
  assert.match(notes.open.get('image-update').message, /A newer latest image \(Build 131\) was published/);
});

test('build numbers: the same or a lower number is not an update, whatever the commit and date say', async () => {
  for (const [version, behind] of [['build-128', 0], ['build-120', 0]]) {
    const notes = fakeNotes();
    // another commit, built later: by revision and date alone this would be an update
    const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build({ build: 128 }), fetchImpl: fakeRegistry({ version, created: '2026-10-30T04:00:00Z' }).fetchImpl });
    const st = await u.check();
    assert.equal(st.buildsBehind, behind, version);
    assert.equal(st.updateAvailable, false, version);
    assert.equal(notes.open.size, 0);
  }
});

test('build numbers: without one on either side the commit and date decide, as before', async () => {
  // the newest image has no version label (built before build numbers)
  const noLabel = new ImageUpdates({ db: fakeDb(), buildInfo: build({ build: 128 }), fetchImpl: fakeRegistry().fetchImpl });
  let st = await noLabel.check();
  assert.equal(st.latest.build, null);
  assert.equal(st.buildsBehind, null);
  assert.equal(st.updateAvailable, true, 'another commit');
  const same = new ImageUpdates({ db: fakeDb(), buildInfo: build({ build: 128 }), fetchImpl: fakeRegistry({ revision: SHA, created: '2026-10-13T04:00:00Z' }).fetchImpl });
  assert.equal((await same.check()).updateAvailable, false);
  // this server's image has no number (an image from before them), the newest has one
  const old = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: fakeRegistry({ version: 'build-131' }).fetchImpl });
  st = await old.check();
  assert.equal(st.current.build, null);
  assert.equal(st.latest.build, 131);
  assert.equal(st.buildsBehind, null);
  assert.equal(st.updateAvailable, true);
  // a strange label is no number
  for (const version of ['131', 'build-', 'build-1x', 'v2026.1', 'build-0']) {
    const u = new ImageUpdates({ db: fakeDb(), buildInfo: build({ build: 128 }), fetchImpl: fakeRegistry({ version }).fetchImpl });
    assert.equal((await u.check()).latest.build, null, version);
  }
});

test('parseChallenge reads Bearer challenges only', () => {
  assert.deepEqual(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'), { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:a/b:pull' });
  assert.equal(parseChallenge('Basic realm="x"'), null);
  assert.equal(parseChallenge(''), null);
});

// Releases in the critical tests: 0 the running one (before any critical
// release), A critical (level 1), B a bug fix after A (still carries level 1),
// C a second critical one (level 2).
const A = { revision: 'a'.repeat(40), created: '2026-10-20T04:00:00Z', critical: 'Fixes a bug that\ncan delete footage\u0007', level: 1 };
const B = { revision: 'd'.repeat(40), created: '2026-10-22T04:00:00Z', critical: 'Fixes a bug that can delete footage', level: 1 };
const C = { revision: 'e'.repeat(40), created: '2026-10-25T04:00:00Z', critical: 'Closes a sign-in hole', level: 2 };
const onA = build({ sha: A.revision, builtAt: A.created });
const onB = build({ sha: B.revision, builtAt: B.created });
const at = (u, release) => { u.fetch = fakeRegistry(release).fetchImpl; u.lastCheck = 0; return u.check(); };

test('critical (1): a server older than critical release A sees it, with a notification of its own', async () => {
  const notes = fakeNotes();
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build(), fetchImpl: null });
  const st = await at(u, A);
  assert.deepEqual(st.critical, { level: 1, reason: 'Fixes a bug that can delete footage', created: A.created });
  const n = notes.open.get('image-update-critical');
  assert.equal(n.title, 'Critical update: install now');
  assert.equal(n.level, 'critical');
  assert.match(n.message, /can delete footage.*docker compose pull && docker compose up -d/);
  assert.ok(notes.open.has('image-update'), 'the plain notice too');
});

test('critical (2): a bug fix B after A does not cancel it', async () => {
  const notes = fakeNotes();
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build(), fetchImpl: null });
  await at(u, A);
  const st = await at(u, B);
  assert.equal(st.critical?.level, 1);
  assert.ok(notes.open.has('image-update-critical'));
});

test('critical (3): B without the labels (file emptied by mistake) still leaves it critical, also after a restart', async () => {
  const db = fakeDb();
  const u = new ImageUpdates({ db, buildInfo: build(), fetchImpl: null });
  await at(u, A);
  const st = await at(u, { revision: B.revision, created: B.created });
  assert.equal(st.updateAvailable, true);
  assert.equal(st.critical?.level, 1);
  assert.equal(new ImageUpdates({ db, buildInfo: build() }).status().critical?.level, 1, 'remembered');
});

test('critical (4): installing A or B clears it and its notification', async () => {
  for (const [name, info, latest] of [['A', onA, A], ['B', onB, B]]) {
    const notes = fakeNotes();
    const db = fakeDb();
    await at(new ImageUpdates({ db, notes, buildInfo: build(), fetchImpl: null }), A);
    assert.ok(notes.open.has('image-update-critical'));
    const after = new ImageUpdates({ db, notes, buildInfo: info, ownCritical: { level: 1, reason: 'x' }, fetchImpl: null });
    after.announce();
    assert.equal(after.status().critical, null, name);
    assert.ok(!notes.open.has('image-update-critical'), name);
    const st = await at(after, latest);
    assert.equal(st.critical, null, name);
    assert.equal(st.updateAvailable, false, name);
    assert.equal(notes.open.size, 0, name);
  }
});

test('critical (5): a second critical release C is critical again for servers on A or B', async () => {
  for (const info of [onA, onB]) {
    const notes = fakeNotes();
    const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: info, ownCritical: { level: 1, reason: 'x' }, fetchImpl: null });
    assert.equal((await at(u, B)).critical, null);
    const st = await at(u, C);
    assert.deepEqual(st.critical, { level: 2, reason: 'Closes a sign-in hole', created: C.created });
    assert.ok(notes.open.has('image-update-critical'));
  }
});

test('critical (6): a server already past the critical release but older than the latest gets only the normal notice', async () => {
  const notes = fakeNotes();
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: onA, ownCritical: { level: 1, reason: 'x' }, fetchImpl: null });
  const st = await at(u, B);
  assert.equal(st.updateAvailable, true);
  assert.equal(st.critical, null);
  assert.deepEqual([...notes.open.keys()], ['image-update']);
});

test('critical labels that are empty or strange are not critical', async () => {
  for (const [critical, level] of [['', 1], ['   ', 1], ['\n\t', 3], ['Fix', undefined], ['Fix', 'x'], ['Fix', '-1'], ['Fix', '1e3'], ['Fix', 0]]) {
    const u = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: fakeRegistry({ critical, level }).fetchImpl });
    assert.equal((await u.check()).critical, null, JSON.stringify([critical, level]));
  }
  assert.equal(cleanCritical(42), null);
  assert.equal(cleanCritical({}), null);
  assert.equal(cleanCritical('x'.repeat(5000)).length, 300);
  assert.equal(cleanCritical(' a\u202eb\r\nc  '), 'a b c');
  assert.deepEqual(criticalFromFile('# c\nlevel: 2\nreason: Fix it\n'), { level: 2, reason: 'Fix it' });
  assert.deepEqual(criticalFromFile('level: 2\nreason:\n'), { level: 0, reason: null }, 'no reason, no level');
});

test('the first check after a start comes within minutes, then every 12 hours', async () => {
  const db = fakeDb();
  db.set('image-updates', { latest: null, checkedAt: Date.now() - 11 * 60 * 1000, error: null });
  const reg = fakeRegistry();
  const u = new ImageUpdates({ db, buildInfo: build(), fetchImpl: reg.fetchImpl });
  await u.tick();
  assert.ok(reg.calls.length > 0, 'checked soon after the start');
  const n = reg.calls.length;
  u.lastCheck = 0;
  await u.tick();
  assert.equal(reg.calls.length, n, 'not again until 12 hours later');
});

test('CRITICAL_UPDATE.txt is read the same way by the build and the server', () => {
  const repo = path.join(__dirname, '..');
  const file = fs.readFileSync(path.join(repo, 'CRITICAL_UPDATE.txt'), 'utf8');
  // the committed file is well formed: a level, and a reason when it is above 0
  const own = criticalFromFile(file);
  assert.ok(Number.isSafeInteger(own.level) && own.level >= 0, 'a whole-number level');
  assert.equal(own.level > 0, typeof own.reason === 'string' && own.reason.length > 0, 'a critical level has its reason');
  assert.match(file, /^level: \d+$/m);
  assert.match(file, /^reason:/m);
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/image.yml'), 'utf8');
  assert.match(workflow, /critical: \$\{\{ steps\.critical\.outputs\.critical \}\}/);
  assert.match(workflow, /\$\{\{ needs\.names\.outputs\.critical != '' && format\('io\.sentry-six\.critical=\{0\}', needs\.names\.outputs\.critical\) \|\| '' \}\}/);
  assert.match(workflow, /format\('io\.sentry-six\.critical-level=\{0\}', needs\.names\.outputs\.critical_level\)/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('id: critical')), /^\s+run:.*\$\{\{/m, 'the text never goes into a script');
  const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY .*CRITICAL_UPDATE\.txt/, 'the image knows its own critical text');
  // the workflow's own shell step, run on hostile text, agrees with the server
  const step = /id: critical\n\s+run: \|\n((?: {10}.*\n)+)/.exec(workflow)[1].split('\n').map((l) => l.slice(10)).join('\n');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sm-crit-'));
  try {
    for (const text of ['# only a comment\n', 'level: 3\nreason:  Fix "x" `id` $(id), \\ it\'s\tbad\n# reason: note\n', `level: 0012\r\nreason: ${'y'.repeat(400)}\r\n`, 'level: x\nreason: Fix', 'level: 2\nreason:\n', '  LEVEL: 1\n  Reason: a: b\n']) {
      fs.writeFileSync(path.join(dir, 'CRITICAL_UPDATE.txt'), text);
      execFileSync('bash', ['-eo', 'pipefail', '-c', step], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: path.join(dir, 'out') } });
      const out = fs.readFileSync(path.join(dir, 'out'), 'utf8');
      fs.rmSync(path.join(dir, 'out'));
      const want = criticalFromFile(text);
      assert.equal(out, `critical_level=${want.level}\ncritical=${want.reason || ''}\n`, JSON.stringify(text));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

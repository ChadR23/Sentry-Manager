'use strict';

// CAN Bridge log signatures, pairing and the chain (server/canTrust.js), with
// real ECDSA P-256 signatures made as the bridge makes them (SMO,
// docs/sentry-manager-format.md, "Integrity").

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanTrust, signedMessage, fingerprintOf } = require('../server/canTrust');

const KEY = 'abcdef123456';
const ZERO = '0'.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function bridge() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  let index = 0;
  let prev = { name: '-', sha256: ZERO };
  return {
    fingerprint: fingerprintOf(der),
    /** A log and its sidecar, signed, next in the chain. */
    log(dir, name, body = crypto.randomBytes(500), { key = KEY, note = null } = {}) {
      fs.mkdirSync(path.join(dir, key), { recursive: true });
      fs.writeFileSync(path.join(dir, key, name), body);
      const fields = { vehicleKey: key, name, sha256: sha(body), length: body.length, index, prevName: prev.name, prevSha256: prev.sha256 };
      const signature = crypto.sign('sha256', Buffer.from(signedMessage(fields)), privateKey).toString('base64');
      const integrity = {
        signed: true, version: 'canbridge-log-sig-v1', algorithm: 'ECDSA-P256-SHA256', public_key: der.toString('base64'), key_fingerprint: fingerprintOf(der),
        vehicle_key: key, sha256: fields.sha256, length: fields.length, index, prev_name: prev.name, prev_sha256: prev.sha256, signature,
        ...(note ? { chain_note: note } : {})
      };
      fs.writeFileSync(path.join(dir, key, `${name}.json`), JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 10, integrity }));
      prev = { name, sha256: fields.sha256 };
      index++;
      return { body, integrity };
    },
    skip() { index++; }, // a log made but never sent
    /** A log the bridge could not sign (build 143 with a damaged chain.json): outside the chain. */
    unsigned(dir, name, error = 'JSONException: Value \u0000\u0000 of type java.lang.String cannot be converted to JSONObject') {
      fs.mkdirSync(path.join(dir, KEY), { recursive: true });
      fs.writeFileSync(path.join(dir, KEY, name), crypto.randomBytes(300));
      fs.writeFileSync(path.join(dir, KEY, `${name}.json`), JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 5, integrity: { signed: false, error } }));
    },
    restart() { index = 0; prev = { name: '-', sha256: ZERO }; } // chain.json lost, no signed sidecar left: a new chain at 0
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cantrust-'));
const nm = (i) => `${KEY}_20261108T14${String(i).padStart(2, '0')}00Z_${i + 1}.log.xz`;

test('the signed message is exactly the spec\'s lines with a trailing LF', () => {
  assert.equal(signedMessage({ vehicleKey: 'k', name: 'n.log.xz', sha256: 'ab', length: 3, index: 0, prevName: '-', prevSha256: ZERO }), `canbridge-log-sig-v1\nk\nn.log.xz\nab\n3\n0\n-\n${ZERO}\n`);
});

test('verified, then the first key is paired; a changed file, another key and a lying fingerprint fail', async () => {
  const dir = tmp();
  const t = createCanTrust({ dir });
  const b = bridge();
  b.log(dir, nm(0));
  const r0 = await t.check(KEY, nm(0));
  assert.equal(r0.status, 'verified');
  assert.equal((await t.summary(KEY)).pin.fingerprint, b.fingerprint, 'paired on the first signed log');
  assert.match(b.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.deepEqual(await t.usable(KEY, nm(0)), { use: true, trust: 'verified' });

  // one byte changed after signing
  b.log(dir, nm(1));
  const f = path.join(dir, KEY, nm(1));
  const bytes = fs.readFileSync(f);
  bytes[10] ^= 1;
  fs.writeFileSync(f, bytes);
  const r1 = await t.check(KEY, nm(1));
  assert.deepEqual([r1.status, r1.reason], ['failed', 'the file is not the one that was signed (SHA-256 differs)']);
  assert.deepEqual(await t.usable(KEY, nm(1)), { use: false, trust: null }, 'kept, never used');

  // a sidecar edited to match the changed file: the signature no longer matches
  const side = JSON.parse(fs.readFileSync(`${f}.json`, 'utf8'));
  side.integrity.sha256 = sha(bytes);
  fs.writeFileSync(`${f}.json`, JSON.stringify(side));
  assert.equal((await t.check(KEY, nm(1))).reason, 'the signature does not match');

  // used anyway, when the owner says so
  await t.setOverride(KEY, nm(1), true);
  assert.deepEqual(await t.usable(KEY, nm(1)), { use: true, trust: 'override' });

  // another key (an attacker, or a new Screenmate): failed, and offered to the owner
  const other = bridge();
  other.log(dir, nm(2));
  const r2 = await t.check(KEY, nm(2));
  assert.deepEqual([r2.status, r2.reason], ['failed', 'signed by a key this car is not paired with']);
  assert.equal((await t.summary(KEY)).newKey.fingerprint, other.fingerprint);
  // the owner trusts it: checked again, verified
  await t.trustKey(KEY, other.fingerprint);
  assert.equal((await t.record(KEY, nm(2))).status, 'verified');
  assert.equal((await t.summary(KEY)).pin.how, 'confirmed by the owner');
  await assert.rejects(t.trustKey(KEY, 'AA:BB'), /No such new key/);

  // a fingerprint field that does not match the key it comes with
  const dir2 = tmp();
  const t2 = createCanTrust({ dir: dir2 });
  const b2 = bridge();
  b2.log(dir2, nm(0));
  const f2 = path.join(dir2, KEY, `${nm(0)}.json`);
  const s2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  s2.integrity.key_fingerprint = other.fingerprint;
  fs.writeFileSync(f2, JSON.stringify(s2));
  assert.equal((await t2.check(KEY, nm(0))).reason, 'the key fingerprint does not match the key');
  // signed for another car key
  const b3 = bridge();
  const dir3 = tmp();
  b3.log(dir3, nm(0), undefined, { key: 'ffffff000000' });
  fs.mkdirSync(path.join(dir3, KEY), { recursive: true });
  fs.renameSync(path.join(dir3, 'ffffff000000', nm(0)), path.join(dir3, KEY, nm(0)));
  fs.renameSync(path.join(dir3, 'ffffff000000', `${nm(0)}.json`), path.join(dir3, KEY, `${nm(0)}.json`));
  assert.equal((await createCanTrust({ dir: dir3 }).check(KEY, nm(0))).reason, 'signed for another car key');
});

test('unsigned: used before pairing, failed after; waiting for a sidecar, then judged without it', async () => {
  const dir = tmp();
  let now = 1_000_000;
  const t = createCanTrust({ dir, now: () => now });
  fs.mkdirSync(path.join(dir, KEY));
  fs.writeFileSync(path.join(dir, KEY, nm(0)), 'old bridge');
  assert.equal((await t.check(KEY, nm(0))).status, 'waiting');
  assert.deepEqual(await t.usable(KEY, nm(0)), { use: false, trust: null });
  now += 11 * 60_000; // no sidecar after ten minutes
  assert.equal((await t.check(KEY, nm(0))).status, 'unsigned');
  assert.deepEqual(await t.usable(KEY, nm(0)), { use: true, trust: 'unsigned' });
  // "signed": false with an error (no usable key on the device)
  fs.writeFileSync(path.join(dir, KEY, nm(1)), 'x');
  fs.writeFileSync(path.join(dir, KEY, `${nm(1)}.json`), JSON.stringify({ integrity: { signed: false, error: 'keystore unavailable' } }));
  assert.deepEqual([(await t.check(KEY, nm(1))).status, (await t.record(KEY, nm(1))).reason], ['unsigned', 'not signed: keystore unavailable']);
  // paired: unsigned logs are no longer trusted
  const b = bridge();
  b.log(dir, nm(2));
  assert.equal((await t.check(KEY, nm(2))).status, 'verified');
  fs.writeFileSync(path.join(dir, KEY, nm(3)), 'y');
  fs.writeFileSync(path.join(dir, KEY, `${nm(3)}.json`), JSON.stringify({ frames: 1 }));
  const r3 = await t.check(KEY, nm(3));
  assert.deepEqual([r3.status, r3.reason], ['failed', 'not signed, but this car is paired with a key']);
});

test('the chain: in order is fine; a missing, swapped, duplicated or reordered log is reported; a log deleted here still counts', async () => {
  const dir = tmp();
  const t = createCanTrust({ dir });
  const b = bridge();
  for (let i = 0; i < 4; i++) { b.log(dir, nm(i)); await t.check(KEY, nm(i)); }
  assert.deepEqual(await t.chain(KEY), { count: 4, first: 0, last: 3, issues: [], restarts: [], segments: [{ first: 0, last: 3, count: 4 }] });
  // deleted here afterwards: not a break
  await t.deleted(KEY, nm(1));
  fs.rmSync(path.join(dir, KEY, nm(1)));
  assert.deepEqual((await t.chain(KEY)).issues, []);
  // logs 4 and 5 never arrived (the bridge made them), 6 did
  b.skip(); b.skip();
  b.log(dir, nm(6));
  await t.check(KEY, nm(6));
  assert.deepEqual((await t.chain(KEY)).issues.map((i) => [i.kind, i.text]), [['gap', 'logs 4 to 5 are missing']]);

  // swapped: a log whose previous is not the one stored here
  const dir2 = tmp();
  const t2 = createCanTrust({ dir: dir2 });
  const c = bridge();
  c.log(dir2, nm(0));
  await t2.check(KEY, nm(0));
  // log 1 is made and signed but never arrives; log 2 names it as its previous
  const decoy = `${KEY}_20261108T140500Z_9.log.xz`;
  c.log(dir2, decoy);
  fs.rmSync(path.join(dir2, KEY, decoy));
  fs.rmSync(path.join(dir2, KEY, `${decoy}.json`));
  c.log(dir2, nm(2));
  await t2.check(KEY, nm(2));
  const issues = (await t2.chain(KEY)).issues.map((i) => i.kind);
  assert.deepEqual(issues, ['gap'], 'index 1 never stored: a gap');
  // and a stored index 1 that is not what log 2 names: a mismatch
  fs.writeFileSync(path.join(dir2, KEY, nm(1)), 'swapped in');
  // recorded as a verified index-1 log of this key (as if it had been signed): log 2 does not follow it
  const rec = await t2.record(KEY, nm(0));
  const trustFile = path.join(dir2, KEY, 'trust.json');
  const tj = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
  tj.logs[nm(1)] = { ...rec, index: 1, sha256: sha('swapped in'), prevName: nm(0), prevSha256: rec.sha256, status: 'verified' };
  fs.writeFileSync(trustFile, JSON.stringify(tj));
  const t3 = createCanTrust({ dir: dir2 });
  assert.deepEqual((await t3.chain(KEY)).issues.map((i) => i.kind), ['mismatch']);

  // duplicate index and reordered times
  tj.logs['dup'] = { ...tj.logs[nm(1)], status: 'verified' };
  tj.logs[`${KEY}_20261108T130000Z_7.log.xz`] = { ...rec, index: 3, sha256: 'x'.repeat(64), prevName: nm(2), prevSha256: (await t3.record(KEY, nm(2))).sha256, status: 'verified' };
  fs.writeFileSync(trustFile, JSON.stringify(tj));
  const kinds = (await createCanTrust({ dir: dir2 }).chain(KEY)).issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['duplicate', 'mismatch', 'reordered']);
});

// the bridge's chain.json damaged (SMO build 143): logs sent with "signed": false and an "error" until build 144
const at = (min) => `${KEY}_20261108T${String(15 + Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}00Z_${min + 1}.log.xz`;

test('logs the bridge could not sign: a reason of their own, not used, outside the chain; the next signed log follows the last signed one', async () => {
  const dir = tmp();
  const t = createCanTrust({ dir });
  const b = bridge();
  for (let i = 0; i < 3; i++) { b.log(dir, at(i)); await t.check(KEY, at(i)); }
  // three logs the bridge could not sign (one error with control characters and far too long)
  b.unsigned(dir, at(3));
  b.unsigned(dir, at(4), `IllegalStateException: <b>x</b>\n${'y'.repeat(400)}`);
  b.unsigned(dir, at(5));
  for (let i = 3; i < 6; i++) await t.check(KEY, at(i));
  const r3 = await t.record(KEY, at(3));
  assert.deepEqual([r3.status, r3.kind], ['failed', 'bridge-could-not-sign']);
  assert.equal(r3.reason, 'unsigned: the CAN Bridge could not sign it (JSONException: Value of type java.lang.String cannot be converted to JSONObject)');
  const r4 = await t.record(KEY, at(4));
  assert.ok(!/[\u0000-\u001f]/.test(r4.reason) && r4.reason.length < 180 && r4.reason.endsWith('…)'), r4.reason);
  assert.deepEqual(await t.usable(KEY, at(3)), { use: false, trust: null }, 'not used unless the owner says so');
  // signed again (build 144: continued from the newest signed sidecar, #2), with a note on the repair
  b.log(dir, at(6), undefined, { note: `chain.json was 64 zero bytes (likely a power cut); chain continued from ${at(2)} (index 2)` });
  assert.equal((await t.check(KEY, at(6))).status, 'verified');
  const c = await t.chain(KEY);
  assert.deepEqual(c, { count: 4, first: 0, last: 3, issues: [], restarts: [], segments: [{ first: 0, last: 3, count: 4 }] }, 'no gap, no mismatch, no failed link');
  assert.match((await t.record(KEY, at(6))).chainNote, /^chain\.json was 64 zero bytes .* continued from /);
  const sum = await t.summary(KEY);
  assert.deepEqual(sum.couldNotSign, { count: 3, used: 0 });
  assert.deepEqual([sum.counts.verified, sum.counts.failed], [4, 3]);

  // all of them used at once (only those), then not
  const other = `${KEY}_20261108T160000Z_99.log.xz`;
  b.log(dir, other);
  const f = path.join(dir, KEY, other);
  fs.writeFileSync(f, 'changed after signing');
  assert.equal((await t.check(KEY, other)).status, 'failed');
  assert.deepEqual((await t.setOverrideCouldNotSign(KEY, true)).sort(), [at(3), at(4), at(5)]);
  assert.deepEqual(await t.usable(KEY, at(4)), { use: true, trust: 'override' });
  assert.deepEqual(await t.usable(KEY, other), { use: false, trust: null }, 'a log that is not what was signed is not among them');
  assert.deepEqual((await t.summary(KEY)).couldNotSign, { count: 3, used: 3 });
  assert.deepEqual(await t.setOverrideCouldNotSign(KEY, true), [], 'nothing left to change');
  // one stopped by hand, then all
  await t.setOverride(KEY, at(5), false);
  assert.deepEqual((await t.setOverrideCouldNotSign(KEY, false)).sort(), [at(3), at(4)]);
  assert.deepEqual(await t.usable(KEY, at(3)), { use: false, trust: null });

  // before pairing, a log the bridge could not sign stays unsigned (used, as for an older bridge)
  const dir2 = tmp();
  const t2 = createCanTrust({ dir: dir2 });
  bridge().unsigned(dir2, at(0));
  const u = await t2.check(KEY, at(0));
  assert.deepEqual([u.status, u.kind], ['unsigned', null]);
});

test('a new chain at 0 after the bridge lost its chain: a restart with its note, each part checked on its own', async () => {
  const dir = tmp();
  const t = createCanTrust({ dir });
  const b = bridge();
  for (let i = 0; i < 4; i++) { b.log(dir, at(i)); await t.check(KEY, at(i)); }
  b.unsigned(dir, at(4));
  await t.check(KEY, at(4));
  b.restart();
  const note = 'chain.json was 64 zero bytes (likely a power cut) and no signed log is left here; a new chain starts at index 0';
  b.log(dir, at(5), undefined, { note });
  for (let i = 6; i < 8; i++) b.log(dir, at(i));
  for (let i = 5; i < 8; i++) assert.equal((await t.check(KEY, at(i))).status, 'verified');
  const c = await t.chain(KEY);
  assert.deepEqual(c.issues, [], 'not a duplicate, not a mismatch');
  assert.deepEqual(c.segments, [{ first: 0, last: 3, count: 4 }, { first: 0, last: 2, count: 3 }]);
  assert.deepEqual([c.count, c.first, c.last], [7, 0, 2]);
  assert.equal(c.restarts.length, 1);
  assert.deepEqual([c.restarts[0].name, c.restarts[0].note, c.restarts[0].after], [at(5), note, { index: 3, name: at(3) }]);
  assert.equal(c.restarts[0].text, `the chain started again at 0 with ${at(5)} (the bridge says: ${note}): logs signed between ${at(3)} (#3) and it cannot be checked for gaps`);
  // a gap in the new part is still a gap
  b.skip();
  b.log(dir, at(9));
  await t.check(KEY, at(9));
  assert.deepEqual((await t.chain(KEY)).issues.map((i) => i.text), ['log 3 is missing']);

  // a log at 0 that fails its check proves no restart: it stays a duplicate (and a failed link)
  const dir2 = tmp();
  const t2 = createCanTrust({ dir: dir2 });
  const c2 = bridge();
  for (let i = 0; i < 3; i++) { c2.log(dir2, at(i)); await t2.check(KEY, at(i)); }
  c2.restart();
  c2.log(dir2, at(5));
  fs.appendFileSync(path.join(dir2, KEY, at(5)), 'x');
  assert.equal((await t2.check(KEY, at(5))).status, 'failed');
  const c3 = await t2.chain(KEY);
  assert.deepEqual([c3.restarts, c3.issues.map((i) => i.kind).sort()], [[], ['duplicate']]);
});

test('judgements stored before this version are judged again: the bridge\'s own errors get their reason, chain notes are read', async () => {
  const dir = tmp();
  const b = bridge();
  for (let i = 0; i < 2; i++) b.log(dir, at(i));
  b.unsigned(dir, at(2));
  b.unsigned(dir, at(3));
  b.log(dir, at(4), undefined, { note: 'chain.json was damaged (12 bytes); chain continued from x (index 1)' });
  // the trust file as the old version wrote it (no version, no kind, no chain notes)
  const t0 = createCanTrust({ dir });
  for (let i = 0; i < 5; i++) await t0.check(KEY, at(i));
  const file = path.join(dir, KEY, 'trust.json');
  const tj = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete tj.v;
  for (const r of Object.values(tj.logs)) { delete r.v; delete r.kind; delete r.chainNote; }
  tj.logs[at(2)].reason = 'not signed: JSONException: Value, but this car is paired with a key';
  tj.logs[at(3)].reason = tj.logs[at(2)].reason;
  tj.logs[at(3)].override = true; // used anyway by hand before: kept
  // and a record of a log deleted here
  tj.logs[at(9)] = { status: 'failed', signed: false, deleted: true, reason: 'not signed, but this car is paired with a key' };
  fs.writeFileSync(file, JSON.stringify(tj));

  const t = createCanTrust({ dir });
  const again = await t.pending();
  assert.deepEqual(again.map((x) => x.name).sort(), [at(2), at(3)], 'only the unsigned ones are hashed again');
  for (const { key, name } of again) await t.check(key, name);
  assert.deepEqual([(await t.record(KEY, at(2))).kind, (await t.record(KEY, at(3))).override], ['bridge-could-not-sign', true]);
  assert.match((await t.record(KEY, at(4))).chainNote, /^chain\.json was damaged/);
  assert.equal((await t.record(KEY, at(4))).status, 'verified');
  assert.deepEqual(await t.pending(), [], 'done once');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
  assert.deepEqual((await t.summary(KEY)).couldNotSign, { count: 2, used: 1 });
});

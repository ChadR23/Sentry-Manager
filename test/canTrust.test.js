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
    log(dir, name, body = crypto.randomBytes(500), { key = KEY } = {}) {
      fs.mkdirSync(path.join(dir, key), { recursive: true });
      fs.writeFileSync(path.join(dir, key, name), body);
      const fields = { vehicleKey: key, name, sha256: sha(body), length: body.length, index, prevName: prev.name, prevSha256: prev.sha256 };
      const signature = crypto.sign('sha256', Buffer.from(signedMessage(fields)), privateKey).toString('base64');
      const integrity = {
        signed: true, version: 'canbridge-log-sig-v1', algorithm: 'ECDSA-P256-SHA256', public_key: der.toString('base64'), key_fingerprint: fingerprintOf(der),
        vehicle_key: key, sha256: fields.sha256, length: fields.length, index, prev_name: prev.name, prev_sha256: prev.sha256, signature
      };
      fs.writeFileSync(path.join(dir, key, `${name}.json`), JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 10, integrity }));
      prev = { name, sha256: fields.sha256 };
      index++;
      return { body, integrity };
    },
    skip() { index++; } // a log made but never sent
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
  assert.deepEqual(await t.chain(KEY), { count: 4, first: 0, last: 3, issues: [] });
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

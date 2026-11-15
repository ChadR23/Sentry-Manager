'use strict';

// What src/main/converter/verifier.js decides for the candidates that
// telemetryFixtures.js made (and tampered copies of them), for the Rust
// verifier's parity test (lean/src/converter/tests.rs). Each candidate is
// verified as a copy, Quick and Full, with and without a size profile:
//
//   <dir>/verify/<case>.<codec>.<variant>.mp4            the candidate
//   <dir>/verify/<case>.<codec>.<variant>.<mode>.<profile>.json   the verdict
//
//   node lean/src/converter/testdata/verifierFixtures.js <dir>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const { verifyCandidate } = require(path.join(REPO, 'src/main/converter/verifier'));

const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: node verifierFixtures.js <dir>');
  process.exit(2);
}
const out = path.join(dir, 'verify');
fs.mkdirSync(out, { recursive: true });

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, timedOut: false }));
  });
}

// One byte of the first telemetry payload changed (inside a record, not a length).
function tampered(bytes, codec) {
  const copy = Buffer.from(bytes);
  const marker = codec === 'h265' ? copy.indexOf(Buffer.from('Sentry-Six-Tesla')) + 16 : copy.indexOf(Buffer.from([0x42, 0x42, 0x42, 0x69]));
  if (marker < 16) return null;
  copy[marker + 6] ^= 0x01;
  return copy;
}

async function main() {
  const { cases, codecs } = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
  const list = [];
  for (const name of cases) {
    for (const codec of codecs) {
      const good = path.join(dir, `${name}.${codec}.out`);
      if (!fs.existsSync(good)) continue;
      const bytes = fs.readFileSync(good);
      const variants = { good: bytes, raw: fs.readFileSync(path.join(dir, `${name}.${codec}.enc`)), short: bytes.subarray(0, bytes.length - 100) };
      const t = tampered(bytes, codec);
      if (t) variants.tampered = t;
      for (const [variant, data] of Object.entries(variants)) {
        const candidate = path.join(out, `${name}.${codec}.${variant}.mp4`);
        fs.writeFileSync(candidate, data);
        for (const mode of ['quick', 'full']) {
          for (const profileId of ['custom', 'aggressive']) {
            const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-fixture-'));
            const { createVerificationSnapshot } = require(path.join(REPO, 'src/main/converter/verificationSnapshot'));
            const verdict = await verifyCandidate({
              source: path.join(dir, `${name}.mp4`), candidate, codec, profileId, verifyMode: mode,
              runFfprobe: run, runFullDecode: run,
              createSnapshot: (input) => createVerificationSnapshot({ ...input, tempRoot: snapshots })
            });
            fs.rmSync(snapshots, { recursive: true, force: true });
            delete verdict.publicationArtifact;
            const file = `${name}.${codec}.${variant}.${mode}.${profileId}.json`;
            fs.writeFileSync(path.join(out, file), JSON.stringify(verdict, null, 1));
            list.push({ file, candidate: path.basename(candidate), source: `${name}.mp4`, codec, mode, profileId });
          }
        }
      }
    }
  }
  fs.writeFileSync(path.join(out, 'list.json'), JSON.stringify(list));
}

main().catch((error) => { console.error(error); process.exit(1); });

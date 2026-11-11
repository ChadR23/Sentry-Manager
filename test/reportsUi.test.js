'use strict';

// Settings → Help & feedback in all five interfaces: one shared module
// (web/reportsSettings.js) mounted in each interface's own Settings, with
// its own button and input classes, for admins only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PACKS = { aurora: 'aurora', daylight: 'dl', flux: 'flux', horizon: 'hz' };

test('the shared module: feedback, support, the opt-in, anonymous, the preview, the password, "not set up"', () => {
  const m = read('web/reportsSettings.js');
  assert.match(m, /export function createReportsSettings\(el, \{ cls = \{\}, h24 = null \} = \{\}\)/);
  for (const text of ['Send feedback', 'Send diagnostics to support', 'Share diagnostics with the developers', 'Send anonymously', 'What will be sent', "Reporting isn't set up in this build.", 'Attach diagnostics', 'Contact (optional)', "What's wrong (optional)", 'Your reference']) {
    assert.ok(m.includes(text), text);
  }
  assert.match(m, /data-msg maxlength="5000" required/);
  assert.match(m, /data-note maxlength="1000"/);
  assert.match(m, /'\/api\/reports\/preview'/);
  assert.match(m, /'\/api\/reports\/send'/);
  assert.match(m, /'\/api\/reports\/settings'/);
  assert.match(m, /err\.code === 'CONFIRM_PASSWORD'/, 'sending asks for the password like other security settings');
  assert.match(m, /'\/api\/auth\/confirm'/);
  // the opt-in is off unless checked by the saved setting, and turns on in one click (no pop-up)
  assert.match(m, /data-k="share"\$\{s\.share \? ' checked' : ''\}/);
  assert.doesNotMatch(m, /window\.confirm/);
  // with no key every control is disabled
  assert.match(m, /const dis = off \? ' disabled' : ''/);
  // the JSON shown is the server's, exactly
  assert.match(m, /\$\('\[data-pvjson\]'\)\.textContent = JSON\.stringify\(payload, null, 2\)/);
  assert.match(m, /showPreview\(`What will be sent[^\n]*out\.payload, false\)/);
  // a changed message drops the preview (what is sent is what was shown)
  assert.match(m, /pending = null; \$\('\[data-pv\]'\)\.hidden = true;/);
});

test('the heartbeat: in the opt-in\'s words, "Last heartbeat" in Status, a sample in the preview (never sent by hand)', () => {
  const m = read('web/reportsSettings.js');
  assert.ok(m.includes('and a short heartbeat every hour (version, health, how much footage and space saved)'));
  assert.ok(m.includes('<dt>Last heartbeat</dt>'));
  assert.ok(m.includes('Show a heartbeat'));
  assert.match(m, /JSON\.stringify\(\{ kind: 'heartbeat' \}\)/);
  assert.match(m, /showPreview\([^\n]*a heartbeat \(a sample\)`, out\.payload, true\)/);
  assert.match(m, /\$\('\[data-send\]'\)\.parentElement\.hidden = sample/, 'a sample has no Send button');
});

test('the built-in interface: a Help & feedback section, only when /api/reports answers (admins)', () => {
  const app = read('web/app.js');
  assert.match(app, /api\('\/api\/reports'\)\.catch\(\(\) => null\)/);
  assert.match(app, /rep && \['help', 'Help & feedback'\]/);
  assert.match(app, /data-section="help"><h2>Help &amp; feedback<\/h2>/);
  assert.match(app, /import\('\/web\/reportsSettings\.js'\)/);
  assert.match(app, /createReportsSettings\(box, \{ cls: \{ btn: 'btn sm', primary: 'btn sm solid', input: 'input' \}/);
});

for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: Settings has Help & feedback for admins, in the pack's own style`, () => {
    const s = read(`examples/ui-packs/${pack}/web/${mod}/pages/settings.js`);
    assert.match(s, /\['help', 'Help & feedback'/);
    assert.match(s, /const isAdmin = \(\) => fetch\('\/api\/auth\/me'/);
    assert.match(s, /m\?\.role === 'admin'/);
    assert.match(s, /\.filter\(\(\[k\]\) => k !== 'help'\)/, 'a watch-only account does not see the section');
    assert.match(s, /await import\('\/web\/reportsSettings\.js'\)/);
    assert.match(s, /createReportsSettings\([^\n]*?\{ cls: \{ btn: '[^']+', primary: '[^']+', input: '[^']+' \}, h24: \(\) => clockPref\.h24 \}\)/);
    assert.match(s, /async function help\(/);
    assert.match(s, /Help &amp; feedback/);
  });
}

test('watch-only accounts: /api/reports is hidden and refused', () => {
  const { viewerMay } = require('../server/accounts');
  for (const p of ['/api/reports', '/api/reports/settings', '/api/reports/preview', '/api/reports/send']) {
    assert.equal(viewerMay('GET', p), false, p);
    assert.equal(viewerMay('POST', p), false, p);
    assert.equal(viewerMay('PUT', p), false, p);
  }
});

test('a refused preview or Send says why next to its buttons, not only in the line at the bottom', () => {
  const m = read('web/reportsSettings.js');
  // the line under the preview and its Send button, scrolled into view
  assert.match(m, /const tell = \(msg, scroll = true\) => \{ const r = \$\('\[data-result\]'\);[^\n]*r\.scrollIntoView\?\.\(\{ block: 'center' \}\)/);
  assert.match(m, /api\('\/api\/reports\/send'[^\n]*\(\) => \{ b\.disabled = false; \}, tell\);/, 'a refused Send (too many in the hour, say) shows by the Send button');
  assert.match(m, /retry = \{ fn, onCancel, onError \}/, 'and the same after the password is asked for');
  assert.match(m, /guarded\(again\.fn, again\.onCancel, again\.onError\)/);
  assert.match(m, /tell\('Write a message first\.', false\)/);
  const html = m.slice(m.indexOf('data-pv hidden'), m.indexOf('aria-labelledby="sr-opt"'));
  assert.ok(html.includes('data-result'), 'the result line sits right under the preview');
});

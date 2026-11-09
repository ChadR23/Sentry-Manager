'use strict';

// The Sentry USB line on the Footage page (web/sentryUsb.js, the same words in
// every interface): what the Pi in the car last archived, from
// GET /api/vehicles/:id/sentry-usb, and the "Waiting for Sentry USB" day tag
// (the car drove off mid-transfer: nothing is lost, so it is not amber).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'web', 'sentryUsb.js'), 'utf8');
const load = () => import(`data:text/javascript,${encodeURIComponent(SRC)}`);
const app = fs.readFileSync(path.join(REPO, 'web', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'web', 'shell.css'), 'utf8');

// 3:30 PM in Chicago on Nov 8 2026; the archive finished at 3:07 PM there
const NOW = Date.parse('2026-11-08T21:30:00Z');
const TZ = 'America/Chicago';
const at = (iso) => Date.parse(iso);
const BASE = {
  present: true, readAt: NOW - 60000, writtenAt: at('2026-11-08T21:07:00Z'), device: 'sentryusb', state: 'idle',
  archive: { result: 'ok', startedAt: at('2026-11-08T21:00:00Z'), finishedAt: at('2026-11-08T21:07:00Z'), filesArchived: 120, filesNotArchived: 0, lastClip: 'RecentClips/2026-11-08/2026-11-08_14-59-00-front.mp4' },
  verification: { enabled: true, ran: true, matched: 118, converted: 2, resending: 0, noPiCopy: 0, stillQueued: 0, stopped: null },
  autoDeleteEnabled: false, transfer: null, stale: false
};
const TRANSFER = {
  startedAt: at('2026-11-08T21:20:00Z'), files: 48, bytes: 2147483648,
  firstClip: 'RecentClips/2026-11-08/2026-11-08_14-40-00-front.mp4',
  lastClip: 'SentryClips/2026-11-08_15-12-33/2026-11-08_15-12-00-back.mp4',
  expectedFinishAt: at('2026-11-08T21:41:00Z'), giveUpAt: at('2026-11-08T22:20:00Z')
};
const view = async (s) => (await load()).sentryUsbView(s, { timeZone: TZ, now: NOW, locale: 'en-US' });

test('Sentry USB line: each state in words, times in the car\'s time zone', async () => {
  const cases = [
    [BASE, 'ok', 'Sentry USB · last archive 3:07 PM ok · 120 clips · verified 120, 2 of them re-encoded by Sentry Manager'],
    [{ ...BASE, state: 'transferring', transfer: TRANSFER }, 'busy', 'Sentry USB · sending 48 clips (from 2:40 PM to 3:12 PM) · expected by 3:41 PM'],
    [{ ...BASE, state: 'waiting', transfer: TRANSFER }, 'wait', 'Sentry USB · waiting: the car left during the 3:20 PM transfer; its 48 clips stay on the Pi and arrive with the next archive'],
    [{ ...BASE, archive: { ...BASE.archive, result: 'failed', filesArchived: 100, filesNotArchived: 20 } }, 'bad', 'Sentry USB · last archive 3:07 PM failed · 20 clips not sent, retried next archive · 100 clips sent'],
    [{ ...BASE, archive: { ...BASE.archive, result: 'nothing_new', filesArchived: 0 }, verification: { ...BASE.verification, ran: false } }, 'ok', 'Sentry USB · last archive 3:07 PM · nothing new'],
    [{ ...BASE, stale: true, writtenAt: at('2026-11-05T21:30:00Z') }, 'stale', 'Sentry USB · not heard from since Nov 5, 3:30 PM'],
    [{ ...BASE, verification: { ...BASE.verification, resending: 3 } }, 'bad', 'Sentry USB · last archive 3:07 PM ok · 120 clips · verified 120, 2 of them re-encoded by Sentry Manager · 3 clips being re-sent']
  ];
  for (const [s, tone, line] of cases) {
    const v = await view(s);
    assert.equal(v.line, line);
    assert.equal(v.tone, tone, line);
    assert.equal(v.transferring, s.state === 'transferring', line);
  }
  // an archive on another day shows its date; a stale file never polls
  const yday = await view({ ...BASE, archive: { ...BASE.archive, finishedAt: at('2026-11-07T21:07:00Z') } });
  assert.match(yday.line, /last archive Nov 7, 3:07 PM ok/);
  assert.equal((await view({ ...BASE, stale: true, state: 'transferring', transfer: TRANSFER })).transferring, false);
});

test('Sentry USB details: verification counts, auto-delete, device and the transfer', async () => {
  const d = Object.fromEntries((await view({ ...BASE, state: 'transferring', transfer: TRANSFER, verification: { ...BASE.verification, stopped: 'time limit' } })).details);
  assert.equal(d.Sending, '48 clips, 2.0 GB');
  assert.equal(d.Clips, '2:40 PM to 3:12 PM');
  assert.equal(d['Expected by'], '3:41 PM');
  assert.equal(d['Counted as waiting after'], '4:20 PM');
  assert.equal(d['Matched the Pi'], '118');
  assert.equal(d['Re-encoded on the server'], '2');
  assert.equal(d['Being re-sent'], '0');
  assert.equal(d['No Pi copy'], '0');
  assert.equal(d['Still queued'], '0');
  assert.equal(d.Stopped, 'time limit');
  assert.equal(d['Auto-delete on the Pi'], 'off');
  assert.equal(d.Device, 'sentryusb');
  assert.equal(d['Newest clip sent'], '2:59 PM (RecentClips)');
  const off = Object.fromEntries((await view({ ...BASE, verification: null, autoDeleteEnabled: null })).details);
  assert.equal(off['Checksum checks'], 'not reported');
  assert.equal(off['Auto-delete on the Pi'], 'not reported');
});

test('Sentry USB: nothing shown without a status file; the markup escapes what the Pi wrote', async () => {
  const m = await load();
  for (const s of [{ present: false }, { present: false, error: 'EACCES' }, null, undefined, {}]) {
    assert.equal(m.sentryUsbView(s, { timeZone: TZ }), null);
    assert.equal(m.sentryUsbHtml(m.sentryUsbView(s, { timeZone: TZ })), '');
  }
  const html = m.sentryUsbHtml(await view({ ...BASE, device: '<img src=x onerror=alert(1)>' }), { tagClass: (t) => `chip ${t}` });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /^<details class="usb-status usb-ok" data-usb>/);
  assert.match(html, /<summary><span class="usb-tag chip ok">Sentry USB<\/span><span class="usb-text">last archive 3:07 PM ok/);
  // a bad time zone falls back to the browser's instead of throwing
  assert.ok(m.sentryUsbView(BASE, { timeZone: 'Not/AZone' }).line.startsWith('Sentry USB · last archive'));
  assert.deepEqual(m.clipTime('SentryClips/2026-11-08_15-12-33/2026-11-08_15-12-00-back.mp4'), { ms: Date.UTC(2026, 10, 8, 15, 12, 0), day: '2026-11-08' });
  assert.equal(m.clipTime('RecentClips/x.mp4'), null);
});

test('Sentry USB: polls every 60 s only while sending, and a highlight holds the redraw', () => {
  assert.match(SRC, /const POLL_MS = 60000;/);
  assert.match(SRC, /if \(view\?\.transferring\) timer = setTimeout\(load, POLL_MS\);/);
  assert.match(SRC, /if \(selecting\(el\)\)/);
  assert.match(SRC, /if \(dead \|\| !el\.isConnected\) return;/, 'stops when the page is gone');
  assert.match(SRC, /fetch\(`\/api\/vehicles\/\$\{encodeURIComponent\(id\)\}\/sentry-usb`/);
});

test('Built-in Footage page: the Sentry USB line under the filters, and the waiting day tag', () => {
  const footage = app.match(/\n {2}pages\.footage = [\s\S]*?\n {2}\};\n/)[0];
  assert.match(footage, /<div id="usb-status" hidden><\/div>\s*<p class="hint">/);
  assert.match(footage, /page\.innerHTML = html;\s*mountUsb\(v\);/);
  assert.match(footage, /f\.usb\?\.destroy\(\);/);
  assert.match(app, /import\('\/web\/sentryUsb\.js'\)/);
  const chip = app.match(/\n {2}function dayArchiveChip\([\s\S]*?\n {2}\}\n/)[0];
  assert.match(chip, /a\.state === 'waiting' \? 'Waiting for Sentry USB'/);
  assert.match(chip, /a\.state === 'partial' \? ' amber' : a\.state === 'waiting' \? ' wait' : ''/, 'amber only for partly archived');
  assert.match(chip, /title="\$\{esc\(a\.summary\)\}"/, 'the tooltip is the summary');
  const rule = css.match(/\.chip\.slate, \.chip\.gap\.wait \{([^}]*)\}/);
  assert.ok(rule, 'a neutral rule for the waiting tag');
  assert.doesNotMatch(rule[1], /--warn/);
});

const PACKS = {
  aurora: ['aurora', 'aurora/app.css', 'foot-usb', /\.chip\.slate \{/],
  daylight: ['dl', 'dl/app.css', 'dl-usb', /\.chip-slate \{/],
  flux: ['flux', 'flux.css', 'fo-usb', /\.chip\.slate \{/],
  horizon: ['hz', 'hz/app.css', 'ft-usb', /\.pill\.slate \{/]
};
for (const [pack, [mod, cssFile, slot, slate]] of Object.entries(PACKS)) {
  test(`${pack}: the Sentry USB line on Footage, hidden without a status file, and the waiting day tag`, () => {
    const page = fs.readFileSync(path.join(REPO, 'examples', 'ui-packs', pack, 'web', mod, 'pages', 'footage.js'), 'utf8');
    assert.match(page, /import \{ mountSentryUsb \} from '\/web\/sentryUsb\.js';/);
    assert.ok(page.includes(`<div id="${slot}" hidden></div>`), `${pack}: the slot starts hidden`);
    assert.match(page, new RegExp(`mountSentryUsb\\([^)]*#${slot}'[^)]*\\), v, \\{ tagClass: \\(tone\\) => USB_TAG\\[tone\\], h24: [^}]*\\}\\)`));
    assert.match(page, /usb\??\.destroy\(\)/, `${pack}: stops polling on leaving`);
    for (const tone of ['ok', 'busy', 'wait', 'bad', 'stale']) assert.match(page, new RegExp(`const USB_TAG = \\{[^}]*\\b${tone}: '`), `${pack}: ${tone}`);
    assert.ok(page.includes('Waiting for Sentry USB'), `${pack}: the day tag`);
    assert.match(page, /waiting: '?\s*'?slate|'waiting' \? '[^']*slate|chip-slate/, `${pack}: neutral, not amber`);
    const packCss = fs.readFileSync(path.join(REPO, 'examples', 'ui-packs', pack, 'web', cssFile), 'utf8');
    assert.match(packCss, slate, `${pack}: the slate tag`);
    assert.match(packCss, /\.usb-status \{/, `${pack}: the line in the pack's style`);
  });
}

test('Sentry USB: the 24-hour clock switch', async () => {
  const m = await load();
  assert.equal(m.sentryUsbView(BASE, { timeZone: TZ, now: NOW, locale: 'en-US', h24: true }).line, 'Sentry USB · last archive 15:07 ok · 120 clips · verified 120, 2 of them re-encoded by Sentry Manager');
  assert.match(app, /h24: \(\) => clockPref\.h24/);
});

test('Sentry USB details: the checksums Sentry Manager records, the older clips\' progress, and the setting for admins only', async () => {
  const m = await load();
  const rec = { enabled: true, today: 12, lastAt: at('2026-11-08T21:05:00Z'), pending: 4, lines: 300, windowDays: 7, older: true,
    backlog: { total: 35480, done: 35480, left: 0, failed: 0, bytesLeft: 0, etaMinutes: 0 }, canBackfill: true };
  const v = await view({ ...BASE, record: rec });
  assert.equal(Object.fromEntries(v.details)['Checksums recorded'], '12 clips today · last at 3:05 PM · 4 waiting', 'the backlog done: the usual line');
  assert.equal(v.line, (await view(BASE)).line, 'the line itself is unchanged');
  const html = m.sentryUsbHtml(v);
  assert.match(html, /<form class="usb-backfill" data-usb-backfill>/);
  assert.match(html, /<input type="checkbox" name="older" checked> Record checksums for older clips<\/label>/);
  assert.match(html, /every clip on the share, newest first/);
  // a watch-only account: the row, no setting
  const viewer = await view({ ...BASE, record: { ...rec, canBackfill: false } });
  assert.doesNotMatch(m.sentryUsbHtml(viewer), /usb-backfill/);
  assert.ok(Object.fromEntries(viewer.details)['Checksums recorded']);
  // none yet; the backlog under way (hours, minutes, days); turned off; a share without .sentryusb/ (not enabled) shows nothing
  assert.equal(Object.fromEntries((await view({ ...BASE, record: { ...rec, today: 0, lastAt: null, pending: 0 } })).details)['Checksums recorded'], '0 clips today · none yet');
  const running = await view({ ...BASE, record: { ...rec, backlog: { total: 35480, done: 12400, left: 23080, failed: 0, bytesLeft: 360e9, etaMinutes: 125 } } });
  assert.equal(Object.fromEntries(running.details)['Checksums recorded'], 'Recording checksums for older clips: 12,400 of 35,480 · about 2 h left');
  assert.match(Object.fromEntries((await view({ ...BASE, record: { ...rec, backlog: { ...rec.backlog, done: 35470, etaMinutes: 3 } } })).details)['Checksums recorded'], /· about 3 min left$/);
  assert.match(Object.fromEntries((await view({ ...BASE, record: { ...rec, backlog: { ...rec.backlog, done: 1, etaMinutes: 4000 } } })).details)['Checksums recorded'], /· about 3 days left$/);
  const off = await view({ ...BASE, record: { ...rec, older: false, backlog: null } });
  assert.equal(Object.fromEntries(off.details)['Checksums recorded'], '12 clips today · last at 3:05 PM · 4 waiting');
  assert.match(m.sentryUsbHtml(off), /<input type="checkbox" name="older"> Record checksums for older clips<\/label>/);
  assert.match(m.sentryUsbHtml(off), /only clips from the last 7 days/);
  assert.equal(Object.fromEntries((await view({ ...BASE, record: { ...rec, enabled: false } })).details)['Checksums recorded'], undefined);
  assert.equal(Object.fromEntries((await view(BASE)).details)['Checksums recorded'], undefined, 'an older server: no row');
  assert.match(SRC, /fetch\(`\/api\/vehicles\/\$\{encodeURIComponent\(id\)\}\/sentry-usb\/record`, \{\s*method: 'POST'/);
  assert.match(SRC, /body: JSON\.stringify\(\{ older: box\.checked \}\)/);
  assert.match(SRC, /if \(view\?\.record\?\.backlog\) timer = setTimeout\(load, 10000\);/);
});

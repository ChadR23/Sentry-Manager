#!/usr/bin/env node
'use strict';

// Replays recorded goldens (record.js) against another server and prints
// what differs, route by route. Exits 1 when anything differs, 2 when it
// cannot run, 0 when every answer is the same: the correctness gate for a
// faster build or a new backend (same clip counts, durations, codecs, speed
// samples, telemetry bytes, error answers).
//
//   SM_PASSWORD=… node tools/contract/compare.js --goldens goldens/ --base https://host:8443 --ca ca.crt
//
// Options as record.js (--user, --password-env, --cookie-env, --ca,
// --insecure-self-signed), plus --only REGEX, --max N (differences shown per
// answer, 8), --json FILE (the whole report), --allow-mutating (replay the
// recorded non-GET requests too; without it they are left out and named).

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const spec = require('./spec');

async function compare(args) {
  const dir = path.resolve(args.goldens || 'contract-goldens');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const only = args.only ? new RegExp(args.only) : null;
  const max = Number(args.max || 8);
  const client = await lib.connect(args);
  const report = { same: 0, different: 0, left: [], byRoute: {} };
  try {
    const get = async (p) => {
      const res = await client.request('GET', p);
      if (res.status !== 200) throw new Error(`GET ${p} answered ${res.status}`);
      return lib.parseJson(res.body);
    };
    // only this server's folders: the requests themselves are the recorded ones
    const folders = spec.folders(await spec.discover(get));
    // in the order they were recorded (seq): a request that changes something can change
    // what a later one answers (a pairing code shown, then cancelled), as it did on the
    // recorded server; older goldens without it keep the index's order
    const order = index.goldens.map((g, i) => [g, i]).sort((a, b) => (a[0].seq ?? a[1]) - (b[0].seq ?? b[1])).map(([g]) => g);
    for (const g of order) {
      if (only && !only.test(g.route)) continue;
      const golden = JSON.parse(fs.readFileSync(path.join(dir, g.file), 'utf8'));
      if (golden.method !== 'GET' && !args['allow-mutating']) {
        report.left.push(g.label);
        continue;
      }
      const s = golden.method === 'GET' ? spec.ROUTES[golden.route] || {} : { normalise: golden.normalise || [] };
      const res = await client.request(golden.method, lib.requestUrl(golden.request, folders), { body: golden.body, headers: golden.request.headers || {} });
      const actual = lib.snapshot(res, s, { replace: folders, strings: [], now: Date.now() });
      const diffs = lib.diff(golden.response, actual);
      const r = (report.byRoute[golden.route] ||= { same: 0, different: 0, answers: [] });
      if (diffs.length) {
        report.different++;
        r.different++;
        r.answers.push({ label: g.label, diffs });
      } else {
        report.same++;
        r.same++;
      }
    }
  } finally {
    client.close();
  }

  for (const [route, r] of Object.entries(report.byRoute).sort()) {
    if (!r.different) {
      console.log(`ok    ${route}${r.same > 1 ? ` (${r.same} answers)` : ''}`);
      continue;
    }
    console.log(`DIFF  ${route} (${r.different} of ${r.same + r.different} answers differ)`);
    for (const a of r.answers) {
      console.log(`      ${a.label}`);
      for (const d of a.diffs.slice(0, max)) console.log(`        ${d.path}: golden ${lib.brief(d.golden)}, now ${lib.brief(d.actual)}`);
      if (a.diffs.length > max) console.log(`        … ${a.diffs.length - max} more`);
    }
  }
  if (report.left.length) console.log(`left out (they change something; --allow-mutating replays them): ${report.left.join(', ')}`);
  const routes = Object.values(report.byRoute);
  console.log(`${report.different ? 'FAIL' : 'PASS'}: ${report.same} of ${report.same + report.different} answers the same; ${routes.filter((r) => r.different).length} of ${routes.length} routes differ.`);
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  compare(lib.parseArgs(process.argv.slice(2), ['insecure-self-signed', 'allow-mutating'])).then((r) => {
    process.exit(r.different ? 1 : 0);
  }, (err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { compare };

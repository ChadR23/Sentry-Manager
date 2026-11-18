#!/usr/bin/env node
'use strict';

// Records the answers of a running Sentry Six Manager as golden files, for
// compare.js to check another server against (docs: tools/contract/README.md).
//
//   SM_PASSWORD=… node tools/contract/record.js --base https://host:8443 --ca ca.crt --out goldens/
//
// Only GET routes are called (from docs/api-contract.json, the way
// tools/contract/spec.js says). A route that changes something is called
// only when it is listed in an --allow file:
//   [{ "method": "POST", "path": "/api/vehicles/contract-car/scan", "body": {} }]
// (an entry may carry `normalise` rules as spec.js's: kept in its golden, so the
// replay normalises the same way)
//
// Options: --user (admin), --password-env NAME (SM_PASSWORD), --cookie-env NAME
// (a session cookie instead of a password), --ca FILE (the server's
// certificate authority, Settings → Security) or --insecure-self-signed (accept
// any certificate: only for a server on this machine), --only REGEX (routes),
// --contract FILE. A password is only ever sent over https://.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const spec = require('./spec');

const REPO = path.join(__dirname, '..', '..');

/** The GET routes of the contract, each with how it is recorded or why not. */
function plan(contract, ctx) {
  const out = [];
  const missing = [];
  for (const r of contract.routes) {
    if (r.method !== 'GET') continue;
    const key = `GET ${r.path}`;
    if (spec.SKIP[key]) { out.push({ key, route: r, skip: spec.SKIP[key] }); continue; }
    const s = spec.ROUTES[key];
    if (!s && r.path.includes(':')) { missing.push(key); continue; }
    const requests = s?.requests ? s.requests(ctx) : [{ path: r.path }];
    out.push({ key, route: r, spec: s || {}, requests });
  }
  return { routes: out, missing };
}

/** The mutating requests an --allow file lists, each checked against the contract. */
function allowed(contract, file) {
  if (!file) return [];
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${file}: a list of { method, path, query?, body? } is expected`);
  return list.map((x) => {
    const method = String(x.method || '').toUpperCase();
    if (method === 'GET' || !method) throw new Error(`${file}: ${x.path}: only non-GET requests belong in an allow file`);
    const route = contract.routes.find((r) => r.method === method && new RegExp(`^${r.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, '[^/]+')}$`).test(x.path));
    if (!route) throw new Error(`${file}: ${method} ${x.path} is not a route in the contract`);
    return { key: `${method} ${route.path}`, route, method, request: { path: x.path, query: x.query, headers: x.headers }, body: x.body, spec: { normalise: x.normalise || [] } };
  });
}

async function record(args) {
  const contract = JSON.parse(fs.readFileSync(args.contract || path.join(REPO, 'docs', 'api-contract.json'), 'utf8'));
  const out = path.resolve(args.out || 'contract-goldens');
  const only = args.only ? new RegExp(args.only) : null;
  const allow = allowed(contract, args.allow);
  const client = await lib.connect(args);
  try {
    const get = async (p) => {
      const res = await client.request('GET', p);
      if (res.status !== 200) throw new Error(`Discovery: GET ${p} answered ${res.status}`);
      return lib.parseJson(res.body);
    };
    const ctx = await spec.discover(get);
    const folders = spec.folders(ctx);
    const { routes, missing } = plan(contract, ctx);
    if (missing.length) throw new Error(`GET routes with parameters that tools/contract/spec.js neither records nor skips:\n  ${missing.join('\n  ')}`);

    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(out)) if (f.endsWith('.json')) fs.unlinkSync(path.join(out, f));
    const index = { contract: contract.totals, routes: {}, goldens: [] };
    let n = 0;
    const save = async (key, method, request, body, s) => {
      const url = lib.requestUrl(request, folders);
      const res = await client.request(method, url, { body, headers: request.headers || {} });
      const snap = lib.snapshot(res, s, { replace: folders, strings: [], now: Date.now() });
      const file = lib.goldenName(method, lib.requestLabel(method, request).slice(method.length + 1));
      fs.writeFileSync(path.join(out, file), `${JSON.stringify({ route: key, method, request, ...(body !== undefined ? { body } : {}), ...(method !== 'GET' && s.normalise?.length ? { normalise: s.normalise } : {}), response: snap }, null, 2)}\n`);
      index.goldens.push({ file, route: key, label: lib.requestLabel(method, request), status: snap.status, seq: n, ...(method !== 'GET' ? { mutating: true } : {}) });
      n++;
    };
    for (const p of routes) {
      if (only && !only.test(p.key)) continue;
      if (p.skip) { index.routes[p.key] = { skipped: p.skip }; continue; }
      index.routes[p.key] = { requests: p.requests.length };
      for (const req of p.requests) await save(p.key, 'GET', req, undefined, p.spec);
    }
    for (const a of allow) {
      if (only && !only.test(a.key)) continue;
      index.routes[a.key] = { requests: (index.routes[a.key]?.requests || 0) + 1, mutating: true };
      await save(a.key, a.method, a.request, a.body, a.spec);
    }
    index.goldens.sort((a, b) => a.file.localeCompare(b.file));
    fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    const recorded = Object.values(index.routes).filter((r) => r.requests).length;
    const skipped = Object.values(index.routes).filter((r) => r.skipped).length;
    console.log(`Recorded ${n} answers from ${recorded} routes into ${out} (${skipped} GET routes skipped, reasons in index.json).`);
    return index;
  } finally {
    client.close();
  }
}

if (require.main === module) {
  record(lib.parseArgs(process.argv.slice(2), ['insecure-self-signed'])).catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { record, plan, allowed };

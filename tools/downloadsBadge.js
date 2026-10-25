'use strict';

// The README's "downloads" badge: how many times the Docker image was pulled
// from GitHub's registry. GitHub shows that total on the package page but
// has no API for it, so the Downloads workflow reads the page once a day and
// commits docs/badges/downloads.svg when the number changed. Everything stays
// on GitHub; no badge service is involved.
//
// usage: node tools/downloadsBadge.js <owner> <repo> <package> <out.svg>

const fs = require('fs');

/** The total from the package page: the exact title="12345", else "12.3K". */
function parseTotal(html) {
  const at = html.search(/Total downloads/i);
  if (at < 0) return null;
  const after = html.slice(at, at + 600);
  const exact = after.match(/title="([\d,]+)"/);
  if (exact) return Number(exact[1].replace(/,/g, ''));
  const short = after.match(/>\s*([\d.]+)\s*([kKmM]?)\s*</);
  if (!short) return null;
  const scale = { k: 1e3, m: 1e6 }[short[2].toLowerCase()] || 1;
  return Math.round(Number(short[1]) * scale);
}

/** 1234 -> "1.2k", 1234567 -> "1.2M", the way badges usually show it. */
function shortCount(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A flat badge like shields.io's, sized for its text (Verdana 11px widths). */
function badgeSvg(label, value) {
  const width = (text) => Math.round([...text].reduce((w, c) => w + (/[ilj.,:]/.test(c) ? 3.5 : /[mwMW]/.test(c) ? 9.5 : /[A-Z0-9]/.test(c) ? 7.5 : 6.5), 0)) + 10;
  const lw = width(label);
  const vw = width(value);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + vw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="#4c1"/><rect width="${lw + vw}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text>
</g>
</svg>
`;
}

async function main([owner, repo, pkg, out]) {
  const url = `https://github.com/${owner}/${repo}/pkgs/container/${pkg}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'sentry-six-manager-badge' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is the package public?)`);
  const total = parseTotal(await res.text());
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${url}: no "Total downloads" number on the page`);
  const svg = badgeSvg('downloads', shortCount(total));
  const before = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (before !== svg) fs.writeFileSync(out, svg);
  console.log(`${total} downloads${before === svg ? ' (unchanged)' : ''}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { parseTotal, shortCount, badgeSvg };

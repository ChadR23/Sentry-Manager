'use strict';

// What src/main/converter/scanner.js finds in a folder, for the Rust
// scanner's parity test (lean/src/converter/scanner.rs):
//   node lean/parity/converterScan.js <config.json>

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { scanTeslaFootage, compareScanPaths } = require(path.join(REPO, 'src/main/converter/scanner'));

(async () => {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = [];
  try {
    for await (const item of scanTeslaFootage(config, { concurrency: 4 })) out.push(item);
  } catch (error) {
    out.push({ error: error.code || error.name });
  }
  const paths = out.map((item) => item.relativePath).filter(Boolean);
  const compared = [];
  for (const a of paths) for (const b of paths) compared.push(compareScanPaths(a, b, config.groupOrder));
  process.stdout.write(JSON.stringify({ items: out, compared }));
})();
